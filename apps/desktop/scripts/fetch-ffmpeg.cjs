const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { spawnSync } = require('node:child_process');

const platform = process.platform;
const isWindows = platform === 'win32';
const outputDir = path.resolve(process.cwd(), 'bin');
const ffmpegName = isWindows ? 'ffmpeg.exe' : 'ffmpeg';
const ffprobeName = isWindows ? 'ffprobe.exe' : 'ffprobe';
const ffmpegPath = path.join(outputDir, ffmpegName);
const ffprobePath = path.join(outputDir, ffprobeName);
const isDarwinArm64 = platform === 'darwin' && process.arch === 'arm64';

function resolveUrls() {
  const ffmpegExplicit = String(process.env.FFMPEG_DOWNLOAD_URL || '').trim();
  const ffprobeExplicit = String(process.env.FFPROBE_DOWNLOAD_URL || '').trim();

  if (ffmpegExplicit && ffprobeExplicit) {
    return { ffmpegUrl: ffmpegExplicit, ffprobeUrl: ffprobeExplicit };
  }

  if (platform === 'darwin') {
    const isArm64 = process.arch === 'arm64';
    return {
      // evermeet only publishes Intel macOS binaries; Apple Silicon needs a native arm64 source.
      ffmpegUrl: ffmpegExplicit || (
        isArm64
          ? 'https://www.osxexperts.net/ffmpeg80arm.zip'
          : 'https://evermeet.cx/ffmpeg/getrelease/ffmpeg'
      ),
      ffprobeUrl: ffprobeExplicit || (
        isArm64
          ? 'https://www.osxexperts.net/ffprobe80arm.zip'
          : 'https://evermeet.cx/ffmpeg/getrelease/ffprobe'
      ),
    };
  }

  if (platform === 'linux') {
    const arch = process.arch === 'arm64' ? 'linuxarm64' : 'linux64';
    return {
      ffmpegUrl: ffmpegExplicit
        || `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-${arch}-gpl.tar.xz`,
      ffprobeUrl: ffprobeExplicit
        || `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-${arch}-gpl.tar.xz`,
    };
  }

  if (platform === 'win32') {
    const arch = process.arch === 'arm64' ? 'winarm64' : 'win64';
    return {
      ffmpegUrl: ffmpegExplicit
        || `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-${arch}-gpl.zip`,
      ffprobeUrl: ffprobeExplicit
        || `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-${arch}-gpl.zip`,
    };
  }

  throw new Error(
    `No default ffmpeg download URLs for this platform (${platform}). Set FFMPEG_DOWNLOAD_URL and FFPROBE_DOWNLOAD_URL.`
  );
}

function downloadWithRedirects(url, destinationPath, redirectBudget = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'M3U8-Downloader-Build/1.0',
      },
    }, (res) => {
      const status = Number(res.statusCode || 0);
      if (status >= 300 && status < 400 && res.headers.location && redirectBudget > 0) {
        res.resume();
        const redirectedUrl = new URL(String(res.headers.location), url).toString();
        downloadWithRedirects(redirectedUrl, destinationPath, redirectBudget - 1)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (status < 200 || status >= 300) {
        res.resume();
        reject(new Error(`Download failed with HTTP ${status}`));
        return;
      }

      const tempPath = `${destinationPath}.tmp`;
      const out = fs.createWriteStream(tempPath);

      out.on('error', (err) => {
        try { fs.unlinkSync(tempPath); } catch {}
        reject(err);
      });

      res.on('error', (err) => {
        try { fs.unlinkSync(tempPath); } catch {}
        reject(err);
      });

      out.on('finish', () => {
        try {
          fs.renameSync(tempPath, destinationPath);
          resolve();
        } catch (err) {
          try { fs.unlinkSync(tempPath); } catch {}
          reject(err);
        }
      });

      res.pipe(out);
    });

    req.on('error', reject);
    req.setTimeout(60_000, () => {
      req.destroy(new Error('Timed out downloading ffmpeg binary'));
    });
  });
}

function canExecuteBinary(binaryPath) {
  const probe = spawnSync(binaryPath, ['-version'], { stdio: 'ignore' });
  return probe.status === 0;
}

function findExecutableInPath(command) {
  const probe = spawnSync('which', [command], {
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8',
  });
  if (probe.status !== 0) {
    return '';
  }
  const resolved = String(probe.stdout || '').trim();
  return resolved && fs.existsSync(resolved) ? resolved : '';
}

function getHomebrewPrefix(formulaName) {
  const probe = spawnSync('brew', ['--prefix', formulaName], {
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8',
  });
  if (probe.status !== 0) {
    return '';
  }
  return String(probe.stdout || '').trim();
}

function installHomebrewFfmpegIfNeeded() {
  const brewPath = findExecutableInPath('brew');
  if (!brewPath) {
    return false;
  }

  const existingPrefix = getHomebrewPrefix('ffmpeg');
  if (existingPrefix) {
    return true;
  }

  console.log('[fetch-ffmpeg] Installing ffmpeg via Homebrew as macOS arm64 fallback');
  const install = spawnSync(brewPath, ['install', 'ffmpeg'], {
    stdio: 'inherit',
  });
  return install.status === 0;
}

function tryCopySystemBinary(targetPath, binaryName) {
  const candidates = [];

  const pathMatch = findExecutableInPath(binaryName);
  if (pathMatch) {
    candidates.push(pathMatch);
  }

  const brewPrefix = getHomebrewPrefix('ffmpeg');
  if (brewPrefix) {
    candidates.push(path.join(brewPrefix, 'bin', binaryName));
  }

  for (const candidate of candidates) {
    if (!candidate || !fs.existsSync(candidate)) continue;
    try {
      fs.copyFileSync(candidate, targetPath);
      if (!isWindows) {
        fs.chmodSync(targetPath, 0o755);
      }
      if (canExecuteBinary(targetPath)) {
        console.log(`[fetch-ffmpeg] Using system ${binaryName} from ${candidate}`);
        return true;
      }
    } catch {
      continue;
    }
  }

  return false;
}

function extractArchiveIfNeeded(binaryPath, expectedName) {
  if (canExecuteBinary(binaryPath)) {
    return;
  }

  const extractDir = fs.mkdtempSync(path.join(outputDir, '.extract-'));
  const extractResult = spawnSync('tar', ['-xf', binaryPath, '-C', extractDir], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });

  if (extractResult.status !== 0) {
    const stderr = String(extractResult.stderr || '').trim();
    const stdout = String(extractResult.stdout || '').trim();
    throw new Error(
      `Failed to extract archive ${binaryPath}: ${stderr || stdout || `tar exited ${extractResult.status}`}`
    );
  }

  const candidates = [];
  const stack = [extractDir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      entries = [];
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name === expectedName) {
        candidates.push(fullPath);
      }
    }
  }

  if (candidates.length === 0) {
    throw new Error(`Archive ${binaryPath} did not contain expected binary: ${expectedName}`);
  }

  fs.copyFileSync(candidates[0], binaryPath);
  fs.rmSync(extractDir, { recursive: true, force: true });

  if (!canExecuteBinary(binaryPath)) {
    throw new Error(`Extracted binary still not executable: ${binaryPath}`);
  }
}

async function run() {
  fs.mkdirSync(outputDir, { recursive: true });

  if (isDarwinArm64 && !process.env.FFMPEG_DOWNLOAD_URL && !process.env.FFPROBE_DOWNLOAD_URL) {
    const copiedFromSystem = tryCopySystemBinary(ffmpegPath, ffmpegName)
      && tryCopySystemBinary(ffprobePath, ffprobeName);
    if (!copiedFromSystem) {
      const installed = installHomebrewFfmpegIfNeeded();
      const copiedAfterInstall = installed
        && tryCopySystemBinary(ffmpegPath, ffmpegName)
        && tryCopySystemBinary(ffprobePath, ffprobeName);
      if (!copiedAfterInstall) {
        throw new Error(
          'Unable to obtain native macOS arm64 ffmpeg/ffprobe. Install ffmpeg with Homebrew or set FFMPEG_DOWNLOAD_URL and FFPROBE_DOWNLOAD_URL.'
        );
      }
    }
  } else {
    const { ffmpegUrl, ffprobeUrl } = resolveUrls();
    console.log(`[fetch-ffmpeg] Downloading ffmpeg from: ${ffmpegUrl}`);
    await downloadWithRedirects(ffmpegUrl, ffmpegPath);
    extractArchiveIfNeeded(ffmpegPath, ffmpegName);
    console.log(`[fetch-ffmpeg] Downloading ffprobe from: ${ffprobeUrl}`);
    await downloadWithRedirects(ffprobeUrl, ffprobePath);
    extractArchiveIfNeeded(ffprobePath, ffprobeName);
  }

  if (!isWindows) {
    fs.chmodSync(ffmpegPath, 0o755);
    fs.chmodSync(ffprobePath, 0o755);
  }

  const ffmpegStat = fs.statSync(ffmpegPath);
  const ffprobeStat = fs.statSync(ffprobePath);
  console.log(`[fetch-ffmpeg] Saved ${ffmpegPath} (${ffmpegStat.size} bytes)`);
  console.log(`[fetch-ffmpeg] Saved ${ffprobePath} (${ffprobeStat.size} bytes)`);
}

run().catch((err) => {
  console.error('[fetch-ffmpeg] Failed:', err && err.message ? err.message : err);
  process.exitCode = 1;
});
