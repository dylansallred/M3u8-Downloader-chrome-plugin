const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class AuthManager {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, 'auth.json');
    this.state = {
      pairing: null,
      tokens: [],
      updatedAt: Date.now(),
    };
    this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, 'utf8');
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        this.state = {
          pairing: parsed.pairing || null,
          tokens: Array.isArray(parsed.tokens) ? parsed.tokens : [],
          updatedAt: parsed.updatedAt || Date.now(),
        };
      }
    } catch {
      this.state = {
        pairing: null,
        tokens: [],
        updatedAt: Date.now(),
      };
    }
  }

  save() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.state.updatedAt = Date.now();
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), 'utf8');
  }

  generatePairingCode(ttlMs = 10 * 60 * 1000) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 8; i += 1) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }

    const now = Date.now();
    this.state.pairing = {
      code,
      createdAt: now,
      expiresAt: now + ttlMs,
      used: false,
    };
    this.save();

    return {
      code,
      expiresAt: this.state.pairing.expiresAt,
      ttlMs,
    };
  }

  clearExpiredPairing() {
    const pairing = this.state.pairing;
    if (!pairing) return;
    if (pairing.used || pairing.expiresAt <= Date.now()) {
      this.state.pairing = null;
      this.save();
    }
  }

  static hashToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
  }

  completePairing({ pairingCode, extensionId, extensionVersion, browser }) {
    this.clearExpiredPairing();

    const pairing = this.state.pairing;
    if (!pairing || pairing.used || pairing.expiresAt <= Date.now()) {
      const err = new Error('No valid pairing code. Generate a new code in desktop settings.');
      err.statusCode = 400;
      throw err;
    }

    const normalized = String(pairingCode || '').trim().toUpperCase();
    if (!normalized || normalized !== pairing.code) {
      const err = new Error('Invalid pairing code.');
      err.statusCode = 401;
      throw err;
    }

    const token = crypto.randomBytes(32).toString('hex');
    const tokenId = crypto.randomUUID();

    this.state.tokens.push({
      id: tokenId,
      tokenHash: AuthManager.hashToken(token),
      extensionId: extensionId || '',
      extensionVersion: extensionVersion || '',
      browser: browser || 'chrome',
      createdAt: Date.now(),
      lastUsedAt: null,
      revokedAt: null,
    });

    pairing.used = true;
    this.save();

    return {
      token,
      tokenId,
      issuedAt: new Date().toISOString(),
    };
  }

  verifyToken(token) {
    const hash = AuthManager.hashToken(token);
    const record = this.state.tokens.find((t) => t.tokenHash === hash && !t.revokedAt);
    if (!record) {
      return null;
    }
    record.lastUsedAt = Date.now();
    this.save();
    return record;
  }

  listTokens() {
    return this.state.tokens
      .filter((t) => !t.revokedAt)
      .map((t) => ({
        id: t.id,
        extensionId: t.extensionId,
        extensionVersion: t.extensionVersion,
        browser: t.browser,
        createdAt: t.createdAt,
        lastUsedAt: t.lastUsedAt,
      }));
  }

  revokeToken(id) {
    const record = this.state.tokens.find((t) => t.id === id && !t.revokedAt);
    if (!record) return false;
    record.revokedAt = Date.now();
    this.save();
    return true;
  }

  revokeAll() {
    let changed = false;
    this.state.tokens.forEach((t) => {
      if (!t.revokedAt) {
        t.revokedAt = Date.now();
        changed = true;
      }
    });
    if (changed) this.save();
    return changed;
  }

  isPairingRequired() {
    return this.state.tokens.filter((t) => !t.revokedAt).length === 0;
  }
}

module.exports = AuthManager;
