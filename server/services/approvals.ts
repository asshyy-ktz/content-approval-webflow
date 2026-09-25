import crypto from "crypto";
import { UserAction } from "../../shared/types";
import { db } from "../db";
import { Actor } from "./auth";
import { audit, insertTransition } from "./audit";
import { HttpError } from "./errors";
import { membersWithRoles, ownerEmails } from "./members";
import { notifyMany } from "./mailer";
import { finalStage, requireWorkflow, stageIndex, Workflow } from "./workflow";
import { getClient } from "./webflow-client";

export interface ItemRow {
  site_id: string;
  collection_id: string;
  item_id: string;
  title: string;
  slug: string;
  stage_key: string;
  field_data_json: string;
  approved_snapshot_json: string | null;
  approved_hash: string | null;
  approved_at: string | null;
  approved_by: string | null;
  flagged: number;
  flag_reason: string | null;
  published_at: string | null;
  webflow_last_updated: string | null;
  created_at: string;
  updated_at: string;
}

export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

export function hashFields(fields: Record<string, unknown>): string {
  return crypto.createHash("sha256").update(stableStringify(fields)).digest("hex");
}

export function getItemRow(siteId: string, collectionId: string, itemId: string): ItemRow | undefined {
  return db.get<ItemRow>(`SELECT * FROM items WHERE site_id = ? AND collection_id = ? AND item_id = ?`, [siteId, collectionId, itemId]);
}

export function requireItemRow(siteId: string, collectionId: string, itemId: string): ItemRow {
  const row = getItemRow(siteId, collectionId, itemId);
  if (!row) throw new HttpError(404, "Item is not tracked; sync the collection first", "item_not_tracked");
  return row;
}

/** The role that authorizes `actor` to move items out of the stage, or null. Owners bypass role checks. */
export function authorizingRole(actor: Actor, requiredRoles: string[]): string | null {
  if (actor.isOwner) return "owner";
  return requiredRoles.find((r) => actor.roles.includes(r)) ?? null;
}

export function allowedActions(actor: Actor, wf: Workflow, item: ItemRow): UserAction[] {
  const idx = stageIndex(wf, item.stage_key);
  if (idx < 0 || !authorizingRole(actor, wf.stages[idx].requiredRoles)) return [];
  const last = wf.stages.length - 1;
  const out: UserAction[] = [];
  if (idx < last) out.push("advance");
  if (idx > 0) out.push("reject", "request_changes");
  if (idx === last) out.push("publish");
  return out;
}

function itemLabel(item: ItemRow): string {
  return item.title || item.slug || item.item_id;
}

/** approve (advance), reject (back to the first stage) or request changes (back one stage). */
export async function performAction(siteId: string, collectionId: string, itemId: string, action: "advance" | "reject" | "request_changes", actor: Actor, noteInput?: string): Promise<ItemRow> {
  const wf = requireWorkflow(siteId, collectionId);
  const item = requireItemRow(siteId, collectionId, itemId);
  const idx = stageIndex(wf, item.stage_key);
  if (idx < 0) throw new HttpError(409, "Item is in a stage that no longer exists; re-sync the collection", "unknown_stage");
  const role = authorizingRole(actor, wf.stages[idx].requiredRoles);
  if (!role) throw new HttpError(403, `Moving items out of "${wf.stages[idx].name}" requires one of: ${wf.stages[idx].requiredRoles.join(", ")}`, "forbidden");

  const last = wf.stages.length - 1;
  const note = (noteInput ?? "").trim().slice(0, 2000);
  let target: number;
  if (action === "advance") {
    if (idx >= last) throw new HttpError(409, "Item is already at the final stage", "already_final");
    target = idx + 1;
  } else {
    if (idx === 0) throw new HttpError(409, "Item is already at the first stage", "already_first");
    if (!note) throw new HttpError(400, "A note is required when rejecting or requesting changes", "note_required");
    target = action === "reject" ? 0 : idx - 1;
  }
  const from = wf.stages[idx];
  const to = wf.stages[target];

  // Reaching the final stage captures the live content as the approved snapshot (baseline for later diffs).
  let snapshot: Record<string, unknown> | null = null;
  if (action === "advance" && target === last) snapshot = (await getClient(siteId).getItem(collectionId, itemId)).fieldData ?? {};

  db.transaction(() => {
    if (snapshot) {
      db.run(
        `UPDATE items SET stage_key = ?, field_data_json = ?, approved_snapshot_json = ?, approved_hash = ?, approved_at = datetime('now'), approved_by = ?, flagged = 0, flag_reason = NULL, updated_at = datetime('now')
         WHERE site_id = ? AND collection_id = ? AND item_id = ?`,
        [to.key, JSON.stringify(snapshot), JSON.stringify(snapshot), hashFields(snapshot), actor.email, siteId, collectionId, itemId]
      );
    } else {
      db.run(`UPDATE items SET stage_key = ?, updated_at = datetime('now') WHERE site_id = ? AND collection_id = ? AND item_id = ?`, [to.key, siteId, collectionId, itemId]);
    }
    insertTransition(siteId, collectionId, itemId, from.key, to.key, action, actor.email, role, note);
    db.run(
      `UPDATE review_requests SET status = 'done', completed_at = datetime('now')
       WHERE site_id = ? AND collection_id = ? AND item_id = ? AND stage_key = ? AND assignee_email = ? AND status = 'open'`,
      [siteId, collectionId, itemId, from.key, actor.email]
    );
  });

  const verb = action === "advance" ? "moved forward" : action === "reject" ? "rejected" : "sent back for changes";
  notifyMany(
    siteId,
    membersWithRoles(siteId, to.requiredRoles),
    "stage_change",
    `"${itemLabel(item)}" ${verb}: now in ${to.name}`,
    `${actor.email} ${verb} "${itemLabel(item)}" from ${from.name} to ${to.name}.${note ? `\n\nNote: ${note}` : ""}`,
    actor.email
  );
  return requireItemRow(siteId, collectionId, itemId);
}

/**
 * Moves an approved item back to the review stage because it was edited after approval, and flags it for the owner.
 * Nothing is un-published: if the item is live, the previously approved version stays live until someone acts.
 */
export function autoRevert(siteId: string, wf: Workflow, item: ItemRow, liveFields: Record<string, unknown>): void {
  const wasLive = !!item.published_at;
  const reason = `Edited in Webflow after approval${wasLive ? "; the previously approved version may still be live and was NOT unpublished" : ""}. Review the changes and re-approve.`;
  const revertKey = wf.revertStageKey;
  db.transaction(() => {
    db.run(
      `UPDATE items SET stage_key = ?, flagged = 1, flag_reason = ?, field_data_json = ?, updated_at = datetime('now') WHERE site_id = ? AND collection_id = ? AND item_id = ?`,
      [revertKey, reason, JSON.stringify(liveFields), siteId, item.collection_id, item.item_id]
    );
    insertTransition(siteId, item.collection_id, item.item_id, item.stage_key, revertKey, "auto_revert", "system", "system", reason);
    audit(siteId, "system", "item_flagged", { reason, wasLive }, item.collection_id, item.item_id);
  });
  const recipients = [...ownerEmails(siteId), ...(item.approved_by ? [item.approved_by] : [])];
  notifyMany(siteId, recipients, "item_flagged", `Approved item edited: "${itemLabel(item)}"`, `${reason}\n\nCollection ${wf.collectionName || wf.collectionId}, item ${item.item_id}.`);
}

/** Publishes an item through the Data API, only when it is at the final stage and unchanged since approval. */
export async function publishItem(siteId: string, collectionId: string, itemId: string, actor: Actor): Promise<ItemRow> {
  const wf = requireWorkflow(siteId, collectionId);
  const item = requireItemRow(siteId, collectionId, itemId);
  const fin = finalStage(wf);
  if (item.stage_key !== fin.key || !item.approved_hash) throw new HttpError(409, `Only items at the final stage ("${fin.name}") can be published`, "not_approved");
  const role = authorizingRole(actor, fin.requiredRoles);
  if (!role) throw new HttpError(403, `Publishing requires one of: ${fin.requiredRoles.join(", ")}`, "forbidden");

  // Gate on the authoritative live content, not on cached data.
  const client = getClient(siteId);
  const live = await client.getItem(collectionId, itemId);
  const fields = live.fieldData ?? {};
  if (hashFields(fields) !== item.approved_hash) {
    autoRevert(siteId, wf, item, fields);
    throw new HttpError(409, "The item changed after approval; it was moved back to review and not published", "content_changed");
  }

  const result = await client.publishItems(collectionId, [itemId]);
  if (result.errors && result.errors.length > 0) throw new HttpError(502, `Webflow refused to publish: ${result.errors.join("; ")}`, "publish_failed");

  db.transaction(() => {
    db.run(`UPDATE items SET published_at = datetime('now'), updated_at = datetime('now') WHERE site_id = ? AND collection_id = ? AND item_id = ?`, [siteId, collectionId, itemId]);
    insertTransition(siteId, collectionId, itemId, fin.key, fin.key, "publish", actor.email, role, "");
    audit(siteId, actor.email, "item_published", { hash: item.approved_hash }, collectionId, itemId);
  });
  return requireItemRow(siteId, collectionId, itemId);
}

/** Owner acknowledges an auto-revert flag. */
export function clearFlag(siteId: string, collectionId: string, itemId: string, actor: Actor): ItemRow {
  const item = requireItemRow(siteId, collectionId, itemId);
  db.run(`UPDATE items SET flagged = 0, flag_reason = NULL, updated_at = datetime('now') WHERE site_id = ? AND collection_id = ? AND item_id = ?`, [siteId, collectionId, itemId]);
  audit(siteId, actor.email, "flag_cleared", { previous: item.flag_reason }, collectionId, itemId);
  return requireItemRow(siteId, collectionId, itemId);
}
