import { useCallback, useEffect, useMemo, useState } from 'react';
import type { HistoryItem } from '@/types/history';
import { createApiClient } from '@/lib/api';
import { toast } from 'sonner';

export function useHistory(apiBase: string) {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [filterText, setFilterText] = useState('');
  const [filterType, setFilterType] = useState('all');

  const api = useMemo(() => createApiClient(apiBase), [apiBase]);

  const loadHistory = useCallback(async () => {
    const data = await api.getHistory();
    setItems(data?.items || []);
  }, [api]);

  useEffect(() => {
    loadHistory();
    const timer = setInterval(loadHistory, 2000);
    return () => clearInterval(timer);
  }, [loadHistory]);

  const visibleItems = useMemo(() => {
    const text = String(filterText || '').trim().toLowerCase();
    return (items || []).filter((item) => {
      if (filterType !== 'all') {
        const ext = String(item.ext || '').toLowerCase().replace(/^\./, '');
        if (ext !== filterType) return false;
      }
      if (!text) return true;
      const label = String(item.label || '').toLowerCase();
      const fileName = String(item.fileName || '').toLowerCase();
      return label.includes(text) || fileName.includes(text);
    });
  }, [items, filterText, filterType]);

  const clearAll = useCallback(async () => {
    await api.clearHistory();
    await loadHistory();
    toast.success('History cleared');
  }, [api, loadHistory]);

  const deleteItem = useCallback(async (fileName: string) => {
    await api.deleteHistoryItem(fileName);
    await loadHistory();
    toast.success(`Deleted ${fileName}`);
  }, [api, loadHistory]);

  const openFile = useCallback(async (fileName: string) => {
    try {
      const result = await window.desktop.openHistoryFile(fileName);
      if (!result?.ok) throw new Error(result?.error || 'Failed to open file');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`Failed to open file: ${message}`);
    }
  }, []);

  const openFolder = useCallback(async (fileName: string) => {
    try {
      const result = await window.desktop.openHistoryFolder(fileName);
      if (!result?.ok) throw new Error(result?.error || 'Failed to open folder');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`Failed to open folder: ${message}`);
    }
  }, []);

  return {
    items,
    visibleItems,
    filterText,
    filterType,
    setFilterText,
    setFilterType,
    clearAll,
    deleteItem,
    openFile,
    openFolder,
    apiBase,
  };
}
