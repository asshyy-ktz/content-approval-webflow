import crypto from "crypto";
import { config } from "../config";
import { db } from "../db";

export interface StoredTokens {
  accessToken: string;
  refreshToken: string | null;
  scopes: string;
}

/** Encrypted token storage interface; swap the implementation for a KMS/vault-backed one if needed. */
export interface TokenStore {
  save(siteId: string, tokens: StoredTokens): void;
  get(siteId: string): StoredTokens | undefined;
  purge(siteId: string): void;
}

function key(): Buffer {
  return crypto.createHash("sha256").update(config.tokenEncryptionKey).digest();
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")].join(".");
}

export function decryptSecret(blob: string): string {
  const [version, iv, tag, ct] = blob.split(".");
  if (version !== "v1" || !iv || !tag || !ct) throw new Error("Unsupported token blob format");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
}

interface TokenRow {
  access_token_enc: string;
  refresh_token_enc: string | null;
  scopes: string;
}

class SqliteTokenStore implements TokenStore {
  save(siteId: string, tokens: StoredTokens): void {
    db.run(
      `INSERT INTO installations (site_id, access_token_enc, refresh_token_enc, scopes)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(site_id) DO UPDATE SET access_token_enc = excluded.access_token_enc,
         refresh_token_enc = excluded.refresh_token_enc, scopes = excluded.scopes`,
      [siteId, encryptSecret(tokens.accessToken), tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null, tokens.scopes]
    );
  }

  get(siteId: string): StoredTokens | undefined {
    const row = db.get<TokenRow>(`SELECT access_token_enc, refresh_token_enc, scopes FROM installations WHERE site_id = ?`, [siteId]);
    if (!row) return undefined;
    return {
      accessToken: decryptSecret(row.access_token_enc),
      refreshToken: row.refresh_token_enc ? decryptSecret(row.refresh_token_enc) : null,
      scopes: row.scopes,
    };
  }

  purge(siteId: string): void {
    db.run(`DELETE FROM installations WHERE site_id = ?`, [siteId]);
  }
}

export let tokenStore: TokenStore = new SqliteTokenStore();

export function setTokenStore(store: TokenStore): void {
  tokenStore = store;
}
