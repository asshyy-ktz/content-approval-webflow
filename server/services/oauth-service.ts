import crypto from "crypto";
import { WebflowSiteSummary, WebflowTokenResponse } from "../../shared/webflow-types";
import { config } from "../config";
import { db } from "../db";
import { tokenStore } from "./token-store";

const TOKEN_URL = "https://api.webflow.com/oauth/access_token";
const STATE_TTL_MS = 10 * 60 * 1000;

export function buildAuthorizeUrl(): string {
  const state = crypto.randomBytes(16).toString("hex");
  db.run(`DELETE FROM oauth_states WHERE created_at < ?`, [Date.now() - STATE_TTL_MS]);
  db.run(`INSERT INTO oauth_states (state, created_at) VALUES (?, ?)`, [state, Date.now()]);
  const params = new URLSearchParams({
    client_id: config.webflow.clientId,
    response_type: "code",
    redirect_uri: config.webflow.redirectUri,
    scope: config.webflow.scopes.join(" "),
    state,
  });
  return `https://webflow.com/oauth/authorize?${params.toString()}`;
}

export function consumeState(state: string | undefined): boolean {
  if (!state) return false;
  const row = db.get<{ created_at: number }>(`SELECT created_at FROM oauth_states WHERE state = ?`, [state]);
  if (!row) return false;
  db.run(`DELETE FROM oauth_states WHERE state = ?`, [state]);
  return Date.now() - row.created_at <= STATE_TTL_MS;
}

export async function exchangeCode(code: string): Promise<WebflowTokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: config.webflow.clientId,
      client_secret: config.webflow.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: config.webflow.redirectUri,
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status}): ${await res.text()}`);
  return (await res.json()) as WebflowTokenResponse;
}

export async function listAuthorizedSites(accessToken: string): Promise<WebflowSiteSummary[]> {
  const res = await fetch("https://api.webflow.com/v2/sites", { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
  if (!res.ok) throw new Error(`Listing sites failed (${res.status}): ${await res.text()}`);
  const json = (await res.json()) as { sites?: WebflowSiteSummary[] };
  return json.sites ?? [];
}

const inflight = new Map<string, Promise<boolean>>();

/** Uses the stored refresh token (when Webflow issued one). Returns true when a new access token was saved. */
export function refreshAccessToken(siteId: string): Promise<boolean> {
  const existing = inflight.get(siteId);
  if (existing) return existing;
  const p = doRefresh(siteId).finally(() => inflight.delete(siteId));
  inflight.set(siteId, p);
  return p;
}

async function doRefresh(siteId: string): Promise<boolean> {
  const tokens = tokenStore.get(siteId);
  if (!tokens?.refreshToken) return false;
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: config.webflow.clientId,
      client_secret: config.webflow.clientSecret,
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
    }),
  });
  if (!res.ok) return false;
  const json = (await res.json()) as WebflowTokenResponse;
  if (!json.access_token) return false;
  tokenStore.save(siteId, { accessToken: json.access_token, refreshToken: json.refresh_token ?? tokens.refreshToken, scopes: json.scope ?? tokens.scopes });
  return true;
}
