import { sha256Hex } from "@grasp-os/shared/encoding";
import { eventSourcePath } from "@grasp-os/shared/event-source-path";
import {
  eventSourceErrors,
  eventSourceHeaders,
  eventSourceLimits,
  eventSourceTestSchema,
  sourceEventSchema,
} from "@grasp-os/shared/event-sources";
import type {
  EventSourceRefusalReason,
  EventSourceTestResult,
} from "@grasp-os/shared/event-sources";
import { readAtMost } from "@grasp-os/shared/http";
import type { Json } from "@grasp-os/shared/json";
import { log } from "@grasp-os/shared/log";
import { coreStartKeyPrefix } from "@grasp-os/shared/workflow-resources";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import type { Acting } from "../auth/identity.ts";
import { eventSources, triggerResources } from "../db/core/schema.ts";
import { errorResponse } from "../errors.ts";
import {
  liveSource,
  requireSourceAdmin,
  sourceSecretKeyOf,
  sourceUnavailable,
} from "../event-sources.ts";
import { triggersOnSource } from "../trigger-resources.ts";
import { startOnce } from "./connector-triggers.ts";
import type { Outcome, Taker } from "./connector-triggers.ts";
import { routeSourceEvent } from "./event-waits.ts";
import type { SourceEvent } from "./event-waits.ts";
import {
  countRefusal,
  recordDelivery,
  recordTest,
} from "./source-deliveries.ts";

// Events from outside (GRA-1560): an event source (event-sources.ts) takes
// POSTs at `/api/hooks/<token>`, each a delivery Standard Webhooks signs
// (standardwebhooks.com), and turns each into a typed event: the body's
// `type` and its `data`, as Standard Webhooks shapes a payload. Webhook
// triggers on that source and type start their workflows with the data as
// input (trigger-resources.ts); runs waiting on a match its data has take
// it, or it is kept for a wait reached later (event-waits.ts, whose threat
// model covers that part). App code never handles the request: a
// workflow started or woken here calls an App's mutation through its
// binding.
// Threat model, written before the code, and how each is closed:
//
// - A forged or spoofed sender. The URL's token (128 random bits of the
//   source's own, never its ID, shown to admins alone and left out of the
//   request log, `withoutSourceToken`) is not the credential: every
//   delivery must be signed as Standard Webhooks says, the
//   `webhook-signature` `v1,` and the base64 HMAC-SHA256 of
//   `<id>.<timestamp>.<body>` with the source's secret, checked in
//   constant time (`crypto.subtle.verify`) before the body is parsed. The
//   event's type, data and ID come only from what was signed: nothing in
//   the request but the signed ID, timestamp and body is read. A provider
//   with a signing scheme of its own (Stripe, GitHub, Shopify) comes in
//   through a connector in connect, never a check written here.
// - A delivery replayed or retried. A sender's retry is signed afresh but
//   keeps its `webhook-id`; the event's key is the source and that ID
//   (`same`), and each trigger's start is keyed by the trigger and the
//   event (`startOnce`, a start receipt), so a retry is the same start,
//   its run the same run. The ID is signed, so it can't be swapped for
//   another to start a second run. A captured delivery replayed later than
//   five minutes from its timestamp is refused
//   (`eventSourceLimits.toleranceSeconds`); within them it is the same
//   event. A delivery cut off mid-way (its body never complete, core
//   restarted under it) started nothing it won't start again under the
//   same ID: each start is admitted once, in one statement.
// - The secret rotated, revoked or the source deleted mid-delivery. Each
//   start's admission requires the source to be live with the secret
//   generation the delivery was checked with, unrevoked (`also`, read in
//   the statement that admits it): one that changed meanwhile starts
//   nothing and is answered 401, settling nothing, so the sender's retry
//   signed with the new secret starts it. A deleted source's token is
//   cleared, so its URL takes nothing at once.
// - Learning which tokens exist. A token no live source has (never made,
//   or its source deleted) is answered as a revoked secret is, 401, with
//   the same body: a response never tells a guessed URL from a real one.
// - An event reaching a workflow nobody approved. Only live, enabled
//   webhook triggers that name this source and type
//   take it, each start needing `start` on its workflow, a grant of its
//   own only an admin gives, which names the source and type it starts on;
//   each start reads the trigger, its grant and its person live as it is
//   admitted (workflow-starts.ts). A grant revoked meanwhile starts
//   nothing, audited.
// - A payload too large, malformed or of the wrong shape. The body is read
//   as it arrives and never past `eventSourceLimits.bodyBytes` (413); it
//   must be one JSON object with a `type` (an event type) and `data` (400).
//   Each trigger's input is the data as is, checked against the pinned
//   workflow version's input schema as any start's input is, and nothing
//   in it is evaluated; one refused is refused for good, audited
//   (`workflow.webhook.refused`).
// - Floods. Before core reads a byte, the router counts every request to
//   a source's URL per client address (`WEBHOOK_RATE_LIMIT`) and per URL
//   (`WEBHOOK_SOURCE_RATE_LIMIT`, larger: one source takes all its
//   sender's events), apps/router, and answers 429 past either. A trigger starts at most
//   `triggeredRunsPerHour` runs an hour, counted as each is admitted
//   (`startOnce`); past it the sender is told to try again later (503,
//   `retry-after`), holding nothing back: its retry under the same
//   `webhook-id` starts only what didn't start. An unsigned request costs
//   a lookup by a unique index, an HMAC and, when its URL is a source's,
//   one more in that source's count for the hour, written after the
//   answer (source-deliveries.ts): at most the router's 120 a minute for
//   an address and 3,000 a minute for a URL, each one upsert of a row
//   that is already there. It is logged by reason, never audited, so an
//   unauthenticated sender can't fill the audit log.
// - Privacy. What is kept of a delivery, and for how long, is
//   source-deliveries.ts's, with its own threat model. Kept: a delivery
//   answered 202, once by its `webhook-id`, with its time, type, how many
//   triggers it started and its data, the data for a day and the rest for
//   seven. Counted, by its source, the reason and the hour, and only when
//   its URL is a live source's: a delivery answered 401 (its secret
//   revoked; its signing headers missing, malformed or stale; its
//   signature wrong; its secret changed as it was admitted), 413 (too
//   large), 400 (signed, but not an event), 409 (its `webhook-id` came
//   before with another event) or 503 (told to try again). Neither kept
//   nor counted: a request to a URL no live source has, and one that
//   isn't a POST. Of a delivery that is only counted, no body, header,
//   signature or sender's address is kept anywhere. Beyond that its data
//   becomes the input of the runs it starts, kept and erased as any run's
//   is, and the audit log names a delivery only by the hash of its
//   `webhook-id`, never its body.

/** A token of a source's URL: 128 random bits, in hex. */
const tokenPattern = /^[0-9a-f]{32}$/u;

/** The token a path names, if it is a source's URL. */
export const eventSourceTokenAt = (pathname: string): string | undefined => {
  const prefix = `${eventSourcePath}/`;
  if (!pathname.startsWith(prefix)) {
    return undefined;
  }
  return pathname.slice(prefix.length);
};

/**
 * `pathname` as the request log keeps it: a source's token left out,
 * whatever follows the path.
 */
export const withoutSourceToken = (pathname: string): string =>
  eventSourceTokenAt(pathname) === undefined
    ? pathname
    : `${eventSourcePath}/-`;

/** One signature of `webhook-signature`: `v1,` and a 32-byte MAC in base64. */
const signaturePattern = /^v1,(?<mac>[A-Za-z0-9+/]{43}=)$/u;

/** A timestamp as sent: Unix seconds. */
const timestampPattern = /^\d{1,12}$/u;

/** A `webhook-id`: 1 to 256 printable ASCII characters, no spaces. */
const deliveryIdPattern = /^[!-~]{1,256}$/u;

/** The most signatures one `webhook-signature` header lists. */
const maxSignatures = 8;

/** Base64 `text` as bytes. */
const bytesOfBase64 = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(text), (char) => char.codePointAt(0) ?? 0);

/** A source as a delivery reads it: its secret's generation and state. */
interface Source {
  id: string;
  generation: number;
  revokedAt: Date | null;
}

/** The live source at `token`. */
const sourceAt = async (env: Env, token: string): Promise<Source | undefined> =>
  await drizzle(env.DB)
    .select({
      id: eventSources.id,
      generation: eventSources.secretGeneration,
      revokedAt: eventSources.secretRevokedAt,
    })
    .from(eventSources)
    .where(and(eq(eventSources.token, token), isNull(eventSources.deletedAt)))
    .get();

/** What a delivery is signed over, as its headers say. */
interface Signed {
  id: string;
  timestamp: string;
  signatures: string;
}

/**
 * Whether one of `signed.signatures` (space-separated, as Standard
 * Webhooks lists them, a key rotating on the sender's side) is `v1,` and
 * the HMAC-SHA256 of `<id>.<timestamp>.<body>` with `key`, each checked in
 * constant time. Signatures of any other version are passed over.
 */
const signedWith = async (
  key: Uint8Array<ArrayBuffer>,
  { id, timestamp, signatures }: Signed,
  body: Uint8Array<ArrayBuffer>
): Promise<boolean> => {
  const macs = signatures
    .split(" ")
    .slice(0, maxSignatures)
    .flatMap((each) => {
      const mac = signaturePattern.exec(each)?.groups?.mac;
      return mac === undefined ? [] : [bytesOfBase64(mac)];
    });
  if (macs.length === 0) {
    return false;
  }
  const hmac = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const prefix = new TextEncoder().encode(`${id}.${timestamp}.`);
  const content = new Uint8Array(prefix.byteLength + body.byteLength);
  content.set(prefix);
  content.set(body, prefix.byteLength);
  const verified = await Promise.all(
    macs.map(
      async (mac) => await crypto.subtle.verify("HMAC", hmac, mac, content)
    )
  );
  return verified.includes(true);
};

/** Whether `timestamp` (Unix seconds, as sent) is within the window of now. */
const isRecent = (timestamp: string | null): timestamp is string =>
  timestamp !== null &&
  timestampPattern.test(timestamp) &&
  Math.abs(Date.now() / 1000 - Number(timestamp)) <=
    eventSourceLimits.toleranceSeconds;

/** The headers a delivery is signed by, if they are all there and well formed. */
const signedOf = (headers: Headers): Signed | undefined => {
  const id = headers.get(eventSourceHeaders.id);
  const timestamp = headers.get(eventSourceHeaders.timestamp);
  const signatures = headers.get(eventSourceHeaders.signature);
  return id !== null &&
    deliveryIdPattern.test(id) &&
    isRecent(timestamp) &&
    signatures !== null
    ? { id, timestamp, signatures }
    : undefined;
};

/** What answering a delivery takes: where its record is written after. */
interface Answering {
  env: Env;
  /** What goes on after the answer: a count, a delivery kept. */
  ctx: Pick<ExecutionContext, "waitUntil">;
  requestId: string;
}

/**
 * Refuses a delivery with `status` and `code`, counted by `reason` for
 * `source`, the live source its URL is, if it is one's
 * (source-deliveries.ts): after the answer, so a URL that is a source's
 * answers no slower than one that isn't. Nothing of the delivery itself
 * is kept.
 */
const refusal = (
  to: Answering,
  source: string | undefined,
  reason: EventSourceRefusalReason | "unknown",
  status: number,
  code: Parameters<typeof eventSourceErrors.create>[0]
): Response => {
  if (source !== undefined && reason !== "unknown") {
    to.ctx.waitUntil(countRefusal(to.env, source, reason));
  }
  return errorResponse(status, eventSourceErrors.create(code), to.requestId);
};

/** Refuses a delivery as unsigned: logged by reason, never audited, counted. */
const unsigned = (
  to: Answering,
  reason: "unknown" | "revoked" | "headers" | "signature" | "rotated",
  source?: string
): Response => {
  log.warn("workflow.webhook.unsigned", { reason });
  return refusal(to, source, reason, 401, "webhook.signature_invalid");
};

/** The body as an event's type and data, if it is one. */
const eventOf = (
  bytes: Uint8Array
): { type: string; data: Json } | undefined => {
  try {
    const parsed = sourceEventSchema.safeParse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          bytes
        )
      )
    );
    return parsed.success
      ? { type: parsed.data.type, data: parsed.data.data }
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * That source `id` is still live, with its secret at `generation`,
 * unrevoked, as SQL: what each start of a delivery checked with that
 * secret requires as it is admitted.
 */
const stillSignedSql = (id: string, generation: number): SQL =>
  sql`EXISTS (SELECT 1 FROM ${eventSources}
    WHERE ${eventSources.id} = ${id}
      AND ${eventSources.secretGeneration} = ${generation}
      AND ${eventSources.secretRevokedAt} IS NULL
      AND ${eventSources.deletedAt} IS NULL)`;

/** The live, enabled webhook triggers that take `event`. */
const takersOf = async (
  env: Env,
  event: Pick<SourceEvent, "source" | "type">
): Promise<Taker[]> =>
  await drizzle(env.DB)
    .select({
      id: triggerResources.id,
      workflowId: triggerResources.workflowResourceId,
      inputMapping: triggerResources.inputMapping,
    })
    .from(triggerResources)
    .where(
      and(
        eq(triggerResources.kind, "webhook"),
        eq(triggerResources.enabled, true),
        isNull(triggerResources.deletedAt),
        eq(triggerResources.eventSourceId, event.source),
        eq(triggerResources.eventType, event.type)
      )
    )
    .orderBy(asc(triggerResources.id));

/**
 * Starts the run of each webhook trigger that takes `event`, each admitted
 * only while `also` holds (the secret it was checked with still the
 * source's): what each trigger's turn came to.
 */
export const startSourceTriggers = async (
  env: Env,
  event: SourceEvent,
  also: SQL
): Promise<Outcome[]> => {
  const takers = await takersOf(env, event);
  return await Promise.all(
    takers.map(
      async (taker) =>
        await startOnce(env, taker, {
          same: event.same,
          key: `${coreStartKeyPrefix}webhook:${taker.id}:${event.same}`,
          admission: `webhook:${event.same}:${taker.id}`,
          input: event.data,
          stamped: undefined,
          also,
          noted: { delivery: event.same, source: event.source },
          audited: {
            refused: "workflow.webhook.refused",
            detail: { delivery: event.same, source: event.source },
          },
          logged: { type: "webhook", delivery: event.same },
          answered: true,
        })
    )
  );
};

/** How long a sender is asked to wait before trying again, in seconds. */
const retryAfterSeconds = 60;

/**
 * The answer to signed delivery `event` whose triggers came to `outcomes`
 * and waits to `routed`: told to sign again when the secret changed under
 * it (no trigger started, as each needed the same secret), to try again
 * later when any trigger may start later or a waiting run take it later,
 * accepted otherwise, and then kept for the source's admins to see, after
 * the answer (source-deliveries.ts). A trigger or a run refusing it
 * for good is audited, and the event still accepted: the sender's retry
 * wouldn't change that, and others may have taken it.
 */
const answerOf = (
  to: Answering,
  event: SourceEvent,
  outcomes: readonly (Outcome | "retry" | "stale")[]
): Response => {
  if (outcomes.includes("stale")) {
    return unsigned(to, "rotated", event.source);
  }
  if (outcomes.includes("retry")) {
    const response = refusal(to, event.source, "busy", 503, "webhook.busy");
    response.headers.set("retry-after", String(retryAfterSeconds));
    return response;
  }
  // Kept once by its `webhook-id` (`same`): `started` is also what a
  // trigger that started on an earlier try of it says, so a sender's
  // retry is the delivery already listed, never a second one that seems
  // to have started its workflows again.
  to.ctx.waitUntil(
    recordDelivery(to.env, {
      id: event.same,
      source: event.source,
      type: event.type,
      data: event.data,
      triggers: outcomes.filter((outcome) => outcome === "started").length,
    })
  );
  return Response.json({ accepted: true }, { status: 202 });
};

/**
 * Answers a POST to a source's URL (see the header): 202 once the event
 * was taken (the same `webhook-id` again too), 401 unsigned or for no
 * live source there, alike, 413 or 400 for a body that isn't an event
 * within the limit, 503 to try again later.
 */
export const sourceEventResponse = async (
  request: Request,
  env: Env,
  token: string,
  requestId: string,
  ctx: Pick<ExecutionContext, "waitUntil">
): Promise<Response> => {
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }
  const to: Answering = { env, ctx, requestId };
  const source = tokenPattern.test(token)
    ? await sourceAt(env, token)
    : undefined;
  // No source there answers as a revoked secret: the same status and body.
  if (source === undefined || source.revokedAt !== null) {
    await request.body?.cancel();
    return unsigned(
      to,
      source === undefined ? "unknown" : "revoked",
      source?.id
    );
  }
  const signed = signedOf(request.headers);
  if (signed === undefined) {
    await request.body?.cancel();
    return unsigned(to, "headers", source.id);
  }
  // SAFETY: a request's body in workerd is a byte stream, of Uint8Array
  // chunks; its type says `any` only for streams in general.
  const stream = request.body as ReadableStream<Uint8Array> | null;
  const body =
    stream === null
      ? new Uint8Array()
      : await readAtMost(stream, eventSourceLimits.bodyBytes);
  if (body === undefined) {
    return refusal(to, source.id, "too_large", 413, "webhook.body_invalid");
  }
  const key = await sourceSecretKeyOf(env, source.id, source.generation);
  if (!(await signedWith(key, signed, body))) {
    return unsigned(to, "signature", source.id);
  }
  const event = eventOf(body);
  if (event === undefined) {
    return refusal(to, source.id, "body", 400, "webhook.body_invalid");
  }
  // The same `webhook-id`, however often sent and signed, is the same
  // event: a sender's retries start one run per trigger.
  const same = await sha256Hex(`webhook:${source.id}:${signed.id}`);
  const taken: SourceEvent = { source: source.id, same, ...event };
  const also = stillSignedSql(source.id, source.generation);
  const outcomes = await startSourceTriggers(env, taken, also);
  if (outcomes.includes("stale")) {
    return answerOf(to, taken, outcomes);
  }
  const routed = await routeSourceEvent(env, taken, also);
  if (routed === "conflict") {
    return refusal(to, source.id, "conflict", 409, "webhook.delivery_conflict");
  }
  return answerOf(
    to,
    taken,
    routed === "retry" || routed === "stale" ? [...outcomes, routed] : outcomes
  );
};

/**
 * Sends source `id` the test event `input`, for an admin
 * (`EventSourcesApi.sendTest`): checked as a delivery's body is, its size
 * too, kept marked a test, and answered with the enabled triggers a
 * delivery of it would find (`takersOf`, the same read). It starts no
 * run, reaches no waiting run and is kept for no wait, so nothing outside
 * changes. Audited (source-deliveries.ts).
 */
export const sendTestEvent = async (
  env: Env,
  by: Acting,
  id: unknown,
  input: unknown
): Promise<EventSourceTestResult> => {
  requireSourceAdmin(by);
  const source = await liveSource(env, id);
  if (source === undefined) {
    throw sourceUnavailable();
  }
  const event = eventSourceErrors.parse(
    "webhook.test_invalid",
    eventSourceTestSchema,
    input
  );
  const body = new TextEncoder().encode(JSON.stringify(event));
  if (body.byteLength > eventSourceLimits.bodyBytes) {
    throw eventSourceErrors.create("webhook.test_invalid");
  }
  const [takers, triggers] = await Promise.all([
    takersOf(env, { source: source.id, type: event.type }),
    triggersOnSource(env, source.id),
  ]);
  const taking = new Set(takers.map((taker) => taker.id));
  const matched = triggers.filter((trigger) => taking.has(trigger.id));
  const delivery = await recordTest(
    env,
    by,
    { source: source.id, type: event.type, data: event.data },
    matched.length
  );
  return { delivery, matched };
};
