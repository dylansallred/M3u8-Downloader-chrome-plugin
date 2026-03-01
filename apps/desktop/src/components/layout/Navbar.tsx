import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { AlertTriangle, ArrowDownToLine } from 'lucide-react';
import { cn } from '@/lib/utils';

type View = 'queue' | 'history' | 'settings';

const TABS: { id: View; label: string }[] = [
  { id: 'queue', label: 'Queue' },
  { id: 'history', label: 'History' },
  { id: 'settings', label: 'Settings' },
];

interface NavbarProps {
  currentView: View;
  onViewChange: (view: View) => void;
  status: string;
  compatibilityWarning: string;
  hasUpdate: boolean;
}

export function Navbar({ currentView, onViewChange, status, compatibilityWarning, hasUpdate }: NavbarProps) {
  return (
    <header className="drag-region h-12 border-b border-border flex items-center px-4 gap-4 shrink-0">
      <span className="no-drag text-sm font-semibold text-foreground tracking-tight select-none">
        FetchV
      </span>

      <nav className="no-drag flex items-center gap-0.5 ml-2">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => onViewChange(tab.id)}
            className={cn(
              'px-3 py-1.5 rounded-md text-[13px] font-medium transition-all duration-150',
              currentView === tab.id
                ? 'bg-background-active text-foreground'
                : 'text-foreground-muted hover:text-foreground hover:bg-background-hover',
            )}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <div className="flex-1" />

      <div className="no-drag flex items-center gap-2">
        {hasUpdate && (
          <Badge className="bg-primary/15 text-primary border-0 text-[10px] uppercase tracking-wider gap-1">
            <ArrowDownToLine className="size-3" />
            Update Ready
          </Badge>
        )}
        {compatibilityWarning && (
          <button
            onClick={() => onViewChange('settings')}
            title={compatibilityWarning}
            className="text-status-paused hover:text-status-paused/80 transition-colors"
          >
            <AlertTriangle className="size-4" />
          </button>
        )}
        <span className="text-xs text-foreground-subtle truncate max-w-80">{status}</span>
      </div>
    </header>
  );
}
