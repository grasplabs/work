import { log } from "@grasp-os/shared/log";
import {
  provisionProbeMaxBytes,
  provisionProbeMaxSkewMs,
  provisionProbePurpose,
  provisionProbeRequestSchema,
} from "@grasp-os/shared/provision-probe";
import type {
  ClockRegistration,
  ProvisionProbe,
} from "@grasp-os/shared/provision-probe";

import { clock } from "./clock.ts";
import { consoleSigned } from "./console-signed.ts";

// The admin's provisioning probe (spec 40.2 step 7,
// @grasp-os/shared/provision-probe): before it publishes a client's
// hostname, the admin asks core whether it runs as that client, whether
// each private binding answers, and arms both durable clocks. Threat
// model, each tried in test/provision-probe.test.ts:
//
// - Anyone reaching core through the router: the router adds its secret to
//   every public request, so the probe also wants the admin's signature
//   (console-signed.ts), with a key derived from this client's auth secret
//   for the probe alone. A signature for another client, or for the
//   onboarding summary or a platform update, is made with another key and
//   doesn't verify.
// - A signed request caught and sent again: taken only within
//   `provisionProbeMaxSkewMs` of when it was signed, and all it can do
//   then is what the admin asked anyway: no-op reads and arming clocks
//   that are armed.
// - Telling the endpoint exists: a request that isn't the admin's gets
//   what any other unknown path gets, so no answer, status or header sets
//   it apart. The signature is compared in constant time.
// - Making core work for nobody: nothing is read, armed or called before
//   the signature verifies.
// - Leaking what the answer is about: binding and task names from core's
//   own code, each with a yes or no, the version id and the client id the
//   admin deployed. No resource id, no error message, no secret and
//   nothing a client's people entered.

/** What a bucket is asked for: a key nothing writes, so the answer is "none". */
const absentKey = "platform/probe";

/** Whether `call` settled; why it didn't is logged, by its error's kind only. */
const answers = async (
  binding: string,
  call: () => Promise<unknown>
): Promise<boolean> => {
  try {
    await call();
    return true;
  } catch (error) {
    log.warn("probe.binding_failed", {
      binding,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return false;
  }
};

/** A clock's registration, or null when it didn't answer. */
const registration = async (
  name: string,
  ensure: () => Promise<ClockRegistration>
): Promise<ClockRegistration | null> => {
  try {
    const { armed, tasks } = await ensure();
    return { armed, tasks };
  } catch (error) {
    log.warn("probe.clock_failed", {
      clock: name,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return null;
  }
};

/** A database's no-op: `SELECT 1`. */
const d1 = (database: D1Database) => async () =>
  await database.prepare("SELECT 1").first();

/** A bucket's no-op: the head of a key nothing writes. */
const r2 = (bucket: R2Bucket) => async () => await bucket.head(absentKey);

/**
 * Core as the probe finds it: each private binding asked its no-op;
 * connect asked to arm its clock, which also says its binding answers;
 * core's own clock armed.
 */
const probed = async (env: Env): Promise<ProvisionProbe> => {
  const [db, brain, files, auditArchive, brainObjects, connect, core] =
    await Promise.all([
      answers("DB", d1(env.DB)),
      answers("BRAIN_DB", d1(env.BRAIN_DB)),
      answers("FILES", r2(env.FILES)),
      answers("AUDIT_ARCHIVE", r2(env.AUDIT_ARCHIVE)),
      answers("BRAIN_OBJECTS", r2(env.BRAIN_OBJECTS)),
      registration("connect", async () => await env.CONNECT.ensureClock()),
      registration("core", async () => await clock(env).ensureRegistered()),
    ]);
  return {
    version: env.CF_VERSION_METADATA?.id ?? null,
    clientId: env.CLIENT_ID ?? null,
    bindings: {
      DB: db,
      BRAIN_DB: brain,
      FILES: files,
      AUDIT_ARCHIVE: auditArchive,
      BRAIN_OBJECTS: brainObjects,
      CONNECT: connect !== null,
    },
    clocks: { core, connect },
  };
};

/**
 * The admin's signed probe: 200 with what it found, once the request is
 * signed, fresh and well formed. Undefined for anything else, which core
 * then answers as it answers any path it has no route for. The body is
 * read from a copy, so that answer gets the request as it came.
 */
export const provisionProbeResponse = async (
  request: Request,
  env: Env
): Promise<Response | undefined> => {
  if (request.method !== "POST") {
    return undefined;
  }
  const asked = await consoleSigned(request.clone(), env, {
    purpose: provisionProbePurpose,
    schema: provisionProbeRequestSchema,
    maxBytes: provisionProbeMaxBytes,
    maxSkewMs: provisionProbeMaxSkewMs,
  });
  if (typeof asked === "string") {
    log.info("probe.refused", { reason: asked });
    return undefined;
  }
  return Response.json(await probed(env), {
    headers: { "cache-control": "no-store" },
  });
};
