import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Download, RefreshCw, Clock } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { UpdaterState } from '@/types/updater';
import type { AppInfo } from '@/types/desktop-bridge';
import { normalizeReleaseNotes } from '@/lib/utils';

interface UpdaterCardProps {
  updater: UpdaterState;
  appInfo: AppInfo | null;
}

export function UpdaterCard({ updater, appInfo }: UpdaterCardProps) {
  const releaseNotes = useMemo(() => normalizeReleaseNotes(updater.releaseNotes), [updater.releaseNotes]);
  const [notesOpen, setNotesOpen] = useState(false);
  const currentVersion = updater.currentVersion || appInfo?.version || 'unknown';
  const latestVersion = updater.updateInfo?.version || null;
  const isPackaged = appInfo?.isPackaged !== false;

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
        <p className="text-sm text-foreground-muted">{updater.message}</p>

        <div className="grid grid-cols-2 gap-3 text-xs text-foreground-muted">
          <div>
            <span className="text-foreground-subtle">Current version:</span> {currentVersion}
          </div>
          <div>
            <span className="text-foreground-subtle">Latest version:</span> {latestVersion || 'Not checked yet'}
          </div>
        </div>

        {updater.lastCheckedAt && (
          <p className="text-xs text-foreground-subtle">
            Last checked: {new Date(updater.lastCheckedAt).toLocaleString()}
          </p>
        )}

        {!isPackaged && (
          <p className="text-xs text-foreground-subtle">
            Auto-update checks only work in packaged app builds.
          </p>
        )}

        {updater.phase === 'downloading' && (
          <Progress value={updater.progress || 0} className="h-1" />
        )}

        {updater.deferredUntil && (
          <p className="text-xs text-foreground-subtle">
            Deferred until: {new Date(updater.deferredUntil).toLocaleString()}
          </p>
        )}

        {updater.error && (
          <p className="text-xs text-destructive">{updater.error}</p>
        )}

        {releaseNotes.length > 0 && (
          <Collapsible open={notesOpen} onOpenChange={setNotesOpen}>
            <CollapsibleTrigger className="text-xs text-foreground-muted hover:text-foreground transition-colors cursor-pointer underline-offset-2 hover:underline">
              {notesOpen ? 'Hide' : 'Show'} release notes
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2 space-y-1">
              {releaseNotes.map((note, idx) => (
                <p key={idx} className="text-xs text-foreground-muted">{note}</p>
              ))}
            </CollapsibleContent>
          </Collapsible>
        )}

        <div className="flex gap-1.5 pt-1">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1.5"
            disabled={!isPackaged}
            onClick={() => window.desktop.checkForUpdates()}
          >
            <RefreshCw className="size-3" /> Check
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1.5"
            disabled={updater.phase !== 'downloaded'}
            onClick={() => window.desktop.installUpdateNow()}
          >
            <Download className="size-3" /> Restart & Install
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1.5"
            disabled={updater.phase !== 'downloaded'}
            onClick={() => window.desktop.remindLater(30)}
          >
            <Clock className="size-3" /> Later
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
