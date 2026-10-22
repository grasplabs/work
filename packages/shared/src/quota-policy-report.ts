import { z } from "zod";

import { lowerableLimits } from "./quota-policy.ts";

// What the console reads of a client's quota policy (core's
// workflows/quota-report.ts), for its client page: the generation core
// applies, the limits it lowers and when core recorded it, so the console
// can tell when core refused a policy it deployed (GRA-600). Numbers only.
// Only the console reads it: the request is signed with a key both derive
// from the client's auth secret for this purpose alone, as the onboarding
// summary is (`onboarding-summary.ts`).

/** Where the console asks core for the policy. Behind the router-secret check. */
export const quotaPolicyReportPath = "/platform/quota-policy";

/** The purpose the request's signing key is derived for (`hkdfHmacKey`). */
export const quotaPolicyReportPurpose = "grasp-os quota policy report key";

/** How far from core's clock a request may have been sent. */
export const quotaPolicyReportMaxSkewMs = 5 * 60 * 1000;

/** The most bytes a request's body may have. */
export const quotaPolicyReportMaxBytes = 1024;

/** What the console sends: when, so a request caught on its way can't be sent later. */
export const quotaPolicyReportRequestSchema = z.strictObject({
  sentAt: z.iso.datetime(),
});

const limitValue = z.int().min(1);

/** The policy core applies, as it answers the console. */
export const quotaPolicyReportSchema = z.strictObject({
  /** The generation applied; 0 for the platform's own, none recorded. */
  generation: z.int().min(0),
  /** What it lowers, each as applied (no higher than the platform's now). */
  lowered: z.partialRecord(z.enum(lowerableLimits), limitValue),
  /**
   * The hash of the limits core recorded for it (`quotaLimitsHash`), as
   * deployed: the console compares it with its own, so another policy
   * under the same generation reads as drift. Null for the platform's own.
   */
  limitsHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/u)
    .nullable(),
  /** When core recorded it (ISO 8601); null for the platform's own. */
  recordedAt: z.iso.datetime().nullable(),
});
export type QuotaPolicyReport = z.infer<typeof quotaPolicyReportSchema>;
