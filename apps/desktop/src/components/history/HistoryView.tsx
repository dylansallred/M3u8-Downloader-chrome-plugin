import { useHistory } from '@/hooks/useHistory';
import { HistoryToolbar } from './HistoryToolbar';
import { HistoryItemCard } from './HistoryItemCard';

interface HistoryViewProps {
  apiBase: string;
}

export function HistoryView({ apiBase }: HistoryViewProps) {
  const history = useHistory(apiBase);

  return (
    <div className="animate-fade-slide-in space-y-5">
      <h1 className="sr-only">History</h1>
      <HistoryToolbar
        filterText={history.filterText}
        filterType={history.filterType}
        onFilterTextChange={history.setFilterText}
        onFilterTypeChange={history.setFilterType}
        onClearAll={history.clearAll}
      />
      <div className="space-y-2">
        {history.visibleItems.length > 0 ? (
          history.visibleItems.map((item) => (
            <HistoryItemCard
              key={item.id}
              item={item}
              apiBase={apiBase}
              onOpenFile={history.openFile}
              onOpenFolder={history.openFolder}
              onDelete={history.deleteItem}
            />
          ))
        ) : (
          <p className="text-foreground-muted text-sm py-8 text-center">
            No history items match current filter.
          </p>
        )}
      </div>
    </div>
  );
}
