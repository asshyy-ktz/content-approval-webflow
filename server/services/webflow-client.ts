// Hand-rolled typed client for Webflow Data API v2 (no SDK dependency).
// Cross-cutting: per-site token bucket (60 req/min), refresh-on-401 retry, 429 exponential backoff honoring Retry-After.

import {
  PublishItemsResponse,
  WebflowAuthorizedUser,
  WebflowCollection,
  WebflowCollectionSummary,
  WebflowItem,
  WebflowItemListResponse,
  WebflowSiteSummary,
  WebflowWebhook,
} from "../../shared/webflow-types";
import { refreshAccessToken } from "./oauth-service";
import { tokenStore } from "./token-store";

const API_BASE = "https://api.webflow.com/v2";
const MAX_429_RETRIES = 5;
const MAX_5XX_RETRIES = 2;
const PAGE_SIZE = 100;
const PUBLISH_BATCH = 100;

export class WebflowApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`Webflow API error ${status}: ${JSON.stringify(body)}`);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Token bucket sized for Webflow's 60 requests/minute limit: capacity 60, refilling one token per second.
 * block() lets a 429 pause every caller of the same site until the Retry-After window has passed.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill = Date.now();
  private blockedUntil = 0;

  constructor(private capacity = 60, private refillPerMinute = 60) {
    this.tokens = capacity;
  }

  block(ms: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, Date.now() + ms);
    this.tokens = 0;
    this.lastRefill = this.blockedUntil;
  }

  private refill(now: number): void {
    if (now <= this.lastRefill) return;
    const gained = ((now - this.lastRefill) / 60000) * this.refillPerMinute;
    this.tokens = Math.min(this.capacity, this.tokens + gained);
    this.lastRefill = now;
  }

  async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      if (now < this.blockedUntil) {
        await sleep(this.blockedUntil - now);
        continue;
      }
      this.refill(now);
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await sleep(Math.ceil(((1 - this.tokens) / this.refillPerMinute) * 60000));
    }
  }
}

const limiters = new Map<string, TokenBucket>();
function limiterFor(siteId: string): TokenBucket {
  let l = limiters.get(siteId);
  if (!l) {
    l = new TokenBucket();
    limiters.set(siteId, l);
  }
  return l;
}

function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | undefined>;
}

export class WebflowClient {
  private limiter: TokenBucket;

  constructor(public readonly siteId: string) {
    this.limiter = limiterFor(siteId);
  }

  private async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) qs.set(k, String(v));
    const qstr = qs.toString();
    const url = `${API_BASE}${path}${qstr ? `?${qstr}` : ""}`;

    let refreshed = false;
    let retries429 = 0;
    let retries5xx = 0;

    for (;;) {
      await this.limiter.acquire();
      const tokens = tokenStore.get(this.siteId);
      if (!tokens) throw new WebflowApiError(401, { message: `No stored token for site ${this.siteId}` });

      const res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${tokens.accessToken}`, Accept: "application/json", "Content-Type": "application/json" },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });

      if (res.status === 401 && !refreshed) {
        refreshed = true;
        if (await refreshAccessToken(this.siteId)) continue;
      }

      if (res.status === 429 && retries429 < MAX_429_RETRIES) {
        // Exponential backoff (1s, 2s, 4s...) but never shorter than the server's Retry-After.
        const backoff = 1000 * 2 ** retries429;
        const wait = Math.max(backoff, parseRetryAfterMs(res.headers.get("Retry-After")) ?? 0) + Math.floor(Math.random() * 250);
        this.limiter.block(wait);
        retries429++;
        continue;
      }

      if (res.status >= 500 && method === "GET" && retries5xx < MAX_5XX_RETRIES) {
        await sleep(500 * 2 ** retries5xx);
        retries5xx++;
        continue;
      }

      if (!res.ok) throw new WebflowApiError(res.status, await res.json().catch(() => ({})));
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }
  }

  /** GET /v2/sites/{siteId} */
  getSite(): Promise<WebflowSiteSummary> {
    return this.request("GET", `/sites/${this.siteId}`);
  }

  /** GET /v2/token/authorized_by (needs authorized_user:read) */
  getAuthorizedUser(): Promise<WebflowAuthorizedUser> {
    return this.request("GET", `/token/authorized_by`);
  }

  /** GET /v2/sites/{siteId}/collections */
  async listCollections(): Promise<WebflowCollectionSummary[]> {
    const r = await this.request<{ collections?: WebflowCollectionSummary[] }>("GET", `/sites/${this.siteId}/collections`);
    return r.collections ?? [];
  }

  /** GET /v2/collections/{collectionId} */
  getCollection(collectionId: string): Promise<WebflowCollection> {
    return this.request("GET", `/collections/${encodeURIComponent(collectionId)}`);
  }

  /** GET /v2/collections/{collectionId}/items, paginated to completion. */
  async listAllItems(collectionId: string): Promise<WebflowItem[]> {
    const all: WebflowItem[] = [];
    let offset = 0;
    for (;;) {
      const page = await this.request<WebflowItemListResponse>("GET", `/collections/${encodeURIComponent(collectionId)}/items`, { query: { limit: PAGE_SIZE, offset } });
      all.push(...(page.items ?? []));
      offset += PAGE_SIZE;
      if (!page.items || page.items.length === 0 || offset >= (page.pagination?.total ?? 0)) return all;
    }
  }

  /** GET /v2/collections/{collectionId}/items/{itemId} */
  getItem(collectionId: string, itemId: string): Promise<WebflowItem> {
    return this.request("GET", `/collections/${encodeURIComponent(collectionId)}/items/${encodeURIComponent(itemId)}`);
  }

  /** POST /v2/collections/{collectionId}/items/publish */
  async publishItems(collectionId: string, itemIds: string[]): Promise<PublishItemsResponse> {
    const published: string[] = [];
    const errors: string[] = [];
    for (let i = 0; i < itemIds.length; i += PUBLISH_BATCH) {
      const r = await this.request<PublishItemsResponse | undefined>("POST", `/collections/${encodeURIComponent(collectionId)}/items/publish`, { body: { itemIds: itemIds.slice(i, i + PUBLISH_BATCH) } });
      published.push(...(r?.publishedItemIds ?? []));
      errors.push(...(r?.errors ?? []));
    }
    return { publishedItemIds: published, errors };
  }

  async listWebhooks(): Promise<WebflowWebhook[]> {
    const r = await this.request<{ webhooks: WebflowWebhook[] }>("GET", `/sites/${this.siteId}/webhooks`);
    return r.webhooks ?? [];
  }

  createWebhook(triggerType: string, url: string): Promise<WebflowWebhook> {
    return this.request("POST", `/sites/${this.siteId}/webhooks`, { body: { triggerType, url } });
  }

  async deleteWebhook(webhookId: string): Promise<void> {
    await this.request("DELETE", `/webhooks/${webhookId}`);
  }
}

const clients = new Map<string, WebflowClient>();

export function getClient(siteId: string): WebflowClient {
  let c = clients.get(siteId);
  if (!c) {
    c = new WebflowClient(siteId);
    clients.set(siteId, c);
  }
  return c;
}

export function forgetClient(siteId: string): void {
  clients.delete(siteId);
  limiters.delete(siteId);
}
