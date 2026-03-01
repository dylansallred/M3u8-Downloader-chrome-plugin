import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Separator } from '@/components/ui/separator';
import { KeyRound, Trash2 } from 'lucide-react';
import { useMemo } from 'react';
import type { PairingCode, TokenRow } from '@/types/pairing';
import { cn, compareVersions } from '@/lib/utils';

interface PairingCardProps {
  pairing: PairingCode | null;
  hasActivePairingCode: boolean;
  tokenRows: TokenRow[];
  tokenFilter: string;
  tokenSort: string;
  onFilterChange: (filter: string) => void;
  onSortChange: (sort: string) => void;
  onGenerateCode: () => void;
  onRevokeToken: (id: string) => void;
  onRevokeAll: () => void;
}

export function PairingCard({
  pairing,
  hasActivePairingCode,
  tokenRows,
  tokenFilter,
  tokenSort,
  onFilterChange,
  onSortChange,
  onGenerateCode,
  onRevokeToken,
  onRevokeAll,
}: PairingCardProps) {
  const visibleTokenRows = useMemo(() => {
    const filtered = tokenRows.filter((token) => {
      if (tokenFilter === 'outdated') return token.status === 'outdated';
      if (tokenFilter === 'compatible') return token.status === 'compatible';
      return true;
    });
    return filtered.slice().sort((a, b) => {
      if (tokenSort === 'extension') return String(a.extensionId || '').localeCompare(String(b.extensionId || ''));
      if (tokenSort === 'version') return compareVersions(b.displayVersion, a.displayVersion);
      if (tokenSort === 'status') {
        if (a.status !== b.status) return a.status === 'outdated' ? -1 : 1;
        return String(a.extensionId || '').localeCompare(String(b.extensionId || ''));
      }
      return 0;
    });
  }, [tokenRows, tokenFilter, tokenSort]);

  return (
    <Card className="bg-background-raised border-border">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">Extension Pairing</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5" onClick={onGenerateCode}>
          <KeyRound className="size-3.5" /> Generate Pairing Code
        </Button>

        {hasActivePairingCode && pairing && (
          <div className="border border-dashed border-border rounded-md p-3">
            <p className="text-sm">
              Code: <span className="font-mono font-semibold text-primary">{pairing.code}</span>
            </p>
            <p className="text-xs text-foreground-muted mt-1">
              Expires: {new Date(pairing.expiresAt).toLocaleString()}
            </p>
          </div>
        )}

        <Separator className="bg-border" />

        <div>
          <h4 className="text-xs font-medium text-foreground-muted uppercase tracking-wide mb-3">
            Paired Extensions
          </h4>

          {tokenRows.length === 0 ? (
            <p className="text-sm text-foreground-muted">No paired extensions.</p>
          ) : (
            <>
              <div className="flex gap-2 mb-3">
                <Select value={tokenFilter} onValueChange={onFilterChange}>
                  <SelectTrigger className="w-28 h-7 text-xs bg-background border-border">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="outdated">Outdated</SelectItem>
                    <SelectItem value="compatible">Compatible</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={tokenSort} onValueChange={onSortChange}>
                  <SelectTrigger className="w-28 h-7 text-xs bg-background border-border">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="status">Status</SelectItem>
                    <SelectItem value="extension">Extension</SelectItem>
                    <SelectItem value="version">Version</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <Table>
                <TableHeader>
                  <TableRow className="border-border hover:bg-transparent">
                    <TableHead className="text-[11px] uppercase tracking-wider text-foreground-subtle h-8">Extension</TableHead>
                    <TableHead className="text-[11px] uppercase tracking-wider text-foreground-subtle h-8">Version</TableHead>
                    <TableHead className="text-[11px] uppercase tracking-wider text-foreground-subtle h-8">Browser</TableHead>
                    <TableHead className="text-[11px] uppercase tracking-wider text-foreground-subtle h-8">Status</TableHead>
                    <TableHead className="text-[11px] uppercase tracking-wider text-foreground-subtle h-8 w-20">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleTokenRows.map((token) => (
                    <TableRow key={token.id} className="border-border-subtle">
                      <TableCell className="text-xs font-mono">{token.extensionId || 'unknown'}</TableCell>
                      <TableCell className="text-xs">{token.displayVersion}</TableCell>
                      <TableCell className="text-xs capitalize">{token.browser || 'chrome'}</TableCell>
                      <TableCell>
                        <Badge className={cn(
                          'text-[10px] uppercase tracking-wider border-0',
                          token.status === 'outdated'
                            ? 'bg-status-paused/15 text-status-paused'
                            : 'bg-status-completed/15 text-status-completed',
                        )}>
                          {token.status}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Button
                          size="xs"
                          variant="ghost"
                          className="text-destructive hover:text-destructive hover:bg-destructive-muted"
                          onClick={() => onRevokeToken(token.id)}
                        >
                          Revoke
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              {visibleTokenRows.length === 0 && (
                <p className="text-xs text-foreground-muted text-center py-4">
                  No rows match current filter.
                </p>
              )}

              <div className="mt-3">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs gap-1.5 text-destructive hover:text-destructive hover:bg-destructive-muted"
                  onClick={onRevokeAll}
                >
                  <Trash2 className="size-3" /> Revoke All
                </Button>
              </div>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
