import { z } from "zod";

import { aiProviderIdSchema, providerTroubles } from "./ai-providers.ts";
import { platformAiFeatures } from "./platform-ai.ts";

// What the admin reads of a client's AI (core's ai-status-report.ts), for
// its Setup: the providers its organization connected, its default
// model's first, and how each one's calls last fared, as the model
// ledger noted them from real calls (`providerHealth`); and how Grasp's
// own keys fared for its platform features; and what those features cost
// on Grasp's keys this month and last, from the ledger's charges. Never a
// key, a mask or a base URL: provider ids, models, times and amounts only. Only the admin reads it: the request
// is signed with a key both derive from the client's auth secret for this
// purpose alone, as the quota policy report is (`quota-policy-report.ts`).

/** Where the admin asks core for its AI's status. Behind the router-secret check. */
export const aiStatusReportPath = "/platform/ai-status";

/** The purpose the request's signing key is derived for (`hkdfHmacKey`). */
export const aiStatusReportPurpose = "grasp-os ai status report key";

/** How far from core's clock a request may have been sent. */
export const aiStatusReportMaxSkewMs = 5 * 60 * 1000;

/** The most bytes a request's body may have. */
export const aiStatusReportMaxBytes = 1024;

/** What the admin sends: when, so a request caught on its way can't be sent later. */
export const aiStatusReportRequestSchema = z.strictObject({
  sentAt: z.iso.datetime(),
});

/** A time in epoch milliseconds, or none. */
const at = z.int().min(0).nullable();

/** How one provider's calls last fared, by whose key. */
export const aiProviderStatusSchema = z.strictObject({
  provider: aiProviderIdSchema,
  /**
   * Whose key: the organization's own, which its admins connected, or
   * Grasp's, for its platform features (conversion, transcription, speech).
   */
  kind: z.enum(["organization", "platform"]),
  /** When a call last worked; null before one did. */
  lastOkAt: at,
  /** When a call last failed; null before one did. */
  lastFailedAt: at,
  /** How it last failed (the transport's failure kind), if it did. */
  lastFailure: z.string().max(64).nullable(),
  /**
   * What its calls show now, by the HTTP class seen (`ProviderTrouble`),
   * and since when: the first failure of that kind after the last call
   * that worked. Null while the last call worked, or once the key was
   * replaced. Missing from a core on an earlier release, which the admin
   * reads as null: the admin and the cores roll out on their own.
   */
  failingClass: z.enum(providerTroubles).nullable().default(null),
  failingSince: at.default(null),
});
export type AiProviderStatus = z.infer<typeof aiProviderStatusSchema>;

/**
 * What one model cost for one of Grasp's own features in a month, on
 * Grasp's keys: the model ledger's charges at list prices, in millionths
 * of a US dollar. `feature` is null for a call on Grasp's key whose
 * feature wasn't recorded.
 */
export const platformSpendRowSchema = z.strictObject({
  feature: z.enum(platformAiFeatures).nullable(),
  /** `<provider>/<model>`, as the ledger records it. */
  model: z.string().min(1).max(256),
  micros: z.int().min(0),
});
export type PlatformSpendRow = z.infer<typeof platformSpendRowSchema>;

/** What Grasp's own features cost in one UTC month, model by model. */
export const platformMonthSpendSchema = z.strictObject({
  /** The UTC month, such as `2026-10`. */
  period: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u),
  rows: z.array(platformSpendRowSchema).max(64),
});
export type PlatformMonthSpend = z.infer<typeof platformMonthSpendSchema>;

/** The client's AI, as core answers the admin. */
export const aiStatusReportSchema = z.strictObject({
  /**
   * Every provider the organization connected (`organization`), its
   * default model's provider first, whether or not a call reached it yet;
   * then every provider Grasp's own key was used with (`platform`).
   */
  providers: z.array(aiProviderStatusSchema).max(16),
  /**
   * What Grasp's own features cost on its keys, this month and last.
   * Optional: a core on an earlier release reports its providers only,
   * and the admin and the cores roll out on their own, so its AI status
   * still reads, its spend shown as not reported by its release.
   */
  platformSpend: z
    .strictObject({
      thisMonth: platformMonthSpendSchema,
      lastMonth: platformMonthSpendSchema,
    })
    .optional(),
});
export type AiStatusReport = z.infer<typeof aiStatusReportSchema>;
