import { CommentDto, MAX_COMMENT_LENGTH } from "../../shared/types";
import { db } from "../db";
import { Actor, parseRoles } from "./auth";
import { audit } from "./audit";
import { HttpError } from "./errors";
import { listMembers } from "./members";
import { notifyMany } from "./mailer";
import { requireItemRow } from "./approvals";

export interface CommentRow {
  id: number;
  site_id: string;
  collection_id: string;
  item_id: string;
  field_slug: string | null;
  parent_id: number | null;
  author_email: string;
  body: string;
  mentions: string;
  resolved: number;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
}

export function toCommentDto(r: CommentRow): CommentDto {
  return {
    id: r.id,
    parentId: r.parent_id,
    fieldSlug: r.field_slug,
    authorEmail: r.author_email,
    body: r.body,
    mentions: parseRoles(r.mentions),
    resolved: !!r.resolved,
    resolvedBy: r.resolved_by,
    resolvedAt: r.resolved_at,
    createdAt: r.created_at,
  };
}

const MENTION_RE = /@([A-Za-z0-9._+-]+(?:@[A-Za-z0-9.-]+\.[A-Za-z]{2,})?)/g;

/** Resolves @email, @local-part and @name (spaces removed) mentions to member emails. */
export function extractMentions(siteId: string, body: string): string[] {
  const members = listMembers(siteId);
  const found = new Set<string>();
  for (const m of body.matchAll(MENTION_RE)) {
    const t = m[1].toLowerCase().replace(/[.,;:!?]+$/, "");
    const hit = members.find((mem) => mem.email === t || mem.email.split("@")[0] === t || mem.name.toLowerCase().replace(/\s+/g, "") === t);
    if (hit) found.add(hit.email);
  }
  return [...found];
}

export function addComment(siteId: string, collectionId: string, itemId: string, actor: Actor, input: { body: unknown; fieldSlug?: unknown; parentId?: unknown }): CommentDto {
  const item = requireItemRow(siteId, collectionId, itemId);
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (!body) throw new HttpError(400, "Comment body is required");
  if (body.length > MAX_COMMENT_LENGTH) throw new HttpError(400, `Comment is too long (max ${MAX_COMMENT_LENGTH} characters)`);

  let fieldSlug: string | null = null;
  if (input.fieldSlug !== undefined && input.fieldSlug !== null && input.fieldSlug !== "") {
    if (typeof input.fieldSlug !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(input.fieldSlug)) throw new HttpError(400, "fieldSlug is invalid");
    fieldSlug = input.fieldSlug;
  }

  let parentId: number | null = null;
  if (input.parentId !== undefined && input.parentId !== null) {
    if (typeof input.parentId !== "number" || !Number.isInteger(input.parentId)) throw new HttpError(400, "parentId must be an integer");
    const parent = db.get<CommentRow>(`SELECT * FROM comments WHERE id = ? AND site_id = ? AND collection_id = ? AND item_id = ?`, [input.parentId, siteId, collectionId, itemId]);
    if (!parent) throw new HttpError(404, "Parent comment not found on this item");
    if (parent.parent_id !== null) throw new HttpError(400, "Replies can only target a thread's first comment");
    parentId = parent.id;
    fieldSlug = parent.field_slug; // replies stay on the thread's field
  }

  const mentions = extractMentions(siteId, body);
  const r = db.run(`INSERT INTO comments (site_id, collection_id, item_id, field_slug, parent_id, author_email, body, mentions) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
    siteId,
    collectionId,
    itemId,
    fieldSlug,
    parentId,
    actor.email,
    body,
    JSON.stringify(mentions),
  ]);
  const created = db.get<CommentRow>(`SELECT * FROM comments WHERE id = ?`, [Number(r.lastInsertRowid)]) as CommentRow;
  audit(siteId, actor.email, "comment_added", { commentId: created.id, field: fieldSlug, parentId, mentions }, collectionId, itemId);
  notifyMany(siteId, mentions, "mention", `${actor.email} mentioned you on "${item.title || item.item_id}"`, `${body}\n\nCollection ${collectionId}, item ${itemId}${fieldSlug ? `, field ${fieldSlug}` : ""}.`, actor.email);
  return toCommentDto(created);
}

/** Resolves or reopens a thread (the root comment carries the state; replies mirror it for convenience). */
export function setResolved(siteId: string, commentId: number, resolved: boolean, actor: Actor): CommentDto {
  const c = db.get<CommentRow>(`SELECT * FROM comments WHERE id = ? AND site_id = ?`, [commentId, siteId]);
  if (!c) throw new HttpError(404, "Comment not found");
  const rootId = c.parent_id ?? c.id;
  if (resolved) db.run(`UPDATE comments SET resolved = 1, resolved_by = ?, resolved_at = datetime('now') WHERE id = ?`, [actor.email, rootId]);
  else db.run(`UPDATE comments SET resolved = 0, resolved_by = NULL, resolved_at = NULL WHERE id = ?`, [rootId]);
  audit(siteId, actor.email, resolved ? "thread_resolved" : "thread_reopened", { commentId: rootId }, c.collection_id, c.item_id);
  return toCommentDto(db.get<CommentRow>(`SELECT * FROM comments WHERE id = ?`, [rootId]) as CommentRow);
}

export function listComments(siteId: string, collectionId: string, itemId: string): CommentDto[] {
  return db.all<CommentRow>(`SELECT * FROM comments WHERE site_id = ? AND collection_id = ? AND item_id = ? ORDER BY id`, [siteId, collectionId, itemId]).map(toCommentDto);
}
