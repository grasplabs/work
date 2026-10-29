import { z } from "zod";

// What the admin asks a client's core before it publishes the client's
// hostname (spec 40.2 step 7; core's src/provision-probe.ts): that core
// runs as this client, that each of its private bindings answers, and that
// its durable clocks are armed. Only the admin may ask: the request is
// signed with the key both derive from the client's auth secret, as the
// onboarding summary is (`onboarding-summary.ts`), and carries the router
// secret, as every request to core does. The router adds that secret to
// every public request it forwards, so it alone says nothing of who asks.
//
// The answer carries no secret, no resource id and nothing a client's
// people entered: core's and connect's version ids, the client id the admin deployed, and
// binding and task names from core's own code, each with a yes or no.

/** Where the admin asks. Behind the router-secret check. */
export const provisionProbePath = "/platform/probe";

/**
 * Where the admin asks core which version its connect answers as: how it
 * reads what a connect in a Workers for Platforms namespace runs (its
 * rollout/drift.ts), as Cloudflare's API lists none there. The admin's
 * alone, as the probe: signed with the key both derive from the client's
 * auth secret for this purpose (`connectVersionPurpose`), with the probe's
 * request (`provisionProbeRequestSchema`), and behind the router-secret
 * check, which says nothing of who asks (the router adds its secret to
 * every public request). Answered `{ ok: true, version }`, or 503 when
 * connect doesn't answer or names none; anything not the admin's is
 * answered as a path core has no route for.
 */
export const connectVersionPath = "/platform/connect-version";

/** The purpose the connect-version request's signing key is derived for (`hkdfHmacKey`). */
export const connectVersionPurpose = "grasp-os connect version key";

/** The purpose the request's signing key is derived for (`hkdfHmacKey`). */
export const provisionProbePurpose = "grasp-os provisioning probe key";

/** How far from core's clock a request may have been sent. */
export const provisionProbeMaxSkewMs = 5 * 60 * 1000;

/** The most bytes a request's body may have. */
export const provisionProbeMaxBytes = 1024;

/** What the admin sends: when, so a request caught on its way can't be sent later. */
export const provisionProbeRequestSchema = z.strictObject({
  sentAt: z.iso.datetime(),
});

/** A durable clock as the probe left it: armed, and the tasks it runs, by name. */
export const clockRegistrationSchema = z.strictObject({
  armed: z.boolean(),
  tasks: z.array(z.string()),
});
export type ClockRegistration = z.infer<typeof clockRegistrationSchema>;

/** What core answers the probe with. */
export const provisionProbeSchema = z.strictObject({
  /** The version answering (version metadata); null where there is none. */
  version: z.string().nullable(),
  /**
   * The version connect answers as, as connect named it to core over its
   * binding (through the connect gateway, in a namespace); null where it
   * has none or didn't answer.
   */
  connectVersion: z.string().nullable(),
  /** The client id its deploy set (`CLIENT_ID`); null where none is set. */
  clientId: z.string().nullable(),
  /**
   * Each private binding, by name: whether it answered a no-op call.
   * Connect's own are `connect.<name>`, as connect answered core.
   */
  bindings: z.record(z.string(), z.boolean()),
  /** Core's clock and connect's, each armed if it wasn't; null for one that didn't answer. */
  clocks: z.strictObject({
    core: clockRegistrationSchema.nullable(),
    connect: clockRegistrationSchema.nullable(),
  }),
});
export type ProvisionProbe = z.infer<typeof provisionProbeSchema>;
