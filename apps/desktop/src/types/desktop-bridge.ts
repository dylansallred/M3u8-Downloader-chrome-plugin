import type { DesktopSettings } from './settings';
import type { PairingCode, Token } from './pairing';
import type { UpdaterState } from './updater';

export interface AppInfo {
  version: string;
  apiBaseUrl: string;
  apiVersion: string;
}

export interface DesktopBridge {
  getAppInfo(): Promise<AppInfo>;
  getSettings(): Promise<DesktopSettings>;
  saveSettings(settings: Partial<DesktopSettings>): Promise<DesktopSettings>;
  generatePairingCode(): Promise<PairingCode>;
  listTokens(): Promise<Token[]>;
  revokeToken(tokenId: string): Promise<{ ok: boolean }>;
  revokeAllTokens(): Promise<{ ok: boolean }>;
  getUpdaterState(): Promise<UpdaterState>;
  checkForUpdates(): Promise<{ ok: boolean }>;
  installUpdateNow(): Promise<{ ok: boolean }>;
  remindLater(minutes: number): Promise<{ ok: boolean; deferredUntil?: number }>;
  saveDiagnosticsFile(payload: unknown): Promise<{ ok: boolean; filePath?: string; error?: string }>;
  openDiagnosticsFolder(): Promise<{ ok: boolean; folderPath?: string; error?: string }>;
  exportSupportBundle(payload: unknown): Promise<{ ok: boolean; bundlePath?: string; error?: string }>;
  openHistoryFile(fileName: string): Promise<{ ok: boolean; error?: string }>;
  openHistoryFolder(fileName: string): Promise<{ ok: boolean; error?: string }>;
  onUpdaterEvent(cb: (event: UpdaterState) => void): () => void;
}

declare global {
  interface Window {
    desktop: DesktopBridge;
  }
}
