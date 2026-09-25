import { ReviewRequestDto, ReviewStatus } from "../../shared/types";
import { db } from "../db";
import { Actor } from "./auth";
import { audit } from "./audit";
import { HttpError } from "./errors";
import { findMemberByEmail } from "./members";
import { notifyMany } from "./mailer";
import { requireItemRow } from "./approvals";
import { config } from "../config";

export interface ReviewRow {
  id: number;
  site_id: string;
  collection_id: string;
  item_id: string;
  stage_key: string;
  requested_by: string;
  assignee_email: string;
  due_at: string | null;
  status: ReviewStatus;
  note: string;
  reminder_sent_at: string | null;
  created_at: string;
  completed_at: string | null;
  item_title?: string | null;
}

export function toReviewDto(r: ReviewRow): ReviewRequestDto {
  return {
    id: r.id,
    collectionId: r.collection_id,
    itemId: r.item_id,
    itemTitle: r.item_title || r.item_id,
    stageKey: r.stage_key,
    requestedBy: r.requested_by,
    assigneeEmail: r.assignee_email,
    dueAt: r.due_at,
    status: r.status,
    note: r.note,
    createdAt: r.created_at,
    completedAt: r.completed_at,
    overdue: r.status === "open" && !!r.due_at && Date.parse(r.due_at) < Date.now(),
  };
}

const REVIEW_SQL = `SELECT r.*, i.title AS item_title FROM review_requests r LEFT JOIN items i ON i.site_id = r.site_id AND i.collection_id = r.collection_id AND i.item_id = r.item_id`;

function getReview(siteId: string, id: number): ReviewRow {
  const row = db.get<ReviewRow>(`${REVIEW_SQL} WHERE r.site_id = ? AND r.id = ?`, [siteId, id]);
  if (!row) throw new HttpError(404, "Review request not found");
  return row;
}

export function createReview(siteId: string, collectionId: string, itemId: string, actor: Actor, input: { assigneeEmail: unknown; dueAt?: unknown; note?: unknown }): ReviewRequestDto {
  const item = requireItemRow(siteId, collectionId, itemId);
  const assignee = typeof input.assigneeEmail === "string" ? findMemberByEmail(siteId, input.assigneeEmail) : undefined;
  if (!assignee) throw new HttpError(400, "assigneeEmail must belong to a team member");
  let dueAt: string | null = null;
  if (input.dueAt !== undefined && input.dueAt !== null && input.dueAt !== "") {
    const t = typeof input.dueAt === "string" ? Date.parse(input.dueAt) : NaN;
    if (Number.isNaN(t)) throw new HttpError(400, "dueAt must be an ISO-8601 date-time");
    if (t > Date.now() + 366 * 86400000) throw new HttpError(400, "dueAt is more than a year away");
    dueAt = new Date(t).toISOString();
  }
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 1000) : "";
  const r = db.run(`INSERT INTO review_requests (site_id, collection_id, item_id, stage_key, requested_by, assignee_email, due_at, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
    siteId,
    collectionId,
    itemId,
    item.stage_key,
    actor.email,
    assignee.email,
    dueAt,
    note,
  ]);
  audit(siteId, actor.email, "review_requested", { reviewId: Number(r.lastInsertRowid), assignee: assignee.email, dueAt }, collectionId, itemId);
  notifyMany(
    siteId,
    [assignee.email],
    "review_request",
    `Review requested: "${item.title || item.item_id}"`,
    `${actor.email} asked you to review "${item.title || item.item_id}" (stage ${item.stage_key})${dueAt ? `, due ${dueAt}` : ""}.${note ? `\n\nNote: ${note}` : ""}`,
    actor.email
  );
  return toReviewDto(getReview(siteId, Number(r.lastInsertRowid)));
}

/** Marks a request done or cancelled. Assignee, requester or the owner may do it. */
export function closeReview(siteId: string, id: number, status: "done" | "cancelled", actor: Actor): ReviewRequestDto {
  const r = getReview(siteId, id);
  if (r.status !== "open") throw new HttpError(409, "Review request is already closed");
  if (!actor.isOwner && actor.email !== r.assignee_email && actor.email !== r.requested_by) throw new HttpError(403, "Only the assignee, the requester or the owner can close this request", "forbidden");
  db.run(`UPDATE review_requests SET status = ?, completed_at = datetime('now') WHERE id = ?`, [status, id]);
  audit(siteId, actor.email, status === "done" ? "review_completed" : "review_cancelled", { reviewId: id }, r.collection_id, r.item_id);
  return toReviewDto(getReview(siteId, id));
}

export function listReviews(siteId: string, opts: { assignee?: string; status?: ReviewStatus | "all"; itemId?: string }): ReviewRequestDto[] {
  const where = ["r.site_id = ?"];
  const params: string[] = [siteId];
  if (opts.assignee) {
    where.push("r.assignee_email = ?");
    params.push(opts.assignee);
  }
  if (opts.status && opts.status !== "all") {
    where.push("r.status = ?");
    params.push(opts.status);
  }
  if (opts.itemId) {
    where.push("r.item_id = ?");
    params.push(opts.itemId);
  }
  return db.all<ReviewRow>(`${REVIEW_SQL} WHERE ${where.join(" AND ")} ORDER BY r.due_at IS NULL, r.due_at, r.id DESC LIMIT 500`, params).map(toReviewDto);
}

export function reminderLeadHours(siteId: string): number {
  const row = db.get<{ reminder_lead_hours: number }>(`SELECT reminder_lead_hours FROM site_settings WHERE site_id = ?`, [siteId]);
  return row?.reminder_lead_hours ?? config.defaultReminderLeadHours;
}

/** Open requests that are overdue or due within the site's reminder lead window. */
export function reminderList(siteId: string, assignee?: string): ReviewRequestDto[] {
  const horizon = new Date(Date.now() + reminderLeadHours(siteId) * 3600000).toISOString();
  const params: string[] = [siteId, horizon];
  let extra = "";
  if (assignee) {
    extra = " AND r.assignee_email = ?";
    params.push(assignee);
  }
  return db.all<ReviewRow>(`${REVIEW_SQL} WHERE r.site_id = ? AND r.status = 'open' AND r.due_at IS NOT NULL AND r.due_at <= ?${extra} ORDER BY r.due_at`, params).map(toReviewDto);
}

const REMINDER_COOLDOWN_MS = 24 * 3600000;

/** Scheduler job: emails assignees about due/overdue requests (through the logged mailer stub), at most once per 24 h each. */
export function sendDueReminders(): number {
  let sent = 0;
  for (const s of db.all<{ site_id: string }>(`SELECT site_id FROM installations`)) {
    for (const r of reminderList(s.site_id)) {
      const raw = db.get<{ reminder_sent_at: string | null }>(`SELECT reminder_sent_at FROM review_requests WHERE id = ?`, [r.id]);
      if (raw?.reminder_sent_at && Date.now() - Date.parse(`${raw.reminder_sent_at.replace(" ", "T")}Z`) < REMINDER_COOLDOWN_MS) continue;
      notifyMany(
        s.site_id,
        [r.assigneeEmail],
        "review_reminder",
        `${r.overdue ? "Overdue" : "Due soon"}: review of "${r.itemTitle}"`,
        `Your review request from ${r.requestedBy} for "${r.itemTitle}" is ${r.overdue ? "overdue" : "due"} (${r.dueAt}).`
      );
      db.run(`UPDATE review_requests SET reminder_sent_at = datetime('now') WHERE id = ?`, [r.id]);
      sent++;
    }
  }
  return sent;
}
