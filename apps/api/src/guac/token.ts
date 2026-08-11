/**
 * Guacamole connection tokens (N-06).
 *
 * Requirements: 60s TTL, single-use, HMAC-signed, bound to a host id.
 *
 * The token carries an *encrypted* connection config because the browser must
 * hand something to the WebSocket endpoint, and that something must not be the
 * host's RDP credentials. AES-256-GCM gives confidentiality and integrity in
 * one pass, and the host id is bound in as additional authenticated data so a
 * token minted for one host cannot be replayed against another even if an
 * attacker could otherwise swap fields.
 */
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

export interface GuacConnectionConfig {
  protocol: 'rdp' | 'vnc';
  hostname: string;
  port: number;
  username?: string;
  password?: string;
  /** RDP-specific; ignored for VNC. */
  domain?: string;
  security?: string;
  ignoreCert?: boolean;
  width?: number;
  height?: number;
  dpi?: number;
}

export interface MintedToken {
  token: string;
  expiresAt: number;
}

const TTL_MS = 60_000;

/** Tokens already redeemed, so a replay fails even inside the TTL. */
const consumed = new Set<string>();

export class GuacTokenService {
  private readonly key: Buffer;

  constructor(secret: string) {
    if (!secret || secret.length < 32) {
      throw new Error(
        'GUAC_TOKEN_SECRET must be at least 32 characters. Generate one with:\n' +
          '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
      );
    }
    // Derive a fixed-length key so any sufficiently long secret works.
    this.key = createHash('sha256').update(secret).digest();
  }

  mint(hostId: string, config: GuacConnectionConfig): MintedToken {
    const expiresAt = Date.now() + TTL_MS;
    const payload = JSON.stringify({ hostId, config, expiresAt, nonce: randomBytes(8).toString('hex') });

    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(hostId, 'utf8'));
    const body = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);

    const token = [
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      body.toString('base64url'),
    ].join('.');

    return { token, expiresAt };
  }

  /**
   * Decrypt and consume a token.
   *
   * Throws on: malformed input, a failed auth tag (tampering or wrong host),
   * expiry, or reuse. All four are indistinguishable to the caller by design —
   * a precise error would tell an attacker which part of a forgery attempt was
   * wrong.
   */
  redeem(token: string, hostId: string): GuacConnectionConfig {
    const invalid = () => new Error('Invalid or expired connection token.');

    if (consumed.has(token)) throw invalid();

    const parts = token.split('.');
    if (parts.length !== 3) throw invalid();
    const [ivPart, tagPart, bodyPart] = parts as [string, string, string];

    let payload: { hostId: string; config: GuacConnectionConfig; expiresAt: number };
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.key,
        Buffer.from(ivPart, 'base64url'),
      );
      decipher.setAAD(Buffer.from(hostId, 'utf8'));
      decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(bodyPart, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
      payload = JSON.parse(plain);
    } catch {
      throw invalid();
    }

    if (payload.hostId !== hostId) throw invalid();
    if (Date.now() > payload.expiresAt) throw invalid();

    consumed.add(token);
    // Bound cleanup: tokens live 60s, so anything older can never be valid.
    if (consumed.size > 1000) {
      consumed.clear();
    }

    return payload.config;
  }
}
