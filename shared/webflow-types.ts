// Typed models for the subset of the Webflow Data API v2 this app uses.

export interface WebflowTokenResponse {
  access_token: string;
  token_type?: string;
  scope?: string;
  refresh_token?: string;
  expires_in?: number;
}

export interface WebflowSiteSummary {
  id: string;
  displayName?: string;
  shortName?: string;
  customDomains?: Array<{ id: string; url: string }>;
}

export interface WebflowAuthorizedUser {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
}

export interface WebflowCollectionSummary {
  id: string;
  displayName: string;
  singularName?: string;
  slug?: string;
  createdOn?: string;
  lastUpdated?: string;
}

export interface WebflowField {
  id: string;
  slug: string;
  displayName: string;
  type: string;
  isRequired?: boolean;
}

export interface WebflowCollection extends WebflowCollectionSummary {
  fields?: WebflowField[];
}

export interface WebflowItem {
  id: string;
  cmsLocaleId?: string;
  createdOn?: string;
  lastUpdated?: string;
  lastPublished?: string | null;
  isArchived?: boolean;
  isDraft?: boolean;
  fieldData: Record<string, unknown>;
}

export interface WebflowItemListResponse {
  items: WebflowItem[];
  pagination?: { limit: number; offset: number; total: number };
}

export interface PublishItemsResponse {
  publishedItemIds?: string[];
  errors?: string[];
}

/** Payload of collection_item_changed / _created / _deleted webhooks. */
export interface WebflowItemWebhookPayload {
  id?: string;
  itemId?: string;
  _id?: string;
  siteId?: string;
  collectionId?: string;
  lastUpdated?: string;
  lastPublished?: string | null;
  isArchived?: boolean;
  isDraft?: boolean;
  fieldData?: Record<string, unknown>;
}

export interface WebflowWebhook {
  id: string;
  triggerType: string;
  url: string;
  siteId?: string;
}

export interface WebflowWebhookEnvelope<T = unknown> {
  triggerType: string;
  payload: T;
}
