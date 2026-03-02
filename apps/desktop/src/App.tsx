import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppInit } from '@/hooks/useAppInit';
import { useCompatibility } from '@/hooks/useCompatibility';
import { AppContext } from '@/contexts/AppContext';
import { createApiClient } from '@/lib/api';
import type { QueueSettings } from '@/types/queue';
import { Navbar } from '@/components/layout/Navbar';
import { ViewContainer } from '@/components/layout/ViewContainer';
import { QueueView } from '@/components/queue/QueueView';
import { HistoryView } from '@/components/history/HistoryView';
import { SettingsView } from '@/components/settings/SettingsView';

type View = 'queue' | 'history' | 'settings';

function App() {
  const [currentView, setCurrentView] = useState<View>('queue');
  const { appInfo, status, settings, saveSettings, updater } = useAppInit();
  const [queueSettings, setQueueSettings] = useState<QueueSettings>({
    maxConcurrent: 1,
    autoStart: true,
  });

  const apiBase = useMemo(
    () => appInfo?.apiBaseUrl || 'http://127.0.0.1:49732',
    [appInfo],
  );
  const api = useMemo(() => createApiClient(apiBase), [apiBase]);

  const { compatibility } = useCompatibility(apiBase);

  const loadQueueSettings = useCallback(async () => {
    const data = await api.getQueue();
    const next = data?.settings || null;
    if (!next) return;
    setQueueSettings({
      maxConcurrent: Number(next.maxConcurrent || 1),
      autoStart: next.autoStart !== false,
    });
  }, [api]);

  useEffect(() => {
    loadQueueSettings().catch(() => {
      // Queue settings load is best-effort during startup.
    });
  }, [loadQueueSettings]);

  const saveQueueSettings = useCallback(async (next: Partial<QueueSettings>) => {
    const payload: QueueSettings = {
      maxConcurrent: Math.max(1, Math.min(16, Number(next.maxConcurrent ?? queueSettings.maxConcurrent ?? 1))),
      autoStart: typeof next.autoStart === 'boolean' ? next.autoStart : queueSettings.autoStart !== false,
    };

    const response = await api.updateQueueSettings(payload) as { settings?: QueueSettings } | null;
    const resolved = response?.settings
      ? {
        maxConcurrent: Number(response.settings.maxConcurrent || payload.maxConcurrent),
        autoStart: response.settings.autoStart !== false,
      }
      : payload;

    setQueueSettings(resolved);
    await saveSettings({
      queueMaxConcurrent: resolved.maxConcurrent,
      queueAutoStart: resolved.autoStart,
    });
  }, [api, queueSettings.autoStart, queueSettings.maxConcurrent, saveSettings]);

  // Derive compatibility warning for navbar
  const compatibilityWarning = useMemo(() => {
    if (compatibility.error) return compatibility.error;
    return '';
  }, [compatibility.error]);

  const hasUpdate = updater.phase === 'downloaded';

  return (
    <AppContext.Provider value={{ apiBase, appInfo }}>
      <div className="h-screen flex flex-col bg-background">
        <Navbar
          currentView={currentView}
          onViewChange={setCurrentView}
          status={status}
          compatibilityWarning={compatibilityWarning}
          hasUpdate={hasUpdate}
        />
        <ViewContainer>
          {currentView === 'queue' && (
            <QueueView
              apiBase={apiBase}
              queueSettings={queueSettings}
              onQueueSettingsChange={saveQueueSettings}
              onQueueSettingsSync={setQueueSettings}
            />
          )}
          {currentView === 'history' && <HistoryView apiBase={apiBase} />}
          {currentView === 'settings' && (
            <SettingsView
              apiBase={apiBase}
              settings={settings}
              queueSettings={queueSettings}
              onSaveSettings={saveSettings}
              onSaveQueueSettings={saveQueueSettings}
              updater={updater}
              compatibility={compatibility}
            />
          )}
        </ViewContainer>
      </div>
    </AppContext.Provider>
  );
}

export default App;
