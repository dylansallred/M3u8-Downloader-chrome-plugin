import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PairingCode, Token, TokenRow } from '@/types/pairing';
import type { CompatibilityInfo } from '@/types/compatibility';
import { compareVersions } from '@/lib/utils';
import { toast } from 'sonner';

export function usePairing(apiBase: string) {
  const [pairing, setPairing] = useState<PairingCode | null>(null);
  const [tokens, setTokens] = useState<Token[]>([]);
  const [tokenFilter, setTokenFilter] = useState('all');
  const [tokenSort, setTokenSort] = useState('status');
  const [clockNow, setClockNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setClockNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const loadTokens = useCallback(async () => {
    if (!window.desktop) return [];
    const nextTokens = await window.desktop.listTokens();
    setTokens(nextTokens || []);
    return nextTokens || [];
  }, []);

  useEffect(() => {
    loadTokens();
    const timer = setInterval(loadTokens, 2000);
    return () => clearInterval(timer);
  }, [loadTokens]);

  const generateCode = useCallback(async () => {
    const code = await window.desktop.generatePairingCode();
    setPairing(code);
  }, []);

  const hasActivePairingCode = useMemo(() => {
    if (!pairing?.expiresAt) return false;
    const expiresAt = new Date(pairing.expiresAt).getTime();
    if (!Number.isFinite(expiresAt)) return false;
    return expiresAt > clockNow;
  }, [pairing, clockNow]);

  const revokeToken = useCallback(async (tokenId: string) => {
    await window.desktop.revokeToken(tokenId);
    await loadTokens();
    toast.success('Token revoked');
  }, [loadTokens]);

  const revokeAll = useCallback(async () => {
    await window.desktop.revokeAllTokens();
    await loadTokens();
    toast.success('All tokens revoked');
  }, [loadTokens]);

  return {
    pairing,
    tokens,
    tokenFilter,
    tokenSort,
    setTokenFilter,
    setTokenSort,
    loadTokens,
    generateCode,
    hasActivePairingCode,
    revokeToken,
    revokeAll,
    clockNow,
  };
}
