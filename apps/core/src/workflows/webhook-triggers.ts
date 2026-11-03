import { sha256Hex, toBase64, toHex } from "@grasp-os/shared/encoding";
import { requestErrors } from "@grasp-os/shared/errors";
import { readAtMost } from "@grasp-os/shared/http";
import { log } from "@grasp-os/shared/log";
import { coreStartKeyPrefix } from "@grasp-os/shared/workflow-resources";
import {
  workflowWebhookErrors,
  workflowWebhookHeaders,
  workflowWebhookLimits,
} from "@grasp-os/shared/workflow-triggers";
import { workflowWebhookPath } from "@grasp-os/shared/workflow-webhook-path";
import { and, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import {
  triggerResources,
  triggerResourceVersions,
} from "../db/core/schema.ts";
import { derivedHmacKey } from "../derived-keys.ts";
import { errorResponse } from "../errors.ts";
import { startOnce } from "./connector-triggers.ts";
import type { Outcome, Taker } from "./connector-triggers.ts";

// Starting an independent workflow from a webhook (GRA-1478): a trigger
// of kind `webhook` (trigger-resources.ts) takes POSTs at
// `/api/workflow-webhooks/<token>`, each a run's input. Threat model,
// written before the code, and how each is closed:
//
// - Anyone who learns the URL starting runs. The token is 128 random bits
//   of the trigger's own (never its ID, which builders, admins, staff and
//   the audit log see), shown only to whoever may see the trigger, and
//   left out of the request log (`withoutWebhookToken`). It is not the
//   credential: every delivery must also be signed as the Standard
//   Webhooks specification says (standardwebhooks.com): `webhook-id`,
//   `webhook-timestamp` and `webhook-signature` headers, the signature
//   `v1,` and the base64 HMAC-SHA256 of `<id>.<timestamp>.<body>` with the
//   trigger's secret (`whsec_` and its key, in base64), checked in
//   constant time (`crypto.subtle.verify`) before the body is parsed. Any
//   sender or library that speaks the standard can call it.
// - The secret leaking from core. It is never stored: it is derived from
//   the trigger's ID and its secret's generation with a key of core's own
//   (`derivedHmacKey`, as outbound webhooks' are), answered once to its
//   owner as it is made (created or rotated), never listed, logged or
//   audited. Rotating makes a new generation, never one used before, so
//   the old secret takes nothing from then on; revoking takes nothing
//   until a new one is made. Rotating core's auth secret changes them all.
//   A delivery whose secret is rotated or revoked while its body arrives
//   starts nothing: its admission requires the secret it was checked with
//   to be the trigger's still (`also`), and is answered 401 when it isn't.
// - A delivery started twice: a sender's retry is signed afresh, with a
//   new timestamp, but keeps its `webhook-id`. The run is keyed by the
//   trigger and that ID (`startOnce`'s key, a start receipt), so a retry
//   is the same start, its run the same run; the ID is signed, so it can't
//   be swapped for another to start a second run. A captured delivery
//   replayed later than five minutes from its timestamp is refused
//   (`workflowWebhookLimits.toleranceSeconds`); within them it is the
//   same start.
// - A trigger nobody approved starting anything. Its starts need `start` on
//   its workflow, a grant of its own only an admin gives, as every
//   trigger's do; a trigger disabled or deleted takes nothing (404), and
//   each start reads it live as it is admitted (workflow-starts.ts).
// - Input the workflow doesn't take, or code in it. The body is one JSON
//   value of at most `workflowWebhookLimits.bodyBytes`, read as it
//   arrives and never past that; it is the run's input as is, checked
//   against the pinned version's input schema as any start's is, and
//   nothing in it is evaluated. One refused is refused for good, audited.
// - Floods. A trigger starts at most `triggeredRunsPerHour` runs an hour,
//   counted as each is admitted, as connector and email triggers do
//   (`startOnce`); past it the sender is told to try again later (503,
//   `retry-after`), and nothing is held back for it: it retries under the
//   same `webhook-id`, which starts one run however often it is sent.
//   Before any of it, the router counts every request to a webhook URL per
//   client address and per URL (`WEBHOOK_RATE_LIMIT`, apps/router), and
//   answers 429 past either, before core looks the URL up or reads a byte.
//   An unsigned request costs a lookup by a unique index and an HMAC, and
//   is logged by reason, never audited: an unauthenticated sender can't
//   fill the audit log. Each signed delivery is audited: its start with
//   its run, a refusal for good as `workflow.webhook.refused`, by the
//   hash of its `webhook-id`, never its body.

const secretPurpose = "grasp-os workflow webhook secret";

/** The prefix of a Standard Webhooks secret: its key follows, in base64. */
const secretPrefix = "whsec_";

/** The key of webhook trigger `id`'s secret at `generation`: never stored. */
const secretKeyOf = async (
  env: Pick<Env, "BETTER_AUTH_SECRET">,
  id: string,
  generation: number
): Promise<Uint8Array<ArrayBuffer>> => {
  const key = await derivedHmacKey(env, secretPurpose, ["sign"]);
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}\n${generation}`)
  );
  return new Uint8Array(mac);
};

/**
 * The secret of webhook trigger `id` at `generation`, as Standard Webhooks
 * writes one: `whsec_` and its 32-byte key, in base64. Never stored.
 */
export const webhookTriggerSecretOf = async (
  env: Pick<Env, "BETTER_AUTH_SECRET">,
  id: string,
  generation: number
): Promise<string> =>
  `${secretPrefix}${toBase64(await secretKeyOf(env, id, generation))}`;

/** A token of a webhook trigger's URL: 128 random bits, in hex. */
const tokenPattern = /^[0-9a-f]{32}$/u;

/** Random bytes in a webhook trigger's token. */
const tokenBytes = 16;

/** A new webhook trigger's token: random, its own. */
export const webhookTokenOf = (): string =>
  toHex(crypto.getRandomValues(new Uint8Array(tokenBytes)));

/** The token a path names, if it is a webhook trigger's URL. */
export const webhookTokenAt = (pathname: string): string | undefined => {
  const prefix = `${workflowWebhookPath}/`;
  if (!pathname.startsWith(prefix)) {
    return undefined;
  }
  return pathname.slice(prefix.length);
};

/**
 * `pathname` as the request log keeps it: a webhook trigger's token left
 * out, whatever follows the path.
 */
export const withoutWebhookToken = (pathname: string): string =>
  webhookTokenAt(pathname) === undefined
    ? pathname
    : `${workflowWebhookPath}/-`;

/** One signature of `webhook-signature`: `v1,` and a 32-byte MAC in base64. */
const signaturePattern = /^v1,(?<mac>[A-Za-z0-9+/]{43}=)$/u;

/** A timestamp as sent: Unix seconds. */
const timestampPattern = /^\d{1,12}$/u;

/** A `webhook-id`: 1 to 256 printable ASCII characters, no spaces. */
const deliveryIdPattern = /^[\u0021-\u007E]{1,256}$/u;

/** The most signatures one `webhook-signature` header lists. */
const maxSignatures = 8;

/** Base64 `text` as bytes. */
const bytesOfBase64 = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(text), (char) => char.codePointAt(0) ?? 0);

/** A webhook trigger, with its secret's generation and whether it was revoked. */
interface WebhookTaker extends Taker {
  generation: number | null;
  revokedAt: Date | null;
}

/** The live, enabled webhook trigger at `token`. */
const webhookTakerAt = async (
  env: Env,
  token: string
): Promise<WebhookTaker | undefined> =>
  await drizzle(env.DB)
    .select({
      id: triggerResources.id,
      version: triggerResources.currentVersion,
      workflowId: triggerResourceVersions.workflowResourceId,
      workflowVersion: triggerResourceVersions.workflowResourceVersion,
      inputMapping: triggerResourceVersions.inputMapping,
      generation: triggerResources.webhookSecretGeneration,
      revokedAt: triggerResources.webhookSecretRevokedAt,
    })
    .from(triggerResources)
    .innerJoin(
      triggerResourceVersions,
      and(
        eq(triggerResourceVersions.triggerId, triggerResources.id),
        eq(triggerResourceVersions.version, triggerResources.currentVersion)
      )
    )
    .where(
      and(
        eq(triggerResources.webhookToken, token),
        eq(triggerResources.kind, "webhook"),
        eq(triggerResources.enabled, true),
        isNull(triggerResources.deletedAt)
      )
    )
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
    workflowWebhookLimits.toleranceSeconds;

/** The headers a delivery is signed by, if they are all there and well formed. */
const signedOf = (headers: Headers): Signed | undefined => {
  const id = headers.get(workflowWebhookHeaders.id);
  const timestamp = headers.get(workflowWebhookHeaders.timestamp);
  const signatures = headers.get(workflowWebhookHeaders.signature);
  return id !== null &&
    deliveryIdPattern.test(id) &&
    isRecent(timestamp) &&
    signatures !== null
    ? { id, timestamp, signatures }
    : undefined;
};

/** Refuses a delivery as unsigned: logged by reason, never audited. */
const unsigned = (reason: string, requestId: string): Response => {
  log.warn("workflow.webhook.unsigned", { reason });
  return errorResponse(
    401,
    workflowWebhookErrors.create("webhook.signature_invalid"),
    requestId
  );
};

const jsonValue = z.json();

/** The body as one JSON value, if it is one. */
const jsonOf = (bytes: Uint8Array): z.infer<typeof jsonValue> | undefined => {
  try {
    const parsed = jsonValue.safeParse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          bytes
        )
      )
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

/** How long a sender is asked to wait before trying again, in seconds. */
const retryAfterSeconds = 60;

/** The answer to a signed delivery whose start came to `outcome`. */
const answerOf = (outcome: Outcome, requestId: string): Response => {
  switch (outcome) {
    case "started": {
      return Response.json({ accepted: true }, { status: 202 });
    }
    case "gone": {
      return errorResponse(
        422,
        workflowWebhookErrors.create("webhook.input_refused"),
        requestId
      );
    }
    case "stale": {
      // Its secret was rotated or revoked as the delivery arrived.
      log.warn("workflow.webhook.unsigned", { reason: "rotated" });
      return errorResponse(
        401,
        workflowWebhookErrors.create("webhook.signature_invalid"),
        requestId
      );
    }
    case "unavailable": {
      return errorResponse(
        404,
        requestErrors.create("request.not_found"),
        requestId
      );
    }
    case "retry": {
      const response = errorResponse(
        503,
        workflowWebhookErrors.create("webhook.busy"),
        requestId
      );
      response.headers.set("retry-after", String(retryAfterSeconds));
      return response;
    }
    default: {
      return outcome satisfies never;
    }
  }
};

/**
 * Answers a POST to a webhook trigger's URL (see the header): 202 once its
 * run started (or had, for the same `webhook-id`), 401 unsigned, 404 for no
 * live trigger there, 413 or 400 for a body that isn't one JSON value
 * within the limit, 422 refused for good, 503 to try again later.
 */
export const workflowWebhookResponse = async (
  request: Request,
  env: Env,
  token: string,
  requestId: string
): Promise<Response> => {
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }
  const taker = tokenPattern.test(token)
    ? await webhookTakerAt(env, token)
    : undefined;
  if (taker === undefined) {
    await request.body?.cancel();
    return errorResponse(
      404,
      requestErrors.create("request.not_found"),
      requestId
    );
  }
  if (taker.generation === null || taker.revokedAt !== null) {
    await request.body?.cancel();
    return unsigned("revoked", requestId);
  }
  const signed = signedOf(request.headers);
  if (signed === undefined) {
    await request.body?.cancel();
    return unsigned("headers", requestId);
  }
  const { generation } = taker;
  // SAFETY: a request's body in workerd is a byte stream, of Uint8Array
  // chunks; its type says `any` only for streams in general.
  const stream = request.body as ReadableStream<Uint8Array> | null;
  const body =
    stream === null
      ? new Uint8Array()
      : await readAtMost(stream, workflowWebhookLimits.bodyBytes);
  if (body === undefined) {
    return errorResponse(
      413,
      workflowWebhookErrors.create("webhook.body_invalid"),
      requestId
    );
  }
  const key = await secretKeyOf(env, taker.id, generation);
  if (!(await signedWith(key, signed, body))) {
    return unsigned("signature", requestId);
  }
  const input = jsonOf(body);
  if (input === undefined) {
    return errorResponse(
      400,
      workflowWebhookErrors.create("webhook.body_invalid"),
      requestId
    );
  }
  // The same `webhook-id`, however often sent and signed, is the same
  // start: a sender's retries start one run.
  const same = await sha256Hex(`webhook:${signed.id}`);
  const outcome = await startOnce(env, taker, {
    same,
    key: `${coreStartKeyPrefix}webhook:${taker.id}:${same}`,
    admission: `webhook:${same}:${taker.id}`,
    input,
    stamped: undefined,
    // Admitted only while the secret it was checked with is still the
    // trigger's: rotated or revoked meanwhile, it starts nothing.
    also: sql`EXISTS (SELECT 1 FROM ${triggerResources}
      WHERE ${triggerResources.id} = ${taker.id}
        AND ${triggerResources.webhookSecretGeneration} = ${generation}
        AND ${triggerResources.webhookSecretRevokedAt} IS NULL)`,
    noted: { delivery: same },
    audited: {
      refused: "workflow.webhook.refused",
      detail: { delivery: same },
    },
    logged: { type: "webhook", delivery: same },
    answered: true,
  });
  return answerOf(outcome, requestId);
};
