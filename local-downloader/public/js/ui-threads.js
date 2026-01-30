// Thread pills and tooltip controller for Local HLS Downloader UI
// Encapsulates threadStatusList rendering and tooltip behavior.

export function createThreadController({
  threadStatusList,
}) {
  let threadTooltipEl = null;
  let currentHoveredPill = null;
  let lastMouseEvent = null;
  const previousThreadStates = new Map();

  function ensureThreadTooltip() {
    if (threadTooltipEl) return threadTooltipEl;
    const el = document.createElement('div');
    el.className = 'thread-tooltip';

    const title = document.createElement('div');
    title.className = 'thread-tooltip-title';
    el.appendChild(title);

    const body = document.createElement('div');
    body.className = 'thread-tooltip-body';
    el.appendChild(body);

    document.body.appendChild(el);
    threadTooltipEl = el;
    return el;
  }

  function showThreadTooltip(event, pill, content) {
    const el = ensureThreadTooltip();
    const titleEl = el.querySelector('.thread-tooltip-title');
    const bodyEl = el.querySelector('.thread-tooltip-body');
    if (!titleEl || !bodyEl) return;

    const workerId = pill.getAttribute('data-worker-id') || '';
    titleEl.textContent = workerId ? `Thread ${workerId}` : 'Thread';
    bodyEl.textContent = content;

    if (event) {
      const offset = 12;
      const x = event.clientX + offset;
      const y = event.clientY + offset;
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
    }
    el.classList.add('visible');
  }

  function hideThreadTooltip() {
    if (!threadTooltipEl) return;
    threadTooltipEl.classList.remove('visible');
    currentHoveredPill = null;
    lastMouseEvent = null;
  }

  function updateTooltipForPill(pill) {
    if (currentHoveredPill !== pill) return;
    const pillStatus = pill.getAttribute('data-status') || 'idle';
    const pillSeg = pill.getAttribute('data-seg') || '-';
    const pillAttempt = parseInt(pill.getAttribute('data-attempt') || '1', 10);
    const pillStarted = parseInt(pill.getAttribute('data-started') || '0', 10);
    let elapsed = '';
    if (pillStarted && Date.now() > pillStarted) {
      const sec = Math.floor((Date.now() - pillStarted) / 1000);
      elapsed = ` · ${sec}s`;
    }
    const attStr = pillAttempt > 1 ? ` · attempt ${pillAttempt}` : '';
    const tip = `${pillStatus} · seg ${pillSeg}${attStr}${elapsed}`;
    showThreadTooltip(lastMouseEvent, pill, tip);
  }

  function updateThreads(threadStates) {
    if (!Array.isArray(threadStates) || !threadStatusList) return;

    const active = threadStates.filter(
      (t) => t && (t.status === 'downloading' || t.status === 'retrying')
    );
    const list = active.length > 0 ? active : threadStates.filter(Boolean);
    const now = Date.now();

    const currentPills = new Map();
    Array.from(threadStatusList.children).forEach((pill) => {
      const workerId = pill.getAttribute('data-worker-id');
      if (workerId) {
        currentPills.set(workerId, pill);
      }
    });

    list.forEach((t) => {
      const workerId = String(t.workerId);
      const seg = typeof t.segmentIndex === 'number' ? t.segmentIndex : '-';
      const status = t.status || 'idle';
      const attempt = typeof t.attempt === 'number' ? t.attempt : 1;
      const prevState = previousThreadStates.get(workerId);

      let pill = currentPills.get(workerId);
      const isNewPill = !pill;

      if (isNewPill) {
        pill = document.createElement('span');
        pill.className = 'thread-pill';
        pill.setAttribute('data-worker-id', workerId);
        pill.setAttribute('data-status', status);
        pill.setAttribute('data-attempt', attempt);

        const idSpan = document.createElement('span');
        idSpan.className = 'thread-pill-id';
        idSpan.textContent = `T${t.workerId}`;
        pill.appendChild(idSpan);

        const statusSpan = document.createElement('span');
        statusSpan.className = 'thread-pill-status';
        pill.appendChild(statusSpan);

        const startedAt = typeof t.startedAt === 'number' ? t.startedAt : null;
        let elapsedStr = '';
        if (startedAt && now > startedAt) {
          const seconds = Math.floor((now - startedAt) / 1000);
          elapsedStr = ` · ${seconds}s`;
        }
        const attemptStr = attempt && attempt > 1 ? ` · attempt ${attempt}` : '';
        const tooltip = `${status} · seg ${seg}${attemptStr}${elapsedStr}`;

        pill.addEventListener('mouseenter', (ev) => {
          currentHoveredPill = pill;
          lastMouseEvent = ev;
          const pillStatus = pill.getAttribute('data-status') || 'idle';
          const pillSeg = pill.getAttribute('data-seg') || '-';
          const pillAttempt = parseInt(pill.getAttribute('data-attempt') || '1', 10);
          const pillStarted = parseInt(pill.getAttribute('data-started') || '0', 10);
          let elapsed = '';
          if (pillStarted && Date.now() > pillStarted) {
            const sec = Math.floor((Date.now() - pillStarted) / 1000);
            elapsed = ` · ${sec}s`;
          }
          const attStr = pillAttempt > 1 ? ` · attempt ${pillAttempt}` : '';
          const tip = `${pillStatus} · seg ${pillSeg}${attStr}${elapsed}`;
          showThreadTooltip(ev, pill, tip);
        });
        pill.addEventListener('mousemove', (ev) => {
          lastMouseEvent = ev;
          const pillStatus = pill.getAttribute('data-status') || 'idle';
          const pillSeg = pill.getAttribute('data-seg') || '-';
          const pillAttempt = parseInt(pill.getAttribute('data-attempt') || '1', 10);
          const pillStarted = parseInt(pill.getAttribute('data-started') || '0', 10);
          let elapsed = '';
          if (pillStarted && Date.now() > pillStarted) {
            const sec = Math.floor((Date.now() - pillStarted) / 1000);
            elapsed = ` · ${sec}s`;
          }
          const attStr = pillAttempt > 1 ? ` · attempt ${pillAttempt}` : '';
          const tip = `${pillStatus} · seg ${pillSeg}${attStr}${elapsed}`;
          showThreadTooltip(ev, pill, tip);
        });
        pill.addEventListener('mouseleave', () => {
          hideThreadTooltip();
        });

        threadStatusList.appendChild(pill);
      } else {
        currentPills.delete(workerId);
      }

      const prevStatus = pill.getAttribute('data-status');
      const prevAttempt = parseInt(pill.getAttribute('data-attempt') || '1', 10);
      const prevSeg = pill.getAttribute('data-seg');

      let needsClassUpdate = false;
      let needsSegUpdate = false;

      if (prevStatus !== status || prevAttempt !== attempt) {
        needsClassUpdate = true;
        pill.setAttribute('data-status', status);
        pill.setAttribute('data-attempt', attempt);
      }

      if (String(seg) !== prevSeg) {
        needsSegUpdate = true;
        pill.setAttribute('data-seg', seg);
      }

      if (needsClassUpdate || needsSegUpdate) {
        let classes = 'thread-pill thread-pill--' + status;

        if (attempt > 1) {
          if (attempt >= 2 && attempt <= 4) {
            classes += ' retry-1';
          } else if (attempt >= 5 && attempt <= 7) {
            classes += ' retry-2';
          } else if (attempt >= 8 && attempt <= 10) {
            classes += ' retry-3';
          } else if (attempt >= 11 && attempt <= 14) {
            classes += ' retry-4';
          } else if (attempt >= 15) {
            classes += ' retry-5-plus';
          }
        }

        pill.className = classes;

        const statusSpan = pill.querySelector('.thread-pill-status');
        if (statusSpan) {
          statusSpan.className = `thread-pill-status thread-pill-status-${status}`;
          const segLabel = seg === '-' ? '' : `seg ${seg}`;
          const attemptLabel = attempt > 1 ? ` · x${attempt}` : '';
          statusSpan.textContent = segLabel + attemptLabel;
        }
        updateTooltipForPill(pill);
      }

      const startedAt = typeof t.startedAt === 'number' ? t.startedAt : null;
      if (startedAt) {
        pill.setAttribute('data-started', startedAt);
      }

      previousThreadStates.set(workerId, { segmentIndex: seg, status, attempt });
    });

    currentPills.forEach((pill) => {
      pill.remove();
    });
  }

  return {
    updateThreads,
    hideThreadTooltip,
  };
}
