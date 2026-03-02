import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { Play, Pause, RotateCcw, X, Cpu } from 'lucide-react';
import type { QueueJob, ActiveMetrics } from '@/types/queue';
import { cn, formatBytesPerSecond, formatEta, formatRuntime, extractYear, getQueueStatusLabel, getQueuePrimaryAction, resolveJobStatus, resolveThumbnailUrl } from '@/lib/utils';
import { SegmentHeatmap } from './SegmentHeatmap';

// Status badge styling helper
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

// Primary action icon
function ActionIcon({ label }: { label: string }) {
  switch (label) {
    case 'Pause': return <Pause className="size-3.5" />;
    case 'Resume':
    case 'Start': return <Play className="size-3.5" />;
    case 'Retry': return <RotateCcw className="size-3.5" />;
    default: return null;
  }
}

interface ActiveDownloadCardProps {
  job: QueueJob | null;
  metrics: ActiveMetrics;
  apiBase: string;
  onAction: (endpoint: string, method?: string, body?: unknown) => Promise<void>;
}

export function ActiveDownloadCard({ job, metrics, apiBase, onAction }: ActiveDownloadCardProps) {
  const primaryAction = getQueuePrimaryAction(job);
  const progress = Math.max(0, Math.min(100, Number(job?.progress || 0)));
  const jobStatus = resolveJobStatus(job);
  const isFinalizing = String(job?.status || '').toLowerCase() === 'finalizing';
  const isDownloading = jobStatus === 'downloading';
  const thumbnailUrl = job ? resolveThumbnailUrl(job.thumbnailUrls?.[0], apiBase) : null;
  const year = job ? extractYear(job.tmdbReleaseDate) : null;
  const runtime = job ? formatRuntime(job.tmdbMetadata?.runtime) : null;
  const genres = job?.tmdbMetadata?.genres?.slice(0, 3) ?? [];
  const displayText = job?.tmdbMetadata?.tagline || job?.tmdbMetadata?.overview || null;
  const hasMetadata = year || runtime || genres.length > 0 || displayText;
  const threads = job?.threadStates;
  const activeThreads = threads?.filter((t) => t.status === 'downloading').length ?? 0;
  const totalThreads = threads?.length ?? 0;
  const showHeatmap = isDownloading && (job?.totalSegments || 0) > 0 && job?.segmentStates;

  if (!job) {
    return (
      <div className="flex items-center gap-2 text-foreground-muted text-xs py-1">
        <div className="w-0.5 h-4 bg-primary/30 rounded-full" />
        <span>No active download</span>
      </div>
    );
  }

  return (
    <Card className="border-l-2 border-l-primary bg-background-raised border-border py-0 gap-0">
      <CardContent className="p-3">
        <div className="flex items-start gap-3 mb-2">
          {thumbnailUrl && (
            <img
              src={thumbnailUrl}
              alt=""
              className="w-24 h-36 object-cover rounded shrink-0"
              loading="lazy"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2 mb-0.5">
              <p className="text-foreground font-medium text-sm truncate">{job.title || job.id}</p>
              <Badge className={cn('text-[10px] uppercase tracking-wider shrink-0', statusBadgeClass(jobStatus))}>
                {getQueueStatusLabel(jobStatus)}
              </Badge>
            </div>
            {job.fallbackUsed && (
              <p className="text-primary text-[11px]">Fallback used: direct media URL</p>
            )}
            {hasMetadata && (
              <div className="mt-1.5 space-y-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                  {year && <span className="text-[11px] text-foreground-muted">{year}</span>}
                  {runtime && (
                    <>
                      <span className="text-[11px] text-foreground-subtle">&middot;</span>
                      <span className="text-[11px] text-foreground-muted">{runtime}</span>
                    </>
                  )}
                  {genres.length > 0 && (year || runtime) && (
                    <span className="text-[11px] text-foreground-subtle">&middot;</span>
                  )}
                  {genres.map((g) => (
                    <Badge
                      key={g}
                      variant="outline"
                      className="text-[9px] font-normal border-border text-foreground-muted py-0 px-1.5 h-4"
                    >
                      {g}
                    </Badge>
                  ))}
                </div>
                {displayText && (
                  <p className="text-[11px] text-foreground-muted leading-tight line-clamp-2">
                    {displayText}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="mb-2">
          <div className="flex justify-between text-xs text-foreground-muted mb-1">
            <span>{progress}%</span>
            <span>{job.completedSegments || 0}/{job.totalSegments || 0} segments</span>
          </div>
          <div className="relative">
            <Progress value={progress} className="h-2" />
            {isDownloading && (
              <div
                className="absolute inset-0 h-2 rounded-full overflow-hidden"
                style={{ width: `${progress}%` }}
              >
                <div className="h-full w-full bg-gradient-to-r from-primary via-primary/60 to-primary bg-[length:200%_100%] animate-shimmer rounded-full" />
              </div>
            )}
          </div>
        </div>

        {showHeatmap && (
          <div className="mb-2">
            <SegmentHeatmap totalSegments={job.totalSegments} segmentStates={job.segmentStates} />
          </div>
        )}

        <div className="grid grid-cols-[1fr_1fr_1fr_auto] gap-x-2 text-xs mb-2">
          <span className="text-foreground-muted whitespace-nowrap">
            Speed: <span className="text-foreground font-medium tabular-nums">{isFinalizing ? 'finalizing...' : formatBytesPerSecond(metrics.speedBps)}</span>
          </span>
          <span className="text-foreground-muted whitespace-nowrap">
            ETA: <span className="text-foreground font-medium tabular-nums">{isFinalizing ? 'finalizing...' : formatEta(metrics.etaSeconds)}</span>
          </span>
          <span className="text-foreground-muted whitespace-nowrap">
            Downloaded: <span className="text-foreground font-medium tabular-nums">{Math.round((job.bytesDownloaded || 0) / (1024 * 1024))} MB</span>
          </span>
          {totalThreads > 0 && (
            <span className="text-foreground-muted flex items-center gap-1 whitespace-nowrap">
              <Cpu className="size-3" />
              <span className="text-foreground font-medium tabular-nums">{activeThreads}/{totalThreads}</span>
            </span>
          )}
        </div>

        {isFinalizing && (
          <p className="text-[11px] text-foreground-muted mb-2">
            Finalizing media file (merging segments/remuxing)...
          </p>
        )}

        {job.error && (
          <p className="text-destructive text-xs mb-2">Error: {job.error}</p>
        )}

        <div className="flex gap-2">
          {primaryAction && (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={() => onAction(primaryAction.endpoint)}
            >
              <ActionIcon label={primaryAction.label} />
              {primaryAction.label}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive hover:bg-destructive-muted gap-1.5"
            onClick={() => onAction(`/api/jobs/${job.id}/cancel`)}
          >
            <X className="size-3.5" />
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
