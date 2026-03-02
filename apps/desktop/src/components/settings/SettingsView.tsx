import type { DesktopSettings } from '@/types/settings';
import type { UpdaterState } from '@/types/updater';
import type { CompatibilityInfo } from '@/types/compatibility';
import type { QueueSettings } from '@/types/queue';
import { DesktopSettingsCard } from './DesktopSettingsCard';
import { UpdaterCard } from './UpdaterCard';

interface SettingsViewProps {
  apiBase: string;
  settings: DesktopSettings;
  queueSettings: QueueSettings;
  onSaveSettings: (next: Partial<DesktopSettings>) => void;
  onSaveQueueSettings: (next: Partial<QueueSettings>) => Promise<void>;
  updater: UpdaterState;
  compatibility: CompatibilityInfo;
}

export function SettingsView({
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
        settings={settings}
        queueSettings={queueSettings}
        onSave={onSaveSettings}
        onSaveQueueSettings={onSaveQueueSettings}
      />
      <UpdaterCard updater={updater} />
    </div>
  );
}
