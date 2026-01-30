void 0 === window.Hls && ((window.Hls = {}), (window.Hls.isSupported = () => !1));
class e {
    constructor() {
        (this.disableDetailUrl = "/blog/not-support-youtube"),
            (this.tab = null),
            (this.options = OPTION),
            (this.langDir = ""),
            (this.langCode = "en"),
            (this.disable = !1),
            (this.bootstrap = null),
            (this.ruleId = 1),
            (this.items = []),
            (this.storageKey = null),
            (this.isMobile = !1),
            this.langRender(),
            (this.$item = this.selector("item").cloneNode(!0)),
            this.selector("item").remove(),
            (this.$loading = this.selector("loading")),
            (this.$empty = this.selector("empty")),
            (this.$disable = this.selector("disable")),
            (this.$container = this.selector("container")),
            (this.$list = this.selector("list")),
            (this.$optionsBtn = this.selector("optionsBtn")),
            (this.$options = this.selector("options")),
            (this.$record = this.selector("record", !0)),
            (this.$recMode = this.selector("recMode", !0)),
            (this.$recModeSwitch = this.selector("recModeSwitch", !0)),
            (this.$inject = this.selector("inject", !0)),
            (this.$injectWrap = this.selector("injectWrap", !0)),
            (this.$noResourceLead = this.selector("noResourceLead")),
            (this.$noResourceBottom = this.selector("noResourceBottom")),
            (this.$home = this.selector("home")),
            (this.$openDownloader = this.selector("openDownloader")),
            (this.$disableDetail = this.selector("disableDetail"));
    }
    itemToggle(e, t) {
        const { max: s, min: i } = this.options.size;
        let o = !0;
        (o = 0 !== i && 0 !== s ? t < i || t > s : (0 !== i || 0 !== s) && (0 === i ? t > s : t < i)),
            o ? e.classList.add("d-none") : e.classList.remove("d-none");
    }
    optionRender() {
        this.$options.classList.add("offcanvas"), this.$options.classList.remove("d-none");
        const e = new this.bootstrap.Offcanvas(this.$options);
        (this.$optionsBtn.onclick = () => {
            e.toggle();
        }),
            document.querySelectorAll(".tooltip-toggle").forEach((e) => {
                new this.bootstrap.Tooltip(e);
            });
        const { $options: t, options: s } = this,
            i = this.selector("sizeMin", !1, t),
            o = this.selector("sizeMax", !1, t),
            n = this.selector("noAddDomainTip", !1, t),
            hMode = this.selector("downloaderMode", !1, t);
        (i.value = s.size.min / 1024), (o.value = s.size.max / 1024), (n.checked = !s.noAddDomainTip), hMode && (hMode.value = s.downloaderMode || "tab");
        for (const e of s.domain) this.createOptionDomain(e);
        (i.onblur = () => {
            let e = i.value || 0;
            e ? (e = parseInt(e)) : (i.value = 0),
                (e *= 1024),
                e != this.options.size.min &&
                    ((this.options.size.min = e),
                    this.saveOptions().then(() => {
                        for (const e of this.items) "hls" !== e.detail.type && this.itemToggle(e.$item, e.detail.size);
                        this.toast(this.lang("popup_option_setup_success"));
                    }));
        }),
            (o.onblur = () => {
                let e = o.value || 0;
                e ? (e = parseInt(e)) : (o.value = 0),
                    (e *= 1024),
                    e != this.options.size.max &&
                        ((this.options.size.max = e),
                        this.saveOptions().then(() => {
                            for (const e of this.items)
                                "hls" !== e.detail.type && this.itemToggle(e.$item, e.detail.size);
                            this.toast(this.lang("popup_option_setup_success"));
                        }));
            }),
            (n.onclick = () => {
                (this.options.noAddDomainTip = !n.checked),
                    this.saveOptions().then(() => this.toast(this.lang("popup_option_setup_success")));
            }),
            hMode && (hMode.onchange = () => {
                const v = hMode.value === "headless" ? "headless" : "tab";
                this.options.downloaderMode = v,
                    this.saveOptions().then(() => this.toast(this.lang("popup_option_setup_success")));
            });
    }
    createOptionDomain(e) {
        const t = this.selector("domain", !1, this.$options),
            s = this.selector("noDomain", !1, this.$options);
        s.classList.contains("d-none") || s.classList.add("d-none");
        const i = document.createElement("div");
        i.className = "d-flex justify-content-between align-items-center mb-1";
        const o = document.createElement("span");
        (o.className = "flex-grow-1 text-truncate me-2 text-decoration-underline"), (o.innerText = e);
        const n = document.createElement("button");
        (n.className = "btn btn-light"),
            (n.innerHTML = '<i class="bi bi-trash3"></i>'),
            i.appendChild(o),
            i.appendChild(n),
            t.appendChild(i),
            (n.onclick = () => {
                n.onclick = null;
                const t = this.options.domain.indexOf(e);
                t > -1 && (this.options.domain.splice(t, 1), this.saveOptions()),
                    i.remove(),
                    0 === this.options.domain.length && s.classList.remove("d-none");
            });
    }
    langRender() {
        document.querySelectorAll(".lang-title").forEach((e) => {
            let t = e.getAttribute("title");
            t
                ? ((t = t.trim()), e.setAttribute("title", this.lang(t)))
                : ((t = e.getAttribute("data-bs-title")),
                  t && ((t = t.trim()), e.setAttribute("data-bs-title", this.lang(t))));
        }),
            document.querySelectorAll(".lang").forEach((e) => {
                let t = e.innerText.trim();
                t && (e.innerHTML = this.lang(t));
            });
    }
    getVideoFromTab() {
        const e = () => {
            const e = document.querySelectorAll("video"),
                t = [];
            for (const s of e) {
                if (s.muted) continue;
                let e = !1;
                if (s.srcObject) e = !0;
                else if (s.src && s.src.startsWith("blob:")) e = !0;
                else {
                    const t = s.querySelectorAll("source");
                    t.length && (e = Array.from(t).some((e) => e.src?.startsWith("blob:")));
                }
                e && t.push({ live: !isFinite(s.duration) });
            }
            return t;
        };
        return new Promise((t) => {
            chrome.scripting
                .executeScript({ target: { tabId: this.tab.id, allFrames: !0 }, func: e })
                .then((e) => {
                    const s = [];
                    for (const t of e) {
                        const { result: e } = t;
                        e.length && s.push(...e);
                    }
                    t(s);
                })
                .catch(() => {
                    t([]);
                });
        });
    }
    async init(e = !1) {
        const { bootstrap: t } = await import("../bootstrap/js/bootstrap.bundle.min.js");
        this.bootstrap = t;
        await this.getOptions();
        this.langDir = await this.getLangDir();
        this.tab = await new Promise((resolve) => {
            chrome.tabs.query({ currentWindow: !0 }).then((tabs) => {
                for (const tab of tabs) {
                    if (tab.active) {
                        resolve(tab);
                        break;
                    }
                }
                chrome.storage.local.get(["tasks"], ({ tasks }) => {
                    if (!tasks) return;
                    const filtered = tasks.filter((task) => tabs.some((t) => t.id === task.tabId && t.url.startsWith(this.options.site)));
                    filtered.length !== tasks.length && chrome.storage.local.set({ tasks: filtered });
                });
            });
        });

        if (!this.tab.url.startsWith(this.options.site)) {
            chrome.tabs.sendMessage(
                this.tab.id,
                { cmd: "DETECT_INJECT_STORAGE", parameter: {} },
                { frameId: 0 },
                async (resp) => {
                    if (chrome.runtime.lastError) return;
                    const ok = await new Promise((t) => {
                        chrome.tabs.sendMessage(
                            this.tab.id,
                            { cmd: "DETECT_BLOB_VIDEO", parameter: { topInject: resp } },
                            (r) => {
                                chrome.runtime.lastError ? t(!1) : t(!0);
                            }
                        );
                    });
                    if (ok) {
                        this.$injectWrap.forEach((el) => el.classList.remove("d-none"));
                        resp === !0 &&
                            this.$inject.forEach((el) => {
                                el.checked = !0;
                            });
                    }
                }
            );
        }

        this.optionRender();
        this.$home.onclick = () => chrome.tabs.create({ url: this.options.site + this.langDir, index: this.tab.index + 1 });
        if (this.$openDownloader) {
            this.$openDownloader.onclick = () => {
                chrome.tabs.create({ url: this.options.site, index: this.tab.index + 1 });
            };
        }
        this.$disableDetail.onclick = () =>
            chrome.tabs.create({ url: this.options.site + this.langDir + this.disableDetailUrl, index: this.tab.index + 1 });

        // Preload page titles/context to improve naming before rendering items
        this.pageInfoReady = this.pageInfoReady || Promise.all([this.fetchPageTitles(), this.fetchPageContext()]);
        this.fetchPageSnapshot();

        this.$record.forEach((el) => {
            el.onclick = () => {
                const { options } = this,
                    tip = this.lang("popup_record_no_media_tips");
                this.tab.url?.startsWith("http")
                    ? this.getVideoFromTab().then((list) => {
                          if (!list.length) return void this.toast(tip, 8e3, !0);
                          const payload = {
                                  targetTab: this.tab.id,
                                  type: "rec",
                                  quickStart: 1 === list.length && list[0].live,
                              },
                              host = new URL(this.tab.url).hostname,
                              recCfg = options.recMode.find((r) => r.host === host);
                          if (recCfg) return (payload.mode = recCfg.mode), void this.createTab(payload, !0);
                          const defaultMode = list.some((x) => x.live) ? "msr" : null;
                          this.modal(defaultMode, !1, async (mode, remember) => {
                              payload.mode = mode;
                              remember && (options.recMode.push({ host, mode }), await this.saveOptions());
                              this.createTab(payload, !0);
                          });
                      })
                    : this.toast(tip, 3e3, !0);
            };
        });

        this.$inject.forEach((el) => {
            el.onclick = () => {
                const enabled = el.checked;
                chrome.tabs.sendMessage(this.tab.id, { cmd: "INJECT_CAPTURE", parameter: { enable: enabled } }, (resp) => {
                    chrome.runtime.lastError ||
                        (!0 === resp &&
                            setTimeout(() => {
                                chrome.tabs.reload(this.tab.id), window.close();
                            }, 2e3));
                });
            };
        });

        if (this.tab.url?.startsWith("http")) {
            const host = new URL(this.tab.url).hostname,
                recModeCfg = this.options.recMode.find((t) => t.host === host);
            if (recModeCfg) {
                this.$recMode.forEach((el) => {
                    el.innerText = ` / ${recModeCfg.mode.toUpperCase()}`;
                });
                this.$recModeSwitch.forEach((btn) => {
                    btn.classList.remove("d-none");
                    btn.onclick = () => {
                        this.modal(recModeCfg.mode, !0, async (mode, save) => {
                            if (save) {
                                if (mode !== recModeCfg.mode) {
                                    recModeCfg.mode = mode;
                                    await this.saveOptions();
                                    this.$recMode.forEach((el) => {
                                        el.innerText = ` / ${mode.toUpperCase()}`;
                                    });
                                }
                            } else {
                                const idx = this.options.recMode.findIndex((t) => t.host === host);
                                idx > -1 && (this.options.recMode.splice(idx, 1), await this.saveOptions());
                                this.$recModeSwitch.forEach((el) => el.classList.add("d-none"));
                                this.$recMode.forEach((el) => {
                                    el.innerText = "";
                                });
                            }
                            const videos = await this.getVideoFromTab();
                            if (!videos.length)
                                return void this.toast(
                                    "检测不到可录制的视频，如果视频存在，请检查视频是否处于静音状态，并解除静音！",
                                    8e3,
                                    !0
                                );
                            const payload = {
                                targetTab: this.tab.id,
                                type: "rec",
                                quickStart: 1 === videos.length && videos[0].live,
                                mode,
                            };
                            this.createTab(payload, !0);
                        });
                    };
                });
            }
        }

        chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
            const { cmd, parameter } = msg;
            if ("POPUP_APPEND_ITEMS" === cmd) {
                if (!parameter.tab || !parameter.item || this.disable) return sendResponse(), !0;
                if (this.tab.id !== parameter.tab) return sendResponse(), !0;
                this.$empty.classList.add("d-none"), this.$container.classList.remove("d-none");
                for (const k in parameter.item) this.itemCreate(parameter.item[k]);
                return sendResponse(), !0;
            }
        });

        const blockedHosts = ["youtube.com", "globo.com"];
        if (0 === this.tab.url.indexOf("http")) {
            const host = new URL(this.tab.url).hostname;
            for (const b of blockedHosts)
                if (host.endsWith(b))
                    return this.$loading.remove(), this.$disable.classList.remove("d-none"), void (this.disable = !0);
        }

        this.storageKey = `storage${this.tab.id}`;
        const stored = await new Promise((resolve) => {
            try {
                chrome.storage.local.get([this.storageKey], (t) => {
                    Object.keys(t).length > 0 ? resolve(t[this.storageKey]) : resolve({});
                });
            } catch (err) {
                resolve({});
            }
        });
        if (0 === Object.keys(stored).length) return this.$loading.remove(), void this.$empty.classList.remove("d-none");
        await this.pageInfoReady;
        this.$loading.remove(), this.$container.classList.remove("d-none");
        for (const k in stored) this.itemCreate(stored[k]);
        try {
            /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|mobile|CriOS/i.test(
                navigator.userAgent || navigator.vendor || window.opera
            ) && (this.isMobile = !0);
        } catch (err) {}
        this.isMobile &&
            e &&
            (this.$noResourceLead.classList.add("d-none"), this.$noResourceBottom.classList.add("d-none"));
    }
    selector(e, t = !1, s = null) {
        return s
            ? t
                ? s.querySelectorAll('[selector="' + e + '"]')
                : s.querySelector('[selector="' + e + '"]')
            : t
              ? document.querySelectorAll('[selector="' + e + '"]')
              : document.querySelector('[selector="' + e + '"]');
    }
    saveOptions(e = !1) {
        const t = JSON.parse(JSON.stringify(this.options));
        return (
            (t.size.min = t.size.min / 1024),
            (t.size.max = t.size.max / 1024),
            new Promise((s) => {
                chrome.storage.sync.set({ options: t }).then(() => {
                    const t = {};
                    e && (t.storageKey = this.storageKey),
                        chrome.runtime.sendMessage({ cmd: "RESET_OPTIONS", parameter: t }, () => {
                            s();
                        });
                });
            })
        );
    }
    getOptions() {
        const e = (e) => {
            e?.size?.min && ((e.size.min = 1024 * e.size.min), e.size.min < 0 && (e.size.min = 0)),
                e?.size?.max && ((e.size.max = 1024 * e.size.max), e.size.max < 0 && (e.size.max = 0));
        };
        return new Promise((t) => {
            try {
                chrome.storage.sync.get(["options"]).then(({ options: s }) => {
                    if (s) for (let e in this.options) void 0 !== s[e] && "lang" !== e && (this.options[e] = s[e]);
                    e(this.options), t();
                });
            } catch (s) {
                e(this.options), t();
            }
        });
    }
    getLangDir() {
        return new Promise(async (e) => {
            let t = await chrome.i18n.getUILanguage();
            if (
                (t && (this.langCode = t),
                (t = t.toLowerCase()),
                (t = t.replace(/_/, "-")),
                t.includes("-") && !t.startsWith("zh-"))
            ) {
                const e = t.split("-")[0];
                e && (t = e);
            }
            (t = this.options.lang.indexOf(t) < 0 ? "" : "/" + t), e(t);
        });
    }
    sizeConvert(e) {
        return (
            e < 1024
                ? (e += "B")
                : (e =
                      e < 1048576
                          ? (e / 1024).toFixed(0) + "K"
                          : e < 1073741824
                            ? (e / 1048576).toFixed(0) + "M"
                            : (e / 1073741824).toFixed(2) + "G"),
            e
        );
    }
    getDisplayName(e) {
        const logs = { url: e?.url, providedName: e?.name };
        const addStep = (label, value) => {
            logs[label] = value;
            return value;
        };
        const isGenericPlaylistName = (val) => {
            if (!val) return !1;
            const lower = val.toLowerCase();
            return (
                ["index.m3u8", "master.m3u8", "playlist.m3u8", "main.m3u8", "video.m3u8"].includes(lower) ||
                /^aW5kZXgubTN1OA==/i.test(val)
            );
        };
        const decodeIfBase64 = (value) => {
            if (!value || value.length < 8) return value;
            const stripped = value.replace(/\s+/g, "");
            if (!/^[0-9a-zA-Z+/_=.-]+$/.test(stripped)) return value;
            try {
                const cleaned = stripped.replace(/\.[^.]+$/, "");
                const decoded = atob(cleaned);
                return decoded || value;
            } catch (err) {
                addStep("base64Error", err?.message);
                return value;
            }
        };
        const parseSeasonEpisode = (text) => {
            if (!text) return "";
            const match = text.match(/(?:S(?:eason)?\s*(\d+))?[^\dA-Za-z]?E(?:p(?:isode)?)?\s*(\d+)/i) ||
                text.match(/(\d+)[xX](\d+)/);
            if (match) {
                const s = match[1] || match[2];
                const eNum = match[match.length - 1];
                if (s && eNum) return `S${s.padStart(2, "0")}E${eNum.padStart(2, "0")}`;
            }
            const alt = text.match(/season\s*(\d+)/i);
            const epOnly = text.match(/episode\s*(\d+)/i);
            if (alt && epOnly) return `S${alt[1].padStart(2, "0")}E${epOnly[1].padStart(2, "0")}`;
            return "";
        };
        const parseSeasonEpisodeFromUrl = (url) => {
            if (!url) return "";
            try {
                const u = new URL(url, location.href);
                const parts = u.pathname.split("/").filter(Boolean);
                // Expect /tv/{id}/{season}/{episode}
                const tvIndex = parts.findIndex((p) => p === "tv");
                if (tvIndex >= 0 && parts.length > tvIndex + 3) {
                    const season = parts[tvIndex + 2];
                    const episode = parts[tvIndex + 3];
                    if (season && episode && !isNaN(season) && !isNaN(episode))
                        return `S${season.toString().padStart(2, "0")}E${episode.toString().padStart(2, "0")}`;
                }
            } catch (e) {}
            return "";
        };
        if (e?.name && !/^https?:\/\//i.test(e.name)) {
            const direct = decodeIfBase64(e.name);
            addStep("directName", direct);
            if (!isGenericPlaylistName(direct)) {
                console.log("[FetchV][popup] getDisplayName", logs);
                return direct;
            }
            addStep("directIgnoredGeneric", direct);
        }
        try {
            const t = new URL(e.url);
            const queryName = t.searchParams.get("filename") || t.searchParams.get("file") || t.searchParams.get("name") || "";
            addStep("queryName", queryName);
            const pathSegments = t.pathname.split("/").filter(Boolean);
            const lastSegment = pathSegments[pathSegments.length - 1] || "";
            addStep("lastSegment", lastSegment);
            let candidate = queryName || lastSegment || "";
            candidate && (candidate = decodeURIComponent(candidate));
            candidate = decodeIfBase64(candidate);
            if (isGenericPlaylistName(candidate)) {
                addStep("genericCandidate", candidate);
                candidate = "";
            }
            if (!candidate && e?.name) candidate = e.name;
            const pageTitle = this?.tab?.title ? this.tab.title.trim() : "";
            const pageMetaTitle = this?.pageTitles?.metaTitle || "";
            const pageTitleTag = this?.pageTitles?.title || "";
            const pageOgTitle = this?.pageTitles?.ogTitle || "";
            const pageTwitterTitle = this?.pageTitles?.twitterTitle || "";
            const pageDesc = this?.pageTitles?.metaDesc || "";
            const pageOgDesc = this?.pageTitles?.ogDesc || "";
            const pageH1 = this?.pageTitles?.h1 || "";
            const pageH2 = this?.pageTitles?.h2 || "";
            const pageDataTitle = this?.pageTitles?.dataTitle || "";
            const pageVideoLabel = this?.pageTitles?.videoLabel || "";
            const pageVideoTitle = this?.pageTitles?.videoTitle || "";
            const pagePlayerTitle = this?.pageTitles?.playerTitle || "";
            // Prefer pageContext metas if available
            const pageOgUrl = this?.pageContext?.metas?.ogUrl || this?.pageTitles?.ogUrl || "";
            const pageTwitterUrl = this?.pageContext?.metas?.twitterUrl || this?.pageTitles?.twitterUrl || "";
            const pageCanonical = this?.pageContext?.metas?.canonical || this?.pageTitles?.canonical || "";
            const nextParams =
                this?.pageContext?.next?.props?.pageProps?.query?.params &&
                Array.isArray(this.pageContext.next.props.pageProps.query.params)
                    ? this.pageContext.next.props.pageProps.query.params
                    : [];
            const seasonFromNext = nextParams[1];
            const episodeFromNext = nextParams[2];
            addStep("pageTitle", pageTitle);
            addStep("pageTitleTag", pageTitleTag);
            addStep("pageMetaTitle", pageMetaTitle);
            addStep("pageOgTitle", pageOgTitle);
            addStep("pageTwitterTitle", pageTwitterTitle);
            addStep("pageDesc", pageDesc);
            addStep("pageOgDesc", pageOgDesc);
            addStep("pageH1", pageH1);
            addStep("pageH2", pageH2);
            addStep("pageDataTitle", pageDataTitle);
            addStep("pageVideoLabel", pageVideoLabel);
            addStep("pageVideoTitle", pageVideoTitle);
            addStep("pagePlayerTitle", pagePlayerTitle);
            addStep("pageOgUrl", pageOgUrl);
            addStep("pageTwitterUrl", pageTwitterUrl);
            addStep("pageCanonical", pageCanonical);
            addStep("seasonFromNext", seasonFromNext);
            addStep("episodeFromNext", episodeFromNext);
            const metaSeasonEp =
                parseSeasonEpisodeFromUrl(pageOgUrl) ||
                parseSeasonEpisodeFromUrl(pageTwitterUrl) ||
                parseSeasonEpisodeFromUrl(pageCanonical) ||
                // Only allow regex parse on URLs that look like TV paths
                (/\/tv\//.test(pageOgUrl) ? parseSeasonEpisode(pageOgUrl) : "") ||
                (/\/tv\//.test(pageTwitterUrl) ? parseSeasonEpisode(pageTwitterUrl) : "") ||
                (/\/tv\//.test(pageCanonical) ? parseSeasonEpisode(pageCanonical) : "");
            const resourceSeasonEp =
                parseSeasonEpisodeFromUrl(e.url) || (/\/tv\//.test(e.url) ? parseSeasonEpisode(e.url) : "");
            const titleSeasonEp =
                parseSeasonEpisode(candidate) ||
                parseSeasonEpisode(pageMetaTitle) ||
                parseSeasonEpisode(pageTitleTag) ||
                parseSeasonEpisode(pageOgTitle) ||
                parseSeasonEpisode(pageTwitterTitle) ||
                parseSeasonEpisode(pageH1) ||
                parseSeasonEpisode(pageH2) ||
                parseSeasonEpisode(pageDataTitle) ||
                parseSeasonEpisode(pageVideoLabel) ||
                parseSeasonEpisode(pageVideoTitle) ||
                parseSeasonEpisode(pagePlayerTitle) ||
                parseSeasonEpisode(pageDesc) ||
                parseSeasonEpisode(pageOgDesc) ||
                parseSeasonEpisode(pageTitle) ||
                parseSeasonEpisodeFromUrl(e.url) ||
                parseSeasonEpisodeFromUrl(pageOgUrl) ||
                parseSeasonEpisodeFromUrl(pageTwitterUrl) ||
                parseSeasonEpisodeFromUrl(pageCanonical);
            const preferredTitle =
                pageMetaTitle ||
                pageTitleTag ||
                pageOgTitle ||
                pageTwitterTitle ||
                pageH1 ||
                pageH2 ||
                pageDataTitle ||
                pageVideoLabel ||
                pageVideoTitle ||
                pagePlayerTitle ||
                pageDesc ||
                pageOgDesc ||
                pageTitle;
            const fallbackTitle =
                candidate ||
                pageMetaTitle ||
                pageTitleTag ||
                pageOgTitle ||
                pageTwitterTitle ||
                pageH1 ||
                pageH2 ||
                pageDataTitle ||
                pageVideoLabel ||
                pageVideoTitle ||
                pagePlayerTitle ||
                pageDesc ||
                pageOgDesc ||
                pageTitle;
            // If we have a preferred page title, use it over URL-derived names to avoid generic playlist names.
            const explicitSeasonEp =
                (seasonFromNext && episodeFromNext
                    ? `S${seasonFromNext.toString().padStart(2, "0")}E${episodeFromNext
                          .toString()
                          .padStart(2, "0")}`
                    : "") || metaSeasonEp || titleSeasonEp || resourceSeasonEp;
            const baseName = preferredTitle || fallbackTitle;
            const withSeason = explicitSeasonEp ? `${baseName} ${explicitSeasonEp}`.trim() : baseName;
            const resolved = withSeason || t.hostname || e.url;
            addStep("titleSeasonEp", titleSeasonEp);
            addStep("metaSeasonEp", metaSeasonEp);
            addStep("resourceSeasonEp", resourceSeasonEp);
            addStep("explicitSeasonEp", explicitSeasonEp);
            addStep("resolved", resolved);
            console.log("[FetchV][popup] getDisplayName", logs);
            return resolved;
        } catch (t) {
            addStep("error", t?.message);
            const fallback = e?.name || e?.url || "";
            addStep("resolved", fallback);
            console.log("[FetchV][popup] getDisplayName error", logs);
            return fallback;
        }
    }
    async fetchPageTitles() {
        this.pageTitles = { title: "", ogTitle: "", metaTitle: "", h1: "", videoLabel: "" };
        try {
            const resp = await new Promise((resolve) => {
                chrome.tabs.sendMessage(this.tab.id, { cmd: "GET_PAGE_TITLES" }, (res) => {
                    if (chrome.runtime.lastError) {
                        resolve(null);
                    } else {
                        resolve(res);
                    }
                });
            });
            if (resp) {
                this.pageTitles = resp;
            } else {
                // Fallback: inject a one-off script to read titles
                const [result] = await chrome.scripting.executeScript({
                    target: { tabId: this.tab.id, allFrames: !1 },
                    func: () => {
                        const safeText = (el) => (el ? (el.textContent || '').trim() : '');
                        const safeAttr = (el, attr) => (el ? (el.getAttribute(attr) || '').trim() : '');
                        return {
                            title: (document.title || '').trim(),
                            ogTitle: (document.querySelector('meta[property="og:title"]')?.content || '').trim(),
                            twitterTitle: (document.querySelector('meta[name="twitter:title"]')?.content || '').trim(),
                            metaTitle: (document.querySelector('meta[name="title"]')?.content || '').trim(),
                            metaDesc: (document.querySelector('meta[name="description"]')?.content || '').trim(),
                            ogDesc: (document.querySelector('meta[property="og:description"]')?.content || '').trim(),
                            h1: safeText(document.querySelector('h1')),
                            h2: safeText(document.querySelector('h2')),
                            dataTitle: safeAttr(document.querySelector('[data-title]'), 'data-title'),
                            videoLabel: safeAttr(document.querySelector('video'), 'aria-label'),
                            videoTitle: safeAttr(document.querySelector('video'), 'title'),
                            playerTitle: safeAttr(document.querySelector('[title]'), 'title'),
                        };
                    },
                });
                this.pageTitles = result?.result || this.pageTitles;
            }
            console.log("[FetchV][popup] fetchPageTitles", this.pageTitles);
        } catch (err) {
            console.log("[FetchV][popup] fetchPageTitles error", err?.message);
        }
    }
    async fetchPageSnapshot() {
        try {
            const resp = await new Promise((resolve) => {
                chrome.tabs.sendMessage(this.tab.id, { cmd: "GET_PAGE_SNAPSHOT" }, (res) => {
                    if (chrome.runtime.lastError) {
                        resolve(null);
                    } else {
                        resolve(res);
                    }
                });
            });
            let snapshot = resp;
            if (!snapshot) {
                // Fallback: inject a one-off script to read HTML/sources
                const [result] = await chrome.scripting.executeScript({
                    target: { tabId: this.tab.id, allFrames: !1 },
                    func: () => {
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
                        return {
                            html: truncated,
                            htmlLength: fullHtml.length,
                            scripts: scripts.slice(0, 50),
                            metas: metas.slice(0, 50),
                        };
                    },
                });
                snapshot = result?.result;
            }
            if (snapshot) {
                console.log("[FetchV][popup] fetchPageSnapshot", {
                    htmlLength: snapshot.htmlLength,
                    snippet: snapshot.html?.slice(0, 8000) || "",
                    scripts: snapshot.scripts,
                    metas: snapshot.metas,
                });
            } else {
                console.log("[FetchV][popup] fetchPageSnapshot", { error: "no response" });
            }
        } catch (err) {
            console.log("[FetchV][popup] fetchPageSnapshot error", err?.message);
        }
    }
    async fetchPageContext() {
        this.pageContext = { next: null, metas: {} };
        try {
            const [result] = await chrome.scripting.executeScript({
                target: { tabId: this.tab.id, allFrames: !1 },
                func: () => {
                    const meta = (name) =>
                        document.querySelector(`meta[property="${name}"]`)?.content ||
                        document.querySelector(`meta[name="${name}"]`)?.content ||
                        "";
                    const link = (rel) => document.querySelector(`link[rel="${rel}"]`)?.href || "";
                    return {
                        next: window.__NEXT_DATA__ || null,
                        metas: {
                            ogUrl: meta("og:url"),
                            twitterUrl: meta("twitter:url"),
                            canonical: link("canonical"),
                        },
                    };
                },
            });
            if (result?.result) {
                this.pageContext = result.result;
                // Merge meta URLs into pageTitles for downstream use
                this.pageTitles = this.pageTitles || {};
                if (this.pageContext.metas) {
                    const { ogUrl, twitterUrl, canonical } = this.pageContext.metas;
                    if (ogUrl) this.pageTitles.ogUrl = ogUrl;
                    if (twitterUrl) this.pageTitles.twitterUrl = twitterUrl;
                    if (canonical) this.pageTitles.canonical = canonical;
                }
            }
            console.log("[FetchV][popup] fetchPageContext", this.pageContext);
        } catch (err) {
            console.log("[FetchV][popup] fetchPageContext error", err?.message);
        }
    }
    creatRules(e) {
        const t = [];
        e || (e = {});
        let s = !1;
        for (const i in e) {
            const o = i.toLowerCase();
            ("origin" !== o && "referer" !== o) || (s = !0), t.push({ header: i, operation: "set", value: e[i] });
        }
        return s ? t : null;
    }
    setRules(e, t) {
        const { ruleId: s } = this;
        return new Promise((i) => {
            try {
                const o = { domainType: "thirdParty", resourceTypes: ["xmlhttprequest", "media"], tabIds: [-1] };
                if (("string" == typeof t && (o.urlFilter = t), Array.isArray(t)))
                    if (this.isRequestDomainsSupport()) o.requestDomains = t;
                    else {
                        const e = t.map((e) => `(?:.*\\.)?${e.replace(/\./g, "\\.")}`);
                        o.regexFilter = `https?://(?:www\\.)?(${e.join("|")})(?::\\d+)?(?:/[^s]*)?`;
                    }
                chrome.declarativeNetRequest.updateSessionRules(
                    {
                        removeRuleIds: [s],
                        addRules: [
                            { id: s, priority: 1, action: { type: "modifyHeaders", requestHeaders: e }, condition: o },
                        ],
                    },
                    function () {
                        i(s);
                    }
                );
            } catch (e) {
                i(0);
            }
        });
    }
    removeRules() {
        chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [this.ruleId] });
    }
    getTopLevelDomain(e) {
        const t = new URL(e).hostname;
        if (/^(\d{1,3}\.){3}\d{1,3}$/.test(t)) return t;
        const s = t.split("."),
            i = s.length;
        return i >= 3 && ["co", "com", "org", "net", "gov", "edu"].includes(s[i - 2])
            ? s.slice(-3).join(".")
            : s.slice(-2).join(".");
    }
    isRequestDomainsSupport() {
        try {
            const e = navigator.userAgent.match(/Chrome\/(\d+)/);
            if (e && e[1]) {
                return parseInt(e[1], 10) >= 101;
            }
            return !1;
        } catch (e) {
            return !1;
        }
    }
    player(e, t, s) {
        const i = document.createElement("video");
        (i.autoplay = !0), (i.controls = !0), (i.style.maxWidth = "100%"), t.appendChild(i);
        const o = this.creatRules(e.headers);
        if ("hls" === e.type) {
            if (Hls.isSupported()) {
                const t = [],
                    n = new Hls({ autoStartLoad: !1 });
                return (
                    n.on(Hls.Events.LEVEL_LOADED, async (e, s) => {
                        if (o) {
                            let e = !1;
                            for (const i of s.details.fragments) {
                                const s = this.getTopLevelDomain(i.url);
                                t.includes(s) || ((e = !0), t.push(s));
                            }
                            e && (await this.setRules(o, t));
                        }
                        n.allAudioTracks.length || n.attachMedia(i);
                    }),
                    n.on(Hls.Events.AUDIO_TRACK_LOADED, async (e, s) => {
                        if (o) {
                            let e = !1;
                            for (const i of s.details.fragments) {
                                const s = this.getTopLevelDomain(i.url);
                                t.includes(s) || ((e = !0), t.push(s));
                            }
                            e && (await this.setRules(o, t));
                        }
                        n.media || n.attachMedia(i);
                    }),
                    n.on(Hls.Events.DESTROYING, () => {
                        o && this.removeRules();
                    }),
                    n.on(Hls.Events.MANIFEST_PARSED, async (e, a) => {
                        if (o) {
                            let e = !1;
                            for (const s of a.levels) {
                                const i = this.getTopLevelDomain(s.uri);
                                t.includes(i) || ((e = !0), t.push(i));
                            }
                            if (a.audioTracks.length && a.audio)
                                for (const s of a.audioTracks) {
                                    const i = this.getTopLevelDomain(s.url);
                                    t.includes(i) || ((e = !0), t.push(i));
                                }
                            e && (await this.setRules(o, t));
                        }
                        n.startLoad();
                        let r = 0,
                            l = 0,
                            c = 0;
                        for (const e of n.levels) {
                            const { bitrate: t, width: s, height: i } = e;
                            t && s && i && t > c && ((c = t), (r = s), (l = i));
                        }
                        r && l
                            ? (s.innerText = `${r} x ${l}`)
                            : i.addEventListener("loadedmetadata", () => {
                                  const e = i.videoWidth,
                                      t = i.videoHeight;
                                  s.innerText = `${e} x ${t}`;
                              });
                    }),
                    o
                        ? (t.push(this.getTopLevelDomain(e.url)),
                          this.setRules(o, t).then(() => {
                              n.loadSource(e.url);
                          }))
                        : n.loadSource(e.url),
                    n
                );
            }
        } else
            i.addEventListener("loadedmetadata", () => {
                const t = i.videoWidth,
                    o = i.videoHeight;
                if (t && o) {
                    const i = `${t} x ${o}`;
                    (e.quality = i), (s.innerText = i);
                }
            }),
                o
                    ? this.setRules(o, e.url).then(() => {
                          i.src = e.url;
                      })
                    : (i.src = e.url);
        return null;
    }
    createTab(e, t = !1, s = null) {
        (e.initiator = this.tab.url),
            (e.title = this.tab.title.trim() || this.tab.url),
            chrome.storage.local.set({ queue: e }, () => {
                const { options: e, langDir: i } = this;
                let o = "bufferrecorder";
                if (!t) {
                    if (!s) return;
                    o = "hls" === s ? "m3u8downloader" : "videodownloader";
                }
                if ("zh-CN" !== this.langCode || this.isMobile)
                    chrome.tabs.create({ url: `${e.site}${i}/${o}`, index: this.tab.index + 1 }, (e) => {
                        window.close();
                    });
                else {
                    o = `${i}/${o}`;
                    const t = `${e.site}/router.html?path=${encodeURIComponent(o)}`;
                    chrome.tabs.create({ url: t, index: this.tab.index + 1 }, (e) => {
                        window.close();
                    });
                }
            });
    }
    async itemCreate(e) {
        // Ensure page titles/context are loaded before naming
        if (this.pageInfoReady) {
            try {
                await this.pageInfoReady;
            } catch (err) {
                console.log("[FetchV][popup] itemCreate pageInfoReady error", err?.message);
            }
        }
        let t = null;
        const s = this.$item.cloneNode(!0),
            i = { requestId: e.requestId, detail: e, $item: s },
            o = this.selector("play", !1, s),
            n = this.selector("info", !1, s),
            a = this.selector("name-wrap", !1, s),
            r = this.selector("name-width", !1, s),
            l = this.selector("name", !1, s),
            c = this.selector("name-ellipsis", !1, s),
            d = this.selector("size", !1, s),
            h = this.selector("chevron-down", !1, s),
            m = this.selector("download", !1, s),
            p = this.selector("blocked", !1, s),
            u = this.selector("url-collapse", !1, s),
            b = this.selector("url", !1, s),
            g = this.selector("url-close", !1, s),
            f = this.selector("copy", !1, s),
            v = this.selector("player-collapse", !1, s),
            y = this.selector("resolution", !1, s),
            w = this.selector("player", !1, s),
            T = this.selector("player-close", !1, s);
        const k = this.getDisplayName(e);
        e.name = k;
        console.log("[FetchV][popup] itemCreate display name", { requestId: e.requestId, name: k, url: e.url });
        n.setAttribute("title", k),
            (l.innerText = k),
            (d.innerText =
                "hls" === e.type ? e.type.toUpperCase() : `${e.type.toUpperCase()}/${this.sizeConvert(e.size)}`),
            (b.innerText = e.url),
            this.$list.appendChild(s),
            r.offsetWidth < a.offsetWidth &&
                (r.classList.remove("h-100", "position-absolute", "top-0", "end-0"), c.remove());
        const x = new this.bootstrap.Collapse(u, { toggle: !1 }),
            _ = new this.bootstrap.Collapse(v, { toggle: !1 });
        u.addEventListener("hide.bs.collapse", (e) => {
            h.classList.remove("transform-up");
        }),
            u.addEventListener("show.bs.collapse", (e) => {
                h.classList.add("transform-up"), _.hide();
            }),
            v.addEventListener("hide.bs.collapse", (e) => {
                t && t.destroy(), w.firstElementChild.remove();
            }),
            v.addEventListener("show.bs.collapse", (e) => {
                x.hide();
            }),
            (n.onclick = () => {
                for (const e of this.items) e.requestId !== i.requestId && e.urlCollapse.hide();
                x.toggle();
            }),
            (g.onclick = () => x.hide()),
            (T.onclick = () => _.hide()),
            (o.onclick = () => {
                for (const e of this.items) e.requestId !== i.requestId && e.playerCollapse.hide();
                v.classList.contains("show") || ((t = this.player(e, w, y)), _.show());
            }),
            (m.onclick = () => {
                if (e.contentType.startsWith("audio"))
                    return void chrome.tabs.create({ url: e.url, index: this.tab.index + 1 });
                if (this.options.downloaderMode === "headless") {
                    const payload = {
                        queue: {
                            url: e.url,
                            title: k || this.tab.title.trim() || this.tab.url,
                            name: k,
                            headers: e.headers || {},
                        },
                        threads: (() => {
                            const raw = this.options && typeof this.options.threads !== "undefined" ? Number(this.options.threads) : NaN;
                            if (Number.isFinite(raw) && raw > 0) {
                                return Math.min(16, raw);
                            }
                            return 16;
                        })(),
                    };
                    try {
                        fetch(`${this.options.site}/api/jobs`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify(payload),
                        })
                            .then((res) => {
                                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                                return res.json().catch(() => ({}));
                            })
                            .then((data) => {
                                let msg = "Download queued";
                                if (data && (data.id || typeof data.queuePosition !== "undefined")) {
                                    const parts = [];
                                    data.id && parts.push(`Job: ${data.id}`);
                                    typeof data.queuePosition !== "undefined" &&
                                        parts.push(`Position: ${data.queuePosition}`);
                                    msg = `${msg} (${parts.join(", ")})`;
                                }
                                this.toast(msg);
                            })
                            .catch(() => {
                                this.toast(
                                    `Local downloader not reachable at ${this.options.site}`,
                                    4e3,
                                    !0
                                );
                            });
                    } catch (err) {
                        this.toast(
                            `Local downloader not reachable at ${this.options.site}`,
                            4e3,
                            !0
                        );
                    }
                } else
                    chrome.storage.local.get(["tasks"], ({ tasks: t }) => {
                        t
                            ? chrome.tabs.query({ currentWindow: !0 }).then((s) => {
                                  const i = t.find(
                                      (t) =>
                                          s.some((e) => e.id === t.tabId && e.url.startsWith(this.options.site)) &&
                                          t.url === e.url
                                  );
                                  if (i) {
                                      // Set queue data before focusing existing tab
                                      const queueData = Object.assign({}, e, {
                                          initiator: this.tab.url,
                                          title: this.tab.title.trim() || this.tab.url
                                      });
                                      chrome.storage.local.set({ queue: queueData }, () => {
                                          chrome.tabs.update(i.tabId, { active: !0 });
                                      });
                                  } else {
                                      this.createTab(e, !1, e.type);
                                  }
                              })
                            : this.createTab(e, !1, e.type);
                    });
            }),
            (p.onclick = () => {
                const { options: t } = this,
                    { hostname: i } = new URL(e.url),
                    o = () => {
                        if (t.domain.indexOf(i) < 0) {
                            if (t.domain.length > 30)
                                return void this.toast(this.lang("popup_item_block_error"), 4e3, !0);
                            t.domain.push(i),
                                this.saveOptions(!0).then(() => {
                                    for (this.createOptionDomain(i); ; ) {
                                        let e = !0,
                                            t = 0;
                                        for (const s of this.items) {
                                            if (new URL(s.detail.url).hostname === i) {
                                                s.$item.remove(), this.items.splice(t, 1), (e = !1);
                                                break;
                                            }
                                            t++;
                                        }
                                        if (e) break;
                                    }
                                    this.updateBadge(), this.toast(this.lang("popup_item_block_success"));
                                });
                        } else s.remove();
                    };
                t.noAddDomainTip
                    ? o()
                    : this.modal(
                          {
                              title: `${this.lang("popup_item_block_modal_title")}: <span class="text-danger text-decoration-underline">${i}</span>`,
                              btnConfirm: this.lang("popup_item_block_modal_btn_confirm"),
                              content: this.lang("popup_item_block_modal_content"),
                          },
                          (e) => {
                              (t.noAddDomainTip = e), o();
                          }
                      );
            }),
            (f.onclick = () => {
                try {
                    navigator.clipboard
                        .writeText(e.url)
                        .then(() => {
                            this.toast(this.lang("popup_item_copy_success"));
                        })
                        .catch((e) => {
                            this.toast(this.lang("popup_item_copy_error"), 4e3, !0);
                        });
                } catch (e) {
                    this.toast(this.lang("popup_item_copy_error"), 4e3, !0);
                }
            }),
            (i.urlCollapse = x),
            (i.playerCollapse = _),
            this.items.push(i),
            "hls" !== e.type && this.itemToggle(s, e.size);
    }
    updateBadge() {
        let e = this.items.length;
        0 === e && (this.$container.classList.add("d-none"), this.$empty.classList.remove("d-none")),
            (e = e > 0 ? e.toString() : ""),
            chrome.action.setBadgeText({ text: e, tabId: this.tab.id });
        try {
            chrome.action.setBadgeTextColor({ color: "#FFFFFF" }),
                chrome.action.setBadgeBackgroundColor({ color: "#FF0000" });
        } catch (e) {}
    }
    toast(e, t = 3e3, s = !1) {
        const i = document.createElement("div");
        (i.style.zIndex = 99999),
            (i.className = "w-100 h-100 fixed-top d-flex justify-content-center align-items-start pt-5 pe-none");
        const o = document.createElement("div");
        o.className = "toast align-items-center border-0 text-white pe-auto";
        const n = document.createElement("div");
        n.className = "d-flex";
        const a = document.createElement("div");
        (a.className = "toast-body"), (a.innerText = e);
        const r = document.createElement("button");
        if (((r.className = "btn-close btn-close-white me-2 m-auto"), s)) {
            const e = document.createElement("span");
            (e.className = "text-danger-emphasis"), n.appendChild(e), o.classList.add("bg-danger");
        } else o.classList.add("bg-success");
        i.appendChild(o), o.appendChild(n), n.appendChild(a), n.appendChild(r), document.body.appendChild(i);
        const l = new this.bootstrap.Toast(o);
        l.show(),
            o.addEventListener("hidden.bs.toast", () => {
                (r.onclick = null), l.dispose(), i.remove();
            }),
            (r.onclick = () => l.hide()),
            setTimeout(() => {
                l.hide();
            }, t);
    }
    modal(e = null, t = !1, s = (e = null, t = !1) => {}) {
        const i = [],
            o = document.createElement("div");
        (o.className = "modal fade"),
            o.setAttribute("tabindex", "-1"),
            o.setAttribute("data-bs-delay", '{"show":150,"hide":150}');
        const n = document.createElement("div");
        (n.className = "modal-dialog"), o.appendChild(n);
        const a = document.createElement("div");
        (a.className = "modal-content"), n.appendChild(a);
        const r = document.createElement("div");
        (r.className = "modal-header py-3"),
            (r.innerHTML = `<h3 class="modal-title fs-6">${this.lang("popup_record_mode")}</h3><button type="button" class="btn-close" data-bs-dismiss="modal"></button>`),
            a.appendChild(r);
        const l = document.createElement("div");
        l.className = "modal-body";
        const c = document.createElement("div");
        (c.className = "d-flex justify-content-center align-items-center mb-3"), l.appendChild(c);
        const d = document.createElement("div");
        (d.className = "d-none text-center text-danger py-1"),
            (d.innerText = this.lang("popup_record_mode_error_tips")),
            l.appendChild(d);
        const h = [
            {
                labelText: this.lang("popup_record_mode_msr"),
                tooltip: this.lang("popup_record_mode_msr_tooltip"),
                value: "msr",
            },
            {
                labelText: this.lang("popup_record_mode_mse"),
                tooltip: this.lang("popup_record_mode_mse_tooltip"),
                value: "mse",
            },
        ];
        for (const t of h) {
            const s = document.createElement("label");
            s.className = "d-flex align-items-center mx-1";
            const o = document.createElement("input");
            (o.className = "form-check-input mt-0 me-1 fs-4"),
                (o.type = "radio"),
                (o.name = "recMode"),
                (o.value = t.value),
                e === t.value && (o.checked = !0);
            const n = document.createElement("span");
            n.innerText = t.labelText;
            const a = document.createElement("span");
            (a.className = "px-1"),
                (a.dataset.bsToggle = "tooltip"),
                (a.dataset.bsTitle = t.tooltip),
                (a.innerHTML = '<i class="bi bi-question-circle"></i>'),
                s.appendChild(o),
                s.appendChild(n),
                s.appendChild(a),
                c.appendChild(s),
                i.push(new this.bootstrap.Tooltip(a)),
                (o.onclick = () => {
                    d.classList.add("d-none");
                }),
                (t.input = o);
        }
        a.appendChild(l);
        const m = document.createElement("div");
        (m.className = "modal-footer d-flex justify-content-between align-items-center"), a.appendChild(m);
        const p = document.createElement("label");
        p.className = "form-switch ps-0 d-flex justify-content-start align-items-center pointer";
        const u = document.createElement("input");
        (u.className = "form-check-input mt-0 ms-0 me-1 fs-4"),
            (u.name = "recDefault"),
            u.setAttribute("type", "checkbox"),
            t && (u.checked = !0);
        const b = document.createElement("span");
        b.innerText = this.lang("popup_record_mode_default");
        const g = document.createElement("span");
        (g.className = "px-1"),
            (g.dataset.bsToggle = "tooltip"),
            (g.dataset.bsTitle = this.lang("popup_record_mode_default_tooltip")),
            (g.innerHTML = '<i class="bi bi-question-circle"></i>'),
            i.push(new this.bootstrap.Tooltip(g)),
            p.appendChild(u),
            p.appendChild(b),
            p.appendChild(g),
            m.appendChild(p);
        const f = document.createElement("button");
        (f.className = "btn btn-primary"),
            (f.innerText = this.lang("popup_record_start")),
            m.appendChild(f),
            document.body.appendChild(o);
        const v = new this.bootstrap.Modal(o);
        v.show(),
            o.addEventListener("hidden.bs.modal", (e) => {
                for (const e of i) e.dispose();
                for (const e of h) e.input.onclick = null;
                (f.onclick = null), v.dispose(), o.remove();
            }),
            (f.onclick = () => {
                const e = h.find((e) => e.input.checked);
                if (!e) return void d.classList.remove("d-none");
                const t = e.input.value,
                    i = u.checked;
                s(t, i), v.hide();
            });
    }
    lang(e) {
        return chrome.i18n.getMessage(e);
    }
}
const t = (() => {
        const e = document.getElementById("main");
        if (e.offsetWidth > document.body.offsetWidth + 10) {
            e.style.width = "100%";
            const t = document.createElement("style");
            return document.head.appendChild(t), t.sheet.insertRule(".btn-download {min-width: 0 !important;}"), !0;
        }
        return !1;
    })(),
    s = new e();
s.init(t), chrome.runtime.connect({ name: "POPUP" });
