import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { Download, RefreshCw } from 'lucide-react';
import type { UpdaterState } from '@/types/updater';
import type { AppInfo } from '@/types/desktop-bridge';

interface UpdaterCardProps {
  updater: UpdaterState;
  appInfo: AppInfo | null;
}

export function UpdaterCard({ updater, appInfo }: UpdaterCardProps) {
  const currentVersion = updater.currentVersion || appInfo?.version || 'unknown';
  const latestVersion = updater.updateInfo?.version || null;
  const isPackaged = appInfo?.isPackaged !== false;
  const canInstall = updater.phase === 'downloaded';
  const versionLabel = latestVersion && latestVersion !== currentVersion
    ? `${currentVersion} -> ${latestVersion}`
    : currentVersion;

  const phaseColor: Record<string, string> = {
    idle: 'bg-foreground-muted/15 text-foreground-muted',
    checking: 'bg-status-queued/15 text-status-queued',
    downloading: 'bg-status-downloading/15 text-status-downloading',
    downloaded: 'bg-primary/15 text-primary',
    installing: 'bg-status-downloading/15 text-status-downloading',
    error: 'bg-destructive/15 text-destructive',
  };

  return (
    <Card className="bg-background-raised border-border">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium">Updates</CardTitle>
          <Badge className={`text-[10px] uppercase tracking-wider border-0 ${phaseColor[updater.phase] || ''}`}>
            {updater.phase}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1">
          <p className="text-sm text-foreground-muted">{updater.message}</p>
          <p className="text-xs text-foreground-subtle">Version {versionLabel}</p>
        </div>

        {updater.phase === 'downloading' && (
          <Progress value={updater.progress || 0} className="h-1" />
        )}

        {updater.error && (
          <p className="text-xs text-destructive">{updater.error}</p>
        )}

        <div className="flex gap-1.5 pt-1">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1.5"
            disabled={!isPackaged || updater.phase === 'checking' || updater.phase === 'downloading'}
            onClick={() => window.desktop.checkForUpdates()}
          >
            <RefreshCw className="size-3" /> Check
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1.5"
            disabled={!canInstall}
            onClick={() => window.desktop.installUpdateNow()}
          >
            <Download className="size-3" /> Restart & Install
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
