import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AlertTriangle, ArrowDownToLine, LoaderCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { UpdaterState } from '@/types/updater';
import logoTitle from '@/assets/vidsnag-logo-title.png';

type View = 'queue' | 'history' | 'settings';

const TABS: { id: View; label: string }[] = [
  { id: 'queue', label: 'Queue' },
  { id: 'history', label: 'History' },
  { id: 'settings', label: 'Settings' },
];

interface NavbarProps {
  currentView: View;
  onViewChange: (view: View) => void;
  status: string;
  compatibilityWarning: string;
  updater: UpdaterState;
}

export function Navbar({ currentView, onViewChange, status, compatibilityWarning, updater }: NavbarProps) {
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const latestVersion = updater.updateInfo?.version || '';
  const showUpdateCta = updater.phase === 'downloaded' || updater.phase === 'installing';

  const handleInstallUpdate = async () => {
    if (installingUpdate || updater.phase !== 'downloaded') return;
    setInstallingUpdate(true);
    try {
      await window.desktop.installUpdateNow();
    } finally {
      setInstallingUpdate(false);
    }
  };

  return (
    <header className="drag-region h-12 border-b border-border flex items-center px-4 gap-4 shrink-0">
      <img
        src={logoTitle}
        alt="VidSnag"
        className="no-drag h-6 w-auto max-w-[170px] object-contain select-none"
      />

      <nav className="no-drag flex items-center gap-0.5 ml-2">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => onViewChange(tab.id)}
            className={cn(
              'px-3 py-1.5 rounded-md text-[13px] font-medium transition-all duration-150',
              currentView === tab.id
                ? 'bg-background-active text-foreground'
                : 'text-foreground-muted hover:text-foreground hover:bg-background-hover',
            )}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <div className="flex-1" />

      <div className="no-drag flex items-center gap-2">
        {showUpdateCta && (
          <Button
            size="sm"
            className="h-8 gap-2 px-3 text-[11px] font-semibold tracking-wide"
            disabled={updater.phase !== 'downloaded' || installingUpdate}
            onClick={() => {
              if (updater.phase === 'downloaded') {
                handleInstallUpdate().catch(() => {});
              }
            }}
          >
            {updater.phase === 'installing' || installingUpdate ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <ArrowDownToLine className="size-3.5" />
            )}
            {updater.phase === 'installing'
              ? 'Installing Update...'
              : latestVersion
                ? `Update ${latestVersion} Ready`
                : 'Update Ready'}
            {updater.phase !== 'installing' && <span className="text-primary-foreground/80">Install & Restart</span>}
          </Button>
        )}
        {compatibilityWarning && (
          <button
            aria-label="Compatibility Warning"
            onClick={() => onViewChange('settings')}
            title={compatibilityWarning}
            className="text-status-paused hover:text-status-paused/80 transition-colors"
          >
            <AlertTriangle className="size-4" />
          </button>
        )}
        <span className="text-xs text-foreground-subtle truncate max-w-80">{status}</span>
      </div>
    </header>
  );
}
