import { useMemo } from 'react';
import type { DesktopSettings } from '@/types/settings';
import type { UpdaterState } from '@/types/updater';
import type { CompatibilityInfo } from '@/types/compatibility';
import type { TokenRow } from '@/types/pairing';
import { usePairing } from '@/hooks/usePairing';
import { compareVersions } from '@/lib/utils';
import { DesktopSettingsCard } from './DesktopSettingsCard';
import { UpdaterCard } from './UpdaterCard';
import { PairingCard } from './PairingCard';

interface SettingsViewProps {
  apiBase: string;
  settings: DesktopSettings;
  onSaveSettings: (next: Partial<DesktopSettings>) => void;
  updater: UpdaterState;
  compatibility: CompatibilityInfo;
}

export function SettingsView({
  apiBase,
  settings,
  onSaveSettings,
  updater,
  compatibility,
}: SettingsViewProps) {
  const pairing = usePairing(apiBase);

  const tokenRows = useMemo((): TokenRow[] => {
    const minVersion = compatibility.minExtensionVersion;
    return (pairing.tokens || []).map((token) => {
      const version = String(token?.extensionVersion || '').trim() || 'unknown';
      const isOutdated = Boolean(
        minVersion && version !== 'unknown' && compareVersions(version, minVersion) < 0,
      );
      return {
        ...token,
        displayVersion: version,
        status: isOutdated ? 'outdated' as const : 'compatible' as const,
        isOutdated,
      };
    });
  }, [pairing.tokens, compatibility.minExtensionVersion]);

  return (
    <div className="animate-fade-slide-in space-y-5">
      <DesktopSettingsCard settings={settings} onSave={onSaveSettings} />
      <UpdaterCard updater={updater} />
      <PairingCard
        pairing={pairing.pairing}
        hasActivePairingCode={pairing.hasActivePairingCode}
        tokenRows={tokenRows}
        tokenFilter={pairing.tokenFilter}
        tokenSort={pairing.tokenSort}
        onFilterChange={pairing.setTokenFilter}
        onSortChange={pairing.setTokenSort}
        onGenerateCode={pairing.generateCode}
        onRevokeToken={pairing.revokeToken}
        onRevokeAll={pairing.revokeAll}
      />
    </div>
  );
}
