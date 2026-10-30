import { z } from "zod";

import { aiProviderIdSchema } from "./ai-providers.ts";

// What the admin reads of a client's AI (core's ai-status-report.ts), for
// its Setup: the providers its organization connected, its default
// model's first, and how each one's calls last fared, as the model
// ledger noted them from real calls (`providerHealth`); and how Grasp's
// own keys fared for its platform features. Never a key, a mask or a base
// URL: provider ids and times only. Only the admin reads it: the request
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
});
export type AiProviderStatus = z.infer<typeof aiProviderStatusSchema>;

/** The client's AI, as core answers the admin. */
export const aiStatusReportSchema = z.strictObject({
  /**
   * Every provider the organization connected (`organization`), its
   * default model's provider first, whether or not a call reached it yet;
   * then every provider Grasp's own key was used with (`platform`).
   */
  providers: z.array(aiProviderStatusSchema).max(16),
});
export type AiStatusReport = z.infer<typeof aiStatusReportSchema>;
