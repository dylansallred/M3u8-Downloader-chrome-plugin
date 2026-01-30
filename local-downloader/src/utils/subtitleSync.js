const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const execAsync = promisify(exec);

/**
 * Parse SRT file to extract subtitle timings
 */
function parseSrtTimings(srtPath) {
  if (!fs.existsSync(srtPath)) return [];
  
  const content = fs.readFileSync(srtPath, 'utf8');
  const timings = [];
  const timeRegex = /(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/g;
  
  let match;
  while ((match = timeRegex.exec(content)) !== null) {
    const startMs = parseInt(match[1]) * 3600000 + parseInt(match[2]) * 60000 + parseInt(match[3]) * 1000 + parseInt(match[4]);
    const endMs = parseInt(match[5]) * 3600000 + parseInt(match[6]) * 60000 + parseInt(match[7]) * 1000 + parseInt(match[8]);
    timings.push({ start: startMs, end: endMs, duration: endMs - startMs });
  }
  
  return timings;
}

/**
 * Detect silence periods in audio using FFmpeg
 * Returns array of silence periods with start/end times
 */
async function detectSilence(videoPath, ffmpegPath = 'ffmpeg') {
  try {
    const cmd = `"${ffmpegPath}" -i "${videoPath}" -af silencedetect=noise=-30dB:d=0.5 -f null - 2>&1`;
    const { stdout, stderr } = await execAsync(cmd);
    const output = stdout + stderr;
    
    const silences = [];
    const startRegex = /silence_start: ([\d.]+)/g;
    const endRegex = /silence_end: ([\d.]+)/g;
    
    const starts = [...output.matchAll(startRegex)].map(m => parseFloat(m[1]) * 1000);
    const ends = [...output.matchAll(endRegex)].map(m => parseFloat(m[1]) * 1000);
    
    for (let i = 0; i < Math.min(starts.length, ends.length); i++) {
      silences.push({ start: starts[i], end: ends[i], duration: ends[i] - starts[i] });
    }
    
    return silences;
  } catch (err) {
    throw new Error(`Silence detection failed: ${err.message}`);
  }
}

/**
 * Detect scene changes in video using FFmpeg
 * Returns array of scene change timestamps
 */
async function detectSceneChanges(videoPath, ffmpegPath = 'ffmpeg', threshold = 0.4) {
  try {
    const cmd = `"${ffmpegPath}" -i "${videoPath}" -filter:v "select='gt(scene,${threshold})',showinfo" -f null - 2>&1`;
    const { stdout, stderr } = await execAsync(cmd);
    const output = stdout + stderr;
    
    const sceneChanges = [];
    const timeRegex = /pts_time:([\d.]+)/g;
    
    let match;
    while ((match = timeRegex.exec(output)) !== null) {
      sceneChanges.push(parseFloat(match[1]) * 1000);
    }
    
    return sceneChanges;
  } catch (err) {
    throw new Error(`Scene detection failed: ${err.message}`);
  }
}

/**
 * Calculate subtitle density (subtitles per minute) over time windows
 */
function calculateSubtitleDensity(timings, windowSizeMs = 60000) {
  if (timings.length === 0) return [];
  
  const maxTime = Math.max(...timings.map(t => t.end));
  const densities = [];
  
  for (let windowStart = 0; windowStart < maxTime; windowStart += windowSizeMs) {
    const windowEnd = windowStart + windowSizeMs;
    const subsInWindow = timings.filter(t => t.start >= windowStart && t.start < windowEnd).length;
    densities.push({
      start: windowStart,
      end: windowEnd,
      count: subsInWindow,
      density: subsInWindow / (windowSizeMs / 60000)
    });
  }
  
  return densities;
}

/**
 * Analyze correlation between subtitle timing and audio silence
 * Returns offset suggestions based on silence/subtitle gaps
 */
function analyzeSubtitleSilenceCorrelation(subtitleTimings, silencePeriods) {
  if (subtitleTimings.length === 0 || silencePeriods.length === 0) {
    return { correlation: 0, suggestedOffset: 0, confidence: 'low' };
  }
  
  // Find gaps between subtitles (potential silence periods)
  const subtitleGaps = [];
  for (let i = 0; i < subtitleTimings.length - 1; i++) {
    const gapStart = subtitleTimings[i].end;
    const gapEnd = subtitleTimings[i + 1].start;
    const gapDuration = gapEnd - gapStart;
    if (gapDuration > 1000) { // Only consider gaps > 1 second
      subtitleGaps.push({ start: gapStart, end: gapEnd, duration: gapDuration });
    }
  }
  
  // Try different offsets and calculate correlation
  const offsetRange = [-5000, -4000, -3000, -2000, -1000, 0, 1000, 2000, 3000, 4000, 5000];
  let bestOffset = 0;
  let bestScore = 0;
  
  for (const offset of offsetRange) {
    let matches = 0;
    
    for (const gap of subtitleGaps) {
      const adjustedGapStart = gap.start + offset;
      const adjustedGapEnd = gap.end + offset;
      
      // Check if this gap overlaps with any silence period
      for (const silence of silencePeriods) {
        const overlapStart = Math.max(adjustedGapStart, silence.start);
        const overlapEnd = Math.min(adjustedGapEnd, silence.end);
        const overlap = Math.max(0, overlapEnd - overlapStart);
        
        if (overlap > 500) { // At least 500ms overlap
          matches++;
        }
      }
    }
    
    const score = matches / subtitleGaps.length;
    if (score > bestScore) {
      bestScore = score;
      bestOffset = offset;
    }
  }
  
  const confidence = bestScore > 0.5 ? 'high' : bestScore > 0.3 ? 'medium' : 'low';
  
  return {
    correlation: bestScore,
    suggestedOffset: bestOffset,
    confidence,
    subtitleGaps: subtitleGaps.length,
    silencePeriods: silencePeriods.length
  };
}

/**
 * Main function to analyze subtitle sync
 */
async function analyzeSubtitleSync(videoPath, srtPath, ffmpegPath = 'ffmpeg', logger = console) {
  logger.info('Starting subtitle sync analysis', { videoPath, srtPath });
  
  try {
    // Parse subtitle timings
    logger.info('Parsing subtitle timings...');
    const subtitleTimings = parseSrtTimings(srtPath);
    if (subtitleTimings.length === 0) {
      throw new Error('No subtitle timings found in SRT file');
    }
    logger.info('Subtitle timings parsed', { count: subtitleTimings.length });
    
    // Detect silence in audio
    logger.info('Detecting audio silence periods...');
    const silencePeriods = await detectSilence(videoPath, ffmpegPath);
    logger.info('Silence detection complete', { count: silencePeriods.length });
    
    // Analyze correlation
    logger.info('Analyzing subtitle-silence correlation...');
    const correlation = analyzeSubtitleSilenceCorrelation(subtitleTimings, silencePeriods);
    logger.info('Correlation analysis complete', correlation);
    
    // Calculate subtitle density
    const density = calculateSubtitleDensity(subtitleTimings);
    const avgDensity = density.reduce((sum, d) => sum + d.density, 0) / density.length;
    
    return {
      subtitleCount: subtitleTimings.length,
      silencePeriodsCount: silencePeriods.length,
      averageSubtitleDensity: avgDensity,
      correlation: correlation.correlation,
      suggestedOffset: correlation.suggestedOffset,
      confidence: correlation.confidence,
      recommendation: correlation.confidence === 'high' && Math.abs(correlation.suggestedOffset) > 500
        ? `Apply offset of ${correlation.suggestedOffset}ms to improve sync`
        : 'Subtitles appear to be in sync',
    };
  } catch (err) {
    logger.error('Subtitle sync analysis failed', { error: err.message });
    throw err;
  }
}

module.exports = {
  analyzeSubtitleSync,
  parseSrtTimings,
  detectSilence,
  detectSceneChanges,
  calculateSubtitleDensity,
  analyzeSubtitleSilenceCorrelation,
};
