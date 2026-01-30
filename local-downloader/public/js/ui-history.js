// History panel module for Local HLS Downloader UI
// Responsible for loading, rendering, and managing the history list and player.

export function createHistoryController({
  historyList,
  historyEmpty,
  historyPanel,
  historyToggleBtn,
  historyClearAll,
  historyPlayer,
  historyVideo,
  historyPlayerClose,
  statusMessage,
  formatBytes,
  formatHistoryDate,
}) {
  let isLoadingHistory = false;

  function hideHistoryView() {
    if (!historyPanel) return;
    historyPanel.classList.add('hidden');
    if (historyToggleBtn) {
      historyToggleBtn.classList.remove('selected');
    }
  }

  async function loadHistoryOnce() {
    if (!historyList || !historyEmpty || isLoadingHistory) return;
    isLoadingHistory = true;
    try {
      const res = await fetch('/api/history');
      if (!res.ok) {
        throw new Error(`History request failed with status ${res.status}`);
      }
      const data = await res.json();
      const items = (data && Array.isArray(data.items)) ? data.items : [];

      historyList.innerHTML = '';

      if (!items.length) {
        historyEmpty.classList.remove('hidden');
        return;
      }

      historyEmpty.classList.add('hidden');

      items.forEach((item) => {
        const li = document.createElement('li');
        li.className = 'history-item';

        const main = document.createElement('div');
        main.className = 'history-main';

        const title = document.createElement('div');
        title.className = 'history-title';
        title.textContent = item.fileName || item.label || 'Download';
        if (item.fileName) {
          title.title = item.fileName;
        }

        const meta = document.createElement('div');
        meta.className = 'history-meta';
        const sizeStr = formatBytes(item.sizeBytes || 0);
        const dateStr = formatHistoryDate(item.modifiedAt);
        meta.textContent = [sizeStr, dateStr].filter(Boolean).join(' \u00b7 ');

        main.appendChild(title);
        main.appendChild(meta);

        const actions = document.createElement('div');
        actions.className = 'history-actions';

        const playBtn = document.createElement('button');
        playBtn.type = 'button';
        playBtn.className = 'history-btn icon';
        playBtn.title = 'Play';
        playBtn.textContent = '▶';
        playBtn.addEventListener('click', () => {
          const streamUrl = `/api/history/stream/${encodeURIComponent(item.fileName)}`;
          if (!historyPlayer || !historyVideo) return;

          Array.from(historyList.children).forEach((child) => {
            child.classList.remove('history-item--active');
          });
          li.classList.add('history-item--active');

          historyVideo.src = streamUrl;
          historyPlayer.classList.remove('hidden');
          // Move player directly under the clicked history item
          try {
            li.insertAdjacentElement('afterend', historyPlayer);
          } catch (_) {
            // Fallback to keeping it after the list
            historyList.insertAdjacentElement('afterend', historyPlayer);
          }
          try {
            historyVideo.play();
          } catch (_) {
            // ignore autoplay errors
          }

          historyPlayer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });

        const redownloadBtn = document.createElement('button');
        redownloadBtn.type = 'button';
        redownloadBtn.className = 'history-btn icon';
        redownloadBtn.title = 'Download';
        redownloadBtn.textContent = '⬇';
        redownloadBtn.addEventListener('click', () => {
          const link = document.createElement('a');
          link.href = `/api/history/file/${encodeURIComponent(item.fileName)}`;
          document.body.appendChild(link);
          link.click();
          link.remove();
        });

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'history-btn danger icon';
        deleteBtn.title = 'Delete';
        deleteBtn.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" focusable="false" class="icon-trash"><path d="M9 3h6a1 1 0 0 1 1 1v1h4a1 1 0 1 1 0 2h-1.06l-1.01 12.12A2 2 0 0 1 16.94 21H7.06a2 2 0 0 1-1.99-1.88L4.06 7H3a1 1 0 1 1 0-2h4V4a1 1 0 0 1 1-1Zm5 4a1 1 0 1 0-2 0v10a1 1 0 1 0 2 0V7Zm-4 0a1 1 0 0 0-2 0v10a1 1 0 1 0 2 0V7Zm1-3H9v1h6V4h-4Z"/></svg>';
        deleteBtn.addEventListener('click', async () => {
          try {
            const resp = await fetch(`/api/history/${encodeURIComponent(item.fileName)}`, {
              method: 'DELETE',
            });
            if (!resp.ok) {
              const txt = await resp.text();
              if (statusMessage) {
                statusMessage.textContent = `Failed to delete file: ${txt || resp.status}`;
              }
              return;
            }
            li.remove();
            if (!historyList.children.length) {
              historyEmpty.classList.remove('hidden');
            }
          } catch (err) {
            if (statusMessage) {
              statusMessage.textContent = 'Failed to delete file from history.';
            }
          }
        });

        actions.appendChild(playBtn);
        actions.appendChild(redownloadBtn);
        actions.appendChild(deleteBtn);

        li.appendChild(main);
        li.appendChild(actions);

        historyList.appendChild(li);
      });
    } catch (err) {
      console.warn('[LocalUI] Failed to load history', err);
    } finally {
      isLoadingHistory = false;
    }
  }

  function initHistory() {
    if (historyPlayerClose && historyPlayer && historyVideo && historyList) {
      historyPlayerClose.addEventListener('click', () => {
        try {
          historyVideo.pause();
        } catch (_) {}
        historyVideo.removeAttribute('src');
        historyVideo.load();
        historyPlayer.classList.add('hidden');
        Array.from(historyList.children).forEach((child) => {
          child.classList.remove('history-item--active');
        });
        // Return player to default position after list
        historyList.insertAdjacentElement('afterend', historyPlayer);
      });
    }

    if (historyClearAll && historyList && historyEmpty) {
      historyClearAll.addEventListener('click', async () => {
        const confirmed = confirm('Delete all downloaded files from history?');
        if (!confirmed) return;

        try {
          const resp = await fetch('/api/history', { method: 'DELETE' });
          if (!resp.ok) {
            const txt = await resp.text();
            if (statusMessage) {
              statusMessage.textContent = `Failed to clear history: ${txt || resp.status}`;
            }
            return;
          }

          historyList.innerHTML = '';
          historyEmpty.classList.remove('hidden');
          if (historyPlayer) {
            historyPlayer.classList.add('hidden');
            historyList.insertAdjacentElement('afterend', historyPlayer);
          }
          if (historyVideo) {
            try { historyVideo.pause(); } catch (_) {}
            historyVideo.removeAttribute('src');
            historyVideo.load();
          }
          if (statusMessage) {
            statusMessage.textContent = 'History cleared.';
          }
        } catch (err) {
          if (statusMessage) {
            statusMessage.textContent = 'Failed to clear history.';
          }
        }
      });
    }
  }

  return {
    initHistory,
    hideHistoryView,
    loadHistoryOnce,
  };
}
