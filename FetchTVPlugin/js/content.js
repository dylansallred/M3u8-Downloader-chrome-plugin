(function () {
    console.log('[FetchV Content] Script starting...');
    if (window.__fetchvContentInitialized) {
        console.log('[FetchV Content] Already initialized, skipping');
        return;
    }
    if (!chrome?.runtime?.id) {
        console.warn('[FetchV Content] chrome.runtime not available; skipping init');
        return;
    }
    window.__fetchvContentInitialized = !0;
    console.log('[FetchV Content] Initializing content script');
    const { version: e } = chrome.runtime.getManifest();
    document.body.setAttribute("data-version", e);
    console.log('[FetchV Content] Version:', e);
    let t = null;
    console.log('[FetchV Content] Checking chrome.storage.local for queue...');
    
    // Function to process queue data
    const safeSendMessage = (payload) => new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage(payload, (resp) => {
                const err = chrome.runtime.lastError;
                if (err) {
                    console.warn('[FetchV Content] sendMessage error ignored:', err.message);
                }
                resolve(resp);
            });
        } catch (err) {
            console.warn('[FetchV Content] sendMessage threw; ignoring:', err.message);
            resolve(null);
        }
    });

    const processQueue = async (a) => {
        console.log('[FetchV Content] Processing queue:', a);
        if (a) {
            const { currentTabId: s, tabsCount: o } = await safeSendMessage({ cmd: "GET_TAB_ID", parameter: {} }) || {};
            (a.tabId = s),
                (a.tabsCount = o),
                (a.version = Number(e)),
                (t = new BroadcastChannel(`channel-${s}`)),
                t.addEventListener("message", (e) => {
                    const { id: a, cmd: s, data: o, response: n } = e.data;
                    if ("GET_ALL_STORAGE" !== s)
                        "BG_FETCH" !== s
                            ? safeSendMessage({ cmd: s, parameter: o }).then((e) => {
                                  n && t.postMessage({ id: a, data: e });
                              })
                            : safeSendMessage({ cmd: s, parameter: o }).then((e) => {
                                  e && e.ok && e.blobURL
                                      ? fetch(e.blobURL)
                                            .then((e) => {
                                                if (e.ok) return e.blob();
                                                t.postMessage({
                                                    id: a,
                                                    data: { ok: !1, statusText: `Fetch Error-${e.status}` },
                                                });
                                            })
                                            .then((e) => {
                                                t.postMessage({ id: a, data: { ok: !0, content: e } });
                                            })
                                            .catch((e) => {
                                                t.postMessage({ id: a, data: { ok: !1, statusText: e.name } });
                                            })
                                            .finally(() => {
                                                URL.revokeObjectURL(e.blobURL);
                                            })
                                      : t.postMessage({ id: a, data: e });
                              });
                    else {
                        const { storageKey: e } = o;
                        chrome.storage.local.get([e], (s) => {
                            0 !== Object.keys(s).length && (s = s[e]), n && t.postMessage({ id: a, data: s });
                        });
                    }
                }),
                window.addEventListener("beforeunload", (e) => {
                    t && t.close();
                }),
                chrome.storage.local.remove(["queue"]);
        } else a = null;
        if (a) {
            console.log('[FetchV Content] Sending queue data to page:', a);
            
            // Use window.postMessage to send data from content script to page
            const sendToPage = () => {
                try {
                    window.postMessage({
                        type: 'FETCHV_QUEUE_DATA',
                        source: 'fetchv-extension',
                        payload: a
                    }, '*');
                    console.log('[FetchV Content] Posted message to window');
                } catch (err) {
                    console.error('[FetchV Content] Failed to post message:', err);
                }
            };
            
            // Send immediately and with delays to ensure delivery
            sendToPage();
            setTimeout(sendToPage, 100);
            setTimeout(sendToPage, 300);
            setTimeout(sendToPage, 500);
        }
        if (a)
            if ("rec" !== a.type)
                chrome.storage.local.get(["tasks"], ({ tasks: e }) => {
                    e || (e = []), e.push({ tabId: a.tabId, url: a.url }), chrome.storage.local.set({ tasks: e });
                });
            else {
                let recActive = !1;
                chrome.runtime.onMessage.addListener(function (a, s, o) {
                    const { cmd: n, parameter: r } = a;
                    if ("REC_ON_DATA" === n) {
                        const { data: a } = r;
                        return (
                            a.url
                                ? fetch(a.url)
                                      .then((e) => e.blob())
                                      .then((e) => {
                                          URL.revokeObjectURL(a.url),
                                              (a.content = e),
                                              t && t.postMessage({ id: n, data: a });
                                      })
                                      .catch(() => {
                                          void 0 !== a.onended &&
                                              ((a.onended = !0), t && t.postMessage({ id: n, data: a }));
                                      })
                                : t && t.postMessage({ id: n, data: a }),
                            recActive || (recActive = !0),
                            o(),
                            !0
                        );
                    }
                    return "REC_STOP" === n
                        ? ((recActive = !1), t && t.postMessage({ id: n }), o(), !0)
                        : "REC_ERROR" === n
                          ? (t && t.postMessage({ id: n, data: r }), o(), !0)
                          : void 0;
                });
            }
    };
    
    // Check for initial queue data
    chrome.storage.local.get(["queue"], async ({ queue: a }) => {
        console.log('[FetchV Content] Initial chrome.storage.local.get result:', a);
        await processQueue(a);
    });
    
    // Listen for storage changes to handle when queue is set while tab is already open
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === 'local' && changes.queue) {
            console.log('[FetchV Content] Storage changed, queue updated:', changes.queue.newValue);
            if (changes.queue.newValue) {
                processQueue(changes.queue.newValue);
            }
        }
    });

    // Respond to page title/info requests from the popup
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        const { cmd } = message || {};
        if (cmd === 'GET_PAGE_TITLES') {
            try {
                const safeText = (el) => (el ? (el.textContent || '').trim() : '');
                const safeAttr = (el, attr) => (el ? (el.getAttribute(attr) || '').trim() : '');

                const title = (document.title || '').trim();
                const ogTitle = (document.querySelector('meta[property="og:title"]')?.content || '').trim();
                const twitterTitle = (document.querySelector('meta[name="twitter:title"]')?.content || '').trim();
                const metaTitle = (document.querySelector('meta[name="title"]')?.content || '').trim();
                const metaDesc = (document.querySelector('meta[name="description"]')?.content || '').trim();
                const ogDesc = (document.querySelector('meta[property="og:description"]')?.content || '').trim();
                const ogUrl = (document.querySelector('meta[property="og:url"]')?.content || '').trim();
                const twitterUrl = (document.querySelector('meta[name="twitter:url"]')?.content || '').trim();
                const canonical = (document.querySelector('link[rel="canonical"]')?.href || '').trim();
                const h1 = safeText(document.querySelector('h1'));
                const h2 = safeText(document.querySelector('h2'));
                const dataTitle = safeAttr(document.querySelector('[data-title]'), 'data-title');
                const videoLabel = safeAttr(document.querySelector('video'), 'aria-label');
                const videoTitle = safeAttr(document.querySelector('video'), 'title');
                const playerTitle = safeAttr(document.querySelector('[title]'), 'title');

                const payload = {
                    title,
                    ogTitle,
                    twitterTitle,
                    metaTitle,
                    metaDesc,
                    ogDesc,
                    ogUrl,
                    twitterUrl,
                    canonical,
                    h1,
                    h2,
                    dataTitle,
                    videoLabel,
                    videoTitle,
                    playerTitle,
                };
                console.log('[FetchV Content] GET_PAGE_TITLES', payload);
                sendResponse(payload);
            } catch (err) {
                console.warn('[FetchV Content] GET_PAGE_TITLES error', err?.message);
                sendResponse({
                    title: '',
                    ogTitle: '',
                    twitterTitle: '',
                    metaTitle: '',
                    metaDesc: '',
                    ogDesc: '',
                    h1: '',
                    h2: '',
                    dataTitle: '',
                    videoLabel: '',
                    videoTitle: '',
                    playerTitle: '',
                });
            }
            return !0;
        }
        if (cmd === 'GET_PAGE_SNAPSHOT') {
            try {
                const fullHtml = document.documentElement?.outerHTML || '';
                const truncated = fullHtml.slice(0, 50000);
                const scripts = Array.from(document.querySelectorAll('script')).map((s) => ({
                    src: s.src || '',
                    inline: !!(s.textContent || '').trim(),
                    snippet: (s.textContent || '').trim().slice(0, 160),
                }));
                const metas = Array.from(document.querySelectorAll('meta')).map((m) => ({
                    name: m.getAttribute('name') || m.getAttribute('property') || '',
                    content: (m.getAttribute('content') || '').slice(0, 200),
                }));
                console.log('[FetchV Content] GET_PAGE_SNAPSHOT', {
                    htmlLength: fullHtml.length,
                    truncatedLength: truncated.length,
                    scripts: scripts.slice(0, 20),
                    metas: metas.slice(0, 20),
                });
                sendResponse({
                    html: truncated,
                    htmlLength: fullHtml.length,
                    scripts: scripts.slice(0, 50),
                    metas: metas.slice(0, 50),
                });
            } catch (err) {
                console.warn('[FetchV Content] GET_PAGE_SNAPSHOT error', err?.message);
                sendResponse({ html: '', htmlLength: 0, scripts: [], metas: [] });
            }
            return !0;
        }
        return !1;
    });
})();
