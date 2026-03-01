(function () {
  if (window.__m3u8BridgeInjected) return;
  window.__m3u8BridgeInjected = true;

  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('js/media-detector.js');
  script.async = false;
  (document.head || document.documentElement).appendChild(script);
  script.onload = () => script.remove();

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== 'fetchv-page-detector') return;
    if (event.data.cmd !== 'MEDIA_DETECTED') return;

    const media = event.data.data;
    if (!media || !media.url) return;

    chrome.runtime.sendMessage({
      cmd: 'STORE_DETECTED_MEDIA',
      media,
    });
  });
})();
