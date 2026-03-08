const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const logger = require('../utils/logger');

function normalizeNumber(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function summarizeProbeStreams(probeData = {}) {
  const streams = Array.isArray(probeData.streams) ? probeData.streams : [];
  const videoStream = streams.find((stream) => stream && stream.codec_type === 'video') || null;
  const audioStream = streams.find((stream) => stream && stream.codec_type === 'audio') || null;
  const format = probeData && typeof probeData.format === 'object' ? probeData.format : {};

  return {
    streamCount: streams.length,
    hasVideo: !!videoStream,
    hasAudio: !!audioStream,
    videoCodec: videoStream && videoStream.codec_name ? String(videoStream.codec_name) : null,
    audioCodec: audioStream && audioStream.codec_name ? String(audioStream.codec_name) : null,
    formatName: format && format.format_name ? String(format.format_name) : null,
    durationSeconds: normalizeNumber(format && format.duration),
  };
}

function analyzeSegmentProbe(probeData, expectedProfile = null) {
  const observedProfile = summarizeProbeStreams(probeData);
  const issues = [];

  if (observedProfile.streamCount === 0) {
    issues.push({
      code: 'no_streams',
      severity: 'error',
      message: 'Segment has no detectable media streams.',
    });
  }

  if (observedProfile.durationSeconds !== null && observedProfile.durationSeconds <= 0) {
    issues.push({
      code: 'non_positive_duration',
      severity: 'warn',
      message: 'Segment reports a non-positive duration.',
    });
  }

  if (expectedProfile) {
    if (expectedProfile.hasVideo && !observedProfile.hasVideo) {
      issues.push({
        code: 'missing_video_stream',
        severity: 'warn',
        message: 'Segment is missing a video stream expected from earlier segments.',
      });
    }

    if (expectedProfile.hasAudio && !observedProfile.hasAudio) {
      issues.push({
        code: 'missing_audio_stream',
        severity: 'warn',
        message: 'Segment is missing an audio stream expected from earlier segments.',
      });
    }

    if (
      expectedProfile.videoCodec
      && observedProfile.videoCodec
      && expectedProfile.videoCodec !== observedProfile.videoCodec
    ) {
      issues.push({
        code: 'video_codec_change',
        severity: 'warn',
        message: `Segment video codec changed from ${expectedProfile.videoCodec} to ${observedProfile.videoCodec}.`,
      });
    }

    if (
      expectedProfile.audioCodec
      && observedProfile.audioCodec
      && expectedProfile.audioCodec !== observedProfile.audioCodec
    ) {
      issues.push({
        code: 'audio_codec_change',
        severity: 'warn',
        message: `Segment audio codec changed from ${expectedProfile.audioCodec} to ${observedProfile.audioCodec}.`,
      });
    }
  }

  return {
    observedProfile,
    issues,
    shouldRetry: issues.some((issue) => issue.code === 'no_streams'),
  };
}

async function probeSegmentFile(segmentPath, { FFPROBE_PATH, timeoutMs = 12000 } = {}) {
  if (!FFPROBE_PATH || !segmentPath) {
    return { ok: false, skipped: true, probeData: null, issues: [] };
  }

  try {
    await fs.promises.access(segmentPath);
  } catch {
    return {
      ok: false,
      skipped: false,
      probeData: null,
      issues: [{
        code: 'missing_segment_file',
        severity: 'error',
        message: 'Segment file was missing before validation.',
      }],
    };
  }

  return new Promise((resolve) => {
    const args = [
      '-v', 'error',
      '-show_streams',
      '-show_format',
      '-of', 'json',
      segmentPath,
    ];
    const child = spawn(FFPROBE_PATH, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const killTimer = setTimeout(() => {
      child.kill('SIGKILL');
      settle({
        ok: false,
        skipped: false,
        probeData: null,
        issues: [{
          code: 'ffprobe_timeout',
          severity: 'error',
          message: `ffprobe timed out after ${timeoutMs}ms.`,
        }],
      });
    }, timeoutMs);

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        stdout += Buffer.from(chunk).toString('utf8');
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderr += Buffer.from(chunk).toString('utf8');
      });
    }

    child.on('error', (err) => {
      clearTimeout(killTimer);
      settle({
        ok: false,
        skipped: false,
        probeData: null,
        issues: [{
          code: 'ffprobe_spawn_error',
          severity: 'error',
          message: err && err.message ? err.message : 'ffprobe failed to start.',
        }],
      });
    });

    child.on('close', (code) => {
      clearTimeout(killTimer);
      if (code !== 0) {
        settle({
          ok: false,
          skipped: false,
          probeData: null,
          issues: [{
            code: 'ffprobe_error',
            severity: 'error',
            message: stderr.trim() || `ffprobe exited with code ${code}`,
          }],
        });
        return;
      }

      try {
        const parsed = JSON.parse(stdout || '{}');
        settle({
          ok: true,
          skipped: false,
          probeData: parsed,
          issues: [],
        });
      } catch (err) {
        settle({
          ok: false,
          skipped: false,
          probeData: null,
          issues: [{
            code: 'ffprobe_parse_error',
            severity: 'error',
            message: err && err.message ? err.message : 'Failed to parse ffprobe output.',
          }],
        });
      }
    });
  });
}

function ensureSegmentDiagnostics(job) {
  if (!job.segmentDiagnostics || typeof job.segmentDiagnostics !== 'object') {
    job.segmentDiagnostics = {
      validatedSegments: 0,
      issueCount: 0,
      segmentsWithIssues: [],
      expectedProfile: null,
      reportPath: null,
      updatedAt: null,
    };
  }
  return job.segmentDiagnostics;
}

function recordSegmentDiagnostic(job, entry) {
  const diagnostics = ensureSegmentDiagnostics(job);
  diagnostics.validatedSegments += 1;
  diagnostics.updatedAt = Date.now();

  if (entry && entry.observedProfile && !diagnostics.expectedProfile && entry.promoteObservedProfile) {
    diagnostics.expectedProfile = entry.observedProfile;
  }

  if (!entry || !Array.isArray(entry.issues) || entry.issues.length === 0) {
    return diagnostics;
  }

  diagnostics.issueCount += entry.issues.length;
  diagnostics.segmentsWithIssues.push({
    index: entry.index,
    url: entry.url,
    path: entry.path,
    observedProfile: entry.observedProfile || null,
    issues: entry.issues,
    validatedAt: entry.validatedAt || Date.now(),
  });
  return diagnostics;
}

async function writeSegmentDiagnosticsReport(job, outputDir) {
  const diagnostics = ensureSegmentDiagnostics(job);
  if (!outputDir || diagnostics.validatedSegments <= 0) {
    return null;
  }

  const reportPath = path.join(outputDir, `${job.id}-segment-diagnostics.json`);
  const payload = {
    jobId: job.id,
    title: job.title,
    sourceUrl: job.url,
    validatedSegments: diagnostics.validatedSegments,
    issueCount: diagnostics.issueCount,
    expectedProfile: diagnostics.expectedProfile || null,
    generatedAt: new Date().toISOString(),
    segmentsWithIssues: diagnostics.segmentsWithIssues,
  };

  try {
    await fs.promises.writeFile(reportPath, JSON.stringify(payload, null, 2), 'utf8');
    diagnostics.reportPath = reportPath;
    return reportPath;
  } catch (err) {
    logger.warn('Failed to write segment diagnostics report', {
      jobId: job && job.id,
      reportPath,
      error: err && err.message,
    });
    return null;
  }
}

module.exports = {
  analyzeSegmentProbe,
  ensureSegmentDiagnostics,
  probeSegmentFile,
  recordSegmentDiagnostic,
  summarizeProbeStreams,
  writeSegmentDiagnosticsReport,
};
