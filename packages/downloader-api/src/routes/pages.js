const path = require('path');

function registerPageRoutes(app, publicDir) {
  // Root goes to the downloader UI
  app.get('/', (req, res) => {
    res.redirect('/m3u8downloader');
  });

  // Pretty URLs without extension
  app.get('/m3u8downloader', (req, res) => {
    res.sendFile(path.join(publicDir, 'm3u8downloader.html'));
  });

  // Backwards-compat / alternate path used by the browser extension
  app.get('/videodownloader', (req, res) => {
    res.sendFile(path.join(publicDir, 'm3u8downloader.html'));
  });
}

module.exports = registerPageRoutes;
