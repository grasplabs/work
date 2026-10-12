import { appModuleName, kitModuleName } from "@grasp-os/compiler";
import type { OperationChannel } from "@grasp-os/sdk/runner";
import { versionErrors } from "@grasp-os/shared/app-releases";
import { internalErrors, isExpectedError } from "@grasp-os/shared/errors";
import type { AppId } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import type { Provenance } from "@grasp-os/shared/knowledge";
import {
  appErrorDetailsMaxBytes,
  appErrorMessageMaxLength,
  functionRequestMaxBytes,
  operationInputMaxBytes,
  operationResultMaxBytes,
} from "@grasp-os/shared/operation-limits";
import {
  categoryOf,
  isRetryableCode,
  operationErrors,
} from "@grasp-os/shared/operations";
import type {
  AppErrorPayload,
  OperationResult,
} from "@grasp-os/shared/operations";
import type { Identity } from "@grasp-os/shared/rpc";
import { boundedRpcTarget } from "@grasp-os/shared/rpc-target";
import { rpcArgumentDepth } from "@grasp-os/shared/screens";
import { commitMaxInputBytes } from "@grasp-os/shared/stores";
import type { RpcTarget } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { operationRoles } from "./app-access.ts";
import { loadRelease } from "./app-releases.ts";
import type { Release } from "./app-releases.ts";
import { appFor } from "./apps.ts";
import { openStore } from "./data-stores.ts";
import type { OpenStore } from "./data-stores.ts";
import { sdkReleaseManifests } from "./db/core/schema.ts";
import { hostJsonModule, hostJsonSource } from "./host-json.ts";
import { callOperation } from "./operations.ts";
import type { HostedApp, Invocation, Runner } from "./operations.ts";
import { invocationSources } from "./resource-adapter.ts";
import type { InvocationSources } from "./resource-adapter.ts";
import { resourceBindingsFor } from "./resource-bindings.ts";
import { sandbox } from "./sandbox.ts";

// Running an App's server functions from its sealed release (spec 6, 8,
// 16, 32.6): the App's code runs in an isolate of its own for every
// invocation, loaded from the release's verified artifacts, and holds
// nothing but that invocation's channel to core's operation host
// (operations.ts), which decides everything the call may do. Threat
// model, and how each is closed:
//
// - App code keeps something of one caller's for another's call (a value
//   in module state, a channel): each invocation gets a fresh isolate
//   that no other shares (the loader names none), and its channel stops
//   working when it ends.
// - App code reaches outside the host: its isolate has no network
//   (`globalOutbound: null`), no env and no importable one; its only way
//   out is the channel it is handed.
// - An App reaches another App's store: nothing names a store but the
//   release, as the host sealed it, and the host's own record of that
//   binding (`loadRelease`). No request, reference or App code can.
// - A caller names a contract that isn't the one that runs: a reference
//   is only data. It runs only if it names the App, the version that runs
//   now (the App's current one, never one the caller picks, so no caller
//   reaches an older version's looser access), a public function there,
//   of its kind, and that function's exact fingerprint; otherwise it is
//   refused before any of its input is read.
// - A release changed since it was sealed, or between admission and run:
//   every load checks every hash (`loadRelease`), and the invocation runs
//   the code of the manifest it was admitted under, never source.
// - A request too large to bother with: the request comes as text, and
//   its bytes are bounded before it is parsed.
// - What crosses the isolate boundary is data both ways: a channel call
//   answers a settled value or failure (`IsolateChannel`), and the
//   function's own answer comes back as bounded JSON text, so nothing
//   depends on how RPC carries errors, and App code can't send core a
//   value larger than any answer may be.

/** The module that runs one function in its isolate. */
const runModule = "grasp-function.js";

/** The longest answer, in characters, an isolate hands back as text. */
const answerMaxLength = operationResultMaxBytes;

/**
 * The isolate's main module: the SDK's runner, over the invocation's
 * channel, each channel call's settled answer turned back into a value or
 * an error, and the function's own answer or failure sent back as data.
 * Everything in the isolate is untrusted, this module too: core checks
 * all of it again.
 */
const runMain = `import { WorkerEntrypoint } from "cloudflare:workers";
import { runFunction } from ${JSON.stringify(kitModuleName("@grasp-os/sdk/runner"))};
import { jsonAnswer } from ${JSON.stringify(hostJsonModule)};
import registered from ${JSON.stringify(appModuleName("app.ts"))};

const rebuilt = (settled) => {
  if (settled.ok) {
    return settled.value;
  }
  const error = new Error(settled.error.message);
  error.name = settled.error.name;
  if (settled.error.code !== undefined) {
    error.code = settled.error.code;
  }
  if (settled.error.details !== undefined) {
    error.details = settled.error.details;
  }
  throw error;
};

const channelOf = (remote) => ({
  read: async (request) => rebuilt(await remote.read(request)),
  write: async (request) => rebuilt(await remote.write(request)),
  call: async (kind, path, args) => rebuilt(await remote.call(kind, path, args)),
  resource: async (alias, method, args) => rebuilt(await remote.resource(alias, method, args)),
});

const bounded = (value, max) =>
  typeof value === "string" ? value.slice(0, max) : undefined;

const failed = (error) => {
  try {
    const details = error?.details === undefined ? undefined : JSON.stringify(error.details);
    return {
      ok: false,
      error: {
        name: bounded(error?.name, 100) ?? "Error",
        message: bounded(error?.message, ${appErrorMessageMaxLength + 1}) ?? "",
        ...(typeof error?.code === "string" ? { code: error.code.slice(0, 200) } : {}),
        ...(typeof details === "string" && details.length <= ${appErrorDetailsMaxBytes}
          ? { details }
          : details === undefined ? {} : { details: "null", detailsTooLarge: true }),
      },
    };
  } catch {
    return { ok: false, error: { name: "Error", message: "" } };
  }
};

export class Run extends WorkerEntrypoint {
  async run(path, args, remote) {
    let value;
    try {
      value = await runFunction(registered, path, args, channelOf(remote));
    } catch (error) {
      return failed(error);
    }
    // Read as the host reads a value, before it is serialized: JSON alone
    // would turn NaN or an undefined in an array into a valid null.
    let text;
    try {
      text = jsonAnswer(value);
    } catch {
      return { ok: true, answer: "unreadable" };
    }
    if (typeof text !== "string") {
      return { ok: true, answer: "unreadable" };
    }
    if (text.length > ${answerMaxLength}) {
      return { ok: true, answer: "too_large" };
    }
    return { ok: true, answer: "json", text };
  }
}
`;

interface RunEntrypoint extends Rpc.WorkerEntrypointBranded {
  run: (path: string, args: Json, remote: RpcTarget) => Promise<Settled>;
}

/** What the isolate answers, before core reads it: data, untrusted. */
interface Settled {
  readonly ok: boolean;
}

/** What the isolate answers, as core reads it: nothing of it trusted. */
const settledSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    answer: z.enum(["json", "too_large", "unreadable"]),
    text: z.string().max(answerMaxLength).optional(),
  }),
  z.strictObject({
    ok: z.literal(false),
    error: z.strictObject({
      name: z.string().max(100),
      message: z.string().max(appErrorMessageMaxLength + 1),
      code: z.string().max(200).optional(),
      details: z.string().max(appErrorDetailsMaxBytes).optional(),
      detailsTooLarge: z.literal(true).optional(),
    }),
  }),
]);

/** A failure as it crosses into the isolate: plain data. */
interface CrossingError {
  name: string;
  message: string;
  code?: string;
  details?: unknown;
}

/** `error`, a failure the channel raised, as data for the isolate. */
const crossing = (error: unknown): CrossingError => {
  if (!(error instanceof Error)) {
    return { name: "Error", message: "" };
  }
  const code: unknown = Reflect.get(error, "code");
  const details: unknown = Reflect.get(error, "details");
  return {
    name: error.name,
    message: error.message,
    ...(typeof code === "string" ? { code } : {}),
    ...(details === undefined ? {} : { details }),
  };
};

/** `work`'s answer or failure, as data. */
const settled = async (
  work: () => Promise<unknown>
): Promise<
  { ok: true; value: unknown } | { ok: false; error: CrossingError }
> => {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, error: crossing(error) };
  }
};

/**
 * What an App's isolate holds of its invocation's channel: the same four
 * calls, each answering a settled value or failure as data, so the
 * failures the host raised (copies it keeps its own of) reach App code
 * whole, whatever RPC does with an error. Bounded as the channel is.
 */
const IsolateChannelTarget = boundedRpcTarget({
  depth: rpcArgumentDepth,
  size: commitMaxInputBytes,
});

/**
 * The channel as the isolate's calls reach it: its own checks take each
 * argument as unknown, whatever its declared types say.
 */
interface ArrivingChannel {
  readonly read: (request: unknown) => Promise<unknown>;
  readonly write: (request: unknown) => Promise<unknown>;
  readonly call: (
    kind: unknown,
    path: unknown,
    args: unknown
  ) => Promise<unknown>;
  readonly resource: (
    alias: unknown,
    method: unknown,
    args: unknown
  ) => Promise<unknown>;
}

class IsolateChannel extends IsolateChannelTarget {
  readonly #channel: ArrivingChannel;

  constructor(channel: OperationChannel) {
    super();
    // SAFETY: the channel copies and checks every argument as it arrives
    // (operation-channel.ts), whatever its declared types say.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    this.#channel = channel as ArrivingChannel;
  }

  async read(request: unknown): Promise<unknown> {
    return await settled(async () => await this.#channel.read(request));
  }

  async write(request: unknown): Promise<unknown> {
    return await settled(async () => await this.#channel.write(request));
  }

  async call(kind: unknown, path: unknown, args: unknown): Promise<unknown> {
    return await settled(
      async () => await this.#channel.call(kind, path, args)
    );
  }

  async resource(
    alias: unknown,
    method: unknown,
    args: unknown
  ): Promise<unknown> {
    return await settled(
      async () => await this.#channel.resource(alias, method, args)
    );
  }
}

/** JSON text the isolate sent, parsed, or undefined. */
const parsed = (text: string | undefined): unknown => {
  if (text === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/**
 * The runner of `release`: each call in a fresh isolate of its own (the
 * loader names none, so none is shared or kept), loaded with the release's
 * verified modules and the SDK modules sealed with it (never the SDK the
 * host serves now), with no network and an empty env.
 */
const runnerOf =
  (env: Env, release: Release): Runner =>
  async (path, args, channel) => {
    const isolate = env.LOADER.get(null, () => ({
      ...sandbox,
      mainModule: runModule,
      // The platform's modules last: no App module takes one's name.
      modules: {
        ...release.modules,
        ...release.sdk,
        // The host's reading of what App code answers (host-json.ts).
        [hostJsonModule]: hostJsonSource(),
        [runModule]: runMain,
      },
      env: {},
    })).getEntrypoint<RunEntrypoint>("Run");
    const answer = settledSchema.safeParse(
      await isolate.run(path, args, new IsolateChannel(channel))
    );
    if (!answer.success) {
      throw Object.assign(new Error("The isolate answered something else"), {
        unexpected: true,
      });
    }
    const { data } = answer;
    if (!data.ok) {
      const { name, message, code, details, detailsTooLarge } = data.error;
      // Details past their bound make the error one its contract doesn't
      // allow, as the host decides of any (operations.ts).
      throw Object.assign(new Error(message), {
        name,
        ...(code === undefined ? {} : { code }),
        ...(details === undefined
          ? {}
          : {
              details:
                detailsTooLarge === true
                  ? "x".repeat(appErrorDetailsMaxBytes + 1)
                  : parsed(details),
            }),
      });
    }
    if (data.answer === "too_large") {
      // Past every bound: the host refuses it as any return too large.
      return "x".repeat(operationResultMaxBytes + 1);
    }
    return data.answer === "json" ? parsed(data.text) : undefined;
  };

/** `release` as the operation host runs it. */
export const hostedRelease = (env: Env, release: Release): HostedApp => ({
  manifest: release.app,
  run: runnerOf(env, release),
});

/** Every call of a store a release without tables doesn't have. */
const unbound = async (): Promise<never> =>
  await Promise.reject(versionErrors.create("version.store_unbound"));

/** A store for a release without tables: there is nothing to reach. */
const noStore = (): OpenStore => ({
  // SAFETY: an ID no store has, for logs only: every call is refused.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  id: "none" as OpenStore["id"],
  defineTables: unbound,
  get: unbound,
  claim: unbound,
  commit: unbound,
  read: unbound,
  generations: unbound,
});

/** Refuses with `version.revoked` once release `version` of `app` is revoked. */
const requireNotRevoked = async (
  env: Env,
  app: AppId,
  version: number
): Promise<void> => {
  const row = await drizzle(env.DB)
    .select({ revokedAt: sdkReleaseManifests.revokedAt })
    .from(sdkReleaseManifests)
    .where(
      and(
        eq(sdkReleaseManifests.appId, app),
        eq(sdkReleaseManifests.version, version)
      )
    )
    .get();
  if (row === undefined) {
    throw versionErrors.create("version.not_sealed");
  }
  if (row.revokedAt !== null) {
    throw versionErrors.create("version.revoked");
  }
};

/** What core resolved of the caller, for an invocation. */
interface FunctionCaller {
  readonly by: Pick<Identity, "userId" | "role">;
  readonly requestId: string;
  readonly deadline: number;
  /**
   * What else must still hold before every protected step, for a caller
   * whose call core admitted on more than the person's role (an agent's
   * permission, agent-apps.ts): throws once it doesn't.
   */
  readonly stillAllowed?: () => Promise<void>;
  /** What the invocation reads through its resources is noted here. */
  readonly sources?: InvocationSources;
}

/**
 * The invocation of `release` for `caller`: the store from the release
 * alone, the principal and roles from core's identity of the caller,
 * never from a request.
 */
export const invocationFor = async (
  env: Env,
  release: Release,
  {
    by,
    requestId,
    deadline,
    stillAllowed,
    sources = invocationSources(),
  }: FunctionCaller
): Promise<Invocation> => {
  // SAFETY: a release's resource ID is the App it was sealed for.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const app = release.manifest.resourceId as AppId;
  const bindings = resourceBindingsFor(env, {
    app,
    authority: {
      subject: { type: "app", appId: app },
      onBehalfOf: by.userId,
      mode: "interactive",
      appVersion: release.manifest.resourceVersion,
    },
    context: { type: "app", appId: app },
    sources,
  });
  return {
    principal: by.userId,
    consumer: {
      resourceId: app,
      resourceVersion: release.manifest.resourceVersion,
    },
    store:
      release.store === null
        ? noStore()
        : await openStore(env, release.store.storeId),
    requestId,
    deadline,
    runId: null,
    // Before every protected step: the call starts, each mutation commits
    // and each resource request (the operation host's one gate, `admit`).
    // A release revoked, a role lost or an agent's permission withdrawn
    // meanwhile stops a call already running.
    authorize: async () => {
      await requireNotRevoked(env, app, release.manifest.resourceVersion);
      await stillAllowed?.();
      return await operationRoles(env, by, app);
    },
    // The App's approved bindings, read again on every request, acting
    // for the App and the person calling, with the person there. The
    // operation host admits each request through `authorize` first, as it
    // admits each commit, so nothing else is checked here.
    resources: bindings,
  };
};

const encoder = new TextEncoder();

/** Whether `text` is more than `max` bytes as UTF-8, read no further than needed. */
const isOverBytes = (text: string, max: number): boolean =>
  text.length > max ||
  (text.length * 3 > max && encoder.encode(text).byteLength > max);

/** A call's request, as a screen or agent sends it (spec 32.6). */
const functionRequestSchema = z.strictObject({
  reference: z.strictObject({
    resourceId: z.string().min(1).max(128),
    resourceVersion: z.int().min(1),
    contractId: z.string().min(1).max(256),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
    kind: z.enum(["query", "mutation", "action"]),
  }),
  input: z.unknown(),
  idempotencyKey: z.string().optional(),
});

/** What a call answers (spec 32.6). */
export interface FunctionAnswer {
  readonly result: OperationResult;
  /**
   * Where what the call read through its resources comes from, with its
   * classification (spec 32.3): the Knowledge collections, and whether
   * any was sensitive or restricted. Null when no function ran.
   */
  readonly provenance: Provenance | null;
  /** The fingerprint of the contract that ran, when one did. */
  readonly fingerprint: string | null;
  /** The release that ran, when one did. */
  readonly manifestHash: string | null;
}

/** `error` as the caller may see it, before any function ran. */
const refusalOf = (error: unknown, requestId: string): AppErrorPayload => {
  const expected = isExpectedError(error)
    ? error
    : internalErrors.create("internal.unexpected", { requestId });
  return {
    code: expected.code,
    message: expected.message,
    category: categoryOf(expected.code),
    retryable: isRetryableCode(expected.code),
    requestId,
  };
};

/**
 * Calls a public function of App `app` for `by` (spec 32.6): `request`
 * is the call as its caller sent it, as text, bounded before it is read.
 * It runs only against the release of the App's current version, and
 * only if its reference names exactly a public function there (see the
 * header); then through the operation host, which decides the rest.
 * Never throws.
 */
export const callAppFunction = async (
  env: Env,
  by: Pick<Identity, "userId" | "role" | "teams">,
  app: unknown,
  request: unknown,
  deadline = Date.now() + 60_000,
  stillAllowed?: () => Promise<void>
): Promise<FunctionAnswer> => {
  const requestId = crypto.randomUUID();
  const refused = (error: unknown): FunctionAnswer => ({
    result: { ok: false, error: refusalOf(error, requestId) },
    provenance: null,
    fingerprint: null,
    manifestHash: null,
  });
  if (typeof request !== "string") {
    return refused(operationErrors.create("contract.invalid_request"));
  }
  if (isOverBytes(request, functionRequestMaxBytes)) {
    return refused(
      operationErrors.create("contract.input_too_large", {
        maxBytes: operationInputMaxBytes,
      })
    );
  }
  let call: z.infer<typeof functionRequestSchema>;
  try {
    call = functionRequestSchema.parse(JSON.parse(request));
  } catch {
    return refused(operationErrors.create("contract.invalid_request"));
  }
  let release: Release;
  let path: string;
  try {
    // Anyone without a role in the App learns nothing of it.
    const found = await appFor(env, by, app, "user");
    if (found.currentVersion === null) {
      throw versionErrors.create("version.not_sealed");
    }
    release = await loadRelease(env, found.id, found.currentVersion);
    const { reference } = call;
    const operation = Object.hasOwn(
      release.app.operations,
      reference.contractId
    )
      ? release.app.operations[reference.contractId]
      : undefined;
    // An internal function is refused as one that doesn't exist.
    if (operation === undefined || operation.visibility !== "public") {
      throw operationErrors.create("operation.not_found");
    }
    if (operation.kind !== reference.kind) {
      throw operationErrors.create("operation.kind_mismatch");
    }
    if (
      reference.resourceId !== found.id ||
      reference.resourceVersion !== found.currentVersion ||
      release.fingerprints[operation.path] !== reference.fingerprint
    ) {
      throw versionErrors.create("version.mismatch");
    }
    ({ path } = operation);
  } catch (error) {
    return refused(error);
  }
  try {
    const sources = invocationSources();
    const invocation = await invocationFor(env, release, {
      by,
      requestId,
      deadline,
      ...(stillAllowed === undefined ? {} : { stillAllowed }),
      sources,
    });
    const result = await callOperation(
      hostedRelease(env, release),
      invocation,
      { path, kind: call.reference.kind },
      call.input,
      call.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: call.idempotencyKey }
    );
    return {
      result,
      provenance: sources.snapshot(),
      fingerprint: call.reference.fingerprint,
      manifestHash: release.manifestHash,
    };
  } catch (error) {
    return refused(error);
  }
};
