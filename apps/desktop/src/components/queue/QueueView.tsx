import { useQueue } from '@/hooks/useQueue';
import { useActiveJob } from '@/hooks/useActiveJob';
import { ActiveDownloadCard } from './ActiveDownloadCard';
import { QueueToolbar } from './QueueToolbar';
import { QueueSummaryBar } from './QueueSummaryBar';
import { QueueSettingsBar } from './QueueSettingsBar';
import { QueueJobCard } from './QueueJobCard';

interface QueueViewProps {
  apiBase: string;
}

export function QueueView({ apiBase }: QueueViewProps) {
  const queue = useQueue(apiBase);
  const { activeJob, activeMetrics } = useActiveJob(queue.queueData, apiBase);

  return (
    <div className="animate-fade-slide-in space-y-3">
      <h1 className="sr-only">Queue</h1>
      <ActiveDownloadCard
        job={activeJob}
        metrics={activeMetrics}
        apiBase={apiBase}
        onAction={queue.callAction}
      />
      <QueueToolbar
        filterText={queue.filterText}
        filterStatus={queue.filterStatus}
        onFilterTextChange={queue.setFilterText}
        onFilterStatusChange={queue.setFilterStatus}
        onStartAll={() => queue.callAction('/api/queue/start-all')}
        onPauseAll={() => queue.callAction('/api/queue/pause-all')}
        onClearCompleted={() => queue.callAction('/api/queue/clear-completed')}
      />
      <div className="flex items-center justify-between gap-4">
        <QueueSummaryBar summary={queue.summary} />
        <QueueSettingsBar
          maxConcurrent={queue.queueData.settings?.maxConcurrent || 1}
          autoStart={queue.queueData.settings?.autoStart !== false}
          onSettingsChange={(settings) =>
            queue.callAction('/api/queue/settings', 'POST', settings)
          }
        />
      </div>
      <div className="space-y-1.5">
        {queue.visibleRows.length > 0 ? (
          queue.visibleRows.map((job) => (
            <QueueJobCard key={job.id} job={job} apiBase={apiBase} onAction={queue.callAction} />
          ))
        ) : (
          <p className="text-foreground-muted text-sm py-6 text-center">
            No queue items match current filter.
          </p>
        )}
      </div>
    </div>
  );
}
