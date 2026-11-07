import {
  authErrors,
  internalErrors,
  isExpectedError,
  requestErrors,
} from "@grasp-os/shared/errors";
import { readAtMost } from "@grasp-os/shared/http";
import type { AppId, ChatId } from "@grasp-os/shared/ids";
import { isRecord } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { functionRequestMaxBytes } from "@grasp-os/shared/operation-limits";
import { operationErrors } from "@grasp-os/shared/operations";
import type { AppErrorPayload } from "@grasp-os/shared/operations";
import {
  appFunctionPath,
  jsonBytes,
  pageErrors,
  pageLeaseHeader,
  pageLimits,
  pageVisitorHeader,
  streamCallActions,
} from "@grasp-os/shared/pages";
import type { StreamCallAction } from "@grasp-os/shared/pages";
import type { Identity } from "@grasp-os/shared/rpc";
import { idempotencyKeySchema } from "@grasp-os/shared/submissions";

import {
  accessOf,
  actionInvocation,
  invocationName,
} from "./action-invocation.ts";
import {
  callPageFunction,
  readFunctionRequest,
  refusalOf,
} from "./app-functions.ts";
import type { FunctionAnswer, FunctionRequest } from "./app-functions.ts";
import { visitorCall, visitorStatusFor } from "./app-visitors.ts";
import { currentVersionOf } from "./apps.ts";
import { identify, identifyFull } from "./auth/identity.ts";
import { callDraftOn } from "./draft-runs.ts";
import { workspace } from "./durable-objects.ts";
import { errorResponse } from "./errors.ts";
import {
  delivering,
  personRefusal,
  readLease,
  requireDelivery,
} from "./page-delivery.ts";
import type { PageLease } from "./page-delivery.ts";
import { admitted, admitWindow, windowCharger } from "./pages-rpc.ts";
import { personalWorkspaceId } from "./personal-workspace.ts";
import { requireNotRevoked } from "./release-runner.ts";
import { isOwnOrigin } from "./rpc.ts";
import { routeMember } from "./staff-audit.ts";

// Every page's one way to call its App's functions (spec 32.6):
// `POST /api/app-functions/<app>`, the call as the body. A running App's
// page, a builder's preview of their draft and a visitor's page of a
// public App all call here; their live queries go over the page's socket
// (pages-rpc.ts, `PageFrameRpc`), decided the same way. What a call runs
// on is the lease core signed for the frame (page-delivery.ts): the App's
// current release on the App's store, or the builder's draft on a
// throwaway store with no resources (draft-runs.ts). A plain request, not
// the socket, so its bytes are bounded as they are read, before anything
// parses them. Threat model, and how each is closed:
//
// - A visitor calling a builder's draft. A draft's lease is signed only
//   for a member who builds the App, when their chat's preview opens
//   (chats-rpc.ts), and names them: a visitor's calls are checked against
//   `visitor:<session>`, which no member's ID is, so such a lease is no
//   lease for them; and their calls never reach the draft runner at all
//   (`visitorCall` takes only a release's lease, `leasedBuild`, and
//   refuses a draft's).
// - A preview reaching the App's real store or a resource. No store is
//   ever named by a page: it follows from what the signed lease runs on.
//   A draft runs on its throwaway store, which no inventory lists, with
//   nothing bound (draft-runs.ts); its actions run in the same invocation
//   objects as a release's, by a name of their own, and tell no webhook
//   (action-invocation.ts). A draft's lease on a path that only a
//   release's page reaches (files, links) is refused, never taken for no
//   lease (`leasedBuild`).
// - A page of one App calling another. The App is named by the path
//   alone, and the lease is signed over it: another App's lease is no
//   lease here, so the call is code core didn't serve, refused unless the
//   App's data is `ordinary` (page-delivery.ts), and then only as the
//   person, with their own role in this App. A visitor's session opens
//   its own App and no other.
// - Forged release, draft or store. Each is in the lease, under a MAC
//   only core can make, over the person, the App, the build and the
//   target; anything else is no lease. A draft's chat is looked up in the
//   person's own Workspace object, which knows no one else's.
// - Another person's lease, or session. A lease is signed for one person
//   (or one visitor's session), and checked against who calls now; the
//   page names the person its frame is for, and a call whose session is
//   anyone else's is refused before it is counted or read
//   (`personRefusal`), so nothing the frame sends again runs as them. A
//   visitor's token is a header, never a cookie, so no other site's
//   request carries it; another site can't call as a member either: only
//   the deployment's own pages (`Origin`), and only with a JSON body,
//   which no form sends without a preflight core never answers.
// - Skipping the rate limits. Every call is counted before its body is
//   read: a member's against their requests of the App's pages, whether
//   on the release or a draft (`admitted`); a visitor's against theirs and
//   the App's visitors' together. A paginated list's window counts one
//   more for each page past its first (`admitWindow`), and every page past
//   what it paid for is charged as it is read (`windowCharger`).
// - A request or an answer too large: the body is read no further than
//   `functionRequestMaxBytes`, whatever `content-length` says; an answer
//   larger than a frame takes is refused (`page.answer_too_large`).
// - Someone who lost their role, a build whose release was revoked. The
//   session and role are read on every call, by the call itself; a
//   release's build is checked before the call and again before its
//   answer (`delivering`), and a draft's builder before every step.
//
// A streaming action (spec 10.7.6) goes through the same admission, at
// `<path>/<app>/<stream | attach | cancel>`, and runs in an object of its
// own (action-invocation.ts), which keeps its latest progress and its
// receipt. Its frames outlive the request that started them, so:
// - Progress reaches someone who lost access, or code whose release was
//   revoked: the relay checks again, at most every `streamRecheckMs`
//   before progress and always before the result, that the session is
//   still the person's, their role in the App and the build's delivery;
//   checked on a timer, frames or not, so a silent action is checked too;
//   a refusal ends the relay with it and cancels the invocation at once.
// - Access narrowed since the stream started reaches what it computed:
//   the relay refuses once the person's role or teams differ from those
//   it started under (`operation.access_changed`), and so does the
//   invocation on an attach or a join.
// - Another person reaches the stream: the invocation is named by the
//   person signed in, never by anything in the request.
//
// A plain action sent under a key runs in the same object, without
// progress (`streaming: false`), so a lost answer is recovered by its key:
// the resend joins the run under way or answers its receipt, never runs it
// again. A visitor's page has no streams, and no actions at all.

/** How long a page waits for a function's answer. */
const pageCallMs = 30_000;

/** The App ID after `base` in `pathname`, if it is one of base's paths. */
const appAfter = (pathname: string, base: string): string | undefined => {
  const prefix = `${base}/`;
  if (!pathname.startsWith(prefix)) {
    return undefined;
  }
  const app = pathname.slice(prefix.length);
  return app.length > 0 && !app.includes("/") ? app : undefined;
};

const streamActions: ReadonlySet<string> = new Set(streamCallActions);

const isStreamAction = (value: string): value is StreamCallAction =>
  streamActions.has(value);

/** The App ID and what to do, if `pathname` is a streaming action's call. */
const functionStreamCall = (
  pathname: string
): { app: string; action: StreamCallAction } | undefined => {
  const prefix = `${appFunctionPath}/`;
  if (!pathname.startsWith(prefix)) {
    return undefined;
  }
  const [app, action, ...rest] = pathname.slice(prefix.length).split("/");
  if (
    app === undefined ||
    app.length === 0 ||
    action === undefined ||
    rest.length > 0 ||
    !isStreamAction(action)
  ) {
    return undefined;
  }
  return { app, action };
};

/** The status a refusal before the call answers with. */
export const statusOf = (code: string): number => {
  if (code === "page.rate_limited") {
    return 429;
  }
  if (code === "request.timeout") {
    return 408;
  }
  if (code.startsWith("auth.")) {
    return 401;
  }
  return visitorStatusFor[code] ?? 403;
};

/** `answer`, unless it is more than a frame takes in one call. */
const withinFrame = (answer: FunctionAnswer): FunctionAnswer => {
  if (jsonBytes(answer, pageLimits.answerBytes) > pageLimits.answerBytes) {
    throw pageErrors.create("page.answer_too_large");
  }
  return answer;
};

/** Whether `request` says its body is JSON. */
const isJson = (request: Request): boolean =>
  request.headers.get("content-type")?.split(";")[0]?.trim() ===
  "application/json";

/**
 * A refusal as its error response, or an unexpected failure, logged as
 * `event`, as `internal.unexpected`.
 */
const refusalResponse = (
  error: unknown,
  requestId: string,
  event: string
): Response => {
  if (isExpectedError(error)) {
    return errorResponse(statusOf(error.code), error, requestId);
  }
  log.error(event, { requestId, ...errorFields(error) });
  return errorResponse(
    500,
    internalErrors.create("internal.unexpected"),
    requestId
  );
};

/** How much of a path's App ID a log line keeps: the path is the caller's. */
const loggedAppMaxLength = 128;

/**
 * The body of `request`, read no further than a call may be, whatever
 * its `content-length` says: `request.too_large` past it.
 */
const boundedBody = async (request: Request): Promise<string> => {
  // SAFETY: a request's body in workerd is a byte stream, of Uint8Array
  // chunks; its type says `any` only for streams in general.
  const stream = request.body as ReadableStream<Uint8Array> | null;
  const length = Number(request.headers.get("content-length") ?? 0);
  const body =
    stream === null || length > functionRequestMaxBytes
      ? undefined
      : await readAtMost(stream, functionRequestMaxBytes);
  if (body === undefined) {
    throw requestErrors.create("request.too_large");
  }
  return new TextDecoder().decode(body);
};

/** A member's call core admitted: who, which App, its body, what it runs on. */
interface AdmittedCall {
  readonly person: Identity;
  readonly id: AppId;
  readonly body: string;
  /** The lease core signed for the frame, if it signed one for them. */
  readonly lease: PageLease | undefined;
  /** Who calls now, read again: the session still theirs. */
  readonly current: () => Promise<Identity | undefined>;
}

/**
 * What every member's call passes before anything reads its body (see
 * the header): a session, the person the page names, the person's rate,
 * then the body bounded and the lease read. A refusal as the response to
 * answer; one that is thrown is the caller's to answer.
 */
const admitMember = async (
  request: Request,
  env: Env,
  app: string,
  requestId: string,
  operation: "app.functions" | "app.functions.stream"
): Promise<AdmittedCall | Response> => {
  // A staff member's ask is in the client's audit log, refused or
  // not (staff-audit.ts).
  const person = await routeMember(
    env,
    await identify(env, request.headers),
    operation,
    { app }
  );
  if (person === undefined) {
    return errorResponse(
      401,
      authErrors.create("auth.unauthenticated"),
      requestId
    );
  }
  const refusal = personRefusal(request.headers, person.userId);
  if (refusal !== undefined) {
    // Who was named and who is signed in stay out of the log: only why,
    // and for which App.
    log.info("app_function.person_refused", {
      requestId,
      app: app.slice(0, loggedAppMaxLength),
      reason: refusal.code,
    });
    return errorResponse(statusOf(refusal.code), refusal, requestId);
  }
  const id = await admitted(env, person, app);
  const body = await boundedBody(request);
  return {
    person,
    id,
    body,
    lease: await readLease(
      env,
      person.userId,
      id,
      request.headers.get(pageLeaseHeader)
    ),
    current: async () => await identifyFull(env, request.headers),
  };
};

/** One frame's line as the relay reads it: its type, if it is JSON at all. */
const frameOf = (line: string): { type?: unknown; result?: unknown } => {
  try {
    const frame: unknown = JSON.parse(line);
    return isRecord(frame) ? frame : {};
  } catch {
    return {};
  }
};

/** The call and its key, if `body` is an action sent under a valid key. */
const keyedAction = (
  body: string
): { call: FunctionRequest; key: string } | undefined => {
  let call: FunctionRequest;
  try {
    call = readFunctionRequest(body);
  } catch {
    // The call refuses it, as it refuses any request it can't read.
    return undefined;
  }
  const key = idempotencyKeySchema.safeParse(call.idempotencyKey);
  // One with a window is a query's or nothing: the plain call refuses it
  // before anything runs.
  return call.reference.kind === "action" &&
    key.success &&
    call.window === undefined
    ? { call, key: key.data }
    : undefined;
};

/** The release's build a lease names, if it names one: a draft's has none. */
const buildOf = (lease: PageLease | undefined) =>
  lease?.kind === "release" ? lease.build : undefined;

/**
 * The draft a call's lease names, if it names one: its chat, and its
 * preview's seed now, which a draft action's invocation is named by, so
 * one kept from before its data was dropped is never found again. Refused
 * once the chat is gone (`agent.chat_not_found`).
 */
const draftOf = async (
  env: Env,
  { person, id, lease }: AdmittedCall
): Promise<{ chatId: ChatId; seed: string } | undefined> => {
  if (lease?.kind !== "draft") {
    return undefined;
  }
  const seed = await workspace(
    env,
    personalWorkspaceId(person.userId)
  ).previewSeed(lease.chatId, person.userId, id);
  return { chatId: lease.chatId, seed };
};

/**
 * Refuses, as a call is refused, unless what `call` runs on gets the
 * App's data now: a release's build (`requireDelivery`); a draft reaches
 * none of the App's data, and its builder is checked by its run.
 */
const requireRuns = async (
  env: Env,
  person: Identity,
  { id, lease }: Pick<AdmittedCall, "id" | "lease">,
  operation: "call" | "stream",
  stage: "admission" | "delivery" | "push"
): Promise<void> => {
  if (lease?.kind === "draft") {
    return;
  }
  await requireDelivery(env, person, id, buildOf(lease), { operation, stage });
};

/**
 * The release versions an invocation's answer comes from: the App's
 * current one, which answers every page's call, and the one it runs, or
 * ran, under (`ActionInvocation.version`), which a join, an attach or a
 * receipt may have from before a publish. None for a draft's.
 */
const releasesOf = async (
  env: Env,
  invocation: ReturnType<typeof actionInvocation>,
  { person, id, lease }: AdmittedCall
): Promise<readonly number[]> => {
  if (lease?.kind === "draft") {
    return [];
  }
  const running = await invocation.version(person.userId);
  return [
    ...new Set([
      await currentVersionOf(env, id),
      ...(running === undefined ? [] : [running]),
    ]),
  ];
};

/**
 * Whether the caller of `call` is still who they were, with the access
 * `access` fingerprints (organization role, teams and role in the App,
 * `accessOf`), what it runs on still gets the App's data, and no release
 * it runs under (`versions`) was revoked: throws the refusal otherwise.
 * The build's delivery reads the App's current release only, which a
 * publish moves on from the one an invocation ran.
 */
const stillTheirs = async (
  env: Env,
  call: AdmittedCall,
  { access, versions }: { access: string; versions: readonly number[] },
  operation: "call" | "stream",
  stage: "push" | "delivery"
): Promise<void> => {
  const now = await call.current();
  if (now?.userId !== call.person.userId) {
    throw authErrors.create("auth.unauthenticated");
  }
  // Refuses, too, someone with no role in the App any more.
  if ((await accessOf(env, now, call.id)) !== access) {
    throw operationErrors.create("operation.access_changed");
  }
  await requireRuns(env, now, call, operation, stage);
  for (const version of versions) {
    // oxlint-disable-next-line no-await-in-loop -- one or two, in turn
    await requireNotRevoked(env, call.id, version);
  }
};

/**
 * `refusal`, of an action's answer after it ran, as the outcome it
 * withholds: `submission.outcome_unknown`, uncertain, with the key that
 * recovers it once the person may have it again and the refusal's code.
 */
const withheld = (
  refusal: { readonly code: string },
  key: string
): AppErrorPayload => ({
  code: "submission.outcome_unknown",
  message:
    "Whether this finished is unknown: its answer was withheld. Sending it again with the same idempotency key gets its outcome, and never runs it a second time.",
  category: "uncertain",
  retryable: false,
  requestId: crypto.randomUUID(),
  details: { idempotencyKey: key, refusal: refusal.code },
});

/** What a keyed action answers: what it ran, as far as its invocation keeps. */
interface KeyedAnswer {
  readonly result: unknown;
  readonly provenance: null;
  readonly manifestHash: null;
}

/**
 * The answer to the plain action `call`, under `key`, for `admittedCall`:
 * from the invocation its key names (action-invocation.ts), which starts
 * it, joins it or answers its receipt, read to its result, on the release
 * or the draft its lease names. Its result comes from core's own object,
 * so it is handed on as it is.
 */
const keyedAnswer = async (
  env: Env,
  admittedCall: AdmittedCall,
  { call, key }: { call: FunctionRequest; key: string }
): Promise<KeyedAnswer> => {
  const { person, id } = admittedCall;
  // Nothing ran yet: a build refused is refused as any call is.
  await requireRuns(env, person, admittedCall, "call", "admission");
  const draft = await draftOf(env, admittedCall);
  const name = await invocationName(person.userId, id, call, key, {
    streaming: false,
    ...(draft === undefined ? {} : { draft }),
  });
  const access = await accessOf(env, person, id);
  const invocation = actionInvocation(env, name);
  const frames = await invocation.open({
    by: { userId: person.userId, role: person.role, teams: person.teams },
    access,
    app: id,
    ...(draft === undefined ? {} : { draft: draft.chatId }),
    name,
    call,
    streaming: false,
    attach: false,
    // A page's form, told to the App's webhooks once the run succeeds,
    // named as its own release resolves it (action-invocation.ts).
    form: { key },
  });
  const text = await new Response(frames).text();
  const frame = text
    .split("\n")
    .map((line) => frameOf(line))
    .find(({ type }) => type === "result");
  if (frame === undefined) {
    throw new Error("The invocation ended without a result.");
  }
  const versions = await releasesOf(env, invocation, admittedCall);
  const answer: KeyedAnswer = {
    result: frame.result,
    provenance: null,
    manifestHash: null,
  };
  // Checked again before the answer is handed over, as a stream's relay
  // checks before its result: someone signed out, whose access changed,
  // or whose build's or answer's release was revoked while it ran gets
  // nothing of it. The run settles on its own receipt whatever happens
  // here, and may have changed something: the refusal is no answer to
  // what it did, so it goes back as an outcome withheld, with its key,
  // never as a failure that invites a resubmit under a fresh one.
  try {
    await stillTheirs(
      env,
      admittedCall,
      { access, versions },
      "call",
      "delivery"
    );
  } catch (error) {
    if (!isExpectedError(error)) {
      throw error;
    }
    return { ...answer, result: { ok: false, error: withheld(error, key) } };
  }
  if (jsonBytes(answer, pageLimits.answerBytes) <= pageLimits.answerBytes) {
    return answer;
  }
  // The action ran, and its receipt holds an answer larger than a page
  // takes: what it did is unknown to the page, not refused.
  const refusal = refusalOf(
    pageErrors.create("page.answer_too_large"),
    crypto.randomUUID()
  );
  return {
    ...answer,
    result: {
      ok: false,
      error: {
        ...refusal,
        category: "uncertain",
        details: { idempotencyKey: key },
      },
    },
  };
};

/**
 * A member's call of `app`'s functions, admitted (see the header): an
 * action under a key through its invocation; any other call on what the
 * lease names, the App's current release inside its build's delivery or
 * the builder's draft. Answers the call's `FunctionAnswer`, whatever its
 * result.
 */
const memberCall = async (
  env: Env,
  admittedCall: AdmittedCall
): Promise<unknown> => {
  const { person, id, body, lease } = admittedCall;
  // A window counts as the pages it reads (query-windows.ts).
  await admitWindow(env, person, id, body);
  const keyed = keyedAction(body);
  if (keyed !== undefined) {
    // Checks delivery itself, before the run and again before its answer.
    return await keyedAnswer(env, admittedCall, keyed);
  }
  const deadline = Date.now() + pageCallMs;
  const chargeWindow = windowCharger(env, person, id);
  if (lease?.kind === "draft") {
    return withinFrame(
      await callDraftOn(env, person, { app: id, chatId: lease.chatId }, body, {
        deadline,
        chargeWindow,
      })
    );
  }
  return await delivering(env, person, id, buildOf(lease), "call", async () =>
    withinFrame(
      await callPageFunction(env, person, id, body, deadline, chargeWindow, {
        // A page's keyed mutation commits its form with its writes.
        tellsForm: true,
      })
    )
  );
};

/**
 * `POST /api/app-functions/<app>`: calls a function of the App for whoever
 * the page is for, as their page running what its lease names (see the
 * header): a visitor by their session's token, otherwise the member signed
 * in. Answers the call's `FunctionAnswer`, whatever its result; a refusal
 * before the call as an error response.
 */
const appFunctionResponse = async (
  request: Request,
  env: Env,
  app: string,
  requestId: string
): Promise<Response> => {
  try {
    const token = request.headers.get(pageVisitorHeader);
    if (token !== null) {
      return Response.json(
        await visitorCall(env, {
          token,
          app,
          lease: request.headers.get(pageLeaseHeader),
          read: async () => await boundedBody(request),
        })
      );
    }
    const admittedCall = await admitMember(
      request,
      env,
      app,
      requestId,
      "app.functions"
    );
    if (admittedCall instanceof Response) {
      return admittedCall;
    }
    return Response.json(await memberCall(env, admittedCall));
  } catch (error) {
    if (requestErrors.codeOf(error) === "request.too_large") {
      return errorResponse(
        413,
        requestErrors.create("request.too_large"),
        requestId
      );
    }
    return refusalResponse(error, requestId, "app_function.failed");
  }
};

/**
 * How often a stream's relay checks again that its person is signed in,
 * with the role and teams the stream started under, and that the
 * page's build still gets the App's data: on a timer, whether frames
 * come or not, and before the result whatever the time.
 */
const streamRecheckMs = 5000;

/** What the relay of one stream needs besides its frames. */
interface RelayOf {
  readonly env: Env;
  readonly call: AdmittedCall;
  /** The access the request was admitted under (`accessOf`). */
  readonly access: string;
  /** The release versions the stream runs under, the caller's among them. */
  readonly versions: readonly number[];
  readonly requestId: string;
  /** Cancels the invocation: the person or the build lost access. */
  readonly cancel: () => Promise<unknown>;
}

/**
 * The invocation's frames as the page gets them (see the header): each
 * line passed on as it is read, the result only after a check of its own
 * and within what a page takes in one answer, and the person and the
 * build checked again every `streamRecheckMs` meanwhile, frames or not.
 * A refusal ends the relay with a `refused` line carrying it, and cancels
 * the invocation at once.
 */
const relay = (
  frames: ReadableStream<Uint8Array>,
  { env, call, access, versions, requestId, cancel }: RelayOf
): ReadableStream<Uint8Array> => {
  const reader = frames.pipeThrough(new TextDecoderStream()).getReader();
  const encoder = new TextEncoder();
  let buffered = "";
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const still = async (stage: "push" | "delivery"): Promise<void> => {
    await stillTheirs(env, call, { access, versions }, "stream", stage);
  };
  const finish = async (): Promise<void> => {
    done = true;
    clearTimeout(timer);
    try {
      await reader.cancel();
    } catch {
      // Closed already.
    }
  };
  const nextLine = async (): Promise<string | undefined> => {
    for (;;) {
      const end = buffered.indexOf("\n");
      if (end !== -1) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        return line;
      }
      // oxlint-disable-next-line no-await-in-loop -- one chunk after another
      const { done: ended, value } = await reader.read();
      if (ended) {
        return undefined;
      }
      buffered += value;
    }
  };
  let refuse: ((error: unknown) => Promise<void>) | undefined;
  return new ReadableStream(
    {
      start: (controller) => {
        refuse = async (error) => {
          if (done) {
            return;
          }
          const refusal = refusalOf(error, requestId);
          try {
            controller.enqueue(
              encoder.encode(
                `${JSON.stringify({ type: "refused", error: refusal })}\n`
              )
            );
            controller.close();
          } catch {
            // The page dropped the stream already: nobody reads the
            // refusal, but the invocation is cancelled all the same.
          }
          await finish();
          try {
            await cancel();
          } catch (cancelError) {
            log.warn("app_function.stream_cancel_failed", {
              requestId,
              ...errorFields(cancelError),
            });
          }
        };
        // Runs on a timer nobody awaits: it never throws.
        const check = async (): Promise<void> => {
          try {
            await still("push");
          } catch (error) {
            try {
              await refuse?.(error);
            } catch (refuseError) {
              log.warn("app_function.stream_refuse_failed", {
                requestId,
                ...errorFields(refuseError),
              });
            }
            return;
          }
          if (!done) {
            timer = setTimeout(() => {
              void check();
            }, streamRecheckMs);
          }
        };
        timer = setTimeout(() => {
          void check();
        }, streamRecheckMs);
      },
      pull: async (controller) => {
        const line = await nextLine();
        if (done) {
          return;
        }
        if (line === undefined) {
          controller.close();
          await finish();
          return;
        }
        const frame = frameOf(line);
        if (frame.type !== "result") {
          controller.enqueue(encoder.encode(`${line}\n`));
          return;
        }
        try {
          await still("delivery");
        } catch (error) {
          await refuse?.(error);
          return;
        }
        // As a plain call's answer: no more than a page takes in one.
        const fits =
          jsonBytes(frame.result, pageLimits.answerBytes) <=
          pageLimits.answerBytes;
        const out = fits
          ? line
          : JSON.stringify({
              type: "result",
              seq: 1,
              result: {
                ok: false,
                error: refusalOf(
                  pageErrors.create("page.answer_too_large"),
                  requestId
                ),
              },
            });
        controller.enqueue(encoder.encode(`${out}\n`));
        controller.close();
        await finish();
      },
      cancel: async () => {
        await finish();
      },
    },
    { highWaterMark: 0 }
  );
};

/** The call a stream request carries, with the key it must have. */
const streamRequestOf = (
  body: string
): { call: FunctionRequest; key: string } => {
  const call = readFunctionRequest(body);
  const key = idempotencyKeySchema.safeParse(call.idempotencyKey);
  if (!key.success || call.reference.kind !== "action") {
    throw operationErrors.create("contract.invalid_request");
  }
  return { call, key: key.data };
};

/**
 * `POST /api/app-functions/<app>/<stream | attach | cancel>`: one of the
 * App's streaming actions (spec 10.7.6), for the member signed in, as
 * their page running what its lease names, each admitted as a start is,
 * against the person's role now. `stream` starts the invocation its key
 * names (or joins it, with the same input) and `attach` reads it again
 * without ever starting it, each answering its frames as JSON lines
 * (action-invocation.ts), relayed only while the person and the build
 * still get the App's data; `cancel` asks it to stop, answering
 * `{ requested }`: whether it was still running, never what stopping did,
 * which its result says. A visitor has no streams.
 */
const appStreamResponse = async (
  request: Request,
  env: Env,
  app: string,
  action: StreamCallAction,
  requestId: string
): Promise<Response> => {
  try {
    if (request.headers.has(pageVisitorHeader)) {
      throw operationErrors.create("contract.invalid_request");
    }
    const admittedCall = await admitMember(
      request,
      env,
      app,
      requestId,
      "app.functions.stream"
    );
    if (admittedCall instanceof Response) {
      return admittedCall;
    }
    const { person, id, body } = admittedCall;
    await requireRuns(env, person, admittedCall, "stream", "admission");
    const { call, key } = streamRequestOf(body);
    const draft = await draftOf(env, admittedCall);
    const name = await invocationName(person.userId, id, call, key, {
      streaming: true,
      ...(draft === undefined ? {} : { draft }),
    });
    const invocation = actionInvocation(env, name);
    if (action === "cancel") {
      return Response.json({
        requested: await invocation.cancel(person.userId),
      });
    }
    // Admitted as a start is, against the person's access now, which the
    // invocation compares with the access it started under.
    const access = await accessOf(env, person, id);
    const frames = await invocation.open({
      by: { userId: person.userId, role: person.role, teams: person.teams },
      access,
      app: id,
      ...(draft === undefined ? {} : { draft: draft.chatId }),
      name,
      call,
      streaming: true,
      attach: action === "attach",
      // A start's form, told to the App's webhooks once its run succeeds,
      // named as its own release resolves it (action-invocation.ts).
      ...(action === "stream" ? { form: { key } } : {}),
    });
    // The release it runs under, besides the caller's: a join or an attach
    // may follow a run a release published since started.
    const versions = await releasesOf(env, invocation, admittedCall);
    return new Response(
      relay(frames, {
        env,
        call: admittedCall,
        access,
        versions,
        requestId,
        cancel: async () => await invocation.cancel(person.userId),
      }),
      {
        headers: {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-store",
        },
      }
    );
  } catch (error) {
    if (requestErrors.codeOf(error) === "request.too_large") {
      return errorResponse(
        413,
        requestErrors.create("request.too_large"),
        requestId
      );
    }
    return refusalResponse(error, requestId, "app_function.stream_failed");
  }
};

/**
 * The response to `request` when `pathname` is a page's call of one of
 * its App's functions: a call (`<path>/<app>`) or one of a streaming
 * action's (`<path>/<app>/<stream | attach | cancel>`); undefined for any
 * other path. Only a POST from the deployment's own pages, with a JSON
 * body, is taken (see the header).
 */
export const pageCallRoute = async (
  request: Request,
  env: Env,
  pathname: string,
  requestId: string
): Promise<Response | undefined> => {
  const app = appAfter(pathname, appFunctionPath);
  const stream = app === undefined ? functionStreamCall(pathname) : undefined;
  if (app === undefined && stream === undefined) {
    return undefined;
  }
  if (request.method !== "POST") {
    return errorResponse(
      404,
      requestErrors.create("request.not_found"),
      requestId
    );
  }
  if (!(isOwnOrigin(request, env) && isJson(request))) {
    return errorResponse(
      403,
      requestErrors.create("request.forbidden"),
      requestId
    );
  }
  if (app !== undefined) {
    return await appFunctionResponse(request, env, app, requestId);
  }
  return stream === undefined
    ? undefined
    : await appStreamResponse(
        request,
        env,
        stream.app,
        stream.action,
        requestId
      );
};
