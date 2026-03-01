import { useMemo, useState } from 'react';
import { useAppInit } from '@/hooks/useAppInit';
import { useCompatibility } from '@/hooks/useCompatibility';
import { AppContext } from '@/contexts/AppContext';
import { Navbar } from '@/components/layout/Navbar';
import { ViewContainer } from '@/components/layout/ViewContainer';
import { QueueView } from '@/components/queue/QueueView';
import { HistoryView } from '@/components/history/HistoryView';
import { SettingsView } from '@/components/settings/SettingsView';

type View = 'queue' | 'history' | 'settings';

function App() {
  const [currentView, setCurrentView] = useState<View>('queue');
  const { appInfo, status, settings, saveSettings, updater } = useAppInit();

  const apiBase = useMemo(
    () => appInfo?.apiBaseUrl || 'http://127.0.0.1:49732',
    [appInfo],
  );

  const { compatibility } = useCompatibility(apiBase);

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
          {currentView === 'queue' && <QueueView apiBase={apiBase} />}
          {currentView === 'history' && <HistoryView apiBase={apiBase} />}
          {currentView === 'settings' && (
            <SettingsView
              apiBase={apiBase}
              settings={settings}
              onSaveSettings={saveSettings}
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
