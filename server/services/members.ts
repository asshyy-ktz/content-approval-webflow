import { MemberCreatedDto, MemberDto } from "../../shared/types";
import { db } from "../db";
import { Actor, hashToken, MemberRow, newAdminToken, parseRoles, toActor } from "./auth";
import { audit } from "./audit";
import { HttpError } from "./errors";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLE_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function normalizeRole(input: unknown): string {
  const r = typeof input === "string" ? input.trim().toLowerCase() : "";
  if (!ROLE_RE.test(r)) throw new HttpError(400, `Invalid role "${String(input)}" (use lowercase letters, digits, - or _, max 32 characters)`);
  return r;
}

export function normalizeRoles(input: unknown, max = 20): string[] {
  if (!Array.isArray(input) || input.length > max) throw new HttpError(400, `roles must be an array (max ${max})`);
  return [...new Set(input.map(normalizeRole))];
}

export function toMemberDto(row: MemberRow | Actor): MemberDto {
  const a = "is_owner" in row ? toActor(row) : row;
  return { id: a.id, email: a.email, name: a.name, roles: a.roles, isOwner: a.isOwner };
}

export function listMembers(siteId: string): MemberDto[] {
  return db.all<MemberRow>(`SELECT * FROM members WHERE site_id = ? ORDER BY is_owner DESC, email`, [siteId]).map(toMemberDto);
}

export function findMemberByEmail(siteId: string, email: string): MemberRow | undefined {
  return db.get<MemberRow>(`SELECT * FROM members WHERE site_id = ? AND email = ?`, [siteId, email.trim().toLowerCase()]);
}

export function membersWithRoles(siteId: string, roles: string[]): string[] {
  return listMembers(siteId)
    .filter((m) => m.isOwner || m.roles.some((r) => roles.includes(r)))
    .map((m) => m.email);
}

export function ownerEmails(siteId: string): string[] {
  return db.all<{ email: string }>(`SELECT email FROM members WHERE site_id = ? AND is_owner = 1`, [siteId]).map((r) => r.email);
}

/** Creates the owner member at install time if the site has none yet. */
export function ensureOwner(siteId: string, email: string, name: string): void {
  if (db.get(`SELECT 1 AS x FROM members WHERE site_id = ? AND is_owner = 1`, [siteId])) return;
  db.run(`INSERT OR IGNORE INTO members (site_id, email, name, roles, is_owner) VALUES (?, ?, ?, '[]', 1)`, [siteId, email.trim().toLowerCase(), name]);
  db.run(`UPDATE members SET is_owner = 1, name = ? WHERE site_id = ? AND email = ?`, [name, siteId, email.trim().toLowerCase()]);
}

export function createMember(siteId: string, actor: Actor, input: { email: unknown; name?: unknown; roles: unknown }): MemberCreatedDto {
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpError(400, "A valid email is required");
  if (findMemberByEmail(siteId, email)) throw new HttpError(409, "A member with this email already exists");
  const name = typeof input.name === "string" ? input.name.trim().slice(0, 80) : "";
  const roles = normalizeRoles(input.roles);
  const token = newAdminToken();
  const r = db.run(`INSERT INTO members (site_id, email, name, roles, is_owner, token_hash) VALUES (?, ?, ?, ?, 0, ?)`, [siteId, email, name, JSON.stringify(roles), hashToken(token)]);
  audit(siteId, actor.email, "member_added", { email, roles });
  return { member: { id: Number(r.lastInsertRowid), email, name, roles, isOwner: false }, token };
}

function requireMember(siteId: string, id: number): MemberRow {
  const row = db.get<MemberRow>(`SELECT * FROM members WHERE site_id = ? AND id = ?`, [siteId, id]);
  if (!row) throw new HttpError(404, "Member not found");
  return row;
}

export function updateMember(siteId: string, actor: Actor, id: number, input: { name?: unknown; roles?: unknown }): MemberDto {
  const row = requireMember(siteId, id);
  if (row.is_owner) throw new HttpError(400, "The owner implicitly holds every role and cannot be edited");
  const name = typeof input.name === "string" ? input.name.trim().slice(0, 80) : row.name;
  const roles = input.roles === undefined ? parseRoles(row.roles) : normalizeRoles(input.roles);
  db.run(`UPDATE members SET name = ?, roles = ? WHERE id = ?`, [name, JSON.stringify(roles), id]);
  audit(siteId, actor.email, "member_updated", { email: row.email, roles });
  return toMemberDto(requireMember(siteId, id));
}

export function deleteMember(siteId: string, actor: Actor, id: number): void {
  const row = requireMember(siteId, id);
  if (row.is_owner) throw new HttpError(400, "The owner cannot be removed");
  db.transaction(() => {
    db.run(`UPDATE review_requests SET status = 'cancelled', completed_at = datetime('now') WHERE site_id = ? AND assignee_email = ? AND status = 'open'`, [siteId, row.email]);
    db.run(`DELETE FROM members WHERE id = ?`, [id]);
  });
  audit(siteId, actor.email, "member_removed", { email: row.email });
}

export function rotateMemberToken(siteId: string, actor: Actor, id: number): MemberCreatedDto {
  const row = requireMember(siteId, id);
  if (row.is_owner) throw new HttpError(400, "The owner token is issued at install time");
  const token = newAdminToken();
  db.run(`UPDATE members SET token_hash = ? WHERE id = ?`, [hashToken(token), id]);
  audit(siteId, actor.email, "member_token_rotated", { email: row.email });
  return { member: toMemberDto(requireMember(siteId, id)), token };
}
