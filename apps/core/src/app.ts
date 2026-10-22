import { fileLimits } from "@grasp-os/shared/app-file-limits";
import {
  appErrorDetailsBytes,
  appErrors,
  appMethodPattern,
  reservedAppMethods,
} from "@grasp-os/shared/apps";
import type { AppCaller } from "@grasp-os/shared/apps";
import type { AuditEntry } from "@grasp-os/shared/audit";
import { deadline, whenAborted } from "@grasp-os/shared/deadline";
import type { Deadline } from "@grasp-os/shared/deadline";
import {
  isExpectedError,
  messageOf,
  toOpaqueError,
} from "@grasp-os/shared/errors";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId, PermissionId } from "@grasp-os/shared/ids";
import { log } from "@grasp-os/shared/log";
import {
  actionMaxRunning,
  streamMaxRunning,
} from "@grasp-os/shared/operation-limits";
import { operationErrors } from "@grasp-os/shared/operations";
import type { Authority } from "@grasp-os/shared/permissions";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import { openAnswer, quietLoader } from "@grasp-os/shared/quiet-loader";
import {
  querySubscriptionLimits,
  screenErrors,
  screenLimits,
} from "@grasp-os/shared/screens";
import type {
  AppErrorLog,
  RunChange,
  ServerLog,
} from "@grasp-os/shared/screens";
import {
  statisticErrors,
  statisticLimitsOf,
} from "@grasp-os/shared/statistics";
import type { StatisticUse } from "@grasp-os/shared/statistics";
import { TokenBuckets } from "@grasp-os/shared/token-bucket";
import { passedBound, plainDataBounds } from "@grasp-os/shared/value-bounds";
import type { ValueBounds } from "@grasp-os/shared/value-bounds";
import { executionErrors } from "@grasp-os/shared/workflows";
import { DurableObject, exports } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";

import type { Person } from "./app-access.ts";
import { appBindings } from "./app-bindings.ts";
import { CallQueue } from "./app-call-queue.ts";
import { ErrorLog } from "./app-error-log.ts";
import type { ReportedProblem } from "./app-error-log.ts";
import { waitsOn } from "./app-waits-for.ts";
import type { Held, Hold } from "./app-waits-for.ts";
import { findApp, versionFiles } from "./apps.ts";
import { auditedBatch, outboxed } from "./audit-outbox.ts";
import { appHost } from "./durable-objects.ts";
import { sandbox } from "./sandbox.ts";
import { requireBoundedHere } from "./sandboxed.ts";
import { buildFailed, buildServer } from "./screens.ts";
import { requireAttemptHolds } from "./workflows/attempt-fence.ts";
import type { AttemptFence } from "./workflows/attempt-fence.ts";

// An App's server code runs as a facet of the App's own Durable Object:
// loaded through the Worker Loader from the App's current version, with a
// SQLite database of its own that stays when the code changes. The App is
// code nobody reviewed line by line (the agent writes it), so its isolate
// has no network (`globalOutbound: null`), can't import core's env
// (`disallow_importable_env`), and its env holds only stubs for the App's
// active permissions (app-bindings.ts), never one of core's own bindings.
//
// One App serves everyone who uses it, one call at a time. So its stubs act
// for no one on their own: every call into the App gets a caller from core
// (from the session, the workflow run, or another App's call of one of its
// exports, app-calls.ts), with a token only this object
// knows, for as long as the call runs. The App passes the caller on to its
// stubs, which ask this object who the token belongs to. App code has no
// way to name a person itself, and a token it keeps stops working once its
// call ends.
//
// Its code runs in one isolate for every call, so it can keep any token it
// is handed and use it from whatever else it runs. Calls into the App
// therefore wait their turn (`CallQueue`): a call gets its token only once
// it holds the App, and loses it when it ends; the App's code keeps the
// turn until it settles. So the one token that works while a call runs is
// that call's own, but for work the App's code left running detached from
// an earlier call (see `App.call`). Until App methods run as stateless
// handlers, each call in an isolate of its own, an App serves about one
// call per how long its methods take.

/** The facet the App's server code runs in. */
const facetName = "server";

/**
 * How long one call may take in all, starting the code and waiting
 * included, before the host gives up on it: its caller gets
 * `app.timed_out`, and its token stops working, so a call that never ends
 * can't keep acting for its caller. A server invocation's wall time
 * (spec 18.1); tests shorten it with `APP_CALL_TIMEOUT_MS`, which can
 * only lower it, and it is never set in wrangler.jsonc.
 */
const defaultCallTimeoutMs = platformLimits.serverInvocationWallMs;

export const callTimeoutMs = (
  env: Pick<Env, "APP_CALL_TIMEOUT_MS">
): number => {
  const set = Number(env.APP_CALL_TIMEOUT_MS);
  return Number.isInteger(set) && set > 0 && set < defaultCallTimeoutMs
    ? set
    : defaultCallTimeoutMs;
};

/**
 * A method App code exports: an identifier, and not one the Durable Object
 * runtime, RPC or `Object` gives a meaning of its own (shared with the
 * workflow SDK's typed stub of the App). A name on the facet stub's
 * prototype chain is refused too (see `call`).
 */
const reservedMethods: ReadonlySet<string> = new Set(reservedAppMethods);

/**
 * How many calls may wait for the App while one runs (`CallQueue`): past
 * it, a call is refused at once with `app.busy` rather than queue for a
 * turn its deadline would likely not reach.
 */
export const waitingCallsLimit = 32;

/**
 * How many Apps, at most, one call about to wait asks who waits for them
 * (`waitsOn`): past it, the call waits as it would have, until its
 * deadline. A cycle is always found when at most this many Apps wait for
 * the call's chain, directly or through others.
 */
const waitsForAsked = 32;

/**
 * How long one App asked who waits for it (`waitingHolds`) has to answer:
 * past it, that App is passed over, and the call waits as it would have.
 */
export const waitsForAskMs = 1000;

/** Where the host counts starts on new code or permissions (`#load`, `restart`). */
const generationKey = "generation";

/** How often, at most, the count of dropped reports is written to the log. */
const suppressedWriteMs = 60_000;

/** How often, at most, refused requests of an App's screens are logged. */
const refusalLogMs = 60_000;

/**
 * How often, at most, the same refusal of the App's data to a screen (who,
 * which build, why, what and where) is audited (`auditOnce`).
 */
const refusalAuditMs = 10 * 60_000;

/** How many refusals `auditOnce` remembers at most. */
const refusalsKept = 1000;

/** The one bucket all of an App's reports share, and its server lines. */
const appBucket = "app";

/**
 * The lines kept a minute of what an App's server code writes with
 * `console`, as many as of its screens' reports (`screenLimits.appReports`)
 * but counted apart from them (`logServer`).
 */
const serverLinesLimit = { burst: 200, perMinute: 200 } as const;

/** Where the host keeps the version its code last started on. */
const versionKey = "version";

/**
 * The names of the runtime's own errors, safe to log. Any other name was
 * made up by App code, and may hold anything.
 */
const runtimeErrorNames = new Set([
  "AbortError",
  "DataCloneError",
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TimeoutError",
  "TypeError",
  "URIError",
]);

/** An error's name for the log: the runtime's, or `custom` for App-made ones. */
const errorNameOf = (error: unknown): string => {
  if (!(error instanceof Error)) {
    return typeof error;
  }
  return runtimeErrorNames.has(error.name) ? error.name : "custom";
};

/** Where the App keeps its restricted mode (see restricted.ts). */
const restrictedKey = "restricted";

/**
 * What an App method answers: plain data, as structured clone carries it.
 * Never a stub, a function or an RpcTarget: an answer goes on to screens
 * and workflows, and must not hand them a way into the App.
 */
export type AppAnswer = Rpc.Serializable<unknown>;

/**
 * Whether a value is plain data, as structured clone carries it, within
 * `bounds`. They are checked first, without recursion, so the clone never
 * walks a value deeper or bigger than they are.
 */
export const isPlainData = (
  value: unknown,
  bounds: ValueBounds = plainDataBounds
): boolean => {
  if (passedBound([value], bounds) !== undefined) {
    return false;
  }
  try {
    structuredClone(value);
    return true;
  } catch {
    return false;
  }
};

/** Whether `value` is a boxed big integer (`Object(7n)`), whatever its prototype. */
const isBoxedBigInt = (value: object): boolean => {
  try {
    // Reads the internal slot only a boxed big integer has.
    BigInt.prototype.valueOf.call(value);
    return true;
  } catch {
    return false;
  }
};

/**
 * A getter of every typed array's, which reads its internal slots: what
 * kind it is, and how long. Its own properties can't stand in for them.
 */
const typedArrayGetter = (name: PropertyKey): ((value: object) => unknown) => {
  const typedArray = Reflect.getPrototypeOf(Int8Array.prototype);
  const getter =
    typedArray === null
      ? undefined
      : Reflect.getOwnPropertyDescriptor(typedArray, name)?.get;
  if (getter === undefined) {
    throw new Error(`Typed arrays have no getter ${String(name)}`);
  }
  return (value) => {
    const read: unknown = Reflect.apply(getter, value, []);
    return read;
  };
};

const typedArrayKind = typedArrayGetter(Symbol.toStringTag);
const typedArrayLength = typedArrayGetter("length");

/** Whether `value` is a typed array of big integers with any in it. */
const isBigIntArray = (value: object): boolean => {
  // The kind is `undefined` for anything but a typed array, so the length
  // is only read of one.
  const kind = typedArrayKind(value);
  return (
    (kind === "BigInt64Array" || kind === "BigUint64Array") &&
    typedArrayLength(value) !== 0
  );
};

/** Whether `value` is a typed array or a view of a buffer: numbers only. */
const isNumbers = (value: object): boolean => ArrayBuffer.isView(value);

/**
 * A map's keys and values, or a set's members, read through the internal
 * slot so a changed prototype can't hide them; `undefined` for neither.
 */
const collected = (value: object): unknown[] | undefined => {
  const held: unknown[] = [];
  try {
    Map.prototype.forEach.call(value, (inner: unknown, key: unknown) => {
      held.push(key, inner);
    });
    return held;
  } catch {
    // Not a map.
  }
  try {
    Set.prototype.forEach.call(value, (inner: unknown) => {
      held.push(inner);
    });
    return held;
  } catch {
    return undefined;
  }
};

/** What `heldBy` gives for a getter: what it yields isn't known unrun. */
const unknownYield = Symbol("unknown yield");

/**
 * The values an object holds: a map's keys and values, a set's members,
 * or every own property's, named by a string or a symbol, enumerable or
 * not, as `unknownYield` for a getter.
 */
const heldBy = (value: object): unknown[] => {
  const members = collected(value);
  if (members !== undefined) {
    return members;
  }
  const held: unknown[] = [];
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (property !== undefined) {
      held.push("value" in property ? property.value : unknownYield);
    }
  }
  return held;
};

/**
 * Whether `value` holds a big integer anywhere within it: a big integer, a
 * boxed one or a typed array of them, at any depth, in a map, a set or an
 * error's cause. No value of an App's calls or answers may: they reach
 * screens and workflows, whose values are JSON's.
 *
 * What's walked is what structured clone carries of `value`, as RPC does:
 * a getter read once into plain data, no proxy, and none of the keys it
 * drops. Only a value it can't carry (an argument holding a stub) is
 * walked as it is, where a getter counts as holding one. The walk runs no
 * code of the value's and has no recursion, so a value nested deep can't
 * exhaust the stack; it looks at each object once, and a function (a
 * stub) holds nothing.
 */
export const holdsBigInt = (value: unknown): boolean => {
  let carried: unknown = value;
  try {
    carried = structuredClone(value);
  } catch {
    // Walked as it is (see above).
  }
  const pending: unknown[] = [carried];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const next = pending.pop();
    if (typeof next === "bigint" || next === unknownYield) {
      return true;
    }
    if (typeof next !== "object" || next === null || seen.has(next)) {
      continue;
    }
    seen.add(next);
    if (isBoxedBigInt(next) || isBigIntArray(next)) {
      return true;
    }
    if (isNumbers(next)) {
      continue;
    }
    // One at a time, not spread: a long array would pass too many
    // arguments at once.
    for (const inner of heldBy(next)) {
      pending.push(inner);
    }
  }
  return false;
};

/** `answer`, if it is plain data; `app.answer_invalid` if not. */
const plainAnswer = (
  answer: AppAnswer,
  version: number | null,
  method: string
): AppAnswer => {
  if (!isPlainData(answer) || holdsBigInt(answer)) {
    throw appErrors.create("app.answer_invalid", { version, method });
  }
  return answer;
};

/**
 * A method of the facet's stub. Every name on an RPC stub is a function
 * that calls the method of that name, so this only rules out the few that
 * aren't (`then`, symbols).
 */
const isMethod = (
  value: unknown
): value is (...args: unknown[]) => Promise<AppAnswer> =>
  typeof value === "function";

/**
 * Refuses a method name core never calls on App code: not an identifier,
 * or one the runtime gives a meaning of its own (`reservedMethods`).
 */
export const requireAppMethod = (method: string): void => {
  if (!appMethodPattern.test(method) || reservedMethods.has(method)) {
    throw appErrors.create("app.method_invalid", { method });
  }
};

/** Which App's code a call ran: its version (null for a draft's), and method. */
interface RanAt {
  app: AppId;
  version: number | null;
  method: string;
}

/** Splits text into characters as a person reads them, so a cut keeps each whole. */
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** How many bytes `value` takes as UTF-8 JSON. */
const jsonBytesOf = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

/**
 * What `app.failed` carries: the version, the method and the App's own
 * message, cut to fit `appErrorDetailsBytes` as UTF-8 JSON, at a whole
 * character. Each UTF-16 code unit takes at least a byte, so no more than
 * that many of the message's first code units can fit: only those are
 * measured, and a huge message costs no more than a short one.
 */
export const failureDetails = (
  version: number | null,
  method: string,
  message: string
): { version: number | null; method: string; message: string } => {
  const start = message.slice(0, appErrorDetailsBytes);
  const whole = { version, method, message };
  if (start === message && jsonBytesOf(whole) <= appErrorDetailsBytes) {
    return whole;
  }
  const characters = Array.from(
    graphemes.segment(start),
    ({ segment }) => segment
  );
  // The longest start of the message that fits.
  let fits = 0;
  let tooLong = characters.length;
  while (tooLong - fits > 1) {
    const middle = Math.floor((fits + tooLong) / 2);
    const cut = characters.slice(0, middle).join("");
    if (
      jsonBytesOf({ version, method, message: cut }) <= appErrorDetailsBytes
    ) {
      fits = middle;
    } else {
      tooLong = middle;
    }
  }
  return { version, method, message: characters.slice(0, fits).join("") };
};

/**
 * An error of an App's code as its caller gets it: `app.failed`, with the
 * version that ran and the App's own message (`failureDetails`), never a
 * stack, a cause or a code the App made up. The log gets no App-written
 * text: only which App, version and method, and the error's name.
 */
const appFailure = (error: unknown, { app, version, method }: RanAt): Error => {
  log.warn("app.call_failed", {
    appId: app,
    version: version ?? undefined,
    method,
    errorName: errorNameOf(error),
  });
  const reported = appErrors.create(
    "app.failed",
    failureDetails(version, method, messageOf(error))
  );
  reported.stack = undefined;
  return reported;
};

/**
 * Calls `method` of the App's server code running in `facet`, with
 * `caller` first in its arguments: only the App's own methods, never what
 * every stub has, and only plain data back. An error of the App's code
 * comes back as `app.failed`.
 */
export const invokeServer = async (
  facet: Fetcher,
  caller: AppCaller,
  args: unknown[],
  at: RanAt
): Promise<AppAnswer> => {
  const { method, version } = at;
  if (method in Object.getPrototypeOf(facet)) {
    throw appErrors.create("app.method_invalid", { method });
  }
  const invoke: unknown = Reflect.get(facet, method);
  if (!isMethod(invoke)) {
    throw appErrors.create("app.method_invalid", { method });
  }
  let answer: AppAnswer;
  try {
    // Not `invoke.apply(...)`: on a stub, that calls a method "apply".
    // The server class is wrapped (`loadServer`): its answer is an
    // envelope, a throw of the App's code a value opened here.
    // SAFETY: `plainAnswer` checks it is plain data right below.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    answer = (await openAnswer(
      await Reflect.apply(invoke, facet, [caller, ...args])
    )) as AppAnswer;
  } catch (error) {
    throw appFailure(error, at);
  }
  return plainAnswer(answer, version, method);
};

/**
 * A screen's callback for its App's run changes, as the host keeps it:
 * screens-rpc.ts wraps it, checking before each push that the person may
 * still use the App.
 */
export type RunWatcher = Rpc.Stub<(change: RunChange) => Promise<void>>;

/**
 * A connection's callback for the App's revocations (`followAccess`):
 * called with `true` when its person's role in the App may have dropped,
 * so it checks their access again now (query-subscriptions.ts), and with
 * `false` only to see that it is still there. Called with `false, true`
 * when the person's independent runs the App started changed
 * (`workflowRunsChanged`), so its workflow queries read again. It throws
 * once the connection no longer follows the App.
 */
export type AccessWatcher = Rpc.Stub<
  (revoked: boolean, runsChanged?: boolean) => void
>;

/**
 * Most connections of one person that follow the App's revocations at
 * once: one per open tab of the App's screens, so this only bounds what a
 * page that follows over and over keeps here.
 */
const accessFollowersPerPerson = 64;

/**
 * What let a call into the App, as core checked it before the call, and
 * checks again before each stub call the App's code makes in it
 * (app-bindings.ts, `requireStillAdmitted`): the person's role in the App,
 * for a screen's call (screens-rpc.ts), or the calling App's permission on
 * this App's export, for a call from another App (app-calls.ts). Losing
 * it stops the call acting, while its code still runs.
 */
export type Admission =
  | { type: "role"; person: Person }
  | {
      type: "export";
      /** The calling App, its version and the person, as core checked them. */
      authority: Authority;
      permissionId: PermissionId;
      method: string;
      access: "read" | "write";
      /**
       * The calling App's own running call, by its token, when App code
       * made the call (a workflow run's call has none): admitted again
       * with this one, so the whole chain stops with its first call, by
       * its deadline, its code's generation and what let it in.
       */
      from?: { app: AppId; token: string };
    }
  | {
      /**
       * A run of an independent workflow calling this App's export
       * through its binding `alias` (workflows/resource-calls.ts): the
       * run's call is decided again, on authority as it is now, before
       * each stub call (workflows/resource-authority.ts).
       */
      type: "workflowRun";
      workflow: string;
      run: string;
      alias: string;
    };

/**
 * Who calls the App, as core knows it; the token is the host's. For a
 * workflow run's step, also which attempt of the step the call comes from
 * (`attempt`, the run's engine's ID for it): kept by the host, for the
 * statistics points the call records (statistics.ts). What let the call
 * in (`admission`), checked again on each stub call. Neither is ever shown
 * to the App's code.
 */
export type AppCallerInput = Omit<AppCaller, "token"> & {
  attempt?: string;
  /**
   * For a workflow run's step: who its attempt is, which every stub call
   * of the App's code checks still holds before it acts
   * (attempt-fence.ts). Never shown to the App's code.
   */
  fence?: AttemptFence;
  admission?: Admission;
};

/**
 * What a call from another App's code through an export carries besides
 * its caller (app-calls.ts), for the host to keep with the call: never
 * shown to the App's code.
 */
export interface ExportCall {
  /**
   * The version whose exports core checked the call against: it runs only
   * on that version, and is refused with `app.conflict` once another is
   * current.
   */
  version: number;
  /** The Apps whose calls are under way above this one, outermost first. */
  chain: readonly AppId[];
  /** The turns its calls hold (`CallPath.holding`). */
  holding: readonly Hold[];
  /** When the call it comes from must end, in milliseconds since the epoch. */
  deadline: number;
  /** Whether the call may only call other Apps' exports marked `read`. */
  readOnly: boolean;
  /**
   * Called once the call is pinned to `version`, just before the method
   * runs: where the caller records the call (app-calls.ts). If it
   * throws, the method doesn't run.
   */
  onPinned: () => Promise<void>;
}

/**
 * Where a running call is within calls between Apps, as its stubs call
 * other Apps' exports from it (app-calls.ts).
 */
export interface CallPath {
  /** The Apps whose calls are under way, outermost first, this one last. */
  chain: AppId[];
  /**
   * The turns of `chain`'s Apps its calls hold, by the call holding each,
   * this one last: every App but a workflow run's, whose turn a run's call
   * doesn't hold. While the call waits for another App, they all wait
   * with it (`waitsOn`).
   */
  holding: Hold[];
  /** When the call must end, in milliseconds since the epoch. */
  deadline: number;
  /** Whether it may only call other Apps' exports marked `read`. */
  readOnly: boolean;
}

/**
 * What a call may do through the App's stubs: only read (`read`, a call
 * through an export marked `read`, or one made while serving one), or
 * change things too (`write`).
 *
 * Only the stubs go by it. The App's own SQLite database is not a stub:
 * App code holds it directly, in the same object for every call, so a
 * call that may only read can still write it. That stays so until App
 * methods run as stateless handlers with no storage of their own, whose
 * data goes through the host like everything else. Calls run one at a
 * time (`App.call`), so a read's code can't take up the token of a write
 * running alongside it; only work an earlier call's code left running
 * detached can (see `App.call`).
 */
export type InvocationKind = "read" | "write";

/**
 * A call running now, as the host keeps it by its token: the call's
 * invocation, which the host makes as the call starts from what core
 * knows of it (the session, the run, or the export core checked), never
 * from anything App code passes. Every stub call of the App's code is
 * admitted against it (`admit`).
 */
interface Invocation {
  caller: AppCallerInput;
  /** The method of the App's server code it calls. */
  method: string;
  /** What the call may do through the App's stubs. */
  kind: InvocationKind;
  /** Statistics points it recorded and reads it made (`claimStatistic`). */
  statistics?: { point: number; read: number };
  /** The stub calls it made (`claimHostCall`), each counted as it starts. */
  hostCalls?: number;
  /** The version its code runs on, once started. */
  version?: number;
  /**
   * The code it was handed to, once it was: the generation of the App's
   * code its stub calls must come from. Once that code is stopped
   * (restarted for new permissions, replaced by another version, or
   * stopped after a call ran over), the call acts no more, even if its
   * code went on.
   */
  ranOn?: ServerCode;
  /** The Apps whose calls are under way above it, outermost first. */
  above: readonly AppId[];
  /** The turns its calls above hold (`CallPath.holding`). */
  aboveHolding: readonly Hold[];
  /** The opaque ID of its turn, for the holds it passes on (`Hold.call`). */
  turn: string;
  /** When it must end: past it, it acts no more, whatever its code does. */
  deadline: number;
  /**
   * Set once the workflow run it acts for was cancelled, or the step's
   * attempt it acts for let go of (`App.revokeRunCalls`,
   * `App.revokeAttemptCalls`): it acts no more, whatever its code does.
   */
  revoked?: true;
}

/** Who a stub call acts for, as the host admits it (`App.admit`). */
export interface Admitted {
  authority: Authority;
  idempotencyKey: string | undefined;
  attempt: string | undefined;
  /** For a workflow run's step: its attempt, to check before acting. */
  fence: AttemptFence | undefined;
  path: CallPath;
  method: string;
  kind: InvocationKind;
  /** What let the call in, for the stub to check again (app-bindings.ts). */
  admission: Admission | undefined;
}

/**
 * The code an App's facet runs: its version, which read of the current
 * version chose it (see `App.#facet`), and its class once loaded.
 */
interface ServerCode {
  version: number;
  read: number;
  loaded: Promise<DurableObjectClass>;
}

/** The App's current version: the one that runs. */
const currentVersion = async (env: Env, app: AppId): Promise<number> => {
  const { currentVersion: version } = await findApp(env, app);
  if (version === null) {
    throw appErrors.create("app.not_running");
  }
  return version;
};

/**
 * The App's server code at `version`, with an env for the permissions of
 * `generation` (see `#load`), as the class its facet runs.
 */
export const loadServer = async (
  env: Env,
  app: AppId,
  version: number,
  generation: number
): Promise<DurableObjectClass> => {
  // On-prem, nothing bounds an App's server object (a facet of core's own
  // Loader, which the sandbox can't host): refused unless the deployment
  // says that's fine, until GRA-500 moves Apps onto sealed functions.
  requireBoundedHere(env, "an App's server object");
  const files = await versionFiles(env, app, version);
  const build = await buildServer(env, files, app);
  if (!build.ok) {
    throw appErrors.create("app.build_failed", buildFailed(version, build));
  }
  const bindings = await appBindings(env, app);
  // The same generation has the same key, so the loader may keep its
  // isolate while the host sleeps. Another version, or a grant or revoke
  // (a new generation), starts a new one.
  const key = `app:${app}:${version}:${generation}`;
  return quietLoader(env.LOADER)
    .get(key, () => ({
      ...sandbox,
      mainModule: build.mainModule,
      modules: build.modules,
      env: bindings,
      // What its code writes with `console` goes to its error log.
      tails: [exports.AppTail({ props: { app, version } })],
    }))
    .getDurableObjectClass("App");
};

/** An error as a caller of the App may see it: ours, or `internal.unexpected`. */
const forCaller = (
  error: unknown,
  app: AppId,
  version: number | undefined,
  method: string
): Error => {
  if (!isExpectedError(error)) {
    log.error("app.call_error", {
      appId: app,
      version,
      method,
      errorName: errorNameOf(error),
    });
  }
  return toOpaqueError(error, { version: version ?? null });
};

/** Ends a call's turn (`release`) once its code has settled (`drained`). */
const releaseAfter = async (
  drained: Promise<void>,
  release: () => void
): Promise<void> => {
  try {
    await drained;
  } finally {
    release();
  }
};

/**
 * One App: the host of its server code (`app/server.ts`, exporting an
 * `App` class), and the keeper of its restricted mode (restricted.ts).
 * Core reaches it through `callApp`; the App's own code reaches it only
 * through its stubs.
 */
/** Where the App's object keeps `userId`'s held places of one kind. */
const invocationHoldsKey = (userId: string, streaming: boolean): string =>
  `${streaming ? "stream" : "action"}-holds:${userId}`;

export class App extends DurableObject<Env> {
  /**
   * The code the facet runs: its version, which read of the current
   * version chose it (see `#facet`), and its class once loaded.
   */
  #server: ServerCode | undefined;

  /** How many times a call has read the current version. */
  #reads = 0;

  /** Screens following the App's runs, by workflow and ID (`watchRuns`). */
  readonly #runWatchers = new Map<string, Map<string, RunWatcher>>();

  /** Connections following the App's revocations, by ID (`followAccess`). */
  readonly #accessFollowers = new Map<
    string,
    { readonly userId: string; readonly onRevoked: AccessWatcher }
  >();

  /**
   * The calls running now, by token, with the version their code runs on
   * once it started, and where each runs within calls between Apps.
   */
  readonly #calls = new Map<string, Invocation>();
  /**
   * Lets one call at a time run in the App's code (`call`); a call from
   * another App's waits with the turns its chain holds (`waitingHolds`).
   */
  readonly #queue = new CallQueue<readonly Hold[]>(waitingCallsLimit);

  /** Statistics points the App recorded, and reads, in the current minute. */
  #statisticsMinute = { minute: 0, point: 0, read: 0 };

  /** The minute a read refused past its bounds was last audited. */
  #limitedAuditMinute = -1;

  // What the App's screens may ask and report, counted here because every
  // connection of every person to this App ends at this one object: a
  // count the page or one connection kept is skipped by opening another.
  // Kept in memory: a restart of this object starts the buckets full,
  // which an idle App's are anyway.

  /** Each person's requests of the App's screens. */
  readonly #requests = new TokenBuckets(screenLimits.requests);

  /**
   * Each person's reads of their live queries that writes caused
   * (`querySubscriptionLimits.liveReads`, query-subscriptions.ts).
   */
  readonly #liveReads = new TokenBuckets(querySubscriptionLimits.liveReads);

  /**
   * Each person's chunk requests of the App's files: a budget of their
   * own (an upload is many chunks), charged before a chunk costs anything.
   */
  readonly #chunks = new TokenBuckets(fileLimits.chunkRequests);

  /** Chunks refused since the last line logged of them, and when that was. */
  #refusedChunks = { chunks: 0, loggedAt: 0 };

  /** The reports kept of each person's screens, and of all of them. */
  readonly #callerReports = new TokenBuckets(screenLimits.callerReports);
  readonly #appReports = new TokenBuckets(screenLimits.appReports);

  /**
   * The lines kept of what the App's server code writes with `console`:
   * a budget apart from its screens' reports, so server code that logs
   * a lot never crowds out a problem a screen reports.
   */
  readonly #serverLines = new TokenBuckets(serverLinesLimit);

  /** The App's error log, in this object's own storage. */
  readonly #errorLog = new ErrorLog(this.ctx.storage);

  /** Reports dropped unread and not yet in the log's count, and when it was last written. */
  readonly #suppressed = { writtenAt: 0, writing: false };

  /** Requests refused since the last line logged of them, and when that was. */
  #refused = { requests: 0, loggedAt: 0 };

  /** When each refusal of a screen was last audited, oldest first (`auditOnce`). */
  readonly #refusalsAudited = new Map<string, number>();

  /** The refusals whose rows are being written now (`auditOnce`). */
  readonly #refusalsWriting = new Map<string, Promise<void>>();

  get #app(): AppId {
    return appIdSchema.parse(this.ctx.id.name);
  }

  /**
   * Calls `method` of the App's server code with `args`, for `caller`,
   * who comes first in the arguments the method gets. Runs the App's
   * current version, restarting the code on it when another was running.
   * Answers plain data only.
   *
   * One call runs at a time; the others wait their turn, in the order
   * they came, within their deadline: `ends`, when the caller stops
   * waiting (a screen's call, a workflow step's attempt;
   * `ExportCall.deadline` for a call from another App), never later than
   * the App's own time for a call from when it came. A call's token is made only once it has its turn.
   * A call that can't get its turn in time, or finds `waitingCallsLimit`
   * calls waiting already, gets `app.busy`, and never reaches the App's
   * code.
   *
   * A call not answered by its deadline gets `app.timed_out`, and its
   * token stops working at once. If its method was handed to the App's
   * code, that code keeps the App's turn until it settles: the next call
   * doesn't start alongside it. It has as long as its caller asked for
   * (never more than the App's own time for a call), from when its turn
   * began, however long it waited; a call from another App has the App's
   * own time. Past that, the App's code is stopped (`#overran`), so it
   * can't go on writing the App's data, and then the next call gets its
   * turn.
   *
   * A call from another App's code through an export (`via`, from
   * app-calls.ts) runs only on the version core checked it against, ends
   * by the time the call it came from must, and is kept with the Apps
   * above it, for the calls its code makes on (`callerOf`). One that
   * would wait for this App while this App's turn waits, through other
   * Apps' queues, on one its own chain holds gets `app.call_deadlock` at
   * once (`#waitsOn`), rather than both waiting until a deadline ends
   * one.
   *
   * Known gaps:
   * - Work the App's code leaves running detached from its call (a
   *   promise it doesn't await, a timer) goes on after the call settled,
   *   alongside later calls, and can read a later call's token from what
   *   they share, and act for that caller while that call runs. That is
   *   never more than that later call's own code, the same App's, may do.
   *   Only an isolate per call (App methods as stateless handlers) closes
   *   it.
   * - A caller that gives up frees the App only by its deadline: a
   *   cancelled run doesn't free it early, and a workflow step with no
   *   timeout, which asks for no deadline, holds it for up to the App's
   *   own time for a call.
   */
  async call(
    caller: AppCallerInput,
    method: string,
    args: unknown[],
    via?: ExportCall,
    ends?: number
  ): Promise<AppAnswer> {
    requireAppMethod(method);
    // Each on its own: a stub among them would keep the others from being
    // walked as structured clone carries them (`holdsBigInt`).
    if (args.some((arg) => holdsBigInt(arg))) {
      throw appErrors.create("app.call_invalid", { method });
    }
    const ownMs = callTimeoutMs(this.env);
    const ms = Math.min(
      ownMs,
      (via?.deadline ?? ends ?? Number.POSITIVE_INFINITY) - Date.now()
    );
    if (ms <= 0) {
      throw appErrors.create("app.timed_out", { version: null, method });
    }
    const callEnds = Date.now() + ms;
    // The wait for a turn counts against the deadline.
    const limit = deadline(ms);
    // The opaque ID of the call's turn (`Hold.call`): never its token,
    // which acts for its caller.
    const turn = crypto.randomUUID();
    let release: () => void;
    try {
      release = await this.#queue.turn(
        limit.signal,
        () => appErrors.create("app.busy", { method }),
        turn,
        via === undefined
          ? undefined
          : {
              tag: via.holding,
              check: async (left) =>
                (await this.#waitsOn(via.holding, left))
                  ? appErrors.create("app.call_deadlock", { method })
                  : undefined,
            }
      );
    } catch (error) {
      limit.clear();
      throw error;
    }
    // Settles once the call's code has, or was stopped: never rejects.
    let drained: Promise<void> = Promise.resolve();
    try {
      return await this.#run(caller, method, args, via, {
        turn,
        ends: callEnds,
        limit,
        // From when its turn began: the time its caller asked for, the
        // App's own at most. A call from another App gets the App's own
        // time, so another App can't stop this one's code by calling it
        // just before its own deadline.
        stopAt: Date.now() + (via === undefined ? ms : ownMs),
        drainWith: (draining) => {
          drained = draining;
        },
      });
    } finally {
      limit.clear();
      // Its token is gone (`#run`); its code has settled before the next
      // call gets the App.
      void releaseAfter(drained, release);
    }
  }

  /**
   * Runs a call that has its turn (`call`): its token made, kept while
   * the call runs, and dropped as it ends, whether by its answer, its
   * error or its deadline (`limit`). A call its deadline cut short once
   * its method was handed to the App's code hands `drainWith` what
   * settles once that code has, or was stopped at `stopAt`.
   */
  async #run(
    caller: AppCallerInput,
    method: string,
    args: unknown[],
    via: ExportCall | undefined,
    {
      turn,
      ends,
      limit,
      stopAt,
      drainWith,
    }: {
      turn: string;
      ends: number;
      limit: Deadline;
      stopAt: number;
      drainWith: (draining: Promise<void>) => void;
    }
  ): Promise<AppAnswer> {
    const token = crypto.randomUUID();
    const {
      attempt: _attempt,
      fence: _fence,
      admission: _admission,
      ...shown
    } = caller;
    const call: Invocation = {
      caller,
      method,
      kind: via?.readOnly === true ? "read" : "write",
      above: via?.chain ?? [],
      aboveHolding: via?.holding ?? [],
      turn,
      deadline: ends,
    };
    this.#calls.set(token, call);
    let version: number | undefined;
    /** The code the method was handed to, once it was: see `#overran`. */
    let ranOn: ServerCode | undefined;
    const run = async (): Promise<AppAnswer> => {
      const read = this.#nextRead();
      const current = await currentVersion(this.env, this.#app);
      // The exports checked were another version's: it isn't called.
      if (via !== undefined && current !== via.version) {
        throw appErrors.create("app.conflict");
      }
      const running = await this.#facet(current, read);
      ({ version } = running);
      if (via !== undefined) {
        await this.#pinned(running.server, via);
      }
      // Last before the method starts, after every read: a workflow step's
      // attempt the engine let go of meanwhile starts nothing, its App's
      // own SQLite included (attempt-fence.ts).
      await requireAttemptHolds(this.env, caller.fence, this.#app);
      // Revoked while that was asked (`revokeRunCalls`): checked here, with
      // nothing awaited before the method starts.
      if (this.#calls.get(token)?.revoked === true) {
        throw executionErrors.create("execution.stale_attempt");
      }
      // Timed out while the code started: its caller already has the
      // answer, so the method mustn't run (and write) after all.
      if (!this.#calls.has(token)) {
        throw appErrors.create("app.timed_out", { version, method });
      }
      // What the App's stub calls in this call are audited with, and the
      // code they must come from (`admit`).
      this.#calls.set(token, { ...call, version, ranOn: running.server });
      ranOn = running.server;
      return await invokeServer(
        running.facet,
        { ...shown, token } satisfies AppCaller,
        args,
        { app: this.#app, version: running.version, method }
      );
    };

    // Never rejects: when the deadline wins, the call goes on without a
    // caller, and how it ends is nobody's business any more.
    const settled = async (): Promise<
      { answer: AppAnswer } | { error: unknown }
    > => {
      try {
        return { answer: await run() };
      } catch (error) {
        return { error };
      }
    };
    const settling = settled();
    let outcome: { answer: AppAnswer } | { error: unknown };
    try {
      outcome = await Promise.race([settling, whenAborted(limit.signal)]);
    } catch {
      if (ranOn !== undefined) {
        drainWith(this.#drain(settling, ranOn, method, stopAt));
      }
      throw appErrors.create("app.timed_out", {
        version: version ?? null,
        method,
      });
    } finally {
      this.#calls.delete(token);
    }
    if ("error" in outcome) {
      throw forCaller(outcome.error, this.#app, version, method);
    }
    return outcome.answer;
  }

  /**
   * Waits for the code of a call cut short to settle (`settling`), until
   * `stopAt`, the App's own time for the call; past it, stops the code it
   * ran on (`#overran`). Never rejects.
   */
  async #drain(
    settling: Promise<unknown>,
    ranOn: ServerCode,
    method: string,
    stopAt: number
  ): Promise<void> {
    const cap = deadline(Math.max(0, stopAt - Date.now()));
    try {
      await Promise.race([settling, whenAborted(cap.signal)]);
    } catch {
      await this.#overran(ranOn, method);
    } finally {
      cap.clear();
    }
  }

  /**
   * Pins a call from another App's export to the version core checked it
   * against (`via.version`): the facet `#facet` handed back must run it,
   * then the caller hears it is about to run (`via.onPinned`, which
   * records the call), and the code `#facet` handed back must still be
   * the code that runs after: a call that made another version current
   * meanwhile, and started it, would otherwise have this call run code
   * nobody checked it against.
   * Nothing awaits between this and invoking the method, so no other call
   * can replace the facet in between. `app.conflict` otherwise.
   */
  async #pinned(running: ServerCode, via: ExportCall): Promise<void> {
    if (running.version !== via.version) {
      throw appErrors.create("app.conflict");
    }
    await via.onPinned();
    // The same code, not only the same version: code restarted meanwhile
    // runs in a facet the call wasn't handed.
    if (this.#server !== running) {
      throw appErrors.create("app.conflict");
    }
  }

  /**
   * Which of `turns` holds this App now, and for each call from another
   * App's code, or a workflow run, waiting for it, oldest first: the turns
   * its chain holds (`CallPath.holding`), which all wait for this App with
   * it; none for a run's own call. Nothing while none of `turns` holds it:
   * a hold another App passes on from a call that has ended answers
   * nothing (`waitsOn`). Asked by other Apps' hosts, as a call about to
   * wait looks for a cycle.
   */
  waitingHolds(turns: string[]): Held | undefined {
    const holder = this.#queue.holder();
    if (holder === undefined || !turns.includes(holder)) {
      return undefined;
    }
    return {
      holder,
      waiting: this.#queue
        .waitingTags()
        .map((holding) => holding.map(({ app, call }) => ({ app, call }))),
    };
  }

  /**
   * Whether this App's turn waits, through calls waiting in other Apps,
   * on one of `holding`, the turns a call about to wait for it holds
   * (`waitsOn`): if so, that call would wait for an App that waits for it.
   *
   * A call asks once it waits, where this App's `waitingHolds` shows it
   * (`CallQueue.turn`). So of two calls closing one cycle at the same
   * time, the one that asks later finds the other; both may, and then
   * both are refused, never neither.
   */
  async #waitsOn(
    holding: readonly Hold[],
    signal: AbortSignal
  ): Promise<boolean> {
    return await waitsOn({
      self: this.#app,
      holding,
      holds: (call) => this.#queue.holder() === call,
      ask: async (app, turns) => {
        const cap = deadline(waitsForAskMs);
        try {
          return await Promise.race([
            appHost(this.env, app).waitingHolds([...turns]),
            whenAborted(cap.signal),
          ]);
        } finally {
          cap.clear();
        }
      },
      limit: waitsForAsked,
      signal,
    });
  }

  /** Whether the App has read restricted data. */
  async isRestricted(): Promise<boolean> {
    return (await this.ctx.storage.get(restrictedKey)) === true;
  }

  /** Puts the App in restricted mode, for good. */
  async restrict(): Promise<void> {
    await this.ctx.storage.put(restrictedKey, true);
  }

  /**
   * Audits what `refusal` names, with `entry`: a screen's refusal of the
   * App's data (who, which build, why, what and where), or a person's use
   * of the App from a portable host (app-function-route.ts); unless it was
   * audited within `refusalAuditMs`, so a screen opened over and over, or
   * a page retrying, adds a row a window, not one a try. The check and the
   * write are one operation per refusal here: the same refusal arriving
   * while its row is being written waits for that write instead of
   * writing its own. It counts as audited only once the row is written;
   * a write that fails fails each that waited on it, and the next refusal
   * writes again. Kept in memory, so a restart of this object audits each
   * once more; past `refusalsKept`, the oldest are forgotten first, which
   * only audits them again.
   */
  async auditOnce(refusal: string, entry: AuditEntry): Promise<void> {
    const audited = this.#refusalsAudited.get(refusal);
    if (audited !== undefined && Date.now() - audited < refusalAuditMs) {
      return;
    }
    const writing = this.#refusalsWriting.get(refusal);
    if (writing !== undefined) {
      await writing;
      return;
    }
    const write = this.#writeRefusal(refusal, entry);
    this.#refusalsWriting.set(refusal, write);
    try {
      await write;
    } finally {
      this.#refusalsWriting.delete(refusal);
    }
  }

  /** Writes `refusal`'s row, then notes it audited. */
  async #writeRefusal(refusal: string, entry: AuditEntry): Promise<void> {
    const db = drizzle(this.env.DB);
    await auditedBatch(this.env, db, [outboxed(db, entry)]);
    this.#refusalsAudited.delete(refusal);
    this.#refusalsAudited.set(refusal, Date.now());
    for (const [oldest] of this.#refusalsAudited) {
      if (this.#refusalsAudited.size <= refusalsKept) {
        break;
      }
      this.#refusalsAudited.delete(oldest);
    }
  }

  /**
   * Whether core may read one more of `userId`'s live queries of the App
   * now because a write changed what it read
   * (`querySubscriptionLimits.liveReads`), at `cost` reads: a paginated
   * list's window costs one per page it reads (query-windows.ts), never
   * more than the burst. One that may not waits.
   */
  admitLiveRead(userId: string, cost = 1): boolean {
    return this.#liveReads.take(userId, Date.now(), cost);
  }

  /**
   * Whether `userId` may start the action invocation `name` now, which
   * runs until `until` at most: holds a place for it if so. A person runs
   * at most `streamMaxRunning` streaming actions and `actionMaxRunning`
   * plain ones at once in the App, each kind counted apart. A hold past
   * its time no longer counts, so a run whose end was never told frees its
   * place by its deadline. Stored, not only in memory: a restart of this
   * object while invocations run (each in an object of its own) must not
   * give their places back.
   */
  holdInvocation(
    userId: string,
    name: string,
    until: number,
    streaming: boolean
  ): boolean {
    const now = Date.now();
    const key = invocationHoldsKey(userId, streaming);
    const held = Object.entries(this.#invocationHolds(key)).filter(
      ([, end]) => end > now
    );
    const most = streaming ? streamMaxRunning : actionMaxRunning;
    if (!held.some(([running]) => running === name) && held.length >= most) {
      return false;
    }
    this.ctx.storage.kv.put(key, {
      ...Object.fromEntries(held),
      [name]: until,
    });
    return true;
  }

  /** Frees `userId`'s place for the invocation `name`, which has ended. */
  releaseInvocation(userId: string, name: string, streaming: boolean): void {
    const now = Date.now();
    const key = invocationHoldsKey(userId, streaming);
    const held = Object.entries(this.#invocationHolds(key)).filter(
      ([running, end]) => running !== name && end > now
    );
    if (held.length === 0) {
      this.ctx.storage.kv.delete(key);
      return;
    }
    this.ctx.storage.kv.put(key, Object.fromEntries(held));
  }

  /** The places held under `key`, by invocation name, each until when. */
  #invocationHolds(key: string): Readonly<Record<string, number>> {
    return this.ctx.storage.kv.get<Record<string, number>>(key) ?? {};
  }

  /**
   * Whether `userId`'s screen may ask the App one more thing now
   * (`screenLimits.requests`), at `count` requests: a paginated list's
   * window counts one per page it reads (query-windows.ts), never more
   * than the burst. Asked before the request is read, so one that is
   * refused or malformed counts too.
   */
  admitRequest(userId: string, count = 1): boolean {
    const now = Date.now();
    const admitted = this.#requests.take(userId, now, count);
    if (!admitted) {
      this.#refused.requests += 1;
      // One line a minute for whoever audits it, not one a request.
      if (now - this.#refused.loggedAt >= refusalLogMs) {
        log.warn("screen.requests_limited", {
          appId: this.#app,
          refused: this.#refused.requests,
        });
        this.#refused = { requests: 0, loggedAt: now };
      }
    }
    return admitted;
  }

  /**
   * Whether `userId`'s screen may send one more chunk of a file now
   * (`fileLimits.chunkRequests`): asked before the chunk is read or
   * anything is looked up, so a refused, duplicate or malformed chunk
   * counts too. Refusals reach the log at most once a minute.
   */
  admitChunk(userId: string): boolean {
    const now = Date.now();
    const admitted = this.#chunks.take(userId, now);
    if (!admitted) {
      this.#refusedChunks.chunks += 1;
      if (now - this.#refusedChunks.loggedAt >= refusalLogMs) {
        log.warn("app_file.chunks_limited", {
          appId: this.#app,
          refused: this.#refusedChunks.chunks,
        });
        this.#refusedChunks = { chunks: 0, loggedAt: now };
      }
    }
    return admitted;
  }

  /**
   * Whether one more report of `userId`'s screen is kept now: within what
   * one person's screens may report, and all of the App's together. One
   * that isn't is only counted. The count reaches the log at once the
   * first time and at most once a minute after, so a flood of reports
   * writes one number, not a record each.
   */
  async admitReport(userId: string): Promise<boolean> {
    const now = Date.now();
    // Asked of the App's bucket first, taken from it last: a report the
    // App has no room for must not use up the person's own.
    const admitted =
      this.#appReports.has(appBucket, now) &&
      this.#callerReports.take(userId, now) &&
      this.#appReports.take(appBucket, now);
    if (!admitted) {
      await this.#dropReport(now);
    }
    return admitted;
  }

  /**
   * Counts one report as dropped unread: written to the log at once the
   * first time, and at most once a minute after.
   */
  async #dropReport(now: number): Promise<void> {
    this.#errorLog.suppress();
    if (
      !this.#suppressed.writing &&
      now - this.#suppressed.writtenAt >= suppressedWriteMs
    ) {
      await this.#writeSuppressed(now);
    }
  }

  /**
   * Writes the count of dropped reports to the log. The time of the write
   * moves on only once the log has it: after one that fails, the next
   * dropped report tries again.
   */
  async #writeSuppressed(now: number): Promise<void> {
    this.#suppressed.writing = true;
    try {
      const reports = await this.#errorLog.writeSuppressed();
      this.#suppressed.writtenAt = now;
      // One line for the operator too, as often as the number is written.
      if (reports > 0) {
        log.warn("screen.reports_suppressed", { appId: this.#app, reports });
      }
    } finally {
      this.#suppressed.writing = false;
    }
  }

  /** Adds an admitted report to the App's error log (app-error-log.ts). */
  async logError(reported: ReportedProblem): Promise<void> {
    await this.#errorLog.add(reported);
  }

  /**
   * Adds what the App's server code at `version` wrote with `console` to
   * its error log, for its tail alone (server-logs.ts): each line within
   * what the App's server lines may use together (`serverLinesLimit`),
   * apart from its screens' reports, and only counted past it, so code
   * that logs in a loop writes no more, and suppresses no screen's report.
   */
  async logServer(version: number, logs: ServerLog[]): Promise<void> {
    for (const line of logs) {
      const now = Date.now();
      // oxlint-disable-next-line no-await-in-loop -- in order, each counted against the App's server lines
      await (this.#serverLines.take(appBucket, now)
        ? this.#errorLog.add({ ...line, source: "server", version })
        : this.#dropReport(now));
    }
  }

  /**
   * The App's error log, with every report dropped so far counted.
   * Reading it writes nothing: the count is written only as reports are
   * dropped, at most once a minute (`admitReport`).
   */
  async errors(): Promise<AppErrorLog> {
    return await this.#errorLog.read();
  }

  /**
   * Keeps `onChange`, a screen's callback, and calls it each time a run of
   * the App's workflow `workflow` changes (`runChanged`), until calling it
   * fails: the screen is gone, or the person may no longer use the App.
   * Kept here in memory, outside the App's code, so a restart of that code
   * keeps them; a restart of this object drops them, which tells each
   * screen to follow again. Returns the ID `unwatchRuns` drops it by.
   */
  watchRuns(workflow: string, onChange: RunWatcher): string {
    const id = crypto.randomUUID();
    const watchers =
      this.#runWatchers.get(workflow) ?? new Map<string, RunWatcher>();
    watchers.set(id, onChange.dup());
    this.#runWatchers.set(workflow, watchers);
    return id;
  }

  /** Drops the screen's callback `watchRuns` kept as `id`, if it still does. */
  unwatchRuns(workflow: string, id: string): void {
    this.#drop(workflow, id);
  }

  /**
   * Tells the screens following `workflow` that its run `run` changed, so
   * they read it again (workflows/run-changes.ts). Returns at once: each
   * push goes on by itself, and one that fails drops only its screen.
   */
  runChanged(workflow: string, run: string): void {
    for (const [id, watcher] of this.#runWatchers.get(workflow) ?? []) {
      void this.#tell(workflow, id, watcher, { run });
    }
  }

  async #tell(
    workflow: string,
    id: string,
    watcher: RunWatcher,
    change: RunChange
  ): Promise<void> {
    try {
      await watcher(change);
    } catch {
      this.#drop(workflow, id);
    }
  }

  #drop(workflow: string, id: string): void {
    const watchers = this.#runWatchers.get(workflow);
    const watcher = watchers?.get(id);
    watchers?.delete(id);
    if (watchers?.size === 0) {
      this.#runWatchers.delete(workflow);
    }
    watcher?.[Symbol.dispose]();
  }

  /**
   * Keeps `onRevoked`, the callback of a connection of `userId`'s that
   * follows the App's live queries, and calls it each time their role in
   * the App may have dropped (`accessRevoked`), until calling it fails.
   * Kept in memory, as `watchRuns` keeps its callbacks: a restart of this
   * object drops them, which tells each connection to check its access
   * and follow again, so an event sent meanwhile is never missed. Past
   * `accessFollowersPerPerson`, the person's connections that are gone
   * are let go of first; refused if that frees no place. Returns the ID
   * `unfollowAccess` drops it by.
   */
  async followAccess(
    userId: string,
    onRevoked: AccessWatcher
  ): Promise<string> {
    const held = onRevoked.dup();
    const theirs = (): [string, AccessWatcher][] =>
      [...this.#accessFollowers]
        .filter(([, follower]) => follower.userId === userId)
        .map(([id, follower]) => [id, follower.onRevoked]);
    if (theirs().length >= accessFollowersPerPerson) {
      await Promise.all(
        theirs().map(async ([id, watcher]) => {
          try {
            await watcher(false);
          } catch {
            this.#dropFollower(id);
          }
        })
      );
    }
    if (theirs().length >= accessFollowersPerPerson) {
      held[Symbol.dispose]();
      throw screenErrors.create("screen.too_many_queries");
    }
    const id = crypto.randomUUID();
    this.#accessFollowers.set(id, { userId, onRevoked: held });
    return id;
  }

  /** Drops the callback `followAccess` kept as `id`, if it still does. */
  unfollowAccess(id: string): void {
    this.#dropFollower(id);
  }

  /**
   * Tells the connections of `userIds` (of everyone, when `null`) that
   * follow the App's live queries that their role in it may have dropped
   * (access-revocations.ts): each checks again now, and clears what its
   * screens show if it has. Returns at once, with how many connections it
   * told; a connection that is gone is dropped.
   */
  accessRevoked(userIds: readonly string[] | null): number {
    let told = 0;
    for (const [id, { userId, onRevoked }] of this.#accessFollowers) {
      if (userIds === null || userIds.includes(userId)) {
        told += 1;
        void this.#tellRevoked(id, onRevoked);
      }
    }
    return told;
  }

  async #tellRevoked(id: string, onRevoked: AccessWatcher): Promise<void> {
    try {
      await onRevoked(true);
    } catch {
      this.#dropFollower(id);
    }
  }

  /**
   * Tells the connections of `userId` that follow the App's live queries
   * that their independent runs the App started changed (run-changes.ts,
   * `tellQueryFollowers`): each reads its workflow queries of the App
   * again, as its person. Returns at once, with how many connections it
   * told; a connection that is gone is dropped.
   */
  workflowRunsChanged(userId: string): number {
    let told = 0;
    for (const [id, follower] of this.#accessFollowers) {
      if (follower.userId === userId) {
        told += 1;
        void this.#tellRunsChanged(id, follower.onRevoked);
      }
    }
    return told;
  }

  /**
   * Tells every connection that follows the App's live queries that what
   * the App may start may have changed (a permission of the App granted or
   * revoked, permissions.ts): each reads its workflow queries and watches
   * of the App again, as its person, so a screen's `canRun` and
   * `canCancel` follow the grant (screen-workflows.ts). Returns at once,
   * with how many connections it told.
   */
  workflowPolicyChanged(): number {
    for (const [id, follower] of this.#accessFollowers) {
      void this.#tellRunsChanged(id, follower.onRevoked);
    }
    return this.#accessFollowers.size;
  }

  async #tellRunsChanged(id: string, onRevoked: AccessWatcher): Promise<void> {
    try {
      await onRevoked(false, true);
    } catch {
      this.#dropFollower(id);
    }
  }

  #dropFollower(id: string): void {
    const follower = this.#accessFollowers.get(id);
    this.#accessFollowers.delete(id);
    follower?.onRevoked[Symbol.dispose]();
  }

  /**
   * Revokes the App's calls running now for workflow run `run`'s
   * attempts of generations below `below`, or for every one (`null`):
   * once its run was cancelled, or its earlier activations let go of.
   * The App's own synchronous checks (`admit`, and a method's start)
   * then refuse them, with nothing awaited between. A call that starts
   * later is refused by its method's start, which asks the run's object
   * (attempt-fence.ts). Repeating it changes nothing.
   */
  revokeRunCalls(run: string, below: number | null): void {
    for (const call of this.#calls.values()) {
      const { fence } = call.caller;
      if (fence?.run === run && (below === null || fence.generation < below)) {
        call.revoked = true;
      }
    }
  }

  /**
   * Revokes the App's calls running now for one attempt of a run's step
   * (`fence`), once its function has returned.
   */
  revokeAttemptCalls(fence: AttemptFence): void {
    for (const call of this.#calls.values()) {
      const of = call.caller.fence;
      if (
        of?.run === fence.run &&
        of.key === fence.key &&
        of.number === fence.number &&
        of.generation === fence.generation
      ) {
        call.revoked = true;
      }
    }
  }

  /**
   * Admits one stub call of the App's code made with `token`, for `use`:
   * who it acts for (the caller of the running call `token` names), with
   * the version of the code the call runs, and, for a workflow run's step,
   * that step's idempotency key and its attempt, where the call is within
   * calls between Apps (`path`), the method it calls, and what it may do
   * (`kind`).
   * For the App's stubs (app-bindings.ts, app-calls.ts) only, each of
   * which says whether its call changes anything (`use`): a call that may
   * only read is refused one that does, `app.read_only`, before any of it
   * is done. What the call may do is the host's, as its caller is: App
   * code passes only the token, and nothing else it puts on the caller
   * counts. A call whose code hasn't started has handed its token to no
   * one, so no stub call can come with it; one past its deadline, or from
   * code the host has stopped since (`Invocation.ranOn`), acts no more,
   * even before the host has let go of it. Writes to the App's own SQLite
   * never come through here, so a read call can still make them (see
   * `InvocationKind`).
   */
  admit(token: string, use: InvocationKind): Admitted {
    const call = this.#calls.get(token);
    // The deadline is defence in depth: the host lets go of a call (and
    // its token) when the timer for its deadline fires, but a timer can
    // fire late, and the clock moves on only with I/O. Between the deadline
    // and that timer, nothing a test can bring about on purpose, this
    // still says no.
    // A workflow run's call whose run was cancelled, or whose attempt was
    // let go of, since: revoked here, in the same synchronous check, so
    // nothing awaited after a check elsewhere can let it act.
    if (
      call?.version === undefined ||
      call.ranOn !== this.#server ||
      Date.now() >= call.deadline ||
      call.revoked === true
    ) {
      throw appErrors.create("app.caller_invalid");
    }
    const {
      caller,
      method,
      kind,
      version,
      above,
      aboveHolding,
      turn,
      deadline: ends,
    } = call;
    if (use === "write" && kind === "read") {
      throw appErrors.create("app.read_only");
    }
    return {
      authority: {
        subject: { type: "app", appId: this.#app },
        onBehalfOf: caller.userId,
        mode: caller.mode,
        appVersion: version,
      },
      idempotencyKey: caller.idempotencyKey,
      attempt: caller.attempt,
      fence: caller.fence,
      path: {
        chain: [...above, this.#app],
        holding: [...aboveHolding, { app: this.#app, call: turn }],
        deadline: ends,
        readOnly: kind === "read",
      },
      method,
      kind,
      admission: caller.admission,
    };
  }

  /**
   * Admits one stub call of the running call `token` names for `use`, as
   * `admit` does, and counts it against the call's host calls: the same
   * budget an App function's operation channel has
   * (`platformLimits.invocationHostCalls`, 100; operation-channel.ts), for
   * the App's stubs, which reach core outside that channel. Every stub
   * call counts, each as it reaches the host, refused or not: a read, a
   * call of another App, a connection's action, a statistics point, a
   * guest invited, each a request of a resource outside the App, as the
   * channel counts its resource requests whatever they change. (The App's
   * own writes, to its SQLite, never come through a stub: the channel's
   * uncounted staged writes have no stub here.) Past the budget the stub
   * call is refused, `operation.call_limit`, before it does anything: a
   * method's loop of them ends there, however long its deadline. Only a
   * stub call's first admission counts (app-bindings.ts,
   * `countedCallerOf`): one admitted again before it acts, or before its
   * answer goes back, is admitted with `admit` alone. Kept for the call's
   * life, in memory, as its token is: a call the object outlives not, nor
   * a retry, which is another call with a budget of its own.
   */
  claimHostCall(token: string, use: InvocationKind): Admitted {
    // The token first, then the count, then what the call may do: a write
    // a read-only call is refused (`app.read_only`) still counts, as the
    // channel counts what it refuses, so a loop of refused writes ends at
    // the budget too. A token of no running call counts for nothing.
    const valid = this.admit(token, "read");
    const call = this.#calls.get(token);
    if (call === undefined) {
      throw appErrors.create("app.caller_invalid");
    }
    call.hostCalls = (call.hostCalls ?? 0) + 1;
    if (call.hostCalls > platformLimits.invocationHostCalls) {
      throw operationErrors.create("operation.call_limit", {
        maxHostCalls: platformLimits.invocationHostCalls,
      });
    }
    return use === "write" ? this.admit(token, use) : valid;
  }

  /**
   * Counts one statistics `use` (a point recorded, or a read) of the
   * running call `token` names, for the App's stubs
   * (statistics-binding.ts), and answers who the call acts for as
   * `callerOf` does: at most the use's bounds (`statisticLimitsOf`) in one
   * call, and for the App in one minute, all its calls together, kept in
   * memory (a restart of this object starts the minute again).
   * `statistics.rate_limited` past either, `app.caller_invalid` for a
   * token of no running call, and `app.read_only` for a point recorded
   * by a call that may only read.
   */
  claimStatistic(token: string, use: StatisticUse): Admitted {
    const resolved = this.claimHostCall(
      token,
      use === "point" ? "write" : "read"
    );
    const call = this.#calls.get(token);
    if (call === undefined) {
      throw appErrors.create("app.caller_invalid");
    }
    const minute = Math.floor(Date.now() / 60_000);
    if (this.#statisticsMinute.minute !== minute) {
      this.#statisticsMinute = { minute, point: 0, read: 0 };
    }
    const { perCall, perMinute } = statisticLimitsOf(
      use,
      use === "point"
        ? this.env.STATISTICS_POINT_LIMITS
        : this.env.STATISTICS_READ_LIMITS
    );
    const counts = call.statistics ?? { point: 0, read: 0 };
    if (counts[use] >= perCall || this.#statisticsMinute[use] >= perMinute) {
      throw statisticErrors.create("statistics.rate_limited", {
        use,
        perCall,
        perMinute,
      });
    }
    call.statistics = { ...counts, [use]: counts[use] + 1 };
    this.#statisticsMinute[use] += 1;
    return resolved;
  }

  /**
   * Who the running call `token` names acts for, as `callerOf` says, for
   * the audit of a read refused past its bounds: the first one in a
   * minute, for the App; undefined for the rest of that minute, so a loop
   * can't flood the audit log.
   */
  limitedReadAudit(token: string): Admitted | undefined {
    const minute = Math.floor(Date.now() / 60_000);
    if (this.#limitedAuditMinute === minute) {
      return undefined;
    }
    const resolved = this.admit(token, "read");
    this.#limitedAuditMinute = minute;
    return resolved;
  }

  /**
   * Counts one statistics `use` of a sealed function's statistics resource
   * (resource-statistics.ts) against the App's minute: the same minute
   * `claimStatistic` counts, all the App's calls together, so the bound
   * holds whichever path records or reads. `statistics.rate_limited` past
   * it. Each call's own bound is core's (the invocation's counts).
   */
  claimStatisticMinute(use: StatisticUse): void {
    const minute = Math.floor(Date.now() / 60_000);
    if (this.#statisticsMinute.minute !== minute) {
      this.#statisticsMinute = { minute, point: 0, read: 0 };
    }
    const { perCall, perMinute } = statisticLimitsOf(
      use,
      use === "point"
        ? this.env.STATISTICS_POINT_LIMITS
        : this.env.STATISTICS_READ_LIMITS
    );
    if (this.#statisticsMinute[use] >= perMinute) {
      throw statisticErrors.create("statistics.rate_limited", {
        use,
        perCall,
        perMinute,
      });
    }
    this.#statisticsMinute[use] += 1;
  }

  /**
   * Whether a sealed function's platform read refused past its bounds is
   * the App's first in this minute, the one audited (`limitedReadAudit`,
   * whose minute it shares), so a loop can't flood the audit log.
   */
  limitedReadAuditDue(): boolean {
    const minute = Math.floor(Date.now() / 60_000);
    if (this.#limitedAuditMinute === minute) {
      return false;
    }
    this.#limitedAuditMinute = minute;
    return true;
  }

  /**
   * Stops the App's server code after its permissions changed: the next
   * call starts it again in a new isolate, with an env as the permissions
   * are then. Calls running now fail.
   */
  async restart(reason: string): Promise<void> {
    await this.ctx.storage.put(generationKey, (await this.#generation()) + 1);
    this.#stop(reason);
  }

  /**
   * Stops the App's code after a call in it ran past its time, as a
   * restart does: a token stops working when its call ends, but the code
   * would otherwise go on, and its database is its own, so a timed-out
   * method could still write once nobody waits for it. Only while
   * `ranOn`, the code the call ran on, is still the code that runs:
   * another call that ran over in it already stopped it, and a newer
   * version may have started since. Stopped before anything is awaited,
   * so nothing started meanwhile is stopped with it. Then a new
   * generation, so the next call starts a new isolate, with none of the
   * module state the method left behind.
   */
  async #overran(ranOn: ServerCode, method: string): Promise<void> {
    if (this.#server !== ranOn) {
      return;
    }
    log.warn("app.overran", {
      appId: this.#app,
      version: ranOn.version,
      method,
    });
    try {
      this.#stop("A call to the App ran past its time.");
    } catch (error) {
      // Forgotten all the same (`#stop` does that first), so the next
      // call starts its code afresh.
      log.error("app.stop_failed", {
        appId: this.#app,
        errorName: errorNameOf(error),
      });
    }
    try {
      await this.ctx.storage.put(generationKey, (await this.#generation()) + 1);
    } catch (error) {
      // The code is stopped all the same: without the new generation, the
      // next call may get the same isolate back, with its module state,
      // but none of the stopped call's work goes on in it.
      log.error("app.restart_failed", {
        appId: this.#app,
        errorName: errorNameOf(error),
      });
    }
  }

  async #generation(): Promise<number> {
    return (await this.ctx.storage.get<number>(generationKey)) ?? 0;
  }

  #stop(reason: string): void {
    this.#server = undefined;
    this.ctx.facets.abort(facetName, new Error(reason));
  }

  #nextRead(): number {
    this.#reads += 1;
    return this.#reads;
  }

  /**
   * The class for `version`. A version other than the one that ran last
   * (a release, or a rollback to one that ran before) is a new generation
   * too, so no isolate an earlier run of it kept warm comes back with its
   * memory. Only a host that woke up on the same code reuses one.
   */
  async #load(version: number): Promise<DurableObjectClass> {
    let generation = await this.#generation();
    if ((await this.ctx.storage.get<number>(versionKey)) !== version) {
      generation += 1;
      await this.ctx.storage.put({
        [generationKey]: generation,
        [versionKey]: version,
      });
    }
    return await loadServer(this.env, this.#app, version, generation);
  }

  /**
   * The facet, running the version `read` found current: started, or
   * restarted from another. Calls read the current version at the same
   * time, so a read that started earlier can come back later with an
   * older version: the code a later read chose stays, and the call runs
   * on it.
   */
  async #facet(
    version: number,
    read: number
  ): Promise<{ facet: Fetcher; version: number; server: ServerCode }> {
    let server = this.#server;
    // Unknown after this object started, so the facet is restarted then
    // too: aborting one that isn't running changes nothing.
    if (!server || (server.version !== version && read > server.read)) {
      this.#stop(`Version ${version} is now current.`);
      server = { version, read, loaded: this.#load(version) };
      this.#server = server;
    } else if (server.version === version) {
      server.read = Math.max(server.read, read);
    }
    let loaded: DurableObjectClass;
    try {
      loaded = await server.loaded;
    } catch (error) {
      if (this.#server === server) {
        this.#server = undefined;
      }
      throw error;
    }
    // Replaced meanwhile, by a newer read or a restart.
    if (this.#server !== server) {
      const now = this.#server ?? server;
      return await this.#facet(now.version, now.read);
    }
    const facet = this.ctx.facets.get(facetName, () => ({
      class: loaded,
      id: facetName,
    }));
    return { facet, version: server.version, server };
  }
}

/**
 * Calls a method of an App's server code for `caller`: a person in a
 * session (screens), or the person a workflow run acts for. Core takes the
 * caller from the session or the run, never from the request. Anything
 * that fails outside the App's own errors comes back as
 * `internal.unexpected`. Screens and workflows alike call Apps only
 * through here. `ends`, if given, is when the caller stops waiting for an
 * answer (a workflow step's attempt): the call gives up then, waiting for
 * its turn or not.
 */
export const callApp = async (
  env: Env,
  app: AppId,
  caller: AppCallerInput,
  method: string,
  args: unknown[] = [],
  ends?: number
): Promise<AppAnswer> => {
  try {
    return await appHost(env, app).call(caller, method, args, undefined, ends);
  } catch (error) {
    throw forCaller(error, app, undefined, method);
  }
};
