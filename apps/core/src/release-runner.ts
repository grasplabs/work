import { appModuleName, kitModuleName } from "@grasp-os/compiler";
import type { OperationChannel } from "@grasp-os/sdk/runner";
import { fileErrors } from "@grasp-os/shared/app-files";
import { versionErrors } from "@grasp-os/shared/app-releases";
import { whenAborted } from "@grasp-os/shared/deadline";
import type { AppId } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import {
  appErrorDetailsMaxBytes,
  appErrorMessageMaxLength,
  operationResultMaxBytes,
} from "@grasp-os/shared/operation-limits";
import { boundedRpcTarget } from "@grasp-os/shared/rpc-target";
import { rpcArgumentDepth } from "@grasp-os/shared/screens";
import { commitMaxInputBytes } from "@grasp-os/shared/stores";
import type { RpcTarget } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import type { Release } from "./app-releases.ts";
import { callTimeoutMs } from "./app.ts";
import type { CallTree, RunnerCall } from "./call-tree.ts";
import type { OpenStore } from "./data-stores.ts";
import { sdkReleaseManifests } from "./db/core/schema.ts";
import { hostJsonModule, hostJsonSource } from "./host-json.ts";
import type { HostedApp, Runner } from "./operations.ts";
import {
  capability,
  runInSession,
  sessionEndedError,
} from "./sandbox-session.ts";
import type { ConsoleLine, NestedRun, SessionCall } from "./sandbox-session.ts";
import { sandbox } from "./sandbox.ts";
import { sessionHost } from "./sandboxed.ts";

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
  emit: async (progress) => rebuilt(await remote.emit(progress)),
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
 * What an App's isolate holds of its invocation's channel: the same
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
  readonly emit: (progress: unknown) => Promise<unknown>;
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

  async emit(progress: unknown): Promise<unknown> {
    return await settled(async () => await this.#channel.emit(progress));
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
 * The session each caller's call runs its functions in on-prem, by that
 * call (operations.ts `CallTree`), while it's open: how to run one more
 * function in it.
 */
const openSessions = new WeakMap<CallTree, { run: NestedRun }>();

/**
 * Runs `sessionCall` in a sandbox session. A function nested in another
 * runs in the session of the function its caller named (in its process,
 * idle while it waits, taking none of the owner's share, as it would each
 * nested call deep enough to wait on a place its own callers hold), and
 * never in a session of its own: once that session is over, it's refused.
 * The function a caller named opens the session, open until every nested
 * call the operation host started has settled, authorized or not yet.
 */
const inSession = async (
  host: Fetcher,
  sessionCall: SessionCall,
  { signal, call }: { signal?: AbortSignal; call?: RunnerCall }
): Promise<unknown> => {
  if (call?.nested === true) {
    const open = openSessions.get(call.tree);
    // Its call's session is over (it can't be, as the session waits for
    // every nested call started): a fresh process would escape the whole
    // call's CPU time and memory.
    if (open === undefined) {
      throw sessionEndedError();
    }
    return await open.run(sessionCall, signal);
  }
  if (call === undefined) {
    return await runInSession(
      host,
      sessionCall,
      signal === undefined ? {} : { signal }
    );
  }
  const { tree } = call;
  const entry: { run: NestedRun } = {
    run: async () => await Promise.reject(sessionEndedError()),
  };
  const { promise: answered, resolve: answer } =
    Promise.withResolvers<unknown>();
  const session = (async (): Promise<unknown> => {
    try {
      return await runInSession(
        host,
        tree.parentSession === undefined
          ? sessionCall
          : { ...sessionCall, parent: tree.parentSession },
        {
          ...(signal === undefined ? {} : { signal }),
          // Its call ID, for a call made on its functions' behalf.
          opened: (callId: string) => {
            tree.sessionOpened(callId);
          },
          nesting: {
            open: (run: NestedRun) => {
              entry.run = run;
              openSessions.set(tree, entry);
            },
            answered: answer,
            // Every nested call the operation host started, those they
            // start too: from the moment it starts each (`CallTree`).
            drain: async () => {
              await tree.settled();
            },
            idle: () => tree.idle(),
          },
        }
      );
    } finally {
      // Ended however it did: no function runs in it any more. A run of
      // the named function again (stale reads) opened a session of its own.
      if (openSessions.get(tree) === entry) {
        openSessions.delete(tree);
      }
    }
  })();
  tree.holdSession(session);
  // Answered as the function answers. The session stays open behind it for
  // the calls the function started and didn't wait for, which the operation
  // host waits for in turn, or gives up on at its deadline (`signal`).
  return await Promise.race([answered, session]);
};

/**
 * Hands `lines`, what a call in a sandbox session wrote (sandbox-session.ts,
 * `ConsoleLine`), to `tail` as the runtime hands a Loader tail one call's
 * trace: one event, its logs with their time, level and message.
 */
const tailLines = async (
  tail: Fetcher,
  lines: readonly ConsoleLine[]
): Promise<void> => {
  if (lines.length === 0) {
    return;
  }
  const events = [
    {
      event: null,
      logs: lines.map(({ at, level, message }) => ({
        timestamp: at,
        level,
        message: [message],
      })),
    },
  ];
  const deliver: unknown = Reflect.get(tail, "tail");
  if (typeof deliver === "function") {
    await Reflect.apply(deliver, tail, [events]);
  }
};

/**
 * The runner of `release`: each call in a fresh isolate of its own (the
 * loader names none, so none is shared or kept), loaded with the release's
 * verified modules and the SDK modules sealed with it (never the SDK the
 * host serves now), with no network and an empty env. On-prem it runs in a
 * sandbox session (sandbox-session.ts), its process killed past the CPU
 * time Cloudflare's runtime would give it.
 */
export const releaseRunner =
  (
    env: Pick<
      Env,
      | "LOADER"
      | "RUNTIME_PROFILE"
      | "SANDBOX_HOST"
      | "SANDBOX_IN_PROCESS"
      | "APP_CALL_TIMEOUT_MS"
    >,
    release: Pick<Release, "modules" | "sdk">,
    /** Whose release it is: the App, which the sandbox caps per owner. */
    owner: string,
    /**
     * The tail of the isolate that runs `path`, given: what the function
     * writes with `console` goes there (server-logs.ts). None by default:
     * a live release's calls keep no App-written text.
     */
    tailOf?: (path: string) => Fetcher
  ): Runner =>
  async (path, args, channel, signal, call) => {
    // The platform's modules last: no App module takes one's name.
    const modules = {
      ...release.modules,
      ...release.sdk,
      // The host's reading of what App code answers (host-json.ts).
      [hostJsonModule]: hostJsonSource(),
      [runModule]: runMain,
    };
    const isolateChannel = new IsolateChannel(channel);
    // On-prem, in a sandbox session, where a busy loop costs only its own
    // process (sandbox-session.ts); on Cloudflare, whose runtime ends it
    // at the CPU limit, in a Loader isolate of core's own.
    const host = sessionHost(env);
    const answer = settledSchema.safeParse(
      host === undefined
        ? await Promise.race([
            env.LOADER.get(null, () => ({
              ...sandbox,
              mainModule: runModule,
              modules,
              env: {},
              ...(tailOf === undefined ? {} : { tails: [tailOf(path)] }),
            }))
              .getEntrypoint<RunEntrypoint>("Run")
              .run(path, args, isolateChannel),
            // Given up on: settled at once, its isolate left to the
            // runtime, as nothing of core's is held for it.
            ...(signal === undefined ? [] : [whenAborted(signal)]),
          ])
        : await inSession(
            host,
            {
              mainModule: runModule,
              modules,
              entrypoint: "Run",
              method: "run",
              args: [
                { value: path },
                { value: args },
                { capability: capability(isolateChannel) },
              ],
              owner,
              // What a draft's function writes goes to its tail, as the
              // Loader hands it over on Cloudflare (server-logs.ts).
              ...(tailOf === undefined
                ? {}
                : {
                    console: async (lines: ConsoleLine[]) => {
                      await tailLines(tailOf(path), lines);
                    },
                  }),
              cpuMs: sandbox.limits.cpuMs,
              // The host's own deadline ends the invocation before this
              // (operations.ts), and frees the process (`signal`); this only
              // bounds the session.
              wallMs: callTimeoutMs(env),
            },
            { signal, call }
          )
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

/** `release` as the operation host runs it, each isolate tailed by `tailOf`, if given. */
export const hostedRelease = (
  env: Env,
  release: Release,
  tailOf?: (path: string) => Fetcher
): HostedApp => ({
  manifest: release.app,
  run: releaseRunner(env, release, release.manifest.resourceId, tailOf),
});

/** Every call of a store a release without tables doesn't have. */
const unbound = async (): Promise<never> =>
  await Promise.reject(versionErrors.create("version.store_unbound"));

/** A store for a release without tables: there is nothing to reach. */
export const noStore = (): OpenStore => ({
  // SAFETY: an ID no store has, for logs only: every call is refused.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  id: "none" as OpenStore["id"],
  defineTables: unbound,
  get: unbound,
  claim: unbound,
  receiptStanding: unbound,
  commit: unbound,
  read: unbound,
  generations: unbound,
  filesUsable: async () => {
    await Promise.reject(fileErrors.create("file.unavailable"));
  },
});

/** Refuses with `version.revoked` once release `version` of `app` is revoked. */
export const requireNotRevoked = async (
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
