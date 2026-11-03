import {
  fromHex,
  sha256Hex,
  toBase64Url,
  toHex,
} from "@grasp-os/shared/encoding";
import { requestErrors } from "@grasp-os/shared/errors";
import { readAtMost } from "@grasp-os/shared/http";
import { log } from "@grasp-os/shared/log";
import { coreStartKeyPrefix } from "@grasp-os/shared/workflow-resources";
import {
  workflowWebhookErrors,
  workflowWebhookHeaders,
  workflowWebhookLimits,
  workflowWebhookPath,
} from "@grasp-os/shared/workflow-triggers";
import { and, eq, isNull } from "drizzle-orm";
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
//   credential: every delivery must also be signed, `v1=` HMAC-SHA256 over
//   `<timestamp>.<body>` with the trigger's secret, checked in constant
//   time (`crypto.subtle.verify`) before the body is even parsed.
// - The secret leaking from core. It is never stored: it is derived from
//   the trigger's ID and its secret's generation with a key of core's own
//   (`derivedHmacKey`, as outbound webhooks' are), answered once to its
//   owner as it is made (created or rotated), never listed, logged or
//   audited. Rotating makes a new generation, never one used before, so
//   the old secret takes nothing from then on; revoking takes nothing
//   until a new one is made. Rotating core's auth secret changes them all.
// - A captured delivery replayed. Its timestamp must be within five
//   minutes of now (`workflowWebhookLimits.toleranceSeconds`); within that
//   window the same delivery (the same signature) is the same start
//   (`startOnce`'s key, a start receipt), its run the same run.
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
//   (`startOnce`); past it the sender is told to try again later (503).
//   An unsigned request costs a lookup by a unique index and an HMAC, and
//   is logged by reason, never audited: an unauthenticated sender can't
//   fill the audit log. Each signed delivery is audited: its start with
//   its run, a refusal or a drop as `workflow.webhook.refused` and
//   `workflow.webhook.dropped`, by the delivery's hash, never its body.

const secretPurpose = "grasp-os workflow webhook secret";

/** The prefix of a webhook trigger's secret, so it is recognised wherever it is pasted. */
const secretPrefix = "gwtsec_";

/** The secret of webhook trigger `id` at `generation`: never stored. */
export const webhookTriggerSecretOf = async (
  env: Pick<Env, "BETTER_AUTH_SECRET">,
  id: string,
  generation: number
): Promise<string> => {
  const key = await derivedHmacKey(env, secretPurpose, ["sign"]);
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}\n${generation}`)
  );
  return `${secretPrefix}${toBase64Url(new Uint8Array(mac))}`;
};

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

/** A signature as sent: `v1=` and 64 hex digits. */
const signaturePattern = /^v1=(?<mac>[0-9a-f]{64})$/u;

/** A timestamp as sent: Unix seconds. */
const timestampPattern = /^\d{1,12}$/u;

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

/**
 * Whether `signature` is `v1=` HMAC-SHA256 of `<timestamp>.<body>` with
 * `secret`, checked in constant time.
 */
const signedWith = async (
  secret: string,
  timestamp: string,
  body: Uint8Array<ArrayBuffer>,
  signature: string
): Promise<boolean> => {
  const mac = fromHex(signaturePattern.exec(signature)?.groups?.mac ?? "");
  if (mac === undefined || mac.byteLength === 0) {
    return false;
  }
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const prefix = encoder.encode(`${timestamp}.`);
  const signed = new Uint8Array(prefix.byteLength + body.byteLength);
  signed.set(prefix);
  signed.set(body, prefix.byteLength);
  return await crypto.subtle.verify("HMAC", key, mac, signed);
};

/** Whether `timestamp` (Unix seconds, as sent) is within the window of now. */
const isRecent = (timestamp: string | null): timestamp is string =>
  timestamp !== null &&
  timestampPattern.test(timestamp) &&
  Math.abs(Date.now() / 1000 - Number(timestamp)) <=
    workflowWebhookLimits.toleranceSeconds;

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
 * run started (or had, for the same delivery), 401 unsigned, 404 for no
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
  const timestamp = request.headers.get(workflowWebhookHeaders.timestamp);
  const signature = request.headers.get(workflowWebhookHeaders.signature);
  if (!isRecent(timestamp) || signature === null) {
    await request.body?.cancel();
    return unsigned("timestamp", requestId);
  }
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
  const secret = await webhookTriggerSecretOf(env, taker.id, taker.generation);
  if (!(await signedWith(secret, timestamp, body, signature))) {
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
  // The same delivery, sent again within the window, is the same start.
  const same = await sha256Hex(`webhook:${signature}`);
  const outcome = await startOnce(env, taker, {
    same,
    key: `${coreStartKeyPrefix}webhook:${taker.id}:${same}`,
    admission: `webhook:${same}:${taker.id}`,
    input,
    stamped: undefined,
    noted: { delivery: same },
    audited: {
      refused: "workflow.webhook.refused",
      dropped: "workflow.webhook.dropped",
      detail: { delivery: same },
    },
    logged: { type: "webhook", delivery: same },
  });
  return answerOf(outcome, requestId);
};
