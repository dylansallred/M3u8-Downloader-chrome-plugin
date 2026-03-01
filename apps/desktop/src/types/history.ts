export interface HistoryItem {
  id: string;
  fileName: string;
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
}
