const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');

const platform = process.platform;
const outputDir = path.resolve(process.cwd(), 'bin');
const isWindows = platform === 'win32';
const outputName = isWindows ? 'yt-dlp.exe' : 'yt-dlp';
const outputPath = path.join(outputDir, outputName);

function resolveDownloadUrl() {
  const explicit = String(process.env.YTDLP_DOWNLOAD_URL || '').trim();
  if (explicit) return explicit;

  if (platform === 'darwin') {
    return 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos';
  }
  if (platform === 'win32') {
    return 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
  }
  if (platform === 'linux') {
    const arch = os.arch();
    if (arch === 'arm64') {
      return 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_aarch64';
    }
    return 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
  }

  throw new Error(`Unsupported platform for bundled yt-dlp: ${platform}`);
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
    req.setTimeout(30_000, () => {
      req.destroy(new Error('Timed out downloading yt-dlp'));
    });
  });
}

async function run() {
  const url = resolveDownloadUrl();
  fs.mkdirSync(outputDir, { recursive: true });

  console.log(`[fetch-yt-dlp] Downloading from: ${url}`);
  await downloadWithRedirects(url, outputPath);

  if (!isWindows) {
    fs.chmodSync(outputPath, 0o755);
  }

  const stat = fs.statSync(outputPath);
  console.log(`[fetch-yt-dlp] Saved ${outputPath} (${stat.size} bytes)`);
}

run().catch((err) => {
  console.error('[fetch-yt-dlp] Failed:', err && err.message ? err.message : err);
  process.exitCode = 1;
});
