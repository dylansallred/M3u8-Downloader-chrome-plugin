export interface HistoryItem {
  id: string;
  fileName: string;
  relativePath?: string | null;
  absolutePath?: string | null;
  label: string;
  jobId: string | null;
  title: string | null;
  sizeBytes: number;
  modifiedAt: number;
  ext: string;
  thumbnailUrl: string | null;
  tmdbReleaseDate: string | null;
  tmdbMetadata: {
    overview?: string;
    runtime?: number;
    tagline?: string;
    genres?: string[];
  } | null;
  youtubeMetadata?: {
    channelName?: string;
    channelUrl?: string;
  } | null;
}
