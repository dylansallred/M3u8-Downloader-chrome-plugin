import type { DesktopSettings } from '@/types/settings';
import type { UpdaterState } from '@/types/updater';
import type { CompatibilityInfo } from '@/types/compatibility';
import type { QueueSettings } from '@/types/queue';
import type { AppInfo } from '@/types/desktop-bridge';
import { DesktopSettingsCard } from './DesktopSettingsCard';
import { UpdaterCard } from './UpdaterCard';

interface SettingsViewProps {
  apiBase: string;
  appInfo: AppInfo | null;
  settings: DesktopSettings;
  queueSettings: QueueSettings;
  onSaveSettings: (next: Partial<DesktopSettings>) => void;
  onSaveQueueSettings: (next: Partial<QueueSettings>) => Promise<void>;
  updater: UpdaterState;
  compatibility: CompatibilityInfo;
}

export function SettingsView({
  apiBase,
  appInfo,
  settings,
  queueSettings,
  onSaveSettings,
  onSaveQueueSettings,
  updater,
}: SettingsViewProps) {
  return (
    <div className="animate-fade-slide-in space-y-5">
      <h1 className="sr-only">Settings</h1>
      <DesktopSettingsCard
        apiBase={apiBase}
        settings={settings}
        queueSettings={queueSettings}
        onSave={onSaveSettings}
        onSaveQueueSettings={onSaveQueueSettings}
      />
      <UpdaterCard updater={updater} appInfo={appInfo} />
    </div>
  );
}
