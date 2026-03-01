export interface PairingCode {
  code: string;
  expiresAt: string;
}

export interface Token {
  id: string;
  extensionId: string;
  extensionVersion: string;
  browser: string;
}

export interface TokenRow extends Token {
  displayVersion: string;
  status: 'compatible' | 'outdated';
  isOutdated: boolean;
}
