import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CompatibilityInfo } from '@/types/compatibility';

export function useCompatibility(apiBase: string) {
  const [compatibility, setCompatibility] = useState<CompatibilityInfo>({
    loading: true,
    error: null,
    appVersion: null,
    protocolVersion: null,
    supportedProtocolVersions: null,
    minExtensionVersion: null,
    checkedAt: null,
    lastSuccessAt: null,
  });
  const [clockNow, setClockNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setClockNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const refresh = useCallback(async () => {
    const now = Date.now();
    try {
      const res = await fetch(`${apiBase}/v1/health`, {
        headers: { 'X-Client': 'fetchv-extension', 'X-Protocol-Version': '1' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setCompatibility({
        loading: false,
        error: null,
        appVersion: data?.appVersion || null,
        protocolVersion: data?.protocolVersion || null,
        supportedProtocolVersions: data?.supportedProtocolVersions || null,
        minExtensionVersion: data?.minExtensionVersion || null,
        checkedAt: now,
        lastSuccessAt: now,
      });
      return { ok: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setCompatibility((prev) => ({
        loading: false,
        error: `Unable to read compatibility info: ${message}`,
        appVersion: prev.appVersion,
        protocolVersion: prev.protocolVersion,
        supportedProtocolVersions: prev.supportedProtocolVersions,
        minExtensionVersion: prev.minExtensionVersion,
        checkedAt: now,
        lastSuccessAt: prev.lastSuccessAt || null,
      }));
      return { ok: false, error: message };
    }
  }, [apiBase]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, [refresh]);

  const isStale = useMemo(() => {
    const thresholdMs = 10 * 60 * 1000;
    if (!compatibility.lastSuccessAt) return true;
    return clockNow - compatibility.lastSuccessAt > thresholdMs;
  }, [compatibility.lastSuccessAt, clockNow]);

  return { compatibility, isStale, refresh, clockNow };
}
