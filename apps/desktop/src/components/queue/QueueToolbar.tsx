import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Play, Pause, Trash2 } from 'lucide-react';

interface QueueToolbarProps {
  filterText: string;
  filterStatus: string;
  onFilterTextChange: (text: string) => void;
  onFilterStatusChange: (status: string) => void;
  onStartAll: () => void;
  onPauseAll: () => void;
  onClearCompleted: () => void;
}

export function QueueToolbar({
  filterText,
  filterStatus,
  onFilterTextChange,
  onFilterStatusChange,
  onStartAll,
  onPauseAll,
  onClearCompleted,
}: QueueToolbarProps) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Input
        aria-label="Search"
        placeholder="Search title or job ID..."
        value={filterText}
        onChange={(e) => onFilterTextChange(e.target.value)}
        className="w-56 h-8 text-sm bg-background border-border"
      />
      <Select value={filterStatus} onValueChange={onFilterStatusChange}>
        <SelectTrigger aria-label="Status" className="w-36 h-8 text-sm bg-background border-border">
          <SelectValue placeholder="All statuses" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All</SelectItem>
          <SelectItem value="queued">Queued</SelectItem>
          <SelectItem value="downloading">Downloading</SelectItem>
          <SelectItem value="paused">Paused</SelectItem>
          <SelectItem value="completed">Completed</SelectItem>
          <SelectItem value="failed">Failed</SelectItem>
          <SelectItem value="cancelled">Cancelled</SelectItem>
        </SelectContent>
      </Select>

      <div className="ml-auto flex gap-1.5">
        <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={onStartAll}>
          <Play className="size-3" /> Start All
        </Button>
        <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={onPauseAll}>
          <Pause className="size-3" /> Pause All
        </Button>
        <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs text-destructive hover:text-destructive hover:bg-destructive-muted" onClick={onClearCompleted}>
          <Trash2 className="size-3" /> Clear Completed
        </Button>
      </div>
    </div>
  );
}
