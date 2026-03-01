import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Eye, EyeOff } from 'lucide-react';
import type { DesktopSettings } from '@/types/settings';

interface DesktopSettingsCardProps {
  settings: DesktopSettings;
  onSave: (next: Partial<DesktopSettings>) => void;
}

export function DesktopSettingsCard({ settings, onSave }: DesktopSettingsCardProps) {
  const [showTmdbKey, setShowTmdbKey] = useState(false);
  const [showSubdlKey, setShowSubdlKey] = useState(false);

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
            value={settings.queueMaxConcurrent || 1}
            onChange={(e) => onSave({ queueMaxConcurrent: Number(e.target.value) || 1 })}
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
            checked={settings.queueAutoStart !== false}
            onCheckedChange={(checked) => onSave({ queueAutoStart: checked })}
          />
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
