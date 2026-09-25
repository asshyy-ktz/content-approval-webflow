import { AuditEntryDto, TransitionAction } from "../../shared/types";
import { db } from "../db";

/** Appends to the append-only audit_log. */
export function audit(siteId: string, actorEmail: string, event: string, detail: Record<string, unknown> = {}, collectionId: string | null = null, itemId: string | null = null): void {
  db.run(`INSERT INTO audit_log (site_id, actor_email, event, collection_id, item_id, detail_json) VALUES (?, ?, ?, ?, ?, ?)`, [siteId, actorEmail, event, collectionId, itemId, JSON.stringify(detail)]);
}

/** Appends to the append-only transitions log. Call inside the same transaction as the state change. */
export function insertTransition(
  siteId: string,
  collectionId: string,
  itemId: string,
  fromStage: string | null,
  toStage: string,
  action: TransitionAction,
  actorEmail: string,
  actorRole: string,
  note: string
): void {
  db.run(
    `INSERT INTO transitions (site_id, collection_id, item_id, from_stage, to_stage, action, actor_email, actor_role, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [siteId, collectionId, itemId, fromStage, toStage, action, actorEmail, actorRole, note]
  );
}

export interface AuditQuery {
  from?: string;
  to?: string;
  collectionId?: string;
  itemId?: string;
  limit: number;
}

interface TransitionRow {
  id: number;
  collection_id: string;
  item_id: string;
  from_stage: string | null;
  to_stage: string;
  action: string;
  actor_email: string;
  actor_role: string;
  note: string;
  created_at: string;
}

interface AuditRow {
  id: number;
  actor_email: string;
  event: string;
  collection_id: string | null;
  item_id: string | null;
  detail_json: string;
  created_at: string;
}

/** Unified, newest-first feed of transitions and audit events (used by the panel and the CSV export). */
export function auditFeed(siteId: string, q: AuditQuery): AuditEntryDto[] {
  const where: string[] = ["site_id = ?"];
  const params: string[] = [siteId];
  if (q.from) {
    where.push("date(created_at) >= ?");
    params.push(q.from);
  }
  if (q.to) {
    where.push("date(created_at) <= ?");
    params.push(q.to);
  }
  if (q.collectionId) {
    where.push("collection_id = ?");
    params.push(q.collectionId);
  }
  if (q.itemId) {
    where.push("item_id = ?");
    params.push(q.itemId);
  }
  const clause = where.join(" AND ");
  const transitions = db.all<TransitionRow>(`SELECT * FROM transitions WHERE ${clause} ORDER BY id DESC LIMIT ${Math.floor(q.limit)}`, params);
  const events = db.all<AuditRow>(`SELECT * FROM audit_log WHERE ${clause} ORDER BY id DESC LIMIT ${Math.floor(q.limit)}`, params);

  const out: AuditEntryDto[] = [
    ...transitions.map((t): AuditEntryDto => ({
      source: "transition",
      id: t.id,
      at: t.created_at,
      event: t.action,
      collectionId: t.collection_id,
      itemId: t.item_id,
      fromStage: t.from_stage,
      toStage: t.to_stage,
      actor: t.actor_email,
      role: t.actor_role,
      detail: t.note,
    })),
    ...events.map((e): AuditEntryDto => ({
      source: "audit",
      id: e.id,
      at: e.created_at,
      event: e.event,
      collectionId: e.collection_id,
      itemId: e.item_id,
      fromStage: null,
      toStage: null,
      actor: e.actor_email,
      role: "",
      detail: e.detail_json === "{}" ? "" : e.detail_json,
    })),
  ];
  out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.id - a.id));
  return out.slice(0, q.limit);
}

const CSV_HEADERS = ["timestamp_utc", "source", "event", "collection_id", "item_id", "from_stage", "to_stage", "actor", "role", "detail"];

function csvCell(value: string | number | null): string {
  let s = value === null ? "" : String(value);
  // Neutralize spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function auditToCsv(entries: AuditEntryDto[]): string {
  const lines = [CSV_HEADERS.join(",")];
  for (const e of entries) {
    lines.push([e.at, e.source, e.event, e.collectionId, e.itemId, e.fromStage, e.toStage, e.actor, e.role, e.detail].map(csvCell).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}
