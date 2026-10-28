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
import { inJurisdiction } from "./durable-objects.ts";
import { callSandboxed } from "./sandboxed.ts";

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

/**
 * Connect's private bindings, each as connect answered its no-op; none
 * when connect didn't answer, which leaves each unanswered.
 */
const connectProbe = async (env: Env): Promise<Record<string, boolean>> => {
  try {
    return await env.CONNECT.probeBindings();
  } catch (error) {
    log.warn("probe.binding_failed", {
      binding: "CONNECT",
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return {};
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

/**
 * The sandbox's no-op: a fresh isolate of a module that answers one
 * constant, on whichever sandbox this deployment runs App code in (the
 * Loader on Cloudflare, the sandbox host elsewhere: sandboxed.ts). It
 * reaches nothing: no env, no network.
 */
const sandboxProbe = {
  mainModule: "probe.js",
  modules: {
    "probe.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export class Probe extends WorkerEntrypoint {
  answer() {
    return "probe";
  }
}
`,
  },
};

const sandbox = (env: Env) => async () => {
  const answer = await callSandboxed(env, sandboxProbe, "Probe", "answer");
  if (answer !== "probe") {
    throw new Error("The sandbox answered something else");
  }
};

/**
 * Core's Durable Object namespaces, each as core reaches it: in the
 * jurisdiction its objects are made in (durable-objects.ts). Asked for an
 * ID only, so the probe makes no object and writes nothing.
 */
const objectNamespaces = (env: Env) =>
  ({
    WORKSPACES: env.WORKSPACES,
    APPS: env.APPS,
    AUDIT_LOG: env.AUDIT_LOG,
    BUILTINS: env.BUILTINS,
    CLOCK: env.CLOCK,
    ONBOARDING: env.ONBOARDING,
    MODEL_LEDGER: env.MODEL_LEDGER,
    DATA_STORES: env.DATA_STORES,
    WORKFLOW_RUNS: env.WORKFLOW_RUNS,
    ACTION_INVOCATIONS: env.ACTION_INVOCATIONS,
    CHAT_STATE: env.CHAT_STATE,
  }) satisfies Record<
    string,
    DurableObjectNamespace<Rpc.DurableObjectBranded | undefined>
  >;

/** A namespace's no-op: an object's ID in core's jurisdiction, made but never used. */
const objects =
  (
    env: Env,
    namespace: DurableObjectNamespace<Rpc.DurableObjectBranded | undefined>
  ) =>
  async (): Promise<void> => {
    // A namespace the deploy didn't bind, or can't restrict to the EU,
    // throws here.
    inJurisdiction(env, namespace).idFromName("platform/probe");
    await Promise.resolve();
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
  const namespaces = Object.entries(objectNamespaces(env));
  const [
    db,
    knowledge,
    files,
    auditArchive,
    brainObjects,
    loader,
    connectBindings,
    connect,
    core,
    ...namespaced
  ] = await Promise.all([
    answers("DB", d1(env.DB)),
    answers("KNOWLEDGE", d1(env.KNOWLEDGE)),
    answers("FILES", r2(env.FILES)),
    answers("AUDIT_ARCHIVE", r2(env.AUDIT_ARCHIVE)),
    answers("BRAIN_OBJECTS", r2(env.BRAIN_OBJECTS)),
    answers("LOADER", sandbox(env)),
    connectProbe(env),
    registration("connect", async () => await env.CONNECT.ensureClock()),
    registration("core", async () => await clock(env).ensureRegistered()),
    ...namespaces.map(
      async ([name, namespace]) => await answers(name, objects(env, namespace))
    ),
  ]);
  return {
    version: env.CF_VERSION_METADATA?.id ?? null,
    clientId: env.CLIENT_ID ?? null,
    bindings: {
      DB: db,
      KNOWLEDGE: knowledge,
      FILES: files,
      AUDIT_ARCHIVE: auditArchive,
      BRAIN_OBJECTS: brainObjects,
      LOADER: loader,
      CONNECT: connect !== null,
      ...Object.fromEntries(
        namespaces.map(([name], index) => [name, namespaced[index] === true])
      ),
      // Connect's own, as connect answered for them; its clock, as it
      // armed it.
      ...Object.fromEntries(
        Object.entries(connectBindings).map(([name, answered]) => [
          `connect.${name}`,
          answered,
        ])
      ),
      "connect.CLOCK": connect !== null,
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
