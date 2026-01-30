class e {
    constructor() {
        (this.storageKey = "fv_recorder_tab"),
            (this.recorderTabId = localStorage.getItem(this.storageKey)),
            (this.channel = null),
            (this.active = !1),
            (this.$recording = null),
            this.init();
    }
    init() {
        if (!this.recorderTabId) return;
        (this.recorderTabId = parseInt(this.recorderTabId)),
            setTimeout(() => {
                localStorage.removeItem(this.storageKey);
            }, 5e3);
        const e = new BroadcastChannel(`channel-${this.recorderTabId}`);
        e.addEventListener("message", (e) => {
            if (e.origin === location.origin) {
                chrome.runtime.sendMessage({
                    cmd: "REC_ON_DATA",
                    parameter: { recorderTab: this.recorderTabId, data: e.data },
                });
                let { $recording: t } = this;
                if (null === t) {
                    try {
                        (t = document.createElement("div")),
                            (t.style.width = "100%"),
                            (t.style.height = "100%"),
                            (t.style.position = "fixed"),
                            (t.style.bottom = 0),
                            (t.style.right = 0),
                            (t.style.zIndex = 99999999),
                            (t.style.pointerEvents = "none");
                        const e = new Image();
                        (e.width = 150),
                            (e.height = 150),
                            (e.src = chrome.runtime.getURL("img/recording.svg")),
                            (e.style.position = "absolute"),
                            (e.style.right = "10px"),
                            (e.style.bottom = "10px"),
                            t.appendChild(e),
                            document.body.appendChild(t);
                    } catch (e) {
                        t = !1;
                    }
                    this.active = !0;
                }
                this.$recording = t;
            }
        }),
            (this.channel = e);
        const t = document.createElement("script");
        (t.src = chrome.runtime.getURL("js/hook.js")),
            document.documentElement.appendChild(t),
            window.addEventListener("beforeunload", this.windowClose);
    }
    seedRecorderTabId(e) {
        localStorage.setItem(this.storageKey, e),
            document.querySelectorAll('video[src^="blob:"]').forEach((e) => {
                e.currentTime = 0;
            });
    }
    windowClose() {
        try {
            self === top && localStorage.removeItem(this.storageKey), this.channel && channel.close();
        } catch (e) {}
    }
    destroy() {
        window.removeEventListener("beforeunload", this.windowClose),
            this.channel && this.channel.close(),
            this.$recording && (this.$recording.remove(), (this.$recording = !1));
    }
    stop(e) {
        this.channel && this.channel.postMessage({ cmd: e }),
            setTimeout(() => {
                this.destroy();
            }, 2e3);
    }
    speedUp(e) {
        this.active &&
            document.querySelectorAll('video[src^="blob:"]').forEach((t) => {
                isNaN(t.duration) || (t.playbackRate = e);
            });
    }
}
class t {
    constructor() {
        (this.video = null),
            (this.stream = null),
            (this.recorderTabId = null),
            (this.endDuration = null),
            (this.mediabunny = null),
            (this.output = null),
            (this.onended = !1),
            (this.onerror = !1),
            (this.started = !1),
            (this.outputChunksCount = 0),
            (this.videoEndListener = () => {
                this.stop();
            });
    }
    getAvailableVideo() {
        const e = document.querySelectorAll("video"),
            t = [];
        for (const o of e) {
            if (o.muted) continue;
            let e = !1;
            if (o.srcObject) e = !0;
            else if (o.src && o.src.startsWith("blob:")) e = !0;
            else {
                const t = o.querySelectorAll("source");
                t.length && (e = Array.from(t).some((e) => e.src?.startsWith("blob:")));
            }
            e && t.push({ video: o, live: !isFinite(o.duration) });
        }
        return t;
    }
    getRecorderMimeType() {
        return MediaRecorder.isTypeSupported("video/webm;codecs=vp8")
            ? "video/webm;codecs=vp8,opus"
            : MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
              ? "video/webm;codecs=vp9,opus"
              : "video/webm";
    }
    createStyle() {
        const e = document.createElement("style");
        (e.id = "fv-recorder-style"),
            (e.textContent =
                "\n    .fv-video-recording {\n        box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);\n        outline: 4px solid red;\n        outline-offset: -4px;\n        animation: fv-color-cycle 2s linear infinite;\n    }\n    @keyframes fv-color-cycle {\n        0% {\n            outline-color: #ff0000; /* Red */\n        }\n        50% {\n            outline-color: #0000ff; /* Blue */\n        }\n        100% {\n            outline-color: #ff0000; /* Back to Red */\n        }\n    }\n    .fv-video-border{\n        outline: #FF0000 4px solid !important;\n        outline-offset: -4px;\n    }\n    .fv-modal {\n            background-color: #ffffff;\n            opacity: 0.95;\n            position: absolute;\n            z-index: 999999999999999;\n            padding: 15px;\n            border-radius: 12px;\n            box-shadow: 0 8px 30px rgba(0, 0, 0, 0.15);\n            backdrop-filter: blur(5px);\n            min-width: 300px;\n        }\n        .fv-option-container {\n            display: flex;\n            justify-content: space-between;\n            align-items: center;\n            width: 100%;\n            margin-bottom: 20px;\n            gap: 10px;\n        }\n        .fv-time-wrapper {\n            display: flex;\n            flex-direction: column;\n            align-items: flex-start;\n            gap: 4px;\n            width: 100%;\n            box-sizing: border-box\n        }\n        .fv-time-label {\n            font-size: 14px;\n            color: #555;\n            white-space: nowrap;\n        }\n        .fv-time-input {\n            padding: 8px 12px;\n            border: 1px solid #ddd;\n            border-radius: 8px;\n            font-size: 14px;\n            color: #333;\n            transition: border-color 0.3s ease, box-shadow 0.3s ease;\n            width: 100%;\n            box-sizing: border-box\n        }\n        .fv-time-input:focus {\n            outline: none;\n            border-color: #007bff;\n            box-shadow: 0 0 0 3px rgba(0, 123, 255, 0.2);\n        }\n        .fv-time-input::-webkit-calendar-picker-indicator {\n            cursor: pointer;\n        }\n        .fv-record-btn {\n            width: 100%;\n            padding: 12px 15px;\n            border: none;\n            background-color: #007bff;\n            color: #fff;\n            font-size: 16px;\n            font-weight: 600;\n            border-radius: 8px;\n            cursor: pointer;\n            transition: background-color 0.3s ease, transform 0.1s ease;\n            box-shadow: 0 4px 10px rgba(0, 123, 255, 0.3);\n        }\n        .fv-record-btn:hover {\n            background-color: #0056b3;\n        }\n        .fv-record-btn:active {\n            transform: translateY(1px);\n        }\n    "),
            document.head.append(e);
    }
    createModal(e, t) {
        const { video: o, live: n } = e;
        if (!o.src && !o.srcObject) return;
        o.classList.add("fv-video-border");
        const r = o.getBoundingClientRect(),
            i = r.top + window.scrollY,
            s = r.left + window.scrollX,
            a = document.createElement("div");
        (a.className = "fv-modal"), (a.style.top = `${10 + i}px`), (a.style.left = `${10 + s}px`);
        let d = null,
            c = null,
            l = !1;
        if (!n) {
            const e = o.duration,
                t = this.formatSeconds(e),
                n = document.createElement("div");
            (n.className = "fv-option-container"), a.appendChild(n);
            const r = document.createElement("div");
            r.className = "fv-time-wrapper";
            const i = document.createElement("label");
            (i.innerText = chrome.i18n.getMessage("modal_record_start")),
                (i.className = "fv-time-label"),
                (d = document.createElement("input")),
                (d.type = "time"),
                (d.step = 2),
                (d.className = "fv-time-input"),
                (d.value = "00:00:00"),
                (d.min = "00:00:00"),
                (d.max = this.formatSeconds(e)),
                r.appendChild(i),
                r.appendChild(d),
                n.appendChild(r);
            const s = document.createElement("div");
            s.className = "fv-time-wrapper";
            const h = document.createElement("label");
            (h.innerText = chrome.i18n.getMessage("modal_record_end")),
                (h.className = "fv-time-label"),
                (c = document.createElement("input")),
                (c.type = "time"),
                (c.step = 2),
                (c.className = "fv-time-input fv-time-end-input"),
                (c.value = t),
                (c.min = "00:00:05"),
                (c.max = t),
                (c.onchange = () => {
                    l = c.value !== t;
                }),
                s.appendChild(h),
                s.appendChild(c),
                n.appendChild(s);
        }
        const h = document.createElement("button");
        (h.className = "fv-record-btn"),
            (h.innerText = chrome.i18n.getMessage("modal_record")),
            a.appendChild(h),
            document.body.appendChild(a),
            (h.onclick = () => {
                h.disabled = !0;
                let e = null,
                    n = null;
                d &&
                    c &&
                    ((e = this.stringToTime(d.value)),
                    l && (n = this.stringToTime(c.value)),
                    n && e >= n && ((e = null), (n = null))),
                    t({ video: o, start: e, end: n });
            });
    }
    removeModal() {
        const e = document.querySelectorAll(".fv-modal"),
            t = document.querySelectorAll(".fv-record-btn"),
            o = document.querySelectorAll(".fv-time-end-input"),
            n = document.querySelectorAll(".fv-video-border");
        t.forEach((e) => {
            e.onclick = null;
        }),
            e.forEach((e) => {
                e.remove();
            }),
            o.forEach((e) => {
                e.onchange = null;
            }),
            n.forEach((e) => {
                e.classList.remove("fv-video-border");
            });
    }
    selectVideo(e, t) {
        return new Promise((o) => {
            if (1 === e.length && e[0].live && t) {
                o({ video: e[0].video, start: null, end: null });
            } else for (const t of e) this.createModal(t, o);
        });
    }
    getVideoBitrate(e, t, o, n = "medium") {
        if (!e || !t || !o) return 0;
        let r = 0.07 * (e * t) * o;
        r *= { low: 0.7, medium: 1, high: 1.5 }[n] || 1;
        let i = Math.max(5e5, Math.min(2e7, r));
        return (i = 1e4 * Math.round(i / 1e4)), i;
    }
    getVideoQuality() {
        const { video: e } = this;
        if (!e) return null;
        const { videoHeight: t, videoWidth: o } = e;
        return t && o ? `${o}x${t}` : null;
    }
    error(e) {
        if (!this.video || this.onerror) return;
        (this.onerror = !0), this.output && this.output.cancel(), this.video.classList.remove("fv-video-recording");
        const t = this.outputChunksCount < 1 || this.video.ended;
        chrome.runtime.sendMessage({
            cmd: "REC_ERROR",
            parameter: { tabId: this.recorderTabId, fatal: t, message: e },
        });
    }
    async createRecorder() {
        const { video: e } = this;
        if (e) {
            try {
                this.stream || (this.stream = e.captureStream());
                const {
                        Output: t,
                        NullTarget: o,
                        Mp4OutputFormat: n,
                        MediaStreamAudioTrackSource: r,
                        MediaStreamVideoTrackSource: i,
                        getFirstEncodableVideoCodec: s,
                        getFirstEncodableAudioCodec: a,
                        QUALITY_MEDIUM: d,
                    } = this.mediabunny,
                    [c] = this.stream.getVideoTracks(),
                    [l] = this.stream.getAudioTracks();
                let h,
                    u,
                    m = 0,
                    p = 0;
                const f = new t({
                    target: new o(),
                    format: new n({
                        fastStart: "fragmented",
                        minimumFragmentDuration: 3,
                        onFtyp: (e) => {
                            h = e;
                        },
                        onMoov: (e) => {
                            const t = new Uint8Array(h.length + e.length);
                            t.set(h, 0), t.set(e, h.length);
                            const o = new Blob([t], { type: "application/octet-stream" }),
                                n = URL.createObjectURL(o),
                                { onended: r, recorderTabId: i } = this,
                                s = this.getVideoQuality();
                            chrome.runtime.sendMessage({
                                cmd: "REC_ON_DATA",
                                parameter: { recorderTab: i, data: { url: n, type: "header", onended: r, quality: s } },
                            });
                        },
                        onMoof: (e, t, o) => {
                            (p = o - m), (m = o), (u = e);
                        },
                        onMdat: (e) => {
                            const t = new Uint8Array(u.length + e.length);
                            t.set(u, 0), t.set(e, u.length);
                            const o = new Blob([t], { type: "application/octet-stream" }),
                                n = URL.createObjectURL(o),
                                { onended: r, recorderTabId: i } = this,
                                s = this.getVideoQuality();
                            if (
                                (chrome.runtime.sendMessage({
                                    cmd: "REC_ON_DATA",
                                    parameter: {
                                        recorderTab: i,
                                        data: {
                                            url: n,
                                            type: "segment",
                                            onended: r,
                                            lastMoofTimestamp: m,
                                            lastMoofDuration: p,
                                            quality: s,
                                        },
                                    },
                                }),
                                this.outputChunksCount++,
                                !this.onended && this.endDuration)
                            ) {
                                const { currentTime: e } = this.video;
                                (Math.abs(e - this.endDuration) <= p || e >= this.endDuration) && this.stop();
                            }
                        },
                    }),
                });
                this.output = f;
                let g = null,
                    v = null;
                if (l) {
                    const e = 128e3,
                        t = await a(["aac", "opus", "mp3", "vorbis"], { bitrate: e });
                    t &&
                        ((g = new r(l, { codec: t, bitrate: e })),
                        g.errorPromise.catch((e) => {
                            this.error(e.message);
                        }));
                }
                if (c) {
                    const { width: e, height: t, frameRate: o } = c.getSettings(),
                        n = this.getVideoBitrate(e, t, o) || d,
                        r = { width: e, height: t };
                    Number.isFinite(n) && (r.bitrate = n);
                    const a = await s(["avc", "vp8", "hevc", "vp9", "av1"], r);
                    a &&
                        ((v = new i(c, { codec: a, bitrate: n })),
                        v.errorPromise.catch((e) => {
                            this.error(e.message);
                        }));
                }
                if (!v) return void this.error("No available video tracks found");
                f.addVideoTrack(v), g && f.addAudioTrack(g), f.start();
            } catch (e) {
                this.error(e.message);
            }
            e.addEventListener("ended", this.videoEndListener);
        }
    }
    destroy() {
        const { video: e } = this;
        if (!e) return;
        e.removeEventListener("ended", this.videoEndListener),
            (this.output = null),
            this.removeModal(),
            e.classList.remove("fv-video-recording");
        const t = document.querySelector("#fv-recorder-style");
        t && t.remove();
    }
    getVideoStatus(e) {
        return e.ended
            ? "ended"
            : e.paused
              ? "paused"
              : e.readyState < HTMLMediaElement.HAVE_FUTURE_DATA
                ? "loading"
                : "playing";
    }
    async start(e, t) {
        this.recorderTabId = e;
        const o = this.getAvailableVideo();
        if (!o.length) return;
        (this.started = !0), this.createStyle();
        const { video: n, start: r, end: i } = await this.selectVideo(o, t);
        if (!this.mediabunny) {
            const { mediabunny: e } = await import("./mediabunny.js");
            this.mediabunny = e;
        }
        if (
            (n.classList.add("fv-video-recording"),
            n.classList.remove("fv-video-border"),
            chrome.runtime.sendMessage({ cmd: "REMOVE_ALL_FRAME_MODAL", parameter: {} }),
            (this.video = n),
            Number.isFinite(r))
        ) {
            const e = () =>
                    new Promise((e) => {
                        const t = () => {
                            n.removeEventListener("playing", t), e();
                        };
                        n.addEventListener("playing", t);
                    }),
                t = this.getVideoStatus(n);
            "loading" === t ? (await e(), n.paused || n.pause()) : "paused" !== t && n.pause(),
                (n.currentTime = r),
                setTimeout(() => {
                    n.play().catch((e) => {});
                }, 1e3),
                await e();
        }
        i && (this.endDuration = i), this.createRecorder();
    }
    reStart() {
        this.output &&
            this.video &&
            ((this.onended = !1),
            (this.onerror = !1),
            (this.outputChunksCount = 0),
            this.createRecorder(),
            this.video.classList.add("fv-video-recording"));
    }
    stop() {
        this.output &&
            this.video &&
            !this.onended &&
            !this.onerror &&
            ((this.onended = !0), this.output.finalize(), this.video.classList.remove("fv-video-recording"));
    }
    formatSeconds(e) {
        e = Math.max(0, Math.floor(e));
        const t = Math.floor(e / 3600),
            o = Math.floor((e % 3600) / 60),
            n = e % 60;
        return `${String(t).padStart(2, "0")}:${String(o).padStart(2, "0")}:${String(n).padStart(2, "0")}`;
    }
    stringToTime(e) {
        const [t, o, n] = e.split(":").map(Number);
        return 3600 * t + 60 * o + n;
    }
}
class o {
    constructor() {
        (this.storageKey = "fv_inject"), (this.config = localStorage.getItem(this.storageKey)), this.init();
    }
    init() {
        if (this.config)
            try {
                (this.config = JSON.parse(this.config)),
                    this.availability() &&
                        chrome.runtime.sendMessage({ cmd: "INJECT_STORAGE_REGISTER", parameter: {} });
            } catch (e) {
                this.config = null;
            }
    }
    availability() {
        try {
            const { blob: e, at: t, hit: o } = this.config;
            if (!e) return !1;
            if (!t) return !0;
            const n = Math.floor(Date.now() / 1e3);
            return o
                ? (n - o > 604800 &&
                      (delete this.config.at,
                      delete this.config.hit,
                      localStorage.setItem(this.storageKey, JSON.stringify(this.config))),
                  !0)
                : n - t < 1800;
        } catch (e) {
            return !1;
        }
    }
    removeConfigStorage() {
        localStorage.removeItem(this.storageKey), (this.config = null);
    }
    seedConfigStorage() {
        const e = { top: top === self, blob: !!document.querySelector('video[src^="blob:"]') },
            t = (() => {
                if (!e.top)
                    try {
                        return window.location.origin === window.parent.location.origin;
                    } catch (e) {
                        return !1;
                    }
                return !1;
            })();
        (!e.top && !e.blob) || t || (localStorage.setItem(this.storageKey, JSON.stringify(e)), (this.config = e));
    }
    detectBlobVideo(e) {
        const t = document.querySelector('video[src^="blob:"]');
        let o = this.config || t,
            n = !1;
        if (!this.config && t && top !== self && e) {
            const e = { top: !1, blob: !0 };
            localStorage.setItem(this.storageKey, JSON.stringify(e)), (this.config = e), (n = !0);
        }
        return this.config && top !== self && !e && this.removeConfigStorage(), { response: o, reload: n };
    }
    checkTextContent(e, t, o, n) {
        return new Promise((r) => {
            if (!this.config?.blob) return void r(!1);
            const i = new AbortController(),
                s = i.signal,
                a = { method: o, signal: s, headers: {} };
            for (const e of t)
                (a.headers[e.name] = e.value), "cookie" === e.name.toLowerCase() && (a.credentials = "include");
            a.headers["X-Original-Request-Id"] = n;
            const d = setTimeout(() => {
                i.abort();
            }, 1e4);
            let c = !1;
            fetch(e, a)
                .then((e) => {
                    if ((clearTimeout(d), !e.ok)) throw new Error(`HTTP error! status: ${e.status}`);
                    return e.text();
                })
                .then((e) => {
                    (c = e.trim().startsWith("#EXTM3U")), r(c);
                })
                .catch((e) => {
                    r(!1);
                })
                .finally(() => {
                    const e = Math.floor(Date.now() / 1e3);
                    (this.config.at = e),
                        c && (this.config.hit = e),
                        localStorage.setItem(this.storageKey, JSON.stringify(this.config));
                });
        });
    }
}
let n = new t();
const r = new e(),
    i = new o();
chrome.runtime.onMessage.addListener(function (e, o, s) {
    const { cmd: a, parameter: d } = e;
    if ("REC_START" === a) {
        const { tab: e, mode: o, quickStart: i } = d;
        return (
            "msr" === o
                ? (n.started && (n.destroy(), (n = new t())), n.start(e, i), self === top && s())
                : (r.seedRecorderTabId(e),
                  self === top &&
                      (s(),
                      setTimeout(() => {
                          window.location.reload();
                      }, 500))),
            !0
        );
    }
    if ("REC_STOP" === a) {
        const { mode: e } = d;
        return "msr" === e ? n.stop() : r.stop(a), s(), !0;
    }
    if ("REMOVE_ALL_FRAME_MODAL" === a) return n.removeModal(), s(), !0;
    if ("REC_RESTART" === a) return n.reStart(), s(), !0;
    if ("REC_SPEED_UP" === a) {
        const { speed: e } = d;
        return r.speedUp(e), s(), !0;
    }
    if ("INJECT_CAPTURE" === a) {
        const { enable: e } = d;
        return e ? i.seedConfigStorage() : i.removeConfigStorage(), top === self && s(e), !0;
    }
    if ("DETECT_BLOB_VIDEO" === a) {
        const { topInject: e } = d,
            { response: t, reload: o } = i.detectBlobVideo(e);
        return (
            t && s(!0),
            o &&
                setTimeout(() => {
                    window.location.reload();
                }, 1500),
            !0
        );
    }
    if ("DETECT_INJECT_STORAGE" === a) return self === top && s(!!i.config), !0;
    if ("CHECK_TEXT_CONTENT" === a) {
        const { url: e, headers: t, method: o, requestId: n } = d;
        return (
            i.checkTextContent(e, t, o, n).then((e) => {
                s(e);
            }),
            !0
        );
    }
    if ("CHECK_VIDEO_SRC" === a) {
        const { url: e } = d;
        let t = !1;
        const o = document.querySelectorAll("video");
        if (o.length > 0) {
            const n = document.URL;
            for (const r of o) {
                let o = r.src;
                if (!o) {
                    const e = r.querySelector("source");
                    e && (o = e.src);
                }
                if (
                    o &&
                    !o.startsWith("blob:") &&
                    (/^(http:\/\/|https:\/\/)/i.test(o) || (o = new URL(o, n).href), o === e)
                ) {
                    t = !0;
                    break;
                }
            }
        }
        return t && s(t), !0;
    }
});
