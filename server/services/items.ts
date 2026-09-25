import { CommentDto, FieldDiffDto, ItemCardDto, ItemDetailDto, ReviewRequestDto, SyncResultDto, TransitionDto, BoardDto, TransitionAction } from "../../shared/types";
import { WebflowItem, WebflowItemWebhookPayload } from "../../shared/webflow-types";
import { db } from "../db";
import { Actor } from "./auth";
import { audit, insertTransition } from "./audit";
import { allowedActions, autoRevert, hashFields, ItemRow, requireItemRow, getItemRow } from "./approvals";
import { toCommentDto, CommentRow } from "./comments";
import { toReviewDto, ReviewRow } from "./reviews";
import { getClient } from "./webflow-client";
import { finalStage, getWorkflow, requireWorkflow, toWorkflowDto, Workflow } from "./workflow";

function titleOf(fields: Record<string, unknown>, fallback: string): string {
  const n = fields.name ?? fields.title ?? fields.slug;
  return typeof n === "string" && n.trim() ? n.trim().slice(0, 200) : fallback;
}

function slugOf(fields: Record<string, unknown>): string {
  return typeof fields.slug === "string" ? fields.slug : "";
}

function insertTracked(siteId: string, wf: Workflow, itemId: string, fields: Record<string, unknown>, lastUpdated: string | null): void {
  const first = wf.stages[0].key;
  db.transaction(() => {
    db.run(
      `INSERT OR IGNORE INTO items (site_id, collection_id, item_id, title, slug, stage_key, field_data_json, webflow_last_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [siteId, wf.collectionId, itemId, titleOf(fields, itemId), slugOf(fields), first, JSON.stringify(fields), lastUpdated]
    );
    insertTransition(siteId, wf.collectionId, itemId, null, first, "track" as TransitionAction, "system", "system", "Item started tracking");
  });
}

/**
 * Applies a fresh Webflow item to local state: starts tracking new items, refreshes cached fields, and
 * auto-reverts approved items whose content no longer matches the approved snapshot.
 * Returns "added", "reverted" or "updated".
 */
export function reconcileItem(siteId: string, wf: Workflow, wfItem: { id: string; lastUpdated?: string; fieldData?: Record<string, unknown> }): "added" | "reverted" | "updated" {
  const fields = wfItem.fieldData ?? {};
  const row = getItemRow(siteId, wf.collectionId, wfItem.id);
  if (!row) {
    insertTracked(siteId, wf, wfItem.id, fields, wfItem.lastUpdated ?? null);
    return "added";
  }
  if (row.stage_key === finalStage(wf).key && row.approved_hash && hashFields(fields) !== row.approved_hash) {
    autoRevert(siteId, wf, row, fields);
    return "reverted";
  }
  db.run(
    `UPDATE items SET title = ?, slug = ?, field_data_json = ?, webflow_last_updated = ?, updated_at = datetime('now') WHERE site_id = ? AND collection_id = ? AND item_id = ?`,
    [titleOf(fields, row.item_id), slugOf(fields), JSON.stringify(fields), wfItem.lastUpdated ?? row.webflow_last_updated, siteId, wf.collectionId, wfItem.id]
  );
  return "updated";
}

/** Pulls every item of the collection from Webflow and reconciles it with local tracking. */
export async function syncCollection(siteId: string, collectionId: string, actor: Actor): Promise<SyncResultDto> {
  const wf = requireWorkflow(siteId, collectionId);
  const live: WebflowItem[] = await getClient(siteId).listAllItems(collectionId);
  let added = 0;
  let reverted = 0;
  for (const it of live) {
    const r = reconcileItem(siteId, wf, it);
    if (r === "added") added++;
    else if (r === "reverted") reverted++;
  }
  const liveIds = new Set(live.map((i) => i.id));
  const gone = db.all<{ item_id: string }>(`SELECT item_id FROM items WHERE site_id = ? AND collection_id = ?`, [siteId, collectionId]).filter((r) => !liveIds.has(r.item_id));
  for (const g of gone) removeItem(siteId, collectionId, g.item_id);
  audit(siteId, actor.email, "collection_synced", { total: live.length, added, removed: gone.length, reverted }, collectionId);
  return { total: live.length, added, removed: gone.length, reverted };
}

function removeItem(siteId: string, collectionId: string, itemId: string): void {
  db.transaction(() => {
    db.run(`UPDATE review_requests SET status = 'cancelled', completed_at = datetime('now') WHERE site_id = ? AND collection_id = ? AND item_id = ? AND status = 'open'`, [siteId, collectionId, itemId]);
    db.run(`DELETE FROM items WHERE site_id = ? AND collection_id = ? AND item_id = ?`, [siteId, collectionId, itemId]);
    audit(siteId, "system", "item_removed", {}, collectionId, itemId);
  });
}

function itemIdOf(p: WebflowItemWebhookPayload): string | undefined {
  return p.id ?? p.itemId ?? p._id;
}

/** collection_item_changed / collection_item_created webhook handling. */
export async function handleItemChanged(siteId: string, payload: WebflowItemWebhookPayload): Promise<void> {
  const itemId = itemIdOf(payload);
  if (!itemId || !payload.collectionId) return;
  const wf = getWorkflow(siteId, payload.collectionId);
  if (!wf) return;
  let fields = payload.fieldData;
  const row = getItemRow(siteId, wf.collectionId, itemId);
  // For approved items the cached payload could be stale or out of order: compare against the live item instead.
  if (!fields || (row && row.stage_key === finalStage(wf).key)) {
    fields = (await getClient(siteId).getItem(wf.collectionId, itemId)).fieldData ?? {};
  }
  reconcileItem(siteId, wf, { id: itemId, lastUpdated: payload.lastUpdated, fieldData: fields });
}

/** collection_item_deleted webhook handling. */
export function handleItemDeleted(siteId: string, payload: WebflowItemWebhookPayload): void {
  const itemId = itemIdOf(payload);
  if (!itemId || !payload.collectionId) return;
  if (getItemRow(siteId, payload.collectionId, itemId)) removeItem(siteId, payload.collectionId, itemId);
}

interface CardRow extends ItemRow {
  open_comments: number;
  assignees: string | null;
  next_due: string | null;
}

const CARD_SQL = `
  SELECT i.*,
    (SELECT COUNT(*) FROM comments c WHERE c.site_id = i.site_id AND c.collection_id = i.collection_id AND c.item_id = i.item_id AND c.parent_id IS NULL AND c.resolved = 0) AS open_comments,
    (SELECT group_concat(DISTINCT r.assignee_email) FROM review_requests r WHERE r.site_id = i.site_id AND r.collection_id = i.collection_id AND r.item_id = i.item_id AND r.status = 'open') AS assignees,
    (SELECT MIN(r.due_at) FROM review_requests r WHERE r.site_id = i.site_id AND r.collection_id = i.collection_id AND r.item_id = i.item_id AND r.status = 'open' AND r.due_at IS NOT NULL) AS next_due
  FROM items i`;

function toCard(r: CardRow): ItemCardDto {
  return {
    collectionId: r.collection_id,
    itemId: r.item_id,
    title: r.title || r.slug || r.item_id,
    slug: r.slug,
    stageKey: r.stage_key,
    flagged: !!r.flagged,
    flagReason: r.flag_reason,
    approvedAt: r.approved_at,
    approvedBy: r.approved_by,
    publishedAt: r.published_at,
    openComments: r.open_comments,
    assignees: r.assignees ? r.assignees.split(",") : [],
    nextDueAt: r.next_due,
    updatedAt: r.updated_at,
  };
}

export function getCard(siteId: string, collectionId: string, itemId: string): ItemCardDto {
  requireItemRow(siteId, collectionId, itemId);
  const row = db.get<CardRow>(`${CARD_SQL} WHERE i.site_id = ? AND i.collection_id = ? AND i.item_id = ?`, [siteId, collectionId, itemId]) as CardRow;
  return toCard(row);
}

export function getBoard(siteId: string, collectionId: string): BoardDto {
  const wf = requireWorkflow(siteId, collectionId);
  const rows = db.all<CardRow>(`${CARD_SQL} WHERE i.site_id = ? AND i.collection_id = ? ORDER BY i.updated_at DESC`, [siteId, collectionId]);
  const columns = wf.stages.map((stage) => ({ stage, items: rows.filter((r) => r.stage_key === stage.key).map(toCard) }));
  // Items whose stage vanished (should not happen; saveWorkflow resets them) still show up in the first column.
  const known = new Set(wf.stages.map((s) => s.key));
  for (const r of rows) if (!known.has(r.stage_key)) columns[0].items.push(toCard(r));
  return { workflow: toWorkflowDto(wf), columns };
}

function parseFields(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Field-level diff of current content against the last approved snapshot (everything is "added" without one). */
export function diffFields(before: Record<string, unknown> | null, after: Record<string, unknown>): FieldDiffDto[] {
  const b = before ?? {};
  const keys = [...new Set([...Object.keys(b), ...Object.keys(after)])].sort();
  return keys.map((field): FieldDiffDto => {
    const inB = field in b;
    const inA = field in after;
    if (!inB) return { field, status: "added", before: null, after: after[field] };
    if (!inA) return { field, status: "removed", before: b[field], after: null };
    const same = JSON.stringify(b[field]) === JSON.stringify(after[field]);
    return { field, status: same ? "unchanged" : "changed", before: b[field], after: after[field] };
  });
}

interface TransitionRowFull {
  id: number;
  from_stage: string | null;
  to_stage: string;
  action: TransitionAction;
  actor_email: string;
  actor_role: string;
  note: string;
  created_at: string;
}

export async function getItemDetail(siteId: string, collectionId: string, itemId: string, actor: Actor): Promise<ItemDetailDto> {
  const wf = requireWorkflow(siteId, collectionId);
  requireItemRow(siteId, collectionId, itemId);
  // Refresh from Webflow so the diff reflects the current draft; fall back to cached content if the API is unavailable.
  try {
    const live = await getClient(siteId).getItem(collectionId, itemId);
    reconcileItem(siteId, wf, live);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[items] live refresh failed for ${itemId}:`, err);
  }
  const row = requireItemRow(siteId, collectionId, itemId);
  const snapshot = parseFields(row.approved_snapshot_json);
  const current = parseFields(row.field_data_json) ?? {};

  const transitions = db
    .all<TransitionRowFull>(`SELECT id, from_stage, to_stage, action, actor_email, actor_role, note, created_at FROM transitions WHERE site_id = ? AND collection_id = ? AND item_id = ? ORDER BY id DESC LIMIT 200`, [siteId, collectionId, itemId])
    .map((t): TransitionDto => ({ id: t.id, fromStage: t.from_stage, toStage: t.to_stage, action: t.action, actorEmail: t.actor_email, actorRole: t.actor_role, note: t.note, createdAt: t.created_at }));
  const comments = db
    .all<CommentRow>(`SELECT * FROM comments WHERE site_id = ? AND collection_id = ? AND item_id = ? ORDER BY id`, [siteId, collectionId, itemId])
    .map((c): CommentDto => toCommentDto(c));
  const reviews = db
    .all<ReviewRow>(`SELECT r.*, i.title AS item_title FROM review_requests r LEFT JOIN items i ON i.site_id = r.site_id AND i.collection_id = r.collection_id AND i.item_id = r.item_id WHERE r.site_id = ? AND r.collection_id = ? AND r.item_id = ? ORDER BY r.id DESC`, [siteId, collectionId, itemId])
    .map((r): ReviewRequestDto => toReviewDto(r));

  return {
    item: getCard(siteId, collectionId, itemId),
    workflow: toWorkflowDto(wf),
    hasSnapshot: snapshot !== null,
    diff: diffFields(snapshot, current),
    transitions,
    comments,
    reviews,
    allowedActions: allowedActions(actor, wf, row),
  };
}
