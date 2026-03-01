module.exports = {
  tmdbApiKey: process.env.TMDB_API_KEY || '',
  subdlApiKey: process.env.SUBDL_API_KEY || '',
  downloadThreads: 0, // 0 = use engine default (CPU-based)
};
