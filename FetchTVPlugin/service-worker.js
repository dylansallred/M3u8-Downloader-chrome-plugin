importScripts("./js/options.js");
let e = !1,
    t = 1,
    r = !1;
const o = {},
    n = [],
    s = [];
try {
    chrome.action.setBadgeTextColor({ color: "#FFFFFF" }), chrome.action.setBadgeBackgroundColor({ color: "#FF0000" });
} catch (e) {}
const a = async (e) => {
        if ("getContexts" in chrome.runtime) {
            const t = await chrome.runtime.getContexts({
                contextTypes: ["OFFSCREEN_DOCUMENT"],
                documentUrls: [chrome.runtime.getURL(e)],
            });
            return Boolean(t.length);
        }
        {
            const t = await clients.matchAll();
            return await t.some((t) => t.url.endsWith(`/${e}`));
        }
    },
    i = async () => {
        if (!r)
            if ("offscreen" in chrome) {
                const e = "offscreen.html";
                if (((r = await a(e)), r)) return;
                try {
                    await chrome.offscreen.createDocument({
                        url: e,
                        reasons: [chrome.offscreen.Reason.BLOBS],
                        justification: "Convert blob data to blob URL",
                    }),
                        (r = !0);
                } catch (e) {
                    r = !1;
                }
            } else r = !1;
    },
    c = async () => {
        const e = await chrome.storage.local.get(),
            t = await chrome.tabs.query({});
        for (const r of t) {
            const t = `storage${r.id}`,
                n = e[t];
            "object" == typeof n && Object.keys(n).length && ((o[t] = n), delete e[t]);
        }
        e.tasks && delete e.tasks, e.queue && delete e.queue;
        const r = Object.keys(e);
        r.length && chrome.storage.local.remove(r);
    },
    m = () => {
        const e = (e) => {
            e?.size?.min && ((e.size.min = 1024 * e.size.min), e.size.min < 0 && (e.size.min = 0)),
                e?.size?.max && ((e.size.max = 1024 * e.size.max), e.size.max < 0 && (e.size.max = 0));
        };
        return new Promise((t) => {
            try {
                chrome.storage.sync.get(["options"]).then((r) => {
                    if (void 0 !== r.options) {
                        const e = r.options;
                        for (let t in OPTION) void 0 !== e[t] && "lang" !== t && (OPTION[t] = e[t]);
                    }
                    e(OPTION), t();
                });
            } catch (r) {
                e(OPTION), t();
            }
        });
    },
    d = (e, t) => {
        let r = Object.keys(e).length;
        (r = r > 0 ? r.toString() : ""), chrome.action.setBadgeText({ text: r, tabId: t });
    },
    l = (e) => {
        // Stub: declarativeNetRequest removed in MV3 migration
        // Media detection now handled by content script hooks
    },
    u = (e) =>
        new Promise((t) => {
            // Stub: declarativeNetRequest removed in MV3 migration
            t(e || 2);
        }),
    f = () => !!chrome.runtime.lastError && (console.warn(chrome.runtime.lastError.message), !0),
    p = (e, t) => {
        const r = s.findIndex((r) => r.source === e && r.receiver === t);
        r > -1 && s.splice(r, 1);
    },
    h = (e, t, r) => {
        s.some((r) => r.source === e && r.receiver === t) || s.push({ source: e, receiver: t, mode: r });
    },
    g = (e) => {
        const t = s.filter((t) => t.source === e || t.receiver === e);
        if (t.length)
            for (const r of t) {
                const t = r.source === e ? r.receiver : r.source,
                    o = "REC_STOP",
                    n = {};
                t === r.source && (n.mode = r.mode),
                    chrome.tabs.sendMessage(t, { cmd: o, parameter: n }, () => {
                        f();
                    }),
                    p(r.source, r.receiver);
            }
    };
// Stub: declarativeNetRequest cleanup removed in MV3 migration
// Rules no longer used - media detection via content script hooks
(async function () {
    // No-op: declarativeNetRequest not available
})(),
    chrome.runtime.onConnect.addListener(function (r) {
        "POPUP" === r.name &&
            ((e = !0),
            r.onDisconnect.addListener(function () {
                (e = !1);
                // Stub: declarativeNetRequest removed in MV3 migration
            }));
    }),
    chrome.runtime.onMessage.addListener(function (e, t, s) {
        const { cmd: a, parameter: c } = e;
        if ("REC_ON_DATA" === a) {
            const { recorderTab: e, data: r } = c;
            return (
                chrome.tabs.sendMessage(e, { cmd: a, parameter: { data: r } }, () => {
                    f();
                }),
                r.onended && p(t.tab.id, e),
                s(),
                !0
            );
        }
        if ("BG_FETCH" === a) {
            let { url: e, headers: t, method: o } = c;
            return (
                i().then(() => {
                    r
                        ? chrome.runtime.sendMessage(
                              { cmd: "OFFSCREEN_FETCH_DATA", parameter: { url: e, headers: t, method: o } },
                              (e) => {
                                  (!chrome.runtime.lastError && e) ||
                                      (e = { ok: !1, statusText: "Background Fetch Error" }),
                                      s(e);
                              }
                          )
                        : s({ ok: !1, statusText: "Offscreen Error" });
                }),
                !0
            );
        }
        if ("GET_TAB_ID" === a)
            return (
                chrome.tabs.query({}).then((e) => {
                    const r = t.tab.id,
                        o = e.length;
                    s({ currentTabId: r, tabsCount: o });
                }),
                !0
            );
        if ("SET_RULES" === a) {
            // Stub: declarativeNetRequest removed in MV3 migration
            // Rules no longer needed - media detection via content scripts
            s(0);
            return true;
        }
        if ("REMOVE_RULES" === a) {
            // Stub: declarativeNetRequest removed in MV3 migration
            s();
            return true;
        }
        if ("OPEN_INITIATOR" === a) {
            const { initiator: e } = c;
            return chrome.tabs.create({ url: e, index: t.tab.index + 1 }), s(""), !0;
        }
        if ("GET_ICON" === a) return s(t.tab.favIconUrl), !0;
        if ("RESET_OPTIONS" === a) {
            const { storageKey: e } = c;
            return (
                m().then(() => {
                    if (!e) return void s();
                    const t = o[e],
                        r = [];
                    for (const e in t) {
                        const o = t[e],
                            n = new URL(o.url).hostname;
                        n && OPTION.domain.includes(n) && r.push(e);
                    }
                    if (r.length > 0) {
                        for (const e of r) delete t[e];
                        0 === Object.keys(t).length
                            ? (delete o[e],
                              chrome.storage.local.remove([e], () => {
                                  s();
                              }))
                            : chrome.storage.local.set({ [e]: t }, () => {
                                  s();
                              });
                    } else s();
                }),
                !0
            );
        }
        if ("TAB_ACTIVE" === a)
            return (
                chrome.tabs.update(t.tab.id, { active: !0 }, () => {
                    s();
                }),
                !0
            );
        if ("OPEN_DOWNLOADS" === a)
            return chrome.tabs.create({ url: "chrome://downloads/", index: t.tab.index + 1 }), s(), !0;
        if ("REC_START" === a) {
            const { targetTab: e, mode: r, quickStart: o } = c;
            return (
                chrome.tabs.update(e, { active: !0 }),
                chrome.tabs.sendMessage(e, { cmd: a, parameter: { tab: t.tab.id, mode: r, quickStart: o } }, () => {
                    f() || h(e, t.tab.id, r);
                }),
                s(),
                !0
            );
        }
        if ("REC_STOP" === a) {
            const { tabId: e, mode: r } = c;
            return (
                chrome.tabs.sendMessage(e, { cmd: a, parameter: { mode: r } }, () => {
                    f() && "msr" === r && chrome.tabs.sendMessage(t.tab.id, { cmd: a, parameter: {} });
                }),
                p(e, t.tab.id),
                s(),
                !0
            );
        }
        if ("REC_SPEED_UP" === a) {
            const { targetTab: e, speed: t } = c;
            return (
                chrome.tabs.sendMessage(e, { cmd: a, parameter: { speed: t } }, () => {
                    f();
                }),
                s(),
                !0
            );
        }
        if ("REC_RESTART" === a) {
            const { tabId: e } = c;
            return (
                chrome.tabs.sendMessage(e, { cmd: a, parameter: {} }, () => {
                    f() || h(e, t.tab.id, "msr");
                }),
                s(),
                !0
            );
        }
        if ("REC_ERROR" === a) {
            const { tabId: e, fatal: t, message: r } = c;
            return (
                chrome.tabs.sendMessage(e, { cmd: a, parameter: { fatal: t, message: r } }, () => {
                    f();
                }),
                s(),
                !0
            );
        }
        if ("REMOVE_ALL_FRAME_MODAL" === a)
            return chrome.tabs.sendMessage(t.tab.id, { cmd: a, parameter: {} }), s(), !0;
        if ("INJECT_STORAGE_REGISTER" === a) {
            const { documentId: e } = t;
            return e && !n.includes(e) && n.push(e), s(), !0;
        }
        // Handle media detection from content script (replaces webRequest API)
        if ("STORE_DETECTED_MEDIA" === a) {
            const { media: mediaInfo } = e;
            const tabId = t.tab?.id;

            if (!tabId) {
                s({ success: false, error: 'No tab ID' });
                return true;
            }

            if (!mediaInfo || !mediaInfo.url) {
                s({ success: false, error: 'Invalid media info' });
                return true;
            }

            // Apply existing filters (similar to old webRequest logic)
            const storageKey = `storage${tabId}`;
            let tabMedia = o[storageKey];

            if (!tabMedia) {
                tabMedia = {};
                o[storageKey] = tabMedia;
            }

            // Limit to 30 items per tab
            if (Object.keys(tabMedia).length > 30) {
                s({ success: false, error: 'Media limit reached for this tab' });
                return true;
            }

            // Check for duplicates by URL
            const isDuplicate = Object.values(tabMedia).some(item => item.url === mediaInfo.url);
            if (isDuplicate) {
                s({ success: true, duplicate: true });
                d(tabMedia, tabId);
                return true;
            }

            // Create unique ID for this media item
            const mediaId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

            // Determine format and type
            let format = 'mp4';
            let type = 'mp4';

            if (mediaInfo.url.match(/\.m3u8/i)) {
                format = 'm3u8';
                type = 'hls';
            } else if (mediaInfo.contentType && mediaInfo.contentType.includes('mpegurl')) {
                format = 'm3u8';
                type = 'hls';
            }

            // Store media info
            tabMedia[mediaId] = {
                storageKey,
                requestId: mediaId,
                url: mediaInfo.url,
                method: mediaInfo.method || 'GET',
                format,
                contentType: mediaInfo.contentType || 'video/mp4',
                name: mediaInfo.filename || 'media',
                size: mediaInfo.contentLength || 0,
                headers: mediaInfo.requestHeaders || {},
                type,
                detectedAt: mediaInfo.detectedAt || Date.now()
            };

            // Save to chrome.storage.local
            chrome.storage.local.set({ [storageKey]: tabMedia });

            // Notify popup if it's open
            if (e) {
                chrome.runtime.sendMessage(
                    { cmd: 'POPUP_APPEND_ITEMS', parameter: { tab: tabId, item: { [mediaId]: tabMedia[mediaId] } } },
                    () => {
                        if (chrome.runtime.lastError) {
                            console.log('[FetchV] POPUP closed, media stored for later');
                        }
                    }
                );
            }

            // Update badge
            d(tabMedia, tabId);

            s({ success: true });
            return true;
        }
        s();
    }),
    chrome.tabs.onRemoved.addListener(function (e) {
        l(e);
        const t = `storage${e}`;
        chrome.storage.local.remove([t]), o[t] && delete o[t], g(e);
    }),
    chrome.tabs.onUpdated.addListener(function (e, t, r) {
        if ("loading" === t.status && t.url) {
            const t = `storage${e}`;
            o[t] && delete o[t],
                chrome.storage.local.remove([t], () => {
                    d(o[t] || {}, e);
                }),
                g(e);
        }
    });

// Note: webRequest API code removed for Manifest V3 compliance
// Media detection now handled by media-detector.js injected script
// which hooks fetch/XHR at the page level and sends detected media
// to the STORE_DETECTED_MEDIA message handler above.
