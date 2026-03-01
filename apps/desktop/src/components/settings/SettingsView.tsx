import type { DesktopSettings } from '@/types/settings';
import type { UpdaterState } from '@/types/updater';
import type { CompatibilityInfo } from '@/types/compatibility';
import { DesktopSettingsCard } from './DesktopSettingsCard';
import { UpdaterCard } from './UpdaterCard';

interface SettingsViewProps {
  apiBase: string;
  settings: DesktopSettings;
  onSaveSettings: (next: Partial<DesktopSettings>) => void;
  updater: UpdaterState;
  compatibility: CompatibilityInfo;
}

export function SettingsView({
  settings,
  onSaveSettings,
  updater,
}: SettingsViewProps) {
  return (
    <div className="animate-fade-slide-in space-y-5">
      <h1 className="sr-only">Settings</h1>
      <DesktopSettingsCard settings={settings} onSave={onSaveSettings} />
      <UpdaterCard updater={updater} />
    </div>
  );
}
