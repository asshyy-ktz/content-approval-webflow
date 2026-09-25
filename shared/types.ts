// DTOs shared by the server and the App Panel.

/** Actions recorded in the append-only transition log. */
export type TransitionAction = "advance" | "reject" | "request_changes" | "auto_revert" | "publish" | "track" | "reset";
/** Actions a person can trigger from the panel. */
export type UserAction = "advance" | "reject" | "request_changes" | "publish";

export const MAX_STAGES = 12;
export const MIN_STAGES = 2;
export const MAX_COMMENT_LENGTH = 4000;

export interface StageDto {
  key: string;
  name: string;
  requiredRoles: string[];
}

export interface WorkflowDto {
  collectionId: string;
  collectionName: string;
  revertStageKey: string;
  stages: StageDto[];
  updatedAt: string;
}

export interface WorkflowInput {
  collectionName?: string;
  revertStageKey?: string;
  stages: Array<{ key?: string; name: string; requiredRoles: string[] }>;
}

export interface MemberDto {
  id: number;
  email: string;
  name: string;
  roles: string[];
  isOwner: boolean;
}

export interface MemberCreatedDto {
  member: MemberDto;
  /** Shown once; only its SHA-256 is stored. */
  token: string;
}

export interface MeDto {
  siteId: string;
  member: MemberDto;
}

export interface CollectionDto {
  id: string;
  displayName: string;
  slug?: string;
  hasWorkflow: boolean;
}

export interface ItemCardDto {
  collectionId: string;
  itemId: string;
  title: string;
  slug: string;
  stageKey: string;
  flagged: boolean;
  flagReason: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  publishedAt: string | null;
  openComments: number;
  assignees: string[];
  nextDueAt: string | null;
  updatedAt: string;
}

export interface BoardColumnDto {
  stage: StageDto;
  items: ItemCardDto[];
}

export interface BoardDto {
  workflow: WorkflowDto;
  columns: BoardColumnDto[];
}

export interface SyncResultDto {
  total: number;
  added: number;
  removed: number;
  reverted: number;
}

export type DiffStatus = "added" | "removed" | "changed" | "unchanged";

export interface FieldDiffDto {
  field: string;
  status: DiffStatus;
  before: unknown;
  after: unknown;
}

export interface TransitionDto {
  id: number;
  fromStage: string | null;
  toStage: string;
  action: TransitionAction;
  actorEmail: string;
  actorRole: string;
  note: string;
  createdAt: string;
}

export interface CommentDto {
  id: number;
  parentId: number | null;
  fieldSlug: string | null;
  authorEmail: string;
  body: string;
  mentions: string[];
  resolved: boolean;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export type ReviewStatus = "open" | "done" | "cancelled";

export interface ReviewRequestDto {
  id: number;
  collectionId: string;
  itemId: string;
  itemTitle: string;
  stageKey: string;
  requestedBy: string;
  assigneeEmail: string;
  dueAt: string | null;
  status: ReviewStatus;
  note: string;
  createdAt: string;
  completedAt: string | null;
  overdue: boolean;
}

export interface ItemDetailDto {
  item: ItemCardDto;
  workflow: WorkflowDto;
  hasSnapshot: boolean;
  diff: FieldDiffDto[];
  transitions: TransitionDto[];
  comments: CommentDto[];
  reviews: ReviewRequestDto[];
  allowedActions: UserAction[];
}

export interface AuditEntryDto {
  source: "transition" | "audit";
  id: number;
  at: string;
  event: string;
  collectionId: string | null;
  itemId: string | null;
  fromStage: string | null;
  toStage: string | null;
  actor: string;
  role: string;
  detail: string;
}

export interface SettingsDto {
  reminderLeadHours: number;
}

export interface MailLogDto {
  id: number;
  to: string;
  subject: string;
  body: string;
  kind: string;
  createdAt: string;
}
