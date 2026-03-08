import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Eye, EyeOff, FolderOpen, LoaderCircle, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import type { DesktopSettings } from '@/types/settings';
import type { QueueSettings } from '@/types/queue';
import { createApiClient } from '@/lib/api';

interface DesktopSettingsCardProps {
  apiBase: string;
  settings: DesktopSettings;
  queueSettings: QueueSettings;
  onSave: (next: Partial<DesktopSettings>) => void;
  onSaveQueueSettings: (next: Partial<QueueSettings>) => void;
}

export function DesktopSettingsCard({
  apiBase,
  settings,
  queueSettings,
  onSave,
  onSaveQueueSettings,
}: DesktopSettingsCardProps) {
  const [showTmdbKey, setShowTmdbKey] = useState(false);
  const [showSubdlKey, setShowSubdlKey] = useState(false);
  const [clearingTempData, setClearingTempData] = useState(false);
  const outputDirectory = String(settings.outputDirectory || '').trim();
  const api = createApiClient(apiBase);

  const chooseOutputDirectory = async () => {
    const result = await window.desktop.chooseOutputDirectory();
    if (result?.ok && result.path) {
      onSave({ outputDirectory: result.path });
    }
  };

  const clearTempDownloadData = async () => {
    if (clearingTempData) return;
    setClearingTempData(true);
    try {
      const result = await api.clearTempDownloads();
      const removed = Number(result?.tempDirectoriesRemoved || 0)
        + Number(result?.transientFilesRemoved || 0)
        + Number(result?.emptiedJobDirectoriesRemoved || 0);
      toast.success(
        removed > 0
          ? `Cleared ${removed} stale temp download artifact${removed === 1 ? '' : 's'}.`
          : 'No stale temp download data was found.',
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(message || 'Failed to clear temp download data.');
    } finally {
      setClearingTempData(false);
    }
  };

  return (
    <Card className="bg-background-raised border-border">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">Preferences</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <label className="text-sm text-foreground">Check updates on startup</label>
          <Switch
            checked={settings.checkUpdatesOnStartup !== false}
            onCheckedChange={(checked) => onSave({ checkUpdatesOnStartup: checked })}
          />
        </div>
        <div className="flex items-center justify-between">
          <label className="text-sm text-foreground">Default max concurrent</label>
          <Input
            type="number"
            min={1}
            max={16}
            value={queueSettings.maxConcurrent || 1}
            onChange={(e) => onSaveQueueSettings({ maxConcurrent: Number(e.target.value) || 1 })}
            className="w-20 h-8 text-sm bg-background border-border"
          />
        </div>
        <div className="flex items-center justify-between">
          <label className="text-sm text-foreground">
            Download threads
            <span className="text-xs text-foreground-muted ml-1">(per job)</span>
          </label>
          <Input
            type="number"
            min={1}
            max={16}
            value={settings.downloadThreads || 8}
            onChange={(e) => onSave({ downloadThreads: Math.min(16, Math.max(1, Number(e.target.value) || 1)) })}
            className="w-20 h-8 text-sm bg-background border-border"
          />
        </div>
        <div className="flex items-center justify-between">
          <label className="text-sm text-foreground">Default auto start</label>
          <Switch
            checked={queueSettings.autoStart !== false}
            onCheckedChange={(checked) => onSaveQueueSettings({ autoStart: checked })}
          />
        </div>

        <div className="border-t border-border pt-4 space-y-2">
          <label className="text-sm text-foreground font-medium">Completed video folder</label>
          <p className="text-xs text-foreground-muted">
            Downloads still process in the app data folder first, then the finished video is moved here after completion.
          </p>
          <div className="flex items-center gap-2">
            <Input
              readOnly
              value={outputDirectory || 'Default internal downloads folder'}
              className="flex-1 h-8 text-sm bg-background border-border"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 px-2"
              onClick={chooseOutputDirectory}
            >
              <FolderOpen className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 px-2"
              disabled={!outputDirectory}
              onClick={() => onSave({ outputDirectory: '' })}
            >
              <X className="size-4" />
            </Button>
          </div>
        </div>

        <div className="border-t border-border pt-4 space-y-2">
          <label className="text-sm text-foreground font-medium">Temp download data</label>
          <p className="text-xs text-foreground-muted">
            Clears stale HLS temp folders and partial download files for inactive jobs before you retry a stream.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-2"
            disabled={clearingTempData}
            onClick={() => {
              clearTempDownloadData().catch(() => {});
            }}
          >
            {clearingTempData ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            Clear temp download data
          </Button>
        </div>

        <div className="border-t border-border pt-4 space-y-2">
          <label className="text-sm text-foreground font-medium">TMDB API Key</label>
          <p className="text-xs text-foreground-muted">
            Enables automatic movie/TV metadata and poster thumbnails.{' '}
            <a
              href="https://www.themoviedb.org/settings/api"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              Get a free API key
            </a>{' '}
            by creating an account at themoviedb.org, then go to Settings &rarr; API.
          </p>
          <div className="flex items-center gap-2">
            <Input
              type={showTmdbKey ? 'text' : 'password'}
              placeholder="Enter your TMDB API key"
              value={settings.tmdbApiKey || ''}
              onChange={(e) => onSave({ tmdbApiKey: e.target.value })}
              className="flex-1 h-8 text-sm bg-background border-border font-mono"
            />
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2"
              onClick={() => setShowTmdbKey(!showTmdbKey)}
            >
              {showTmdbKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </Button>
          </div>
        </div>

        <div className="border-t border-border pt-4 space-y-2">
          <label className="text-sm text-foreground font-medium">SubDL API Key</label>
          <p className="text-xs text-foreground-muted">
            Enables automatic subtitle lookup/download for queued jobs.{' '}
            <a
              href="https://subdl.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              Get an API key
            </a>{' '}
            from your SubDL account.
          </p>
          <div className="flex items-center gap-2">
            <Input
              type={showSubdlKey ? 'text' : 'password'}
              placeholder="Enter your SubDL API key"
              value={settings.subdlApiKey || ''}
              onChange={(e) => onSave({ subdlApiKey: e.target.value })}
              className="flex-1 h-8 text-sm bg-background border-border font-mono"
            />
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2"
              onClick={() => setShowSubdlKey(!showSubdlKey)}
            >
              {showSubdlKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
