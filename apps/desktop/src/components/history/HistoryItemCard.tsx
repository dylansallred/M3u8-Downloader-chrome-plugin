import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { FileVideo, FolderOpen, ExternalLink, Play, Trash2 } from 'lucide-react';
import type { HistoryItem } from '@/types/history';
import { resolveThumbnailUrl, extractYear } from '@/lib/utils';

interface HistoryItemCardProps {
  item: HistoryItem;
  apiBase: string;
  onOpenFile: (fileName: string) => void;
  onOpenFolder: (fileName: string) => void;
  onDelete: (fileName: string) => void;
}

function deriveTitle(item: HistoryItem): string {
  if (item.title) return item.title;
  // Clean the label: remove extension, replace underscores with spaces
  const name = item.label.replace(/\.[^.]+$/, '').replace(/_/g, ' ');
  return name || item.fileName;
}

export function HistoryItemCard({ item, apiBase, onOpenFile, onOpenFolder, onDelete }: HistoryItemCardProps) {
  const [showPreview, setShowPreview] = useState(false);
  const sizeMb = Math.round(item.sizeBytes / (1024 * 1024));
  const ext = String(item.ext || '').replace(/^\./, '').toUpperCase();
  const thumbnailUrl = resolveThumbnailUrl(item.thumbnailUrl, apiBase);
  const title = deriveTitle(item);
  const year = extractYear(item.tmdbReleaseDate);
  const genres = item.tmdbMetadata?.genres?.slice(0, 2) ?? [];
  const hasMetaLine = year || genres.length > 0;

  return (
    <>
    <Card className="bg-background-raised border-border hover:border-border/80 transition-colors duration-150 py-0 gap-0">
      <CardContent className="p-0 flex items-stretch overflow-hidden">
        {thumbnailUrl ? (
          <img
            src={thumbnailUrl}
            alt=""
            className="w-20 object-contain bg-black shrink-0 rounded-l-[var(--radius)] cursor-pointer"
            loading="lazy"
            onClick={() => setShowPreview(true)}
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
        ) : (
          <div className="w-20 flex items-center justify-center shrink-0 bg-background-hover rounded-l-[var(--radius)]">
            <FileVideo className="size-5 text-foreground-subtle" />
          </div>
        )}

        <div className="flex-1 min-w-0 py-1.5 px-2.5 flex flex-col justify-center">
          <h4 className="text-[13px] font-medium text-foreground truncate mb-0.5">{title}</h4>
          <div className="flex items-center gap-1.5">
            {item.jobId && (
              <span className="text-[10px] text-foreground-subtle font-mono">{item.jobId}</span>
            )}
            {item.jobId && (hasMetaLine || sizeMb > 0) && (
              <span className="text-[10px] text-foreground-subtle">&middot;</span>
            )}
            {year && <span className="text-[10px] text-foreground-muted">{year}</span>}
            {year && genres.length > 0 && <span className="text-[10px] text-foreground-subtle">&middot;</span>}
            {genres.map((g) => (
              <span key={g} className="text-[10px] text-foreground-muted">{g}</span>
            ))}
            {hasMetaLine && sizeMb > 0 && (
              <span className="text-[10px] text-foreground-subtle">&middot;</span>
            )}
            <span className="text-[10px] text-foreground-muted">{sizeMb} MB</span>
          </div>
        </div>

        <div className="flex items-center shrink-0 pr-2 gap-0.5">
          {ext && (
            <Badge variant="outline" className="text-[10px] font-normal border-border text-foreground-muted shrink-0 mr-1">
              {ext}
            </Badge>
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            title="Open File"
            onClick={() => onOpenFile(item.fileName)}
          >
            <ExternalLink className="size-3.5" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            title="Open Folder"
            onClick={() => onOpenFolder(item.fileName)}
          >
            <FolderOpen className="size-3.5" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            title="Stream"
            asChild
          >
            <a
              href={`${apiBase}/api/history/stream/${encodeURIComponent(item.fileName)}`}
              target="_blank"
              rel="noreferrer"
            >
              <Play className="size-3.5" />
            </a>
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            className="text-destructive/50 hover:text-destructive hover:bg-destructive-muted"
            title="Delete"
            onClick={() => onDelete(item.fileName)}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </CardContent>
    </Card>
    {thumbnailUrl && (
      <Dialog open={showPreview} onOpenChange={setShowPreview}>
        <DialogContent className="max-w-2xl p-2 bg-background border-border" showCloseButton={false}>
          <DialogTitle className="sr-only">Preview: {title}</DialogTitle>
          <DialogDescription className="sr-only">
            Full-size preview image for {title}.
          </DialogDescription>
          <img src={thumbnailUrl} alt={title} className="w-full rounded" />
        </DialogContent>
      </Dialog>
    )}
    </>
  );
}
