import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';

interface QueueSettingsBarProps {
  maxConcurrent: number;
  autoStart: boolean;
  onSettingsChange: (settings: { maxConcurrent: number; autoStart: boolean }) => void;
}

export function QueueSettingsBar({ maxConcurrent, autoStart, onSettingsChange }: QueueSettingsBarProps) {
  return (
    <div className="flex items-center gap-3 text-sm shrink-0">
      <div className="flex items-center gap-2">
        <label className="text-foreground-muted text-xs whitespace-nowrap">Max concurrent</label>
        <Input
          type="number"
          min={1}
          max={16}
          value={maxConcurrent}
          onChange={(e) =>
            onSettingsChange({ maxConcurrent: Number(e.target.value) || 1, autoStart })
          }
          className="w-16 h-7 text-xs bg-background border-border"
        />
      </div>
      <div className="flex items-center gap-2">
        <label className="text-foreground-muted text-xs whitespace-nowrap">Auto start</label>
        <Switch
          checked={autoStart}
          onCheckedChange={(checked) =>
            onSettingsChange({ maxConcurrent, autoStart: checked })
          }
        />
      </div>
    </div>
  );
}
