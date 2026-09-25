import { MAX_STAGES, MIN_STAGES, StageDto, WorkflowDto, WorkflowInput } from "../../shared/types";
import { db } from "../db";
import { Actor, parseRoles } from "./auth";
import { audit, insertTransition } from "./audit";
import { HttpError } from "./errors";
import { normalizeRoles } from "./members";

interface WorkflowRow {
  id: number;
  site_id: string;
  collection_id: string;
  collection_name: string;
  revert_stage_key: string;
  updated_at: string;
}

interface StageRow {
  position: number;
  stage_key: string;
  name: string;
  required_roles: string;
}

export interface Workflow extends WorkflowDto {
  id: number;
}

function load(row: WorkflowRow): Workflow {
  const stages = db
    .all<StageRow>(`SELECT position, stage_key, name, required_roles FROM workflow_stages WHERE workflow_id = ? ORDER BY position`, [row.id])
    .map((s): StageDto => ({ key: s.stage_key, name: s.name, requiredRoles: parseRoles(s.required_roles) }));
  return { id: row.id, collectionId: row.collection_id, collectionName: row.collection_name, revertStageKey: row.revert_stage_key, stages, updatedAt: row.updated_at };
}

export function getWorkflow(siteId: string, collectionId: string): Workflow | undefined {
  const row = db.get<WorkflowRow>(`SELECT * FROM workflows WHERE site_id = ? AND collection_id = ?`, [siteId, collectionId]);
  return row ? load(row) : undefined;
}

export function requireWorkflow(siteId: string, collectionId: string): Workflow {
  const wf = getWorkflow(siteId, collectionId);
  if (!wf) throw new HttpError(404, "No approval workflow is defined for this collection", "no_workflow");
  return wf;
}

export function listWorkflows(siteId: string): Workflow[] {
  return db.all<WorkflowRow>(`SELECT * FROM workflows WHERE site_id = ? ORDER BY collection_name`, [siteId]).map(load);
}

export function toWorkflowDto(wf: Workflow): WorkflowDto {
  return { collectionId: wf.collectionId, collectionName: wf.collectionName, revertStageKey: wf.revertStageKey, stages: wf.stages, updatedAt: wf.updatedAt };
}

export function slugKey(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  return s || "stage";
}

/** Stage indexes: the last stage is the final "approved" (publishable) stage. */
export function finalStage(wf: Workflow): StageDto {
  return wf.stages[wf.stages.length - 1];
}

export function stageIndex(wf: Workflow, key: string): number {
  return wf.stages.findIndex((s) => s.key === key);
}

function validateStages(input: WorkflowInput): StageDto[] {
  if (!Array.isArray(input.stages) || input.stages.length < MIN_STAGES || input.stages.length > MAX_STAGES) {
    throw new HttpError(400, `A workflow needs between ${MIN_STAGES} and ${MAX_STAGES} stages`);
  }
  const used = new Set<string>();
  return input.stages.map((s, i) => {
    const name = typeof s?.name === "string" ? s.name.trim().slice(0, 40) : "";
    if (!name) throw new HttpError(400, `Stage ${i + 1} needs a name`);
    const requiredRoles = normalizeRoles(s.requiredRoles ?? [], 10);
    if (requiredRoles.length === 0) throw new HttpError(400, `Stage "${name}" needs at least one required role`);
    let key = typeof s.key === "string" && /^[a-z0-9][a-z0-9-]{0,31}$/.test(s.key) ? s.key : slugKey(name);
    const base = key;
    for (let n = 2; used.has(key); n++) key = `${base.slice(0, 28)}-${n}`;
    used.add(key);
    return { key, name, requiredRoles };
  });
}

/** Creates or replaces a collection's workflow. Items sitting in removed stages are reset to the first stage. */
export function saveWorkflow(siteId: string, collectionId: string, collectionName: string, input: WorkflowInput, actor: Actor): Workflow {
  const stages = validateStages(input);
  const last = stages.length - 1;
  const defaultRevert = stages[Math.min(1, last - 1)].key;
  const revertKey = input.revertStageKey ?? defaultRevert;
  const revertIdx = stages.findIndex((s) => s.key === revertKey);
  if (revertIdx < 0 || revertIdx === last) throw new HttpError(400, "revertStageKey must be an existing non-final stage");

  db.transaction(() => {
    const existing = db.get<{ id: number }>(`SELECT id FROM workflows WHERE site_id = ? AND collection_id = ?`, [siteId, collectionId]);
    let id: number;
    if (existing) {
      id = existing.id;
      db.run(`UPDATE workflows SET collection_name = ?, revert_stage_key = ?, updated_at = datetime('now') WHERE id = ?`, [collectionName, revertKey, id]);
      db.run(`DELETE FROM workflow_stages WHERE workflow_id = ?`, [id]);
    } else {
      id = Number(db.run(`INSERT INTO workflows (site_id, collection_id, collection_name, revert_stage_key) VALUES (?, ?, ?, ?)`, [siteId, collectionId, collectionName, revertKey]).lastInsertRowid);
    }
    stages.forEach((s, i) => db.run(`INSERT INTO workflow_stages (workflow_id, position, stage_key, name, required_roles) VALUES (?, ?, ?, ?, ?)`, [id, i, s.key, s.name, JSON.stringify(s.requiredRoles)]));

    const keys = new Set(stages.map((s) => s.key));
    const orphans = db.all<{ item_id: string; stage_key: string }>(`SELECT item_id, stage_key FROM items WHERE site_id = ? AND collection_id = ?`, [siteId, collectionId]).filter((i) => !keys.has(i.stage_key));
    for (const o of orphans) {
      db.run(`UPDATE items SET stage_key = ?, updated_at = datetime('now') WHERE site_id = ? AND collection_id = ? AND item_id = ?`, [stages[0].key, siteId, collectionId, o.item_id]);
      insertTransition(siteId, collectionId, o.item_id, o.stage_key, stages[0].key, "reset", actor.email, actor.isOwner ? "owner" : "system", "Stage removed from workflow");
    }
    audit(siteId, actor.email, existing ? "workflow_updated" : "workflow_created", { stages: stages.map((s) => ({ key: s.key, roles: s.requiredRoles })), revertStageKey: revertKey }, collectionId);
  });
  return requireWorkflow(siteId, collectionId);
}

/** Removes a workflow and the item tracking for its collection (the transition log is kept). */
export function deleteWorkflow(siteId: string, collectionId: string, actor: Actor): void {
  const wf = requireWorkflow(siteId, collectionId);
  db.transaction(() => {
    db.run(`UPDATE review_requests SET status = 'cancelled', completed_at = datetime('now') WHERE site_id = ? AND collection_id = ? AND status = 'open'`, [siteId, collectionId]);
    db.run(`DELETE FROM items WHERE site_id = ? AND collection_id = ?`, [siteId, collectionId]);
    db.run(`DELETE FROM workflows WHERE id = ?`, [wf.id]);
    audit(siteId, actor.email, "workflow_deleted", {}, collectionId);
  });
}
