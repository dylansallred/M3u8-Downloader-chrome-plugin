import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Trash2 } from 'lucide-react';

interface HistoryToolbarProps {
  filterText: string;
  filterType: string;
  onFilterTextChange: (text: string) => void;
  onFilterTypeChange: (type: string) => void;
  onClearAll: () => void;
}

export function HistoryToolbar({
  filterText,
  filterType,
  onFilterTextChange,
  onFilterTypeChange,
  onClearAll,
}: HistoryToolbarProps) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Input
        placeholder="Search label or file name..."
        value={filterText}
        onChange={(e) => onFilterTextChange(e.target.value)}
        className="w-56 h-8 text-sm bg-background border-border"
      />
      <Select value={filterType} onValueChange={onFilterTypeChange}>
        <SelectTrigger className="w-24 h-8 text-sm bg-background border-border">
          <SelectValue placeholder="All" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All</SelectItem>
          <SelectItem value="mp4">MP4</SelectItem>
          <SelectItem value="ts">TS</SelectItem>
        </SelectContent>
      </Select>
      <div className="ml-auto">
        <Button
          size="sm"
          variant="outline"
          className="h-8 gap-1.5 text-xs text-destructive hover:text-destructive hover:bg-destructive-muted"
          onClick={onClearAll}
        >
          <Trash2 className="size-3" /> Clear History
        </Button>
      </div>
    </div>
  );
}
