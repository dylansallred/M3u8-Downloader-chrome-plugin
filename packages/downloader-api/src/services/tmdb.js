const https = require('https');

// Simple TMDB helper that searches by title, then fetches details for richer metadata.
// Expects API key to be provided via config or environment. All calls are best-effort.
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on('error', reject);
  });
}

async function lookupPoster({ apiKey, title, type }) {
  if (!apiKey || !title) return null;

  const baseImg = 'https://image.tmdb.org/t/p/w500';

  const pickImages = (images) => {
    const posterList = Array.isArray(images?.posters) ? images.posters : [];
    const backdropList = Array.isArray(images?.backdrops) ? images.backdrops : [];
    const imageUrls = [];
    posterList.slice(0, 3).forEach((p) => {
      if (p.file_path) imageUrls.push(`${baseImg}${p.file_path}`);
    });
    backdropList.slice(0, 3).forEach((b) => {
      if (b.file_path) imageUrls.push(`${baseImg}${b.file_path}`);
    });
    return imageUrls;
  };

  const buildResult = (entity, details, images) => {
    const posterUrl = entity?.poster_path ? `${baseImg}${entity.poster_path}` : null;
    const backdropUrl = entity?.backdrop_path ? `${baseImg}${entity.backdrop_path}` : null;
    const imageUrls = pickImages(images);
    if (posterUrl && !imageUrls.includes(posterUrl)) imageUrls.unshift(posterUrl);
    if (backdropUrl && !imageUrls.includes(backdropUrl)) imageUrls.unshift(backdropUrl);
    return {
      id: entity?.id,
      title: details?.name || details?.title || entity?.name || entity?.title,
      releaseDate: details?.first_air_date || details?.release_date || entity?.first_air_date || entity?.release_date,
      posterUrl,
      backdropUrl,
      overview: details?.overview || entity?.overview,
      runtime: details?.runtime,
      tagline: details?.tagline,
      genres: Array.isArray(details?.genres) ? details.genres.map((g) => g.name) : undefined,
      imageUrls: imageUrls.slice(0, 6),
    };
  };

  const searchTv = async (query) => {
    try {
      const tvResult = await fetchJson(`https://api.themoviedb.org/3/search/tv?api_key=${apiKey}&query=${query}`);
      const tvFirst = Array.isArray(tvResult?.results) && tvResult.results[0];
      if (!tvFirst) return null;
      let tvDetails = {};
      let tvImages = {};
      try {
        tvDetails = await fetchJson(`https://api.themoviedb.org/3/tv/${tvFirst.id}?api_key=${apiKey}`);
      } catch (_) {}
      try {
        tvImages = await fetchJson(`https://api.themoviedb.org/3/tv/${tvFirst.id}/images?api_key=${apiKey}`);
      } catch (_) {}
      return buildResult(tvFirst, tvDetails, tvImages);
    } catch (_) {
      return null;
    }
  };

  const searchMovie = async (query) => {
    try {
      const movieResult = await fetchJson(`https://api.themoviedb.org/3/search/movie?api_key=${apiKey}&query=${query}`);
      const movieFirst = Array.isArray(movieResult?.results) && movieResult.results[0];
      if (!movieFirst) return null;
      let movieDetails = {};
      let movieImages = {};
      try {
        movieDetails = await fetchJson(`https://api.themoviedb.org/3/movie/${movieFirst.id}?api_key=${apiKey}`);
      } catch (_) {}
      try {
        movieImages = await fetchJson(`https://api.themoviedb.org/3/movie/${movieFirst.id}/images?api_key=${apiKey}`);
      } catch (_) {}
      return buildResult(movieFirst, movieDetails, movieImages);
    } catch (_) {
      return null;
    }
  };

  try {
    const query = encodeURIComponent(title);

    if (type === 'tv') {
      return await searchTv(query);
    }
    if (type === 'movie') {
      return await searchMovie(query);
    }

    // Default: movie first, then TV
    return (await searchMovie(query)) || (await searchTv(query));
  } catch (err) {
    return null;
  }
}

module.exports = {
  lookupPoster,
};
