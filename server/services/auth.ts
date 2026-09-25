import crypto from "crypto";
import { NextFunction, Request, Response } from "express";
import { db } from "../db";
import { HttpError } from "./errors";

export interface Actor {
  id: number;
  email: string;
  name: string;
  roles: string[];
  isOwner: boolean;
}

export interface MemberRow {
  id: number;
  site_id: string;
  email: string;
  name: string;
  roles: string;
  is_owner: number;
  token_hash: string;
}

export function newAdminToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function parseRoles(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function toActor(row: MemberRow): Actor {
  return { id: row.id, email: row.email, name: row.name, roles: parseRoles(row.roles), isOwner: !!row.is_owner };
}

/**
 * Guards App Panel API calls: X-Site-Id + X-Admin-Token. The install-time owner token maps to the owner
 * member; personal tokens issued by the owner map to their member row (and therefore their roles).
 */
export function requireSite(req: Request, res: Response, next: NextFunction): void {
  const siteId = req.header("x-site-id");
  const token = req.header("x-admin-token");
  if (!siteId || !token) {
    res.status(401).json({ error: "Missing X-Site-Id or X-Admin-Token" });
    return;
  }
  const inst = db.get<{ admin_token_hash: string }>(`SELECT admin_token_hash FROM installations WHERE site_id = ?`, [siteId]);
  if (!inst) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }
  const hashed = hashToken(token);
  let row: MemberRow | undefined;
  if (inst.admin_token_hash && safeEqual(inst.admin_token_hash, hashed)) {
    row = db.get<MemberRow>(`SELECT * FROM members WHERE site_id = ? AND is_owner = 1 ORDER BY id LIMIT 1`, [siteId]);
  } else {
    row = db.get<MemberRow>(`SELECT * FROM members WHERE site_id = ? AND is_owner = 0 AND token_hash = ?`, [siteId, hashed]);
  }
  if (!row) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }
  res.locals.siteId = siteId;
  res.locals.actor = toActor(row);
  next();
}

export function siteOf(res: Response): string {
  return res.locals.siteId as string;
}

export function actorOf(res: Response): Actor {
  return res.locals.actor as Actor;
}

export function requireOwner(actor: Actor): void {
  if (!actor.isOwner) throw new HttpError(403, "Only the app owner can do this", "forbidden");
}
