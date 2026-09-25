import { Router } from "express";
import { CollectionDto, MeDto, ReviewStatus, SettingsDto, WorkflowInput, MailLogDto } from "../../shared/types";
import { db } from "../db";
import { clearFlag, performAction, publishItem } from "../services/approvals";
import { actorOf, requireOwner, siteOf } from "../services/auth";
import { audit, auditFeed, auditToCsv } from "../services/audit";
import { addComment, listComments, setResolved } from "../services/comments";
import { asyncHandler, dayParam, HttpError, intParam } from "../services/errors";
import { getBoard, getCard, getItemDetail, syncCollection } from "../services/items";
import { createMember, deleteMember, listMembers, rotateMemberToken, toMemberDto, updateMember } from "../services/members";
import { closeReview, createReview, listReviews, reminderLeadHours, reminderList } from "../services/reviews";
import { getClient } from "../services/webflow-client";
import { deleteWorkflow, listWorkflows, saveWorkflow, toWorkflowDto } from "../services/workflow";

// App Panel API. Mounted under /api behind requireSite (which resolves the acting member).
const router = Router();

router.get("/me", (_req, res) => {
  const dto: MeDto = { siteId: siteOf(res), member: toMemberDto(actorOf(res)) };
  res.json(dto);
});

// --- collections & workflows ---
router.get("/collections", asyncHandler(async (_req, res) => {
  const siteId = siteOf(res);
  const has = new Set(listWorkflows(siteId).map((w) => w.collectionId));
  const cols = await getClient(siteId).listCollections();
  const dto: CollectionDto[] = cols.map((c) => ({ id: c.id, displayName: c.displayName, slug: c.slug, hasWorkflow: has.has(c.id) }));
  res.json({ collections: dto });
}));

router.get("/workflows", (_req, res) => {
  res.json({ workflows: listWorkflows(siteOf(res)).map(toWorkflowDto) });
});

router.put("/workflows/:collectionId", asyncHandler(async (req, res) => {
  const actor = actorOf(res);
  requireOwner(actor);
  const siteId = siteOf(res);
  const input = (req.body ?? {}) as WorkflowInput;
  let name = typeof input.collectionName === "string" ? input.collectionName.trim().slice(0, 120) : "";
  if (!name) {
    try {
      name = (await getClient(siteId).getCollection(req.params.collectionId)).displayName;
    } catch {
      name = req.params.collectionId;
    }
  }
  res.json(toWorkflowDto(saveWorkflow(siteId, req.params.collectionId, name, input, actor)));
}));

router.delete("/workflows/:collectionId", (req, res) => {
  const actor = actorOf(res);
  requireOwner(actor);
  deleteWorkflow(siteOf(res), req.params.collectionId, actor);
  res.json({ ok: true });
});

// --- board & items ---
router.post("/collections/:collectionId/sync", asyncHandler(async (req, res) => {
  res.json(await syncCollection(siteOf(res), req.params.collectionId, actorOf(res)));
}));

router.get("/board/:collectionId", (req, res) => {
  res.json(getBoard(siteOf(res), req.params.collectionId));
});

router.get("/items/:collectionId/:itemId", asyncHandler(async (req, res) => {
  res.json(await getItemDetail(siteOf(res), req.params.collectionId, req.params.itemId, actorOf(res)));
}));

router.post("/items/:collectionId/:itemId/actions", asyncHandler(async (req, res) => {
  const { collectionId, itemId } = req.params;
  const action = req.body?.action;
  if (action !== "advance" && action !== "reject" && action !== "request_changes") throw new HttpError(400, "action must be advance, reject or request_changes");
  await performAction(siteOf(res), collectionId, itemId, action, actorOf(res), typeof req.body?.note === "string" ? req.body.note : undefined);
  res.json(getCard(siteOf(res), collectionId, itemId));
}));

router.post("/items/:collectionId/:itemId/publish", asyncHandler(async (req, res) => {
  await publishItem(siteOf(res), req.params.collectionId, req.params.itemId, actorOf(res));
  res.json(getCard(siteOf(res), req.params.collectionId, req.params.itemId));
}));

router.post("/items/:collectionId/:itemId/flag/clear", (req, res) => {
  const actor = actorOf(res);
  requireOwner(actor);
  clearFlag(siteOf(res), req.params.collectionId, req.params.itemId, actor);
  res.json(getCard(siteOf(res), req.params.collectionId, req.params.itemId));
});

// --- comments ---
router.get("/items/:collectionId/:itemId/comments", (req, res) => {
  res.json({ comments: listComments(siteOf(res), req.params.collectionId, req.params.itemId) });
});

router.post("/items/:collectionId/:itemId/comments", (req, res) => {
  const created = addComment(siteOf(res), req.params.collectionId, req.params.itemId, actorOf(res), req.body ?? {});
  res.status(201).json(created);
});

router.post("/comments/:id/resolve", (req, res) => {
  if (typeof req.body?.resolved !== "boolean") throw new HttpError(400, "resolved (boolean) is required");
  res.json(setResolved(siteOf(res), intParam(req.params.id, "id"), req.body.resolved, actorOf(res)));
});

// --- review requests & reminders ---
router.get("/reviews", (req, res) => {
  const status = req.query.status === "done" || req.query.status === "cancelled" || req.query.status === "all" ? (req.query.status as ReviewStatus | "all") : "open";
  const itemId = typeof req.query.itemId === "string" && req.query.itemId ? req.query.itemId : undefined;
  const assignee = req.query.mine === "1" ? actorOf(res).email : undefined;
  res.json({ reviews: listReviews(siteOf(res), { assignee, status, itemId }) });
});

router.post("/items/:collectionId/:itemId/reviews", (req, res) => {
  res.status(201).json(createReview(siteOf(res), req.params.collectionId, req.params.itemId, actorOf(res), req.body ?? {}));
});

router.post("/reviews/:id/complete", (req, res) => {
  res.json(closeReview(siteOf(res), intParam(req.params.id, "id"), "done", actorOf(res)));
});

router.post("/reviews/:id/cancel", (req, res) => {
  res.json(closeReview(siteOf(res), intParam(req.params.id, "id"), "cancelled", actorOf(res)));
});

router.get("/reminders", (req, res) => {
  const actor = actorOf(res);
  const all = req.query.all === "1" && actor.isOwner;
  res.json({ leadHours: reminderLeadHours(siteOf(res)), reminders: reminderList(siteOf(res), all ? undefined : actor.email) });
});

// --- team ---
router.get("/members", (_req, res) => {
  res.json({ members: listMembers(siteOf(res)) });
});

router.post("/members", (req, res) => {
  const actor = actorOf(res);
  requireOwner(actor);
  res.status(201).json(createMember(siteOf(res), actor, req.body ?? {}));
});

router.put("/members/:id", (req, res) => {
  const actor = actorOf(res);
  requireOwner(actor);
  res.json(updateMember(siteOf(res), actor, intParam(req.params.id, "id"), req.body ?? {}));
});

router.delete("/members/:id", (req, res) => {
  const actor = actorOf(res);
  requireOwner(actor);
  deleteMember(siteOf(res), actor, intParam(req.params.id, "id"));
  res.json({ ok: true });
});

router.post("/members/:id/rotate-token", (req, res) => {
  const actor = actorOf(res);
  requireOwner(actor);
  res.json(rotateMemberToken(siteOf(res), actor, intParam(req.params.id, "id")));
});

// --- audit ---
function auditQuery(q: Record<string, unknown>, maxLimit: number) {
  const limit = Math.min(maxLimit, Math.max(1, q.limit ? intParam(q.limit, "limit") : 100));
  return {
    from: q.from === undefined || q.from === "" ? undefined : dayParam(q.from, "from"),
    to: q.to === undefined || q.to === "" ? undefined : dayParam(q.to, "to"),
    collectionId: typeof q.collectionId === "string" && q.collectionId ? q.collectionId : undefined,
    itemId: typeof q.itemId === "string" && q.itemId ? q.itemId : undefined,
    limit,
  };
}

router.get("/audit", (req, res) => {
  res.json({ entries: auditFeed(siteOf(res), auditQuery(req.query, 500)) });
});

router.get("/audit/export.csv", (req, res) => {
  const actor = actorOf(res);
  const siteId = siteOf(res);
  const csv = auditToCsv(auditFeed(siteId, auditQuery(req.query, 50000)));
  audit(siteId, actor.email, "audit_exported", { from: req.query.from ?? null, to: req.query.to ?? null });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="approval-audit-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

// --- settings & mail log ---
router.get("/settings", (_req, res) => {
  const dto: SettingsDto = { reminderLeadHours: reminderLeadHours(siteOf(res)) };
  res.json(dto);
});

router.put("/settings", (req, res) => {
  const actor = actorOf(res);
  requireOwner(actor);
  const siteId = siteOf(res);
  const hours = intParam(req.body?.reminderLeadHours, "reminderLeadHours");
  if (hours < 1 || hours > 720) throw new HttpError(400, "reminderLeadHours must be between 1 and 720");
  db.run(
    `INSERT INTO site_settings (site_id, reminder_lead_hours) VALUES (?, ?) ON CONFLICT(site_id) DO UPDATE SET reminder_lead_hours = excluded.reminder_lead_hours, updated_at = datetime('now')`,
    [siteId, hours]
  );
  audit(siteId, actor.email, "settings_updated", { reminderLeadHours: hours });
  res.json({ reminderLeadHours: hours } satisfies SettingsDto);
});

router.get("/mail-log", (_req, res) => {
  requireOwner(actorOf(res));
  const rows = db.all<{ id: number; to_email: string; subject: string; body: string; kind: string; created_at: string }>(
    `SELECT id, to_email, subject, body, kind, created_at FROM mail_log WHERE site_id = ? ORDER BY id DESC LIMIT 100`,
    [siteOf(res)]
  );
  const mails: MailLogDto[] = rows.map((r) => ({ id: r.id, to: r.to_email, subject: r.subject, body: r.body, kind: r.kind, createdAt: r.created_at }));
  res.json({ mails });
});

export default router;
