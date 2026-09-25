import type {
  AuditEntryDto,
  BoardDto,
  CollectionDto,
  CommentDto,
  ItemCardDto,
  ItemDetailDto,
  MailLogDto,
  MemberCreatedDto,
  MemberDto,
  MeDto,
  ReviewRequestDto,
  SyncResultDto,
  UserAction,
  WorkflowDto,
  WorkflowInput,
} from "../../shared/types";

type Tab = "board" | "reviews" | "workflows" | "team" | "audit";

interface Creds {
  siteId: string;
  token: string;
}

class ApiFailure extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const view = $<HTMLElement>("view");
let creds: Creds | null = null;
let me: MeDto | null = null;
let current: Tab = "board";
let selectedCollection = "";

// --- DOM helpers (text is always set via textContent, never innerHTML) ---
type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | boolean | ((e: Event) => void)> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === "function") el.addEventListener(k.replace(/^on/, ""), v);
    else if (typeof v === "boolean") {
      if (v) el.setAttribute(k, "");
    } else el.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(c));
  return el;
}

function table(headers: string[], rows: Child[][], empty = "Nothing to show."): HTMLElement {
  return h(
    "table",
    {},
    h("thead", {}, h("tr", {}, ...headers.map((t) => h("th", {}, t)))),
    h("tbody", {}, ...(rows.length ? rows.map((r) => h("tr", {}, ...r.map((c) => h("td", {}, c)))) : [h("tr", {}, h("td", { colspan: String(headers.length) }, empty))]))
  );
}

function tag(text: string, kind = ""): HTMLElement {
  return h("span", { class: `tag ${kind}`.trim() }, text);
}

function card(title: string, ...children: Child[]): HTMLElement {
  return h("section", { class: "card" }, h("h2", {}, title), ...children);
}

function toast(message: string, error = false): void {
  const el = $<HTMLElement>("toast");
  el.textContent = message;
  el.className = error ? "toast error" : "toast";
  el.hidden = false;
  window.setTimeout(() => (el.hidden = true), 4000);
}

function fmt(ts: string | null): string {
  if (!ts) return "";
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : `${ts.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}

function show(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

// --- credentials & API ---
function loadCreds(): Creds | null {
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const fromHash = { siteId: hash.get("site") ?? "", token: hash.get("token") ?? "" };
  try {
    if (fromHash.siteId && fromHash.token) {
      sessionStorage.setItem("ca-creds", JSON.stringify(fromHash));
      history.replaceState(null, "", location.pathname);
      return fromHash;
    }
    const raw = sessionStorage.getItem("ca-creds");
    if (raw) return JSON.parse(raw) as Creds;
  } catch {
    if (fromHash.siteId && fromHash.token) return fromHash;
  }
  return null;
}

function authHeaders(): Record<string, string> {
  if (!creds) throw new ApiFailure(401, "Not connected");
  return { "Content-Type": "application/json", "X-Site-Id": creds.siteId, "X-Admin-Token": creds.token };
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, { method, headers: authHeaders(), body: body === undefined ? undefined : JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiFailure(res.status, json.error || `Request failed (${res.status})`);
  return json as T;
}

async function downloadCsv(query: string): Promise<void> {
  const res = await fetch(`/api/audit/export.csv?${query}`, { headers: authHeaders() });
  if (!res.ok) throw new ApiFailure(res.status, `Export failed (${res.status})`);
  const url = URL.createObjectURL(await res.blob());
  const a = h("a", { href: url, download: `approval-audit-${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function guarded(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ApiFailure && err.status === 401) {
      try {
        sessionStorage.removeItem("ca-creds");
      } catch {
        /* ignore */
      }
      creds = null;
      me = null;
      boot();
    }
    toast(err instanceof Error ? err.message : String(err), true);
  }
}

// --- Board ---
async function renderBoard(): Promise<void> {
  const { collections } = await api<{ collections: CollectionDto[] }>("GET", "/collections");
  const withFlow = collections.filter((c) => c.hasWorkflow);
  if (withFlow.length === 0) {
    view.replaceChildren(card("No workflows yet", h("p", { class: "muted" }, me?.member.isOwner ? "Define a workflow for a collection in the Workflows tab." : "Ask the app owner to define a workflow for a collection.")));
    return;
  }
  if (!withFlow.some((c) => c.id === selectedCollection)) selectedCollection = withFlow[0].id;
  const board = await api<BoardDto>("GET", `/board/${encodeURIComponent(selectedCollection)}`);

  const select = h("select", {}, ...withFlow.map((c) => h("option", c.id === selectedCollection ? { value: c.id, selected: true } : { value: c.id }, c.displayName)));
  select.addEventListener("change", () => {
    selectedCollection = select.value;
    void guarded(renderBoard);
  });
  const syncBtn = h("button", { class: "btn" }, "Sync from Webflow");
  syncBtn.addEventListener("click", () =>
    void guarded(async () => {
      syncBtn.disabled = true;
      try {
        const r = await api<SyncResultDto>("POST", `/collections/${encodeURIComponent(selectedCollection)}/sync`);
        toast(`Synced ${r.total} items (${r.added} new, ${r.removed} removed, ${r.reverted} reverted).`);
        await renderBoard();
      } finally {
        syncBtn.disabled = false;
      }
    })
  );

  const columns = board.columns.map((col, i) =>
    h(
      "div",
      { class: "col" },
      h("h3", {}, h("span", {}, col.stage.name), h("span", { class: "muted" }, String(col.items.length))),
      h("div", { class: "muted" }, i === board.columns.length - 1 ? `Approved · publish: ${col.stage.requiredRoles.join(", ")}` : `Approvers: ${col.stage.requiredRoles.join(", ")}`),
      ...col.items.map(itemCard),
      col.items.length === 0 && h("div", { class: "muted" }, "No items")
    )
  );
  view.replaceChildren(h("div", { class: "row" }, select, syncBtn), h("div", { class: "kanban" }, ...columns));
}

function itemCard(it: ItemCardDto): HTMLElement {
  const el = h(
    "div",
    { class: it.flagged ? "kcard flagged" : "kcard" },
    h("div", { class: "title" }, it.title),
    h(
      "div",
      {},
      it.flagged && tag("edited after approval", "flag"),
      it.openComments > 0 && tag(`${it.openComments} open`, "warn"),
      it.publishedAt && tag("published", "ok"),
      it.nextDueAt && tag(`due ${fmt(it.nextDueAt)}`, Date.parse(it.nextDueAt) < Date.now() ? "overdue" : "")
    ),
    it.assignees.length > 0 && h("div", { class: "muted" }, `Assigned: ${it.assignees.join(", ")}`)
  );
  el.addEventListener("click", () => void guarded(() => renderItem(it.collectionId, it.itemId)));
  return el;
}

// --- Item detail ---
const ACTION_LABEL: Record<UserAction, string> = { advance: "Approve", reject: "Reject", request_changes: "Request changes", publish: "Publish" };

async function renderItem(collectionId: string, itemId: string): Promise<void> {
  const d = await api<ItemDetailDto>("GET", `/items/${encodeURIComponent(collectionId)}/${encodeURIComponent(itemId)}`);
  const stageName = (key: string | null): string => (key ? d.workflow.stages.find((s) => s.key === key)?.name ?? key : "");
  const idx = d.workflow.stages.findIndex((s) => s.key === d.item.stageKey);
  const rerender = () => renderItem(collectionId, itemId);

  const back = h("button", { class: "btn small" }, "Back to board");
  back.addEventListener("click", () => void guarded(renderBoard));

  const note = h("textarea", { placeholder: "Note (required for reject / request changes)" });
  const actions = d.allowedActions.map((a) => {
    const label = a === "advance" && idx < d.workflow.stages.length - 1 ? `Approve → ${d.workflow.stages[idx + 1].name}` : ACTION_LABEL[a];
    const btn = h("button", { class: a === "advance" || a === "publish" ? "btn primary" : "btn" }, label);
    btn.addEventListener("click", () =>
      void guarded(async () => {
        if (a === "publish") {
          await api("POST", `/items/${encodeURIComponent(collectionId)}/${encodeURIComponent(itemId)}/publish`);
          toast("Published.");
        } else {
          if ((a === "reject" || a === "request_changes") && !note.value.trim()) throw new Error("Add a note before rejecting or requesting changes.");
          await api("POST", `/items/${encodeURIComponent(collectionId)}/${encodeURIComponent(itemId)}/actions`, { action: a, note: note.value });
          toast(`${ACTION_LABEL[a]} recorded.`);
        }
        await rerender();
      })
    );
    return btn;
  });

  const banner =
    d.item.flagged &&
    h(
      "div",
      { class: "banner" },
      h("strong", {}, "Flagged: "),
      d.item.flagReason ?? "Edited after approval.",
      " ",
      me?.member.isOwner
        ? (() => {
            const b = h("button", { class: "btn small" }, "Acknowledge");
            b.addEventListener("click", () =>
              void guarded(async () => {
                await api("POST", `/items/${encodeURIComponent(collectionId)}/${encodeURIComponent(itemId)}/flag/clear`);
                await rerender();
              })
            );
            return b;
          })()
        : null
    );

  const header = card(
    d.item.title,
    h("div", { class: "row" }, back, tag(stageName(d.item.stageKey), d.item.stageKey === d.workflow.stages[d.workflow.stages.length - 1].key ? "ok" : ""), d.item.approvedAt && h("span", { class: "muted" }, `Last approved ${fmt(d.item.approvedAt)} by ${d.item.approvedBy ?? ""}`), d.item.publishedAt && h("span", { class: "muted" }, `Published ${fmt(d.item.publishedAt)}`)),
    banner,
    d.allowedActions.length > 0 ? h("div", { class: "stack" }, note, h("div", { class: "row" }, ...actions)) : h("p", { class: "muted" }, "You do not have a role that can act on this stage.")
  );

  // Diff against the last approved snapshot.
  const showAll = h("input", { type: "checkbox" });
  const diffBody = h("div", {});
  const drawDiff = () => {
    const rows = d.diff.filter((f) => showAll.checked || f.status !== "unchanged");
    diffBody.replaceChildren(
      ...(rows.length
        ? rows.map((f) =>
            h(
              "div",
              { class: "diff-row" },
              h("div", {}, h("strong", {}, f.field), h("div", {}, tag(f.status, f.status === "unchanged" ? "" : "warn"))),
              h("pre", { class: `before ${f.status}` }, show(f.before)),
              h("pre", { class: `after ${f.status}` }, show(f.after))
            )
          )
        : [h("p", { class: "muted" }, "No differences from the last approved snapshot.")])
    );
  };
  showAll.addEventListener("change", drawDiff);
  drawDiff();
  const diffCard = card(
    "Changes since last approval",
    h("p", { class: "muted" }, d.hasSnapshot ? "Left: last approved snapshot. Right: current content." : "No approval yet, so all fields are shown as new."),
    h("label", {}, showAll, " Show unchanged fields"),
    diffBody
  );

  view.replaceChildren(header, diffCard, commentsCard(d, collectionId, itemId, rerender), await reviewsCard(d, collectionId, itemId, rerender), historyCard(d, stageName));
}

function commentsCard(d: ItemDetailDto, collectionId: string, itemId: string, rerender: () => Promise<void>): HTMLElement {
  const base = `/items/${encodeURIComponent(collectionId)}/${encodeURIComponent(itemId)}`;
  const roots = d.comments.filter((c) => c.parentId === null);
  const replies = (id: number) => d.comments.filter((c) => c.parentId === id);

  const line = (c: CommentDto): HTMLElement => h("div", {}, h("strong", {}, c.authorEmail), h("span", { class: "muted" }, ` ${fmt(c.createdAt)}`), h("div", {}, c.body));

  const threads = roots.map((c) => {
    const resolveBtn = h("button", { class: "btn small" }, c.resolved ? "Reopen" : "Resolve");
    resolveBtn.addEventListener("click", () =>
      void guarded(async () => {
        await api("POST", `/comments/${c.id}/resolve`, { resolved: !c.resolved });
        await rerender();
      })
    );
    const replyInput = h("input", { placeholder: "Reply (use @email to mention)" });
    const replyBtn = h("button", { class: "btn small" }, "Reply");
    replyBtn.addEventListener("click", () =>
      void guarded(async () => {
        if (!replyInput.value.trim()) return;
        await api("POST", `${base}/comments`, { body: replyInput.value, parentId: c.id });
        await rerender();
      })
    );
    return h(
      "div",
      { class: c.resolved ? "thread resolved" : "thread" },
      h("div", { class: "row space" }, h("span", {}, tag(c.fieldSlug ? `field: ${c.fieldSlug}` : "item"), c.resolved && tag(`resolved by ${c.resolvedBy ?? ""}`, "ok")), resolveBtn),
      line(c),
      ...replies(c.id).map((r) => h("div", { class: "reply" }, line(r))),
      h("div", { class: "row reply" }, replyInput, replyBtn)
    );
  });

  const fieldSelect = h("select", {}, h("option", { value: "" }, "Whole item"), ...d.diff.map((f) => h("option", { value: f.field }, f.field)));
  const body = h("textarea", { placeholder: "Write a comment. Mention teammates with @email or @name." });
  const post = h("button", { class: "btn primary" }, "Post comment");
  post.addEventListener("click", () =>
    void guarded(async () => {
      await api("POST", `${base}/comments`, { body: body.value, fieldSlug: fieldSelect.value || undefined });
      await rerender();
    })
  );
  const open = roots.filter((c) => !c.resolved).length;
  return card(`Comments (${open} open, ${roots.length - open} resolved)`, ...threads, roots.length === 0 && h("p", { class: "muted" }, "No comments yet."), h("div", { class: "stack" }, h("div", { class: "row" }, h("span", { class: "muted" }, "On:"), fieldSelect), body, h("div", { class: "row" }, post)));
}

async function reviewsCard(d: ItemDetailDto, collectionId: string, itemId: string, rerender: () => Promise<void>): Promise<HTMLElement> {
  const { members } = await api<{ members: MemberDto[] }>("GET", "/members");
  const assignee = h("select", {}, ...members.map((m) => h("option", { value: m.email }, `${m.name || m.email}${m.roles.length ? ` (${m.roles.join(", ")})` : ""}`)));
  const due = h("input", { type: "datetime-local" });
  const reviewNote = h("input", { placeholder: "Note (optional)" });
  const request = h("button", { class: "btn primary" }, "Request review");
  request.addEventListener("click", () =>
    void guarded(async () => {
      await api("POST", `/items/${encodeURIComponent(collectionId)}/${encodeURIComponent(itemId)}/reviews`, {
        assigneeEmail: assignee.value,
        dueAt: due.value ? new Date(due.value).toISOString() : undefined,
        note: reviewNote.value,
      });
      toast("Review requested.");
      await rerender();
    })
  );
  const rows = d.reviews.map((r) => [
    r.assigneeEmail,
    r.dueAt ? fmt(r.dueAt) : "-",
    h("span", {}, tag(r.status, r.overdue ? "overdue" : r.status === "done" ? "done" : ""), r.overdue && tag("overdue", "overdue")),
    r.note,
    r.status === "open" ? closeButtons(r, rerender) : null,
  ]);
  return card("Review requests", table(["Assignee", "Due", "Status", "Note", ""], rows, "No review requests."), h("div", { class: "row" }, assignee, due, reviewNote, request));
}

function closeButtons(r: ReviewRequestDto, rerender: () => Promise<void>): HTMLElement {
  const done = h("button", { class: "btn small" }, "Done");
  const cancel = h("button", { class: "btn small" }, "Cancel");
  done.addEventListener("click", () => void guarded(async () => (await api("POST", `/reviews/${r.id}/complete`), rerender())));
  cancel.addEventListener("click", () => void guarded(async () => (await api("POST", `/reviews/${r.id}/cancel`), rerender())));
  return h("span", {}, done, " ", cancel);
}

function historyCard(d: ItemDetailDto, stageName: (k: string | null) => string): HTMLElement {
  return card(
    "Transition log (append-only)",
    table(
      ["When", "Action", "From → To", "By", "Note"],
      d.transitions.map((t) => [fmt(t.createdAt), tag(t.action.replace("_", " "), t.action), `${stageName(t.fromStage) || "-"} → ${stageName(t.toStage)}`, `${t.actorEmail}${t.actorRole ? ` (${t.actorRole})` : ""}`, t.note])
    )
  );
}

// --- Reviews tab ---
async function renderReviews(): Promise<void> {
  const [rem, mine] = await Promise.all([
    api<{ leadHours: number; reminders: ReviewRequestDto[] }>("GET", `/reminders${me?.member.isOwner ? "?all=1" : ""}`),
    api<{ reviews: ReviewRequestDto[] }>("GET", "/reviews?mine=1"),
  ]);
  const row = (r: ReviewRequestDto): Child[] => {
    const open = h("button", { class: "btn small" }, "Open item");
    open.addEventListener("click", () => void guarded(() => renderItem(r.collectionId, r.itemId)));
    return [r.itemTitle, r.assigneeEmail, r.dueAt ? fmt(r.dueAt) : "-", r.overdue ? tag("overdue", "overdue") : tag("due soon", "warn"), open];
  };
  const mineRows = mine.reviews.map((r) => {
    const open = h("button", { class: "btn small" }, "Open item");
    open.addEventListener("click", () => void guarded(() => renderItem(r.collectionId, r.itemId)));
    return [r.itemTitle, r.requestedBy, r.dueAt ? fmt(r.dueAt) : "-", r.note, open];
  });
  view.replaceChildren(
    card(`Reminders (due within ${rem.leadHours} h or overdue)`, table(["Item", "Assignee", "Due", "State", ""], rem.reminders.map(row), "No reminders.")),
    card("Assigned to me", table(["Item", "Requested by", "Due", "Note", ""], mineRows, "Nothing assigned to you."))
  );
}

// --- Workflows tab (owner) ---
interface StageDraft {
  key?: string;
  name: string;
  roles: string;
}

function workflowEditor(col: CollectionDto, wf: WorkflowDto | undefined): HTMLElement {
  const stages: StageDraft[] = wf
    ? wf.stages.map((s) => ({ key: s.key, name: s.name, roles: s.requiredRoles.join(", ") }))
    : [
        { name: "Draft", roles: "writer" },
        { name: "Legal", roles: "legal" },
        { name: "Editor", roles: "editor" },
        { name: "Approved", roles: "publisher" },
      ];
  let revertKey = wf?.revertStageKey ?? "";
  const holder = h("div", { class: "stack" });

  const draw = (): void => {
    const rows = stages.map((s, i) => {
      const name = h("input", { value: s.name, placeholder: "Stage name" });
      name.addEventListener("input", () => (s.name = name.value));
      const roles = h("input", { value: s.roles, placeholder: "Roles, comma separated" });
      roles.addEventListener("input", () => (s.roles = roles.value));
      const up = h("button", { class: "btn small" }, "Up");
      up.addEventListener("click", () => {
        if (i > 0) [stages[i - 1], stages[i]] = [stages[i], stages[i - 1]];
        draw();
      });
      const down = h("button", { class: "btn small" }, "Down");
      down.addEventListener("click", () => {
        if (i < stages.length - 1) [stages[i + 1], stages[i]] = [stages[i], stages[i + 1]];
        draw();
      });
      const remove = h("button", { class: "btn small danger" }, "Remove");
      remove.addEventListener("click", () => {
        stages.splice(i, 1);
        draw();
      });
      return h("div", { class: "row" }, h("span", { class: "muted" }, `${i + 1}${i === stages.length - 1 ? " (final)" : ""}`), name, roles, up, down, remove);
    });
    const nonFinal = stages.slice(0, -1);
    const revert = h("select", {}, ...nonFinal.map((s, i) => h("option", (s.key ?? String(i)) === revertKey ? { value: s.key ?? String(i), selected: true } : { value: s.key ?? String(i) }, s.name || `Stage ${i + 1}`)));
    revert.addEventListener("change", () => (revertKey = revert.value));
    const add = h("button", { class: "btn" }, "Add stage");
    add.addEventListener("click", () => {
      stages.splice(Math.max(0, stages.length - 1), 0, { name: "", roles: "" });
      draw();
    });
    const save = h("button", { class: "btn primary" }, wf ? "Save workflow" : "Create workflow");
    save.addEventListener("click", () =>
      void guarded(async () => {
        const input: WorkflowInput = {
          collectionName: col.displayName,
          stages: stages.map((s) => ({ key: s.key, name: s.name, requiredRoles: s.roles.split(",").map((r) => r.trim()).filter(Boolean) })),
        };
        // A revert target is only sent when it names an existing stage key; otherwise the server default (first review stage) applies.
        if (revertKey && stages.some((s) => s.key === revertKey)) input.revertStageKey = revertKey;
        await api("PUT", `/workflows/${encodeURIComponent(col.id)}`, input);
        toast("Workflow saved.");
        await renderWorkflows();
      })
    );
    const del = h("button", { class: "btn danger" }, "Delete workflow");
    del.addEventListener("click", () =>
      void guarded(async () => {
        if (!window.confirm(`Delete the workflow for ${col.displayName}? Item tracking is removed; the audit log is kept.`)) return;
        await api("DELETE", `/workflows/${encodeURIComponent(col.id)}`);
        await renderWorkflows();
      })
    );
    holder.replaceChildren(
      h("p", { class: "muted" }, "Roles on a stage may move items out of it (approve, reject or request changes). Roles on the final stage may publish."),
      ...rows,
      h("div", { class: "row" }, add, h("span", { class: "muted" }, "Send edited-after-approval items back to:"), revert),
      h("div", { class: "row" }, save, wf ? del : null)
    );
  };
  draw();
  return card(`${col.displayName}${wf ? "" : " (no workflow)"}`, holder);
}

async function renderWorkflows(): Promise<void> {
  const [{ collections }, { workflows }] = await Promise.all([api<{ collections: CollectionDto[] }>("GET", "/collections"), api<{ workflows: WorkflowDto[] }>("GET", "/workflows")]);
  view.replaceChildren(...collections.map((c) => workflowEditor(c, workflows.find((w) => w.collectionId === c.id))));
}

// --- Team tab (owner) ---
async function renderTeam(created?: MemberCreatedDto): Promise<void> {
  const [{ members }, settings] = await Promise.all([api<{ members: MemberDto[] }>("GET", "/members"), api<{ reminderLeadHours: number }>("GET", "/settings")]);

  const rows = members.map((m) => {
    if (m.isOwner) return [m.email, m.name, "all roles (owner)", null];
    const roles = h("input", { value: m.roles.join(", ") });
    const save = h("button", { class: "btn small" }, "Save roles");
    save.addEventListener("click", () =>
      void guarded(async () => {
        await api("PUT", `/members/${m.id}`, { roles: roles.value.split(",").map((r) => r.trim()).filter(Boolean) });
        toast("Roles updated.");
        await renderTeam();
      })
    );
    const rotate = h("button", { class: "btn small" }, "New token");
    rotate.addEventListener("click", () => void guarded(async () => renderTeam(await api<MemberCreatedDto>("POST", `/members/${m.id}/rotate-token`))));
    const remove = h("button", { class: "btn small danger" }, "Remove");
    remove.addEventListener("click", () =>
      void guarded(async () => {
        if (!window.confirm(`Remove ${m.email}?`)) return;
        await api("DELETE", `/members/${m.id}`);
        await renderTeam();
      })
    );
    return [m.email, m.name, h("span", {}, roles, " ", save), h("span", {}, rotate, " ", remove)];
  });

  const email = h("input", { placeholder: "email@company.com" });
  const name = h("input", { placeholder: "Name" });
  const roles = h("input", { placeholder: "Roles, e.g. legal, editor" });
  const add = h("button", { class: "btn primary" }, "Add member");
  add.addEventListener("click", () =>
    void guarded(async () => {
      const c = await api<MemberCreatedDto>("POST", "/members", { email: email.value, name: name.value, roles: roles.value.split(",").map((r) => r.trim()).filter(Boolean) });
      await renderTeam(c);
    })
  );

  const lead = h("input", { class: "num", type: "number", min: "1", max: "720", value: String(settings.reminderLeadHours) });
  const saveLead = h("button", { class: "btn" }, "Save");
  saveLead.addEventListener("click", () =>
    void guarded(async () => {
      await api("PUT", "/settings", { reminderLeadHours: Number(lead.value) });
      toast("Settings saved.");
    })
  );

  const tokenCard = created
    ? [card(`Token for ${created.member.email}`, h("p", { class: "muted" }, "Shown once. Share it privately together with the Site ID; it signs the member in with their own roles."), h("div", { class: "token" }, created.token))]
    : [];
  view.replaceChildren(
    ...tokenCard,
    card("Team", table(["Email", "Name", "Roles", ""], rows), h("h3", {}, "Add member"), h("div", { class: "row" }, email, name, roles, add)),
    card("Reminders", h("div", { class: "row" }, h("label", {}, "Start reminding "), lead, h("span", {}, " hours before a review is due "), saveLead))
  );
}

// --- Audit tab ---
async function renderAudit(): Promise<void> {
  const from = h("input", { type: "date" });
  const to = h("input", { type: "date" });
  const query = () => `${from.value ? `from=${encodeURIComponent(from.value)}&` : ""}${to.value ? `to=${encodeURIComponent(to.value)}&` : ""}limit=200`;
  const body = h("div", {});
  const load = async (): Promise<void> => {
    const { entries } = await api<{ entries: AuditEntryDto[] }>("GET", `/audit?${query()}`);
    body.replaceChildren(
      table(
        ["When", "Event", "Item", "Stage", "Actor", "Detail"],
        entries.map((e) => [fmt(e.at), tag(e.event.replace(/_/g, " "), e.source === "transition" ? e.event : ""), e.itemId ?? "", e.toStage ? `${e.fromStage ?? "-"} → ${e.toStage}` : "", `${e.actor}${e.role ? ` (${e.role})` : ""}`, e.detail])
      )
    );
  };
  const apply = h("button", { class: "btn" }, "Apply");
  apply.addEventListener("click", () => void guarded(load));
  const exportBtn = h("button", { class: "btn primary" }, "Export CSV");
  exportBtn.addEventListener("click", () => void guarded(() => downloadCsv(query().replace("limit=200", "limit=50000"))));
  const cards: HTMLElement[] = [card("Audit log", h("div", { class: "row" }, h("label", {}, "From ", from), h("label", {}, "To ", to), apply, exportBtn), body)];
  if (me?.member.isOwner) {
    const { mails } = await api<{ mails: MailLogDto[] }>("GET", "/mail-log");
    cards.push(card("Outgoing mail (logged stub)", table(["When", "To", "Kind", "Subject"], mails.map((m) => [fmt(m.createdAt), m.to, m.kind, m.subject]), "No mail logged yet.")));
  }
  view.replaceChildren(...cards);
  await load();
}

// --- routing & boot ---
async function renderCurrent(): Promise<void> {
  switch (current) {
    case "board":
      return renderBoard();
    case "reviews":
      return renderReviews();
    case "workflows":
      return renderWorkflows();
    case "team":
      return renderTeam();
    case "audit":
      return renderAudit();
  }
}

function setTab(tab: Tab): void {
  current = tab;
  for (const t of document.querySelectorAll<HTMLElement>(".tab")) t.classList.toggle("active", t.dataset.tab === tab);
  void guarded(renderCurrent);
}

function boot(): void {
  creds = creds ?? loadCreds();
  $<HTMLElement>("connect").hidden = creds !== null;
  $<HTMLElement>("main").hidden = creds === null;
  if (!creds) return;
  void guarded(async () => {
    me = await api<MeDto>("GET", "/me");
    $<HTMLElement>("whoami").textContent = `Signed in as ${me.member.name || me.member.email}${me.member.isOwner ? " (owner)" : me.member.roles.length ? ` (${me.member.roles.join(", ")})` : ""}`;
    for (const el of document.querySelectorAll<HTMLElement>(".owner-only")) el.hidden = !me.member.isOwner;
    await renderCurrent();
  });
}

for (const t of document.querySelectorAll<HTMLElement>(".tab")) t.addEventListener("click", () => setTab(t.dataset.tab as Tab));

$<HTMLButtonElement>("conn-save").addEventListener("click", () => {
  const siteId = $<HTMLInputElement>("conn-site").value.trim();
  const token = $<HTMLInputElement>("conn-token").value.trim();
  if (!siteId || !token) return toast("Site ID and token are required.", true);
  creds = { siteId, token };
  try {
    sessionStorage.setItem("ca-creds", JSON.stringify(creds));
  } catch {
    /* session storage unavailable; keep in memory */
  }
  boot();
});

$<HTMLButtonElement>("disconnect").addEventListener("click", () => {
  try {
    sessionStorage.removeItem("ca-creds");
  } catch {
    /* ignore */
  }
  creds = null;
  me = null;
  boot();
});

boot();
