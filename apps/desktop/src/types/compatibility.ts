export interface CompatibilityInfo {
  loading: boolean;
  error: string | null;
  appVersion: string | null;
  protocolVersion: string | null;
  supportedProtocolVersions: { min: string; max: string } | null;
  minExtensionVersion: string | null;
  checkedAt: number | null;
  lastSuccessAt: number | null;
}
