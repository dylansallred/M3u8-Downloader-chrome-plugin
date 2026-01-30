// Thumbnail and background slideshow controller for Local HLS Downloader UI
// Encapsulates logic for updating the file thumbnail strip and background images
// based on job.thumbnailUrls.

export function createThumbnailController({
  fileThumbnailWrapper,
  backgroundSlideshow,
}) {
  let thumbnailUrls = [];

  function setFileIconImage(url) {
    const icon = document.querySelector('.file-icon');
    if (!icon) return;

    let img = icon.querySelector('img');
    if (!img) {
      img = document.createElement('img');
      icon.prepend(img);
    }
    img.src = url;
  }

  function selectBestThumbnail(urls) {
    if (!Array.isArray(urls) || urls.length === 0) return Promise.resolve(null);
    const target = 16 / 9;
    const keywords16x9 = ['backdrop', 'landscape', '16x9', '16-9', 'horizontal', 'w1280', 'w1920'];
    const isWideHint = (u) => keywords16x9.some((k) => u.toLowerCase().includes(k));

    const loadPromises = urls.map((url) =>
      new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ url, width: img.naturalWidth, height: img.naturalHeight });
        img.onerror = () => resolve({ url, width: 0, height: 0 });
        img.src = url;
      })
    );

    return Promise.all(loadPromises).then((entries) => {
      const scored = entries.map(({ url, width, height }) => {
        const ratio = width && height ? width / height : 0;
        const diff = ratio ? Math.abs(ratio - target) : Number.POSITIVE_INFINITY;
        const hint = isWideHint(url) ? 0 : 0.05; // slight bonus for known wide hints
        return { url, width, height, ratio, diff: diff - hint };
      });

      scored.sort((a, b) => a.diff - b.diff);

      console.groupCollapsed('[Thumbnails] Candidates by aspect closeness to 16:9');
      scored.forEach(({ url, width, height, ratio, diff }) => {
        const ratioText = ratio ? ratio.toFixed(3) : 'n/a';
        const diffText = Number.isFinite(diff) ? diff.toFixed(3) : 'n/a';
        console.log(`ratio ${width}x${height} (${ratioText}) diff ${diffText} -> ${url}`);
      });
      let best = scored.find((s) => Number.isFinite(s.diff)) || scored[0] || null;
      if (best) {
        console.log(`[Thumbnails] Best match diff ${best.diff.toFixed(3)} ratio ${best.ratio.toFixed(3)} url:`, best.url);
      }
      console.groupEnd();

      return best ? best.url : urls[0];
    });
  }

  function renderSingleImage(urls) {
    if (!fileThumbnailWrapper || !urls || urls.length === 0) return;

    selectBestThumbnail(urls).then((chosen) => {
      if (!chosen) return;

      fileThumbnailWrapper.innerHTML = '';
      const img = document.createElement('img');
      img.src = chosen;
      img.className = 'file-thumb active';
      img.alt = 'Video preview';
      fileThumbnailWrapper.appendChild(img);

      if (backgroundSlideshow) {
        backgroundSlideshow.innerHTML = '';
        const bgImg = document.createElement('img');
        bgImg.src = chosen;
        bgImg.className = 'background-slideshow-image active';
        backgroundSlideshow.appendChild(bgImg);
      }

      setFileIconImage(chosen);
    });
  }

  function clearThumbs() {
    if (fileThumbnailWrapper) fileThumbnailWrapper.innerHTML = '';
    if (backgroundSlideshow) backgroundSlideshow.innerHTML = '';
    thumbnailUrls = [];
  }

  function updateFromJob(job) {
    if (!fileThumbnailWrapper) return;

    if (job && Array.isArray(job.thumbnailUrls) && job.thumbnailUrls.length > 0) {
      if (thumbnailUrls.join(',') !== job.thumbnailUrls.join(',')) {
        thumbnailUrls = job.thumbnailUrls;
        renderSingleImage(thumbnailUrls);
      } else if (thumbnailUrls.length === 0) {
        thumbnailUrls = job.thumbnailUrls;
        renderSingleImage(thumbnailUrls);
      }
    } else if (thumbnailUrls.length > 0 && (!job || !job.thumbnailUrls || job.thumbnailUrls.length === 0)) {
      clearThumbs();
    }
  }

  function resetThumbnails() {
    clearThumbs();
  }

  return {
    updateFromJob,
    resetThumbnails,
  };
}
