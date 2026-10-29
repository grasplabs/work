import { z } from "zod";

// What the admin reads of a client's model spend (core's
// model-spend-report.ts), for its Setup: what the deployment's calls cost
// this UTC month as the model gateway's deployment budget counts it, the
// budget the admin's spend ceiling sets (GRA-141). Numbers only. Only the
// admin reads it: the request is signed with a key both derive from the
// client's auth secret for this purpose alone, as the quota policy report
// is (`quota-policy-report.ts`).

/** Where the admin asks core for its spend. Behind the router-secret check. */
export const modelSpendReportPath = "/platform/model-spend";

/** The purpose the request's signing key is derived for (`hkdfHmacKey`). */
export const modelSpendReportPurpose = "grasp-os model spend report key";

/** How far from core's clock a request may have been sent. */
export const modelSpendReportMaxSkewMs = 5 * 60 * 1000;

/** The most bytes a request's body may have. */
export const modelSpendReportMaxBytes = 1024;

/** What the admin sends: when, so a request caught on its way can't be sent later. */
export const modelSpendReportRequestSchema = z.strictObject({
  sentAt: z.iso.datetime(),
});

/** The deployment's spend this month, as core answers the admin. */
export const modelSpendReportSchema = z.strictObject({
  /** The UTC month it counts, such as `2026-10`. */
  month: z.string().regex(/^\d{4}-\d{2}$/u),
  /**
   * What the deployment's calls were charged this month, at the providers'
   * list prices in US dollars, as its deployment budget counts it.
   * Reservations held by calls under way aren't spend yet.
   */
  spent: z.number().min(0),
});
export type ModelSpendReport = z.infer<typeof modelSpendReportSchema>;
