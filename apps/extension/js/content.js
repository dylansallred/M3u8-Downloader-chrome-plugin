(function () {
  if (window.__m3u8BridgeInjected) return;
  window.__m3u8BridgeInjected = true;

  const MAX_CANDIDATES = 24;
  const MAX_CANDIDATE_LENGTH = 180;
  const MAX_DOM_NODES = 120;
  const MAX_RESOURCE_SIGNALS = 20;
  const CACHE_TTL_MS = 2500;

  const TITLE_PATTERNS = [
    {
      id: 'sxe',
      regex: /(?:^|[^a-z0-9])s(?:eason)?\s*0*(\d{1,2})\s*[-_. ]*e(?:pisode)?\s*0*(\d{1,3})(?:[^a-z0-9]|$)/i,
    },
    {
      id: 'x-format',
      regex: /(?:^|[^a-z0-9])(\d{1,2})\s*x\s*(\d{1,3})(?:[^a-z0-9]|$)/i,
    },
    {
      id: 'season-episode-words',
      regex: /(?:^|[^a-z0-9])season\s*0*(\d{1,2})\s*[-_. ]*(?:episode|ep)\s*0*(\d{1,3})(?:[^a-z0-9]|$)/i,
    },
  ];

  const SEASON_ONLY_PATTERNS = [
    {
      id: 'season-word',
      regex: /(?:^|[^a-z0-9])season\s*0*(\d{1,2})(?:[^a-z0-9]|$)/i,
    },
    {
      id: 's-word',
      regex: /(?:^|[^a-z0-9])s\s*0*(\d{1,2})(?:[^a-z0-9]|$)/i,
    },
  ];

  const EPISODE_ONLY_PATTERNS = [
    {
      id: 'episode-word',
      regex: /(?:^|[^a-z0-9])episode\s*0*(\d{1,3})(?:[^a-z0-9]|$)/i,
    },
    {
      id: 'ep-word',
      regex: /(?:^|[^a-z0-9])ep\s*0*(\d{1,3})(?:[^a-z0-9]|$)/i,
    },
    {
      id: 'e-word',
      regex: /(?:^|[^a-z0-9])e\s*0*(\d{1,3})(?:[^a-z0-9]|$)/i,
    },
  ];

  let cachedPageContext = null;
  let cachedAt = 0;
  let contextDirty = true;

  function normalizeText(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeTitleText(value) {
    return normalizeText(value)
      .replace(/[._]+/g, ' ')
      .replace(/[-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function trimText(value, max = MAX_CANDIDATE_LENGTH) {
    const text = String(value || '').trim();
    if (text.length <= max) return text;
    return `${text.slice(0, max - 3)}...`;
  }

  function parsePositiveInt(value, min, max) {
    const parsed = Number.parseInt(String(value || '').trim(), 10);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) return null;
    return parsed;
  }

  function inferEpisodeHint(text, source) {
    const normalized = normalizeTitleText(text);
    if (!normalized) return null;

    for (const pattern of TITLE_PATTERNS) {
      const match = normalized.match(pattern.regex);
      if (!match) continue;
      const seasonNumber = parsePositiveInt(match[1], 1, 60);
      const episodeNumber = parsePositiveInt(match[2], 1, 999);
      if (!seasonNumber || !episodeNumber) continue;
      return {
        source,
        matchedPattern: pattern.id,
        matchedText: match[0] ? trimText(match[0], 80) : null,
        seasonNumber,
        episodeNumber,
      };
    }

    let seasonOnly = null;
    for (const pattern of SEASON_ONLY_PATTERNS) {
      const match = normalized.match(pattern.regex);
      if (!match) continue;
      const seasonNumber = parsePositiveInt(match[1], 1, 60);
      if (!seasonNumber) continue;
      seasonOnly = {
        source,
        matchedPattern: pattern.id,
        matchedText: match[0] ? trimText(match[0], 80) : null,
        seasonNumber,
        episodeNumber: null,
      };
      break;
    }

    for (const pattern of EPISODE_ONLY_PATTERNS) {
      const match = normalized.match(pattern.regex);
      if (!match) continue;
      const episodeNumber = parsePositiveInt(match[1], 1, 999);
      if (!episodeNumber) continue;
      return {
        source,
        matchedPattern: seasonOnly ? `${seasonOnly.matchedPattern}+${pattern.id}` : pattern.id,
        matchedText: match[0] ? trimText(match[0], 80) : null,
        seasonNumber: seasonOnly ? seasonOnly.seasonNumber : null,
        episodeNumber,
      };
    }

    return seasonOnly;
  }

  function isLikelyNoise(value) {
    const text = normalizeText(value);
    if (!text || text.length < 2) return true;
    if (text.length > MAX_CANDIDATE_LENGTH * 2) return true;
    if (/^[a-f0-9]{32,}$/i.test(text)) return true;
    if (/^[A-Za-z0-9+/=~_-]{60,}$/.test(text)) return true;
    return false;
  }

  function addCandidate(store, source, value, priority = 100) {
    const text = normalizeText(value);
    if (!text || isLikelyNoise(text)) return;
    const normalized = normalizeTitleText(text).toLowerCase();
    if (!normalized) return;

    const existing = store.get(normalized);
    const entry = {
      source,
      value: trimText(text),
      normalized: trimText(normalizeTitleText(text)),
      priority,
    };

    if (!existing || priority < existing.priority) {
      store.set(normalized, entry);
    }
  }

  function detectTvContextFromUrl(rawUrl) {
    const value = String(rawUrl || '').trim();
    if (!value) return false;
    try {
      const parsed = new URL(value);
      const path = decodeURIComponent(parsed.pathname || '').toLowerCase();
      const query = String(parsed.search || '').toLowerCase();
      if (/(^|\/)(tv|series|show|shows|season|episode)(\/|$)/.test(path)) return true;
      if (/[?&](type|media|mediatype)=tv(?:&|$)/.test(query)) return true;
      if (/[?&](season|episode)=\d+/.test(query)) return true;
      return false;
    } catch {
      return false;
    }
  }

  function extractEpisodeHintFromSourceUrl(rawUrl) {
    const value = String(rawUrl || '').trim();
    if (!value) return null;

    try {
      const parsed = new URL(value);
      const decodedPath = decodeURIComponent(parsed.pathname || '');
      const pathParts = decodedPath.split('/').filter(Boolean);

      let seasonNumber = parsePositiveInt(
        parsed.searchParams.get('season')
          || parsed.searchParams.get('seasonNumber')
          || parsed.searchParams.get('s'),
        1,
        60
      );
      let episodeNumber = parsePositiveInt(
        parsed.searchParams.get('episode')
          || parsed.searchParams.get('episodeNumber')
          || parsed.searchParams.get('ep')
          || parsed.searchParams.get('e'),
        1,
        999
      );

      if (!(seasonNumber && episodeNumber)) {
        const tvRoots = new Set(['tv', 'series', 'show', 'shows']);
        for (let i = 0; i < pathParts.length - 3; i += 1) {
          const root = String(pathParts[i] || '').toLowerCase();
          if (!tvRoots.has(root)) continue;
          const seasonCandidate = parsePositiveInt(pathParts[i + 2], 1, 60);
          const episodeCandidate = parsePositiveInt(pathParts[i + 3], 1, 999);
          if (seasonCandidate && episodeCandidate) {
            seasonNumber = seasonCandidate;
            episodeNumber = episodeCandidate;
            break;
          }
        }
      }

      if (!(seasonNumber && episodeNumber)) {
        const routeWordMatch = decodedPath.match(
          /(?:^|\/)season\/(\d{1,2})(?:\/|$).*?(?:^|\/)episode\/(\d{1,3})(?:\/|$)/i
        );
        if (routeWordMatch) {
          seasonNumber = parsePositiveInt(routeWordMatch[1], 1, 60);
          episodeNumber = parsePositiveInt(routeWordMatch[2], 1, 999);
        }
      }

      if (!(seasonNumber && episodeNumber)) return null;

      return {
        source: 'url-route',
        matchedPattern: 'source-url-route',
        matchedText: value,
        seasonNumber,
        episodeNumber,
      };
    } catch {
      return null;
    }
  }

  function scoreEpisodeSignal(signal) {
    const seasonNumber = parsePositiveInt(signal && signal.seasonNumber, 1, 60);
    const episodeNumber = parsePositiveInt(signal && signal.episodeNumber, 1, 999);
    if (!seasonNumber && !episodeNumber) return -1;

    let score = 0;
    if (seasonNumber) score += 100;
    if (episodeNumber) score += 220;
    if (seasonNumber && episodeNumber) score += 120;

    const pattern = String(signal && signal.matchedPattern || '').toLowerCase();
    if (pattern.includes('query')) score += 20;
    if (pattern.includes('jsonld')) score += 10;

    const url = String(signal && signal.url || '').toLowerCase();
    if (url.includes('/episode/')) score += 20;
    if (url.includes('/season/')) score += 10;

    return score;
  }

  function pickBestEpisodeSignal(signals) {
    let best = null;
    let bestScore = -1;

    for (const signal of Array.isArray(signals) ? signals : []) {
      const score = scoreEpisodeSignal(signal);
      if (score < 0) continue;
      if (!best || score > bestScore) {
        best = signal;
        bestScore = score;
        continue;
      }
      if (score === bestScore) {
        const bestEpisode = parsePositiveInt(best && best.episodeNumber, 1, 999);
        const nextEpisode = parsePositiveInt(signal && signal.episodeNumber, 1, 999);
        if (nextEpisode && !bestEpisode) {
          best = signal;
          bestScore = score;
          continue;
        }
        // When score is tied, prefer the latest signal to avoid stale episode hints in SPA navigation.
        best = signal;
        bestScore = score;
      }
    }

    return best;
  }

  function collectResourceSignals(store) {
    const signals = [];
    const dedupe = new Set();
    const staticAssetExtRe = /\.(?:js|mjs|css|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|map)(?:$|\?)/i;

    let entries = [];
    try {
      entries = performance.getEntriesByType('resource') || [];
    } catch {
      entries = [];
    }

    const recentEntries = entries.slice(-240);
    for (const entry of recentEntries) {
      const rawUrl = String(entry && entry.name || '').trim();
      if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) continue;

      let parsed;
      try {
        parsed = new URL(rawUrl);
      } catch {
        continue;
      }

      const decodedPath = decodeURIComponent(parsed.pathname || '');
      const compactUrl = trimText(rawUrl, 220);
      const lowerPath = decodedPath.toLowerCase();
      const signalText = `${lowerPath} ${String(parsed.search || '').toLowerCase()}`;
      const isStaticAsset = staticAssetExtRe.test(parsed.pathname || '');
      const isSignalPath = /(\/|^)(tv|series|show|season|episode|api)(\/|$)/i.test(lowerPath);
      const isSignalQuery = /(?:^|[?&])(season|episode|tv|series|show|title|name)=/i.test(parsed.search || '');
      const isLikelySignalHost = /(?:^|\.)(videasy\.net|tmdb\.org)$/i.test(parsed.hostname || '');

      if (!(isSignalPath || isSignalQuery || isLikelySignalHost) || isStaticAsset) {
        continue;
      }

      const pathText = `${parsed.hostname || ''} ${decodedPath.replace(/[\/_-]+/g, ' ')}`.trim();
      addCandidate(store, 'resource.url-path', pathText, 14);

      const titleQueryKeys = ['title', 'name', 'show', 'series', 'episode_title', 'episodeName'];
      for (const key of titleQueryKeys) {
        addCandidate(store, `resource.query.${key}`, parsed.searchParams.get(key), 16);
      }

      let seasonNumber = parsePositiveInt(
        parsed.searchParams.get('season')
          || parsed.searchParams.get('seasonNumber')
          || parsed.searchParams.get('s'),
        1,
        60
      );

      let episodeNumber = parsePositiveInt(
        parsed.searchParams.get('episode')
          || parsed.searchParams.get('episodeNumber')
          || parsed.searchParams.get('ep')
          || parsed.searchParams.get('e'),
        1,
        999
      );

      if (!seasonNumber) {
        const seasonPathMatch = lowerPath.match(/(?:^|\/)season\/(\d{1,2})(?:\/|$)/i)
          || lowerPath.match(/(?:^|\/)s(\d{1,2})(?:\/|$)/i)
          || lowerPath.match(/(?:^|[\/_-])season[-_]?(\d{1,2})(?:[\/_-]|$)/i);
        if (seasonPathMatch) {
          seasonNumber = parsePositiveInt(seasonPathMatch[1], 1, 60);
        }
      }

      if (!episodeNumber) {
        const episodePathMatch = lowerPath.match(/(?:^|\/)episode\/(\d{1,3})(?:\/|$)/i)
          || lowerPath.match(/(?:^|\/)ep(?:isode)?[-_]?(\d{1,3})(?:\/|$)/i)
          || lowerPath.match(/(?:^|\/)e(\d{1,3})(?:\/|$)/i);
        if (episodePathMatch) {
          episodeNumber = parsePositiveInt(episodePathMatch[1], 1, 999);
        }
      }

      let matchedPattern = null;
      if (seasonNumber || episodeNumber) {
        matchedPattern = 'resource-query';
      } else {
        const urlHint = inferEpisodeHint(`${decodedPath} ${parsed.search || ''}`, 'resource.url');
        if (urlHint && (urlHint.seasonNumber || urlHint.episodeNumber)) {
          seasonNumber = Number.isFinite(urlHint.seasonNumber) ? urlHint.seasonNumber : null;
          episodeNumber = Number.isFinite(urlHint.episodeNumber) ? urlHint.episodeNumber : null;
          matchedPattern = urlHint.matchedPattern || 'resource-url-pattern';
        }
      }

      if (seasonNumber || episodeNumber) {
        addCandidate(
          store,
          'resource.episode-hint',
          `season ${seasonNumber || ''} episode ${episodeNumber || ''}`,
          9
        );
      }

      const routeHint = /(\/|^)(episode|episodes|season|seasons)(\/|$)/i.test(decodedPath);
      if (!(seasonNumber || episodeNumber || routeHint)) continue;

      const dedupeKey = `${compactUrl}|${seasonNumber || ''}|${episodeNumber || ''}|${matchedPattern || ''}|${routeHint ? 'route' : ''}`;
      if (dedupe.has(dedupeKey)) continue;
      dedupe.add(dedupeKey);

      signals.push({
        url: compactUrl,
        source: 'resource',
        matchedPattern: matchedPattern || (routeHint ? 'resource-route' : null),
        seasonNumber: seasonNumber || null,
        episodeNumber: episodeNumber || null,
      });

      if (signals.length >= MAX_RESOURCE_SIGNALS) break;
    }

    return signals;
  }

  function collectJsonLdCandidates(store) {
    const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]')).slice(0, 8);
    let structuredHint = null;

    function walk(node, depth = 0) {
      if (!node || depth > 6) return;
      if (Array.isArray(node)) {
        node.slice(0, 50).forEach((item) => walk(item, depth + 1));
        return;
      }
      if (typeof node !== 'object') return;

      const typeValue = Array.isArray(node['@type']) ? node['@type'].join(',') : String(node['@type'] || '');
      const lowerType = typeValue.toLowerCase();
      const isEpisodeType = lowerType.includes('tvepisode') || lowerType.includes('episode');
      const seasonRaw = node.seasonNumber || (node.partOfSeason && node.partOfSeason.seasonNumber);
      const episodeRaw = node.episodeNumber;
      const seasonNumber = parsePositiveInt(seasonRaw, 1, 60);
      const episodeNumber = parsePositiveInt(episodeRaw, 1, 999);

      if (!structuredHint && (seasonNumber || episodeNumber || isEpisodeType)) {
        structuredHint = {
          source: 'jsonld',
          matchedPattern: isEpisodeType ? 'jsonld-episode-type' : 'jsonld-episode-numbers',
          matchedText: null,
          seasonNumber,
          episodeNumber,
        };
      }

      const titleFields = ['name', 'headline', 'title', 'alternateName'];
      for (const field of titleFields) {
        if (typeof node[field] === 'string') {
          addCandidate(store, `jsonld.${field}`, node[field], isEpisodeType ? 10 : 20);
        }
      }

      Object.values(node).forEach((value) => {
        if (typeof value === 'object' && value) {
          walk(value, depth + 1);
        }
      });
    }

    for (const script of scripts) {
      const raw = String(script.textContent || '').trim();
      if (!raw || raw.length > 250000) continue;
      try {
        const parsed = JSON.parse(raw);
        walk(parsed);
      } catch {
        // Ignore invalid JSON-LD blocks.
      }
    }

    return structuredHint;
  }

  function collectPageContext() {
    const candidates = new Map();

    addCandidate(candidates, 'document.title', document.title, 5);

    const metaSelectors = [
      'meta[property="og:title"]',
      'meta[name="twitter:title"]',
      'meta[name="title"]',
      'meta[itemprop="name"]',
    ];
    for (const selector of metaSelectors) {
      const node = document.querySelector(selector);
      if (!node) continue;
      addCandidate(candidates, selector, node.getAttribute('content') || '', 8);
    }

    const watchedNodes = Array.from(document.querySelectorAll([
      'h1',
      'h2',
      'h3',
      '[data-title]',
      '[data-name]',
      '[data-season]',
      '[data-episode]',
      '[data-ep]',
      '[data-season-number]',
      '[data-episode-number]',
      '[aria-label*="episode" i]',
      '[data-testid*="title" i]',
      '[data-testid*="episode" i]',
      '[class*="episode" i]',
      '[id*="episode" i]',
      '[class*="title" i]',
      '[id*="title" i]',
    ].join(','))).slice(0, MAX_DOM_NODES);

    for (const node of watchedNodes) {
      addCandidate(candidates, 'dom.text', node.textContent || '', 25);
      addCandidate(candidates, 'dom.aria-label', node.getAttribute && node.getAttribute('aria-label'), 24);
      addCandidate(candidates, 'dom.title-attr', node.getAttribute && node.getAttribute('title'), 24);
      addCandidate(candidates, 'dom.data-title', node.getAttribute && node.getAttribute('data-title'), 24);
      addCandidate(candidates, 'dom.data-name', node.getAttribute && node.getAttribute('data-name'), 24);

      const seasonNumber = parsePositiveInt(
        node.getAttribute && (
          node.getAttribute('data-season')
          || node.getAttribute('data-season-number')
          || node.getAttribute('data-s')
        ),
        1,
        60
      );
      const episodeNumber = parsePositiveInt(
        node.getAttribute && (
          node.getAttribute('data-episode')
          || node.getAttribute('data-episode-number')
          || node.getAttribute('data-ep')
          || node.getAttribute('data-e')
        ),
        1,
        999
      );

      if (seasonNumber || episodeNumber) {
        addCandidate(
          candidates,
          'dom.data-episode-hint',
          `season ${seasonNumber || ''} episode ${episodeNumber || ''}`,
          10
        );
      }
    }

    const videos = Array.from(document.querySelectorAll('video')).slice(0, 3);
    for (const video of videos) {
      const container = video.closest('section,article,main,div');
      if (!container) continue;
      const localNodes = Array.from(container.querySelectorAll('h1,h2,h3,[class*="title" i],[class*="episode" i],[data-title],[aria-label]')).slice(0, 20);
      for (const node of localNodes) {
        addCandidate(candidates, 'player.text', node.textContent || '', 12);
        addCandidate(candidates, 'player.aria-label', node.getAttribute && node.getAttribute('aria-label'), 12);
      }
    }

    const sourcePageUrl = window.location.href || '';
    const sourceUrlEpisodeHint = extractEpisodeHintFromSourceUrl(sourcePageUrl);
    if (sourceUrlEpisodeHint) {
      addCandidate(
        candidates,
        'url.route-episode',
        `season ${sourceUrlEpisodeHint.seasonNumber} episode ${sourceUrlEpisodeHint.episodeNumber}`,
        4
      );
    }

    const structuredHint = collectJsonLdCandidates(candidates);
    const resourceSignals = collectResourceSignals(candidates);

    try {
      const parsed = new URL(window.location.href);
      const decodedPath = decodeURIComponent(parsed.pathname || '');
      addCandidate(candidates, 'url.pathname', decodedPath.replace(/[/_-]+/g, ' '), 35);
    } catch {
      // Ignore invalid URL parsing in unusual contexts.
    }

    const sortedCandidates = Array.from(candidates.values())
      .sort((a, b) => a.priority - b.priority)
      .slice(0, MAX_CANDIDATES)
      .map((entry) => ({
        source: entry.source,
        value: entry.value,
        normalized: entry.normalized,
      }));

    let episodeHint = sourceUrlEpisodeHint || structuredHint;
    if (!episodeHint) {
      const resourceEpisodeHint = pickBestEpisodeSignal(resourceSignals);
      if (resourceEpisodeHint) {
        episodeHint = {
          source: 'resource',
          matchedPattern: resourceEpisodeHint.matchedPattern || 'resource-signal',
          matchedText: resourceEpisodeHint.url || null,
          seasonNumber: resourceEpisodeHint.seasonNumber || null,
          episodeNumber: resourceEpisodeHint.episodeNumber || null,
        };
      }
    }

    if (!episodeHint) {
      for (const entry of sortedCandidates) {
        const hint = inferEpisodeHint(entry.value, entry.source);
        if (hint) {
          episodeHint = hint;
          break;
        }
      }
    }

    const isTvContext = Boolean(
      detectTvContextFromUrl(sourcePageUrl)
      || sourceUrlEpisodeHint
      || episodeHint
      || resourceSignals.length > 0
      || sortedCandidates.some((entry) => /\b(episode|season|series)\b/i.test(String(entry.value || '')))
    );

    return {
      sourcePageTitle: document.title || '',
      sourcePageUrl,
      pageTitleCandidates: sortedCandidates,
      resourceSignals,
      pageEpisodeHint: episodeHint
        ? {
          source: episodeHint.source || null,
          matchedPattern: episodeHint.matchedPattern || null,
          matchedText: episodeHint.matchedText || null,
          seasonNumber: Number.isFinite(episodeHint.seasonNumber) ? episodeHint.seasonNumber : null,
          episodeNumber: Number.isFinite(episodeHint.episodeNumber) ? episodeHint.episodeNumber : null,
        }
        : null,
      pageIsTvContext: isTvContext,
      collectedAt: Date.now(),
    };
  }

  function getPageContextSnapshot() {
    const now = Date.now();
    if (!contextDirty && cachedPageContext && now - cachedAt < CACHE_TTL_MS) {
      return cachedPageContext;
    }
    cachedPageContext = collectPageContext();
    cachedAt = now;
    contextDirty = false;
    return cachedPageContext;
  }

  function markContextDirty() {
    contextDirty = true;
  }

  document.addEventListener('visibilitychange', markContextDirty, { passive: true });
  window.addEventListener('hashchange', markContextDirty, { passive: true });
  window.addEventListener('popstate', markContextDirty, { passive: true });

  try {
    const observer = new MutationObserver(() => {
      markContextDirty();
    });
    const root = document.documentElement || document.body;
    if (root) {
      observer.observe(root, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['content', 'title', 'aria-label', 'data-title', 'data-name'],
      });
    }
  } catch {
    // Ignore observer failures.
  }

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
    const pageContext = getPageContextSnapshot();

    const enrichedMedia = {
      ...media,
      sourcePageTitle: pageContext.sourcePageTitle || document.title || '',
      sourcePageUrl: pageContext.sourcePageUrl || window.location.href || '',
      pageTitleCandidates: Array.isArray(pageContext.pageTitleCandidates)
        ? pageContext.pageTitleCandidates
        : [],
      resourceSignals: Array.isArray(pageContext.resourceSignals)
        ? pageContext.resourceSignals
        : [],
      pageEpisodeHint: pageContext.pageEpisodeHint || null,
      pageIsTvContext: Boolean(pageContext.pageIsTvContext),
      pageContextCollectedAt: pageContext.collectedAt || Date.now(),
    };

    chrome.runtime.sendMessage({
      cmd: 'STORE_DETECTED_MEDIA',
      media: enrichedMedia,
    });
  });
})();
