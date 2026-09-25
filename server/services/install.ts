import { config } from "../config";
import { db } from "../db";
import { hashToken, newAdminToken } from "./auth";
import { ensureOwner } from "./members";
import { exchangeCode, listAuthorizedSites } from "./oauth-service";
import { tokenStore } from "./token-store";
import { forgetClient, getClient } from "./webflow-client";

export const WEBHOOK_TRIGGERS = [
  { triggerType: "collection_item_changed", path: "item-changed" },
  { triggerType: "collection_item_created", path: "item-created" },
  { triggerType: "collection_item_deleted", path: "item-deleted" },
  { triggerType: "app_uninstalled", path: "app-uninstalled" },
] as const;

export function webhookUrl(siteId: string, path: string): string {
  return `${config.publicUrl}/webhooks/${encodeURIComponent(siteId)}/${path}`;
}

/** Registers (or re-registers) our webhooks for a site, removing stale registrations first. */
export async function registerWebhooks(siteId: string): Promise<void> {
  const client = getClient(siteId);
  for (const hook of await client.listWebhooks()) {
    if (hook.url.startsWith(`${config.publicUrl}/webhooks/`)) {
      try {
        await client.deleteWebhook(hook.id);
      } catch {
        // Already removed.
      }
    }
  }
  db.run(`DELETE FROM webhook_registrations WHERE site_id = ?`, [siteId]);
  for (const t of WEBHOOK_TRIGGERS) {
    try {
      const created = await client.createWebhook(t.triggerType, webhookUrl(siteId, t.path));
      db.run(`INSERT OR REPLACE INTO webhook_registrations (site_id, trigger_type, webflow_webhook_id) VALUES (?, ?, ?)`, [siteId, t.triggerType, created.id]);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[install] webhook ${t.triggerType} registration failed for ${siteId}:`, err);
    }
  }
}

/** The installing user (authorized_user:read) becomes the app owner. */
async function seedOwner(siteId: string): Promise<void> {
  try {
    const u = await getClient(siteId).getAuthorizedUser();
    const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email;
    ensureOwner(siteId, u.email, name);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[install] could not read the authorized user for ${siteId}; using a placeholder owner:`, err);
    ensureOwner(siteId, `owner+${siteId}@owner.invalid`, "Site owner");
  }
}

export interface InstallResult {
  siteId: string;
  adminToken: string;
}

/** OAuth callback body: exchange the code, store encrypted tokens, seed the owner, register webhooks. */
export async function completeInstall(code: string): Promise<InstallResult[]> {
  const token = await exchangeCode(code);
  const sites = await listAuthorizedSites(token.access_token);
  if (sites.length === 0) throw new Error("No sites were authorized for this installation");

  const results: InstallResult[] = [];
  for (const site of sites) {
    tokenStore.save(site.id, { accessToken: token.access_token, refreshToken: token.refresh_token ?? null, scopes: token.scope ?? config.webflow.scopes.join(",") });
    const adminToken = newAdminToken();
    db.run(`UPDATE installations SET admin_token_hash = ? WHERE site_id = ?`, [hashToken(adminToken), site.id]);
    db.run(`INSERT OR IGNORE INTO site_settings (site_id, reminder_lead_hours) VALUES (?, ?)`, [site.id, config.defaultReminderLeadHours]);
    await seedOwner(site.id);
    await registerWebhooks(site.id);
    results.push({ siteId: site.id, adminToken });
  }
  return results;
}

/** app-uninstalled cleanup: purge tokens, config and all stored approval data for the site. */
export function purgeInstallation(siteId: string): void {
  // Removing the installation row first lifts the append-only delete guard on transitions/audit_log.
  tokenStore.purge(siteId);
  db.transaction(() => {
    db.run(`DELETE FROM workflow_stages WHERE workflow_id IN (SELECT id FROM workflows WHERE site_id = ?)`, [siteId]);
    for (const table of ["workflows", "items", "transitions", "audit_log", "comments", "review_requests", "members", "site_settings", "webhook_registrations", "mail_log"]) {
      db.run(`DELETE FROM ${table} WHERE site_id = ?`, [siteId]);
    }
  });
  forgetClient(siteId);
}
