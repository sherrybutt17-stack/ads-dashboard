/**
 * GoHighLevel payload shapes.
 *
 * Deliberately loose. Two payload sources reach us with different shapes:
 *
 *  (a) Marketplace app webhooks — the documented flat shape below.
 *  (b) Workflow → Webhook (Outbound) actions — the workflow's contact context,
 *      larger and less stable, with opportunity fields only present when the
 *      workflow was triggered by an opportunity event.
 *
 * We accept (b), so every field is optional and nothing is trusted to be
 * present. Normalisation happens in `normalizeWebhookPayload`.
 */

export interface GhlOpportunityWebhook {
  type?: string;
  locationId?: string;
  id?: string;
  assignedTo?: string;
  contactId?: string;
  monetaryValue?: number;
  name?: string;
  pipelineId?: string;
  /** UUID format — unlike GHL's other ids, which are 20-char base62. */
  pipelineStageId?: string;
  source?: string;
  status?: string;
  /** The opportunity's CREATION date — NOT the time of this event. */
  dateAdded?: string;
  [k: string]: unknown;
}

/** What we actually need, extracted from whichever shape arrived. */
export interface NormalizedOpportunityEvent {
  eventType: string | null;
  locationId: string | null;
  opportunityId: string | null;
  contactId: string | null;
  pipelineId: string | null;
  pipelineStageId: string | null;
  name: string | null;
  status: string | null;
  monetaryValue: number | null;
  source: string | null;
  dateAdded: string | null;
  /** Envelope timestamp if the sender provided one. */
  envelopeTimestamp: string | null;
}

export interface GhlPipeline {
  id: string;
  name?: string;
  stages?: GhlPipelineStage[];
  locationId?: string;
  [k: string]: unknown;
}

/**
 * NOTE: the element shape of `pipelines[].stages[]` is genuinely unpublished —
 * GHL's own PHP SDK types it `array<array<mixed>>`. We read defensively and
 * accept several plausible key spellings.
 */
export interface GhlPipelineStage {
  id?: string;
  _id?: string;
  name?: string;
  stageName?: string;
  position?: number;
  [k: string]: unknown;
}

export interface GhlOpportunity {
  id: string;
  name?: string;
  monetaryValue?: number;
  pipelineId?: string;
  pipelineStageId?: string;
  status?: string;
  source?: string;
  contactId?: string;
  createdAt?: string;
  updatedAt?: string;
  /** The single most valuable field available — the authoritative timestamp of
   *  the most recent stage change. There is no full history anywhere. */
  lastStageChangeAt?: string;
  lastStatusChangeAt?: string;
  lastActionDate?: string;
  contact?: { id?: string; email?: string; name?: string; [k: string]: unknown };
  [k: string]: unknown;
}

export interface GhlAttributionSource {
  url?: string;
  campaign?: string;
  /** Holds the Meta numeric campaign id when UTMs are configured. */
  campaignId?: string;
  utmSource?: string;
  utmMedium?: string;
  utmContent?: string;
  utmTerm?: string;
  utmCampaign?: string;
  referrer?: string;
  fbclid?: string;
  gclid?: string;
  sessionSource?: string;
  medium?: string;
  mediumId?: string;
  /** Populated only if `ad_id` / `ad_group_id` URL params are set on the ads —
   *  the parser appears to be query-parameter-name driven. */
  adId?: string;
  adGroupId?: string;
  [k: string]: unknown;
}

export interface GhlContact {
  id: string;
  locationId?: string;
  firstName?: string;
  lastName?: string;
  name?: string;
  email?: string;
  phone?: string;
  source?: string;
  dateAdded?: string;
  dateUpdated?: string;
  /** First touch — static. */
  attributionSource?: GhlAttributionSource;
  /** Latest touch — overwritten on each qualifying visit. */
  lastAttributionSource?: GhlAttributionSource;
  customFields?: Array<{ id?: string; value?: unknown; [k: string]: unknown }>;
  [k: string]: unknown;
}

export interface GhlLocation {
  id: string;
  name?: string;
  timezone?: string;
  [k: string]: unknown;
}
