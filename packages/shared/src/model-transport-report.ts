import { z } from "zod";

import { modelResidencies, modelTransportKinds } from "./model-transport.ts";

// What the admin reads of a client's model transport (core's
// model-transport-report.ts), for Setup's AI section and the hosting
// policy's automatic check: the transport in force, the route each allowed
// model takes and where it runs, as the residency catalog says, the
// transports' last success and failure, and, when asked, a probe call's
// metadata. Metadata only: never a prompt, an answer or a key. Only the
// admin reads it: the request is signed with a key both derive from the
// client's auth secret for this purpose alone, as the spend report is.

/** Where the admin asks core for it. Behind the router-secret check. */
export const modelTransportReportPath = "/platform/model-transport";

/** The purpose the request's signing key is derived for (`hkdfHmacKey`). */
export const modelTransportReportPurpose =
  "grasp-os model transport report key";

/** How far from core's clock a request may have been sent. */
export const modelTransportReportMaxSkewMs = 5 * 60 * 1000;

/** The most bytes a request's body may have. */
export const modelTransportReportMaxBytes = 1024;

/** What the admin sends: when, and whether core should probe its route. */
export const modelTransportReportRequestSchema = z.strictObject({
  sentAt: z.iso.datetime(),
  /** Make one small model call through the gateway, as any call goes. */
  probe: z.boolean().default(false),
  /** The staff member asking, whom a probe's audit events name. */
  staff: z.email().max(254).optional(),
});
export type ModelTransportReportRequest = z.input<
  typeof modelTransportReportRequestSchema
>;

/** The route an allowed model takes, as the residency catalog has it. */
const routeSchema = z.strictObject({
  model: z.string(),
  /** Its transport, as the audit log names it; null when none reaches it. */
  transport: z.string().nullable(),
  provider: z.string(),
  host: z.string().nullable(),
  /** The residency catalog's entry; null for a route no entry matches. */
  route: z.string().nullable(),
  region: z.string().nullable(),
  /** Whether the organization's residency lets it carry calls. */
  allowed: z.boolean(),
});

const healthSchema = z.strictObject({
  transport: z.string(),
  lastOkAt: z.number().nullable(),
  lastFailedAt: z.number().nullable(),
  lastFailure: z.string().nullable(),
  lastStatus: z.number().nullable(),
});

const probeSchema = z.strictObject({
  model: z.string(),
  ok: z.boolean(),
  /** Why it failed, as a model error code; null when it worked. */
  error: z.string().nullable(),
  /** The way it went, as the ledger recorded it; null when it went nowhere. */
  transport: z.string().nullable(),
  region: z.string().nullable(),
  ms: z.number().min(0),
});

/** The deployment's model transport, as core answers the admin. */
export const modelTransportReportSchema = z.strictObject({
  /** Whether `MODEL_TRANSPORT` parses: when it doesn't, no call is made. */
  valid: z.boolean(),
  residency: z.enum(modelResidencies),
  primary: z.enum(modelTransportKinds).nullable(),
  failover: z.array(z.enum(modelTransportKinds)),
  routes: z.array(routeSchema),
  /** Provider keys the transports name that the deployment doesn't have: names only. */
  missingKeys: z.array(z.string()),
  health: z.array(healthSchema),
  probe: probeSchema.nullable(),
});
export type ModelTransportReport = z.infer<typeof modelTransportReportSchema>;
