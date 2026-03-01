import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Play, Pause, RotateCcw, Trash2, RefreshCw } from 'lucide-react';
import type { QueueJob } from '@/types/queue';
import { cn, getQueueStatusLabel, getQueuePrimaryAction, resolveJobStatus, resolveThumbnailUrl, extractYear } from '@/lib/utils';

function statusBadgeClass(status: string): string {
  const map: Record<string, string> = {
    downloading: 'bg-status-downloading/15 text-status-downloading border-0',
    queued: 'bg-status-queued/15 text-status-queued border-0',
    paused: 'bg-status-paused/15 text-status-paused border-0',
    completed: 'bg-status-completed/15 text-status-completed border-0',
    failed: 'bg-status-failed/15 text-status-failed border-0',
    cancelled: 'bg-status-cancelled/15 text-status-cancelled border-0',
  };
  return map[status] || 'bg-foreground-muted/15 text-foreground-muted border-0';
}

function ActionIcon({ label }: { label: string }) {
  switch (label) {
    case 'Pause': return <Pause className="size-3.5" />;
    case 'Resume':
    case 'Start': return <Play className="size-3.5" />;
    case 'Retry': return <RotateCcw className="size-3.5" />;
    default: return null;
  }
}

interface QueueJobCardProps {
  job: QueueJob;
  apiBase: string;
  onAction: (endpoint: string, method?: string, body?: unknown) => Promise<void>;
}

export function QueueJobCard({ job, apiBase, onAction }: QueueJobCardProps) {
  const [showPreview, setShowPreview] = useState(false);
  const primaryAction = getQueuePrimaryAction(job);
  const progress = Math.max(0, Math.min(100, Number(job.progress || 0)));
  const jobStatus = resolveJobStatus(job);
  const showRetryOriginalHls = job.fallbackUsed && job.originalHlsUrl && ['failed', 'cancelled'].includes(jobStatus);
  const thumbnailUrl = resolveThumbnailUrl(job.thumbnailUrls?.[0], apiBase);
  const year = extractYear(job.tmdbReleaseDate);
  const genres = job.tmdbMetadata?.genres?.slice(0, 2) ?? [];
  const hasMetaLine = year || genres.length > 0;

  return (
    <>
    <Card className="bg-background-raised border-border hover:border-border/80 transition-colors duration-150 py-0 gap-0">
      <CardContent className="p-0 flex items-stretch overflow-hidden relative">
        {thumbnailUrl && (
          <img
            src={thumbnailUrl}
            alt=""
            className="w-20 object-contain bg-black shrink-0 rounded-l-[var(--radius)] cursor-pointer"
            loading="lazy"
            onClick={() => setShowPreview(true)}
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
        )}

        <div className="flex-1 min-w-0 py-1.5 px-2.5 flex flex-col justify-center">
          <div className="flex items-center gap-2 mb-0.5">
            <h4 className="text-[13px] font-medium text-foreground truncate flex-1">{job.title || job.id}</h4>
            <Badge className={cn('text-[10px] uppercase tracking-wider shrink-0', statusBadgeClass(jobStatus))}>
              {getQueueStatusLabel(jobStatus)}
            </Badge>
          </div>
          {hasMetaLine && (
            <div className="flex items-center gap-1.5 mb-0.5">
              {year && <span className="text-[10px] text-foreground-muted">{year}</span>}
              {year && genres.length > 0 && <span className="text-[10px] text-foreground-subtle">&middot;</span>}
              {genres.map((g) => (
                <span key={g} className="text-[10px] text-foreground-muted">{g}</span>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2">
            <Progress value={progress} className="h-1 flex-1" />
            <span className="text-[11px] text-foreground-muted w-8 text-right shrink-0">{progress}%</span>
          </div>
          {job.fallbackUsed && (
            <p className="text-primary text-[10px] mt-0.5">Fallback used</p>
          )}
          {job.error && (
            <p className="text-destructive text-[10px] mt-0.5 truncate">Error: {job.error}</p>
          )}
        </div>

        <div className="flex flex-col items-center justify-center shrink-0 pr-2 gap-0.5">
          {primaryAction && (
            <Button
              size="icon-sm"
              variant="ghost"
              title={primaryAction.label}
              onClick={() => onAction(primaryAction.endpoint)}
            >
              <ActionIcon label={primaryAction.label} />
            </Button>
          )}
          {showRetryOriginalHls && (
            <Button
              size="icon-sm"
              variant="ghost"
              title="Retry Original HLS"
              onClick={() => onAction(`/api/jobs/${job.id}/retry-original-hls`)}
            >
              <RefreshCw className="size-3.5" />
            </Button>
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            className="text-destructive/50 hover:text-destructive hover:bg-destructive-muted"
            title="Remove"
            onClick={() => onAction(`/api/queue/${job.id}`, 'DELETE')}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </CardContent>
    </Card>
    {thumbnailUrl && (
      <Dialog open={showPreview} onOpenChange={setShowPreview}>
        <DialogContent className="max-w-2xl p-2 bg-background border-border" showCloseButton={false}>
          <img src={thumbnailUrl} alt={job.title || job.id} className="w-full rounded" />
        </DialogContent>
      </Dialog>
    )}
    </>
  );
}
