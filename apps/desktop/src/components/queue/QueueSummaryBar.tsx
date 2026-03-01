import { Badge } from '@/components/ui/badge';
import type { QueueSummary } from '@/types/queue';

interface QueueSummaryBarProps {
  summary: QueueSummary;
}

const ITEMS: { key: keyof QueueSummary; label: string; colorClass: string }[] = [
  { key: 'total', label: 'total', colorClass: '' },
  { key: 'downloading', label: 'downloading', colorClass: 'text-status-downloading' },
  { key: 'queued', label: 'queued', colorClass: 'text-status-queued' },
  { key: 'paused', label: 'paused', colorClass: 'text-status-paused' },
  { key: 'completed', label: 'completed', colorClass: 'text-status-completed' },
  { key: 'failed', label: 'failed', colorClass: 'text-status-failed' },
  { key: 'cancelled', label: 'cancelled', colorClass: 'text-status-cancelled' },
];

export function QueueSummaryBar({ summary }: QueueSummaryBarProps) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {ITEMS.filter(({ key }) => key === 'total' || summary[key] > 0).map(({ key, label, colorClass }) => (
        <Badge key={key} variant="outline" className={`text-xs font-normal border-border ${colorClass || 'text-foreground-muted'}`}>
          {summary[key]} {label}
        </Badge>
      ))}
    </div>
  );
}
