const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');
const unzipper = require('unzipper');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { Accept: 'application/json' } }, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data || '{}');
            resolve(parsed);
          } catch (err) {
            reject(new Error(`Failed to parse JSON: ${err.message}`));
          }
        });
      })
      .on('error', reject);
  });
}

async function extractFirstSrt(zipPath, destDir, jobId, logger = console, { seasonNumber, episodeNumber } = {}) {
  if (!zipPath || !fs.existsSync(zipPath)) return null;
  const targetPath = path.join(destDir, `${path.basename(zipPath, path.extname(zipPath))}.srt`);

  return new Promise((resolve, reject) => {
    const srtFiles = [];
    
    fs.createReadStream(zipPath)
      .pipe(unzipper.Parse())
      .on('entry', (entry) => {
        const ext = path.extname(entry.path || '').toLowerCase();
        if (ext !== '.srt') {
          entry.autodrain();
          return;
        }
        
        // Collect all .srt files
        const chunks = [];
        entry.on('data', (chunk) => chunks.push(chunk));
        entry.on('end', () => {
          srtFiles.push({
            path: entry.path,
            data: Buffer.concat(chunks)
          });
        });
      })
      .on('close', () => {
        if (srtFiles.length === 0) {
          logger.warn('SubDL: no .srt file found in zip', { jobId, zipPath });
          resolve(null);
          return;
        }

        // Try to find matching episode file if season/episode provided
        let selectedFile = null;
        if (seasonNumber && episodeNumber) {
          const episodePattern = new RegExp(`s0*${seasonNumber}e0*${episodeNumber}`, 'i');
          selectedFile = srtFiles.find(f => episodePattern.test(f.path));
          
          if (selectedFile) {
            logger.info('SubDL: found matching episode file in zip', { 
              jobId, 
              season: seasonNumber, 
              episode: episodeNumber, 
              file: selectedFile.path 
            });
          }
        }
        
        // Fallback to first .srt file
        if (!selectedFile) {
          selectedFile = srtFiles[0];
          logger.info('SubDL: using first .srt file from zip', { 
            jobId, 
            file: selectedFile.path,
            totalFiles: srtFiles.length
          });
        }
        
        // Write the selected file
        fs.writeFile(targetPath, selectedFile.data, (err) => {
          if (err) {
            reject(err);
          } else {
            logger.info('SubDL: extracted subtitle', { jobId, targetPath, source: selectedFile.path });
            resolve(targetPath);
          }
        });
      })
      .on('error', reject);
  });
}

function selectDownloadUrl(sub) {
  if (!sub) return null;
  if (sub.download_url) return sub.download_url;
  if (sub.url) {
    if (sub.url.startsWith('http')) return sub.url;
    return `https://dl.subdl.com${sub.url}`;
  }
  if (sub.id && sub.file_id) {
    return `https://dl.subdl.com/subtitle/${sub.id}-${sub.file_id}.zip`;
  }
  if (sub.sd_id && sub.file_id) {
    return `https://dl.subdl.com/subtitle/${sub.sd_id}-${sub.file_id}.zip`;
  }
  return null;
}

function downloadToFile(url, dest) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    https
      .get(url, (res) => {
        if (res.statusCode >= 300) {
          res.resume();
          return reject(new Error(`Download failed with status ${res.statusCode}`));
        }
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve(dest)));
      })
      .on('error', (err) => {
        fs.unlink(dest, () => reject(err));
      });
  });
}

function pickBestSubtitle(subtitles = [], { seasonNumber, episodeNumber }) {
  if (!Array.isArray(subtitles) || subtitles.length === 0) return null;

  // Priority 1: Full-season packs for the matching season (episode is null and season matches)
  if (seasonNumber) {
    const fullSeasonMatch = subtitles.find((s) => 
      s.season === seasonNumber && 
      (s.episode === null || s.episode === undefined) &&
      (s.episode_from === null || s.episode_from === undefined)
    );
    if (fullSeasonMatch) return fullSeasonMatch;
  }

  // Priority 2: Multi-episode packs that include the target episode
  if (episodeNumber && seasonNumber) {
    const rangeMatch = subtitles.find((s) => {
      if (s.season !== seasonNumber) return false;
      if (typeof s.episode_from === 'number' && typeof s.episode_end === 'number') {
        return episodeNumber >= s.episode_from && episodeNumber <= s.episode_end;
      }
      return false;
    });
    if (rangeMatch) return rangeMatch;
  }

  // Priority 3: Exact single episode match
  if (episodeNumber && seasonNumber) {
    const exactMatch = subtitles.find((s) => 
      s.season === seasonNumber && 
      s.episode === episodeNumber
    );
    if (exactMatch) return exactMatch;
  }

  // Priority 4: Any subtitle for the matching season
  if (seasonNumber) {
    const seasonMatch = subtitles.find((s) => s.season === seasonNumber);
    if (seasonMatch) return seasonMatch;
  }

  // Fallback: first entry
  return subtitles[0];
}

async function fetchAndSaveSubtitles({ apiKey, title, tmdbId, imdbId, downloadDir, jobId, logger = console, seasonNumber, episodeNumber, type, lookupTitle }) {
  if (!apiKey) {
    logger.info('SubDL: skipped (no API key provided)', { jobId });
    return null;
  }

  const buildUrl = ({ withEpisode, fullSeasonFlag } = {}) => {
    const url = new URL('https://api.subdl.com/api/v1/subtitles');
    url.searchParams.set('api_key', apiKey);
    if (tmdbId) url.searchParams.set('tmdb_id', tmdbId);
    else if (imdbId) url.searchParams.set('imdb_id', imdbId);
    else if (lookupTitle || title) url.searchParams.set('film_name', lookupTitle || title);
    if (type) url.searchParams.set('type', type);
    if (seasonNumber) url.searchParams.set('season_number', String(seasonNumber));
    if (withEpisode && episodeNumber) url.searchParams.set('episode_number', String(episodeNumber));
    if (fullSeasonFlag) url.searchParams.set('full_season', '1');
    url.searchParams.set('languages', 'EN');
    url.searchParams.set('subs_per_page', '10');
    return url.toString();
  };

  const trySearch = async (opts) => {
    const url = buildUrl(opts);
    logger.info('SubDL: request', {
      jobId,
      url,
      tmdbId,
      title: lookupTitle || title,
      type,
      seasonNumber,
      episodeNumber: opts && opts.withEpisode ? episodeNumber : null,
      fullSeason: opts && opts.fullSeasonFlag ? 1 : 0,
    });
    const searchResult = await fetchJson(url);
    logger.info('SubDL: search result', {
      jobId,
      status: searchResult && searchResult.status,
      results: Array.isArray(searchResult && searchResult.results) ? searchResult.results.length : 0,
      subtitles: Array.isArray(searchResult && searchResult.subtitles) ? searchResult.subtitles.length : 0,
      sampleResult: Array.isArray(searchResult?.results) && searchResult.results[0] ? searchResult.results[0] : null,
      sampleSubtitle: Array.isArray(searchResult?.subtitles) && searchResult.subtitles[0] ? searchResult.subtitles[0] : null,
    });
    return searchResult;
  };

  try {
    // First attempt: with episode if provided
    let searchResult = await trySearch({ withEpisode: true, fullSeasonFlag: false });

    // Fallback: drop episode and request full season if nothing returned
    if (!searchResult || searchResult.status !== true || !Array.isArray(searchResult.subtitles) || searchResult.subtitles.length === 0) {
      searchResult = await trySearch({ withEpisode: false, fullSeasonFlag: true });
    }

    if (!searchResult || searchResult.status !== true || !Array.isArray(searchResult.subtitles) || searchResult.subtitles.length === 0) {
      return null;
    }

    const best = pickBestSubtitle(searchResult.subtitles, { seasonNumber, episodeNumber });
    logger.info('SubDL: best subtitle chosen', {
      jobId,
      release_name: best?.release_name,
      language: best?.language,
      season: best?.season,
      episode: best?.episode,
      episode_from: best?.episode_from,
      episode_end: best?.episode_end,
      downloadUrl: selectDownloadUrl(best),
    });
    const downloadUrl = selectDownloadUrl(best);
    if (!downloadUrl) {
      logger.warn('SubDL: no download URL found on subtitle result', { jobId, best });
      return null;
    }

    const destPath = path.join(downloadDir, `${jobId}-subtitles.zip`);
    await downloadToFile(downloadUrl, destPath);
    logger.info('SubDL: subtitle downloaded', { jobId, downloadUrl, destPath });

    const subtitlePath = await extractFirstSrt(destPath, downloadDir, jobId, logger, { seasonNumber, episodeNumber });

    return {
      path: destPath,
      subtitlePath,
      subtitle: best,
      searchResults: searchResult.results || [],
    };
  } catch (err) {
    logger.warn('SubDL: fetch failed', { jobId, error: err && err.message });
    return null;
  }
}

module.exports = {
  fetchAndSaveSubtitles,
};
