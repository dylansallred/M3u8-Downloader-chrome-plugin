import { useEffect, useState } from 'react';
import type { AppInfo } from '@/types/desktop-bridge';
import type { DesktopSettings } from '@/types/settings';
import type { UpdaterState } from '@/types/updater';

export function useAppInit() {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [status, setStatus] = useState('Initializing...');
  const [settings, setSettings] = useState<DesktopSettings>({
    queueMaxConcurrent: 1,
    queueAutoStart: true,
    checkUpdatesOnStartup: true,
    tmdbApiKey: '',
    subdlApiKey: '',
    downloadThreads: 8,
  });
  const [updater, setUpdater] = useState<UpdaterState>({
    phase: 'idle',
    message: 'Idle',
    progress: 0,
  });

  useEffect(() => {
    let mounted = true;

    (async () => {
      try {
        const info = await window.desktop.getAppInfo();
        const appSettings = await window.desktop.getSettings();
        const updaterState = await window.desktop.getUpdaterState();
        if (!mounted) return;
        setAppInfo(info);
        setSettings(appSettings);
        setUpdater(updaterState);
        setStatus(`Connected to local API at ${info.apiBaseUrl}`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        setStatus(`Initialization failed: ${message}`);
      }
    })();

    const disposeUpdater = window.desktop.onUpdaterEvent((event) => {
      setUpdater({ ...event });
    });

    return () => {
      mounted = false;
      disposeUpdater();
    };
  }, []);

  const saveSettings = async (next: Partial<DesktopSettings>) => {
    const merged = await window.desktop.saveSettings(next);
    setSettings(merged);
  };

  return { appInfo, status, setStatus, settings, saveSettings, updater, setUpdater };
}
