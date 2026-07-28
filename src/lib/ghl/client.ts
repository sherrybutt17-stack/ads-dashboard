import type {
  GhlContact,
  GhlLocation,
  GhlOpportunity,
  GhlPipeline,
  GhlPipelineStage,
} from "./types";

const BASE_URL = "https://services.leadconnectorhq.com";

/**
 * Required header with a strict enum. v2 is `2021-07-28`; sending anything else
 * (or omitting it) fails the request.
 */
const API_VERSION = "2021-07-28";

export class GhlApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "GhlApiError";
  }
}

export class GhlClient {
  constructor(private readonly token: string) {}

  private async request<T>(
    path: string,
    init: RequestInit & { query?: Record<string, string | number | undefined> } = {},
  ): Promise<T> {
    const { query, ...rest } = init;
    const url = new URL(`${BASE_URL}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== "") {
          url.searchParams.set(k, String(v));
        }
      }
    }

    const res = await fetch(url, {
      ...rest,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Version: API_VERSION,
        Accept: "application/json",
        ...(rest.body ? { "Content-Type": "application/json" } : {}),
        ...rest.headers,
      },
      cache: "no-store",
    });

    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }

    if (!res.ok) {
      throw new GhlApiError(
        `GHL ${res.status} on ${path}: ${
          typeof body === "string" ? body : JSON.stringify(body)
        }`,
        res.status,
        body,
      );
    }
    return body as T;
  }

  /**
   * Verification call used during onboarding — proves the token is valid AND
   * that it can actually reach this specific location, which a token that is
   * merely well-formed cannot.
   */
  async getLocation(locationId: string): Promise<GhlLocation> {
    const res = await this.request<{ location?: GhlLocation } & GhlLocation>(
      `/locations/${encodeURIComponent(locationId)}`,
    );
    return res.location ?? (res as GhlLocation);
  }

  async getPipelines(locationId: string): Promise<GhlPipeline[]> {
    const res = await this.request<{ pipelines?: GhlPipeline[] }>(
      `/opportunities/pipelines`,
      { query: { locationId } },
    );
    return res.pipelines ?? [];
  }

  async getOpportunity(opportunityId: string): Promise<GhlOpportunity | null> {
    try {
      const res = await this.request<{ opportunity?: GhlOpportunity }>(
        `/opportunities/${encodeURIComponent(opportunityId)}`,
      );
      return res.opportunity ?? null;
    } catch (err) {
      if (err instanceof GhlApiError && err.status === 404) return null;
      throw err;
    }
  }

  async getContact(contactId: string): Promise<GhlContact | null> {
    try {
      const res = await this.request<{ contact?: GhlContact }>(
        `/contacts/${encodeURIComponent(contactId)}`,
      );
      return res.contact ?? null;
    } catch (err) {
      if (err instanceof GhlApiError && err.status === 404) return null;
      throw err;
    }
  }

  /**
   * Page through every opportunity in a location.
   *
   * Used for the day-0 backfill snapshot. Cursor semantics on this endpoint are
   * thinly documented, so we drive it by page number and stop as soon as a page
   * comes back empty or short — and hard-cap the loop so a pagination quirk
   * cannot spin forever.
   */
  async *iterateOpportunities(
    locationId: string,
    { limit = 100, maxPages = 500 } = {},
  ): AsyncGenerator<GhlOpportunity[]> {
    let page = 1;
    while (page <= maxPages) {
      const res = await this.request<{
        opportunities?: GhlOpportunity[];
        meta?: { nextPageUrl?: string | null; total?: number };
      }>(`/opportunities/search`, {
        query: { location_id: locationId, limit, page, status: "all" },
      });

      const batch = res.opportunities ?? [];
      if (batch.length === 0) return;
      yield batch;

      // Stop on a short page, or when the API stops offering a next page.
      if (batch.length < limit) return;
      if (res.meta && res.meta.nextPageUrl === null) return;
      page += 1;
    }
  }
}

/**
 * Flatten GHL's pipelines into our stage rows.
 *
 * Defensive about key spelling because the element shape of `stages[]` is
 * unpublished — GHL's own SDK types it as an untyped array.
 */
export function flattenStages(
  pipelines: GhlPipeline[],
): Array<{
  pipelineId: string;
  pipelineName: string | null;
  stageId: string;
  stageName: string | null;
  position: number;
}> {
  const out: ReturnType<typeof flattenStages> = [];
  for (const p of pipelines) {
    const stages = Array.isArray(p.stages) ? p.stages : [];
    stages.forEach((s: GhlPipelineStage, i: number) => {
      const stageId = s.id ?? s._id;
      if (!stageId) return;
      out.push({
        pipelineId: p.id,
        pipelineName: p.name ?? null,
        stageId: String(stageId),
        stageName: (s.name ?? s.stageName ?? null) as string | null,
        position: typeof s.position === "number" ? s.position : i,
      });
    });
  }
  return out;
}

/**
 * Best-effort guess at which canonical stage a GHL stage name refers to, used
 * only to PRE-SELECT dropdowns in the mapping UI. The operator always confirms.
 * Never used to map silently — a wrong guess would corrupt the funnel.
 */
export function guessCanonicalStage(name: string | null): string | null {
  if (!name) return null;
  const n = name.toLowerCase().trim();

  const rules: Array<[RegExp, string]> = [
    [/\b(no[\s-]?show|missed|didn'?t show)\b/, "no_show"],
    [/\b(won|closed[\s-]?won|sold|customer|purchased)\b/, "closed_won"],
    [/\b(lost|dead|unqualified|not interested|cancel)/, "lost"],
    [/\b(showed|shown|attended|consult(ation)? complete)/, "showed"],
    [/\b(appointment|appt|booked|scheduled|consult)/, "appointment_booked"],
    [/\b(contacted|reached|responded|replied|engaged|follow[\s-]?up)/, "contacted"],
    [/\b(new|lead|inquiry|enquiry|prospect)/, "new_lead"],
  ];

  for (const [re, stage] of rules) if (re.test(n)) return stage;
  return null;
}
