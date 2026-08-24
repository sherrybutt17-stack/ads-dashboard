import { getDailySeries } from "./queries";
import type { AdPlatform, PaidLeadFilter } from "./queries";
import { eachDateKey, todayKey, trailingMonths, windowFromKeys } from "@/lib/dates";
import {
  buildForecast,
  isoDow,
  type ForecastDay,
  type ForecastReport,
} from "./forecast";

/**
 * Fetching for the month-end forecast.
 *
 * Separate from `forecast.ts` so the arithmetic stays pure and testable without
 * a database, and separate from `dashboard.ts` because of the awkward fact
 * below.
 *
 * 🔴 **The forecast does not read the selected date range.** It is a claim about
 * the calendar month, so it loads the calendar month whatever the picker says —
 * the same cadence exception the four report tables carry, and it is labelled
 * the same way in the UI. Reading `data.daily` instead would have been free and
 * would have produced a "month-end forecast" computed from the last 7 days, or
 * from March, depending on what the operator had clicked.
 */

export async function loadForecast(
  clientId: string,
  tz: string,
  filter: PaidLeadFilter,
  platform: AdPlatform,
  now: Date = new Date(),
): Promise<ForecastReport> {
  const [thisMonth, lastMonth] = trailingMonths(2, tz, now);
  const today = todayKey(tz, now);

  /*
   * One query spanning both months rather than two. The previous month is only
   * wanted for context beside the projection, and a second round trip for a
   * comparison line is not worth it on a page already issuing ~60.
   */
  const span = windowFromKeys(lastMonth.startKey, thisMonth.endKey, tz);
  const keys = eachDateKey(span, tz);
  const series = await getDailySeries(
    clientId,
    span,
    tz,
    keys,
    undefined,
    filter,
    platform,
  );

  const days: ForecastDay[] = [];
  let prevSpend = 0;
  let prevLeads = 0;

  for (const p of series) {
    if (p.dateKey >= thisMonth.startKey) {
      days.push({
        dateKey: p.dateKey,
        dow: isoDow(p.dateKey),
        spend: p.ads.spend,
        leads: p.funnel.new_lead,
      });
    } else {
      prevSpend += p.ads.spend;
      prevLeads += p.funnel.new_lead;
    }
  }

  /*
   * Today first, then the rest of the month. Today is in the REMAINING list
   * rather than the observed one because it is still in progress — see
   * `buildForecast`.
   */
  const remainingDows = eachDateKey(thisMonth, tz)
    .filter((k) => k >= today)
    .map(isoDow);

  const monthDays = eachDateKey(thisMonth, tz).length;

  return buildForecast(days, {
    monthKey: thisMonth.monthKey,
    todayKey: today,
    daysInMonth: monthDays,
    remainingDows,
    previous: { spend: prevSpend, leads: prevLeads },
  });
}
