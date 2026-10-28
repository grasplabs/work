import { webhookTargetOf } from "@grasp-os/shared/app-link-limits";
import {
  appWebhookHeaders,
  appWebhookLimits,
  webhookPostSchema,
} from "@grasp-os/shared/app-webhooks";
import type {
  WebhookOutcome,
  WebhookPost,
} from "@grasp-os/shared/app-webhooks";
import type { AuditDetailValue } from "@grasp-os/shared/audit";
import { errorFields, log } from "@grasp-os/shared/log";

import { recordEvents } from "./audit.ts";

// Sending an App's events to a company's webhooks (GRA-1208): core keeps
// the webhooks, queues and signs each delivery (core's app-webhooks.ts),
// and asks connect to send it, as connect alone reaches the internet.
// Threat model, and how each is closed here:
//
// - A webhook reaching inside a network (SSRF): the URL is checked again
//   here, whatever core checked (`webhookTargetOf`): `https:` only, no
//   userinfo, no IP address, no private network name. Connect's fetch
//   refuses a name that resolves to a private address
//   (`global_fetch_strictly_public`), so a public name pointing inside
//   gets nowhere either. A redirect is never followed: it is a failure,
//   so an allowed host can't send the delivery on to one that isn't.
// - Core passing on anything but a delivery: the request is read whole
//   (`webhookPostSchema`), and its headers are set here from its fields,
//   never taken as given; only `POST`, only a JSON body, bounded.
// - A receiver holding connect up, or answering with a flood: it gets
//   `appWebhookLimits.timeoutMs` to answer, and its body is never read.
// - A delivery nobody can trace: each one is audited, sent, failed or
//   refused, as `webhook.call`, by the App, the webhook, the delivery and
//   the URL's origin and status, never its path, query or body, which may
//   hold the receiver's own secrets or the App's data.

/** What a delivery is recorded with. */
interface WebhookRecord {
  post: Pick<WebhookPost, "app" | "webhook" | "delivery" | "event">;
  origin: string | undefined;
  outcome: WebhookOutcome;
}

/** Records a delivery's outcome; one that can't be recorded is logged. */
const record = async (
  env: Env,
  { post, origin, outcome }: WebhookRecord
): Promise<void> => {
  const detail: Record<string, AuditDetailValue> = {
    webhook: post.webhook,
    delivery: post.delivery,
    event: post.event,
    outcome: outcome.outcome,
  };
  if (origin !== undefined) {
    detail.origin = origin;
  }
  if ("reason" in outcome) {
    detail.reason = outcome.reason;
  }
  if ("status" in outcome && outcome.status !== undefined) {
    detail.status = outcome.status;
  }
  try {
    await recordEvents(env, [
      {
        actor: { type: "system" },
        action: "webhook.call",
        target: { type: "app", id: post.app },
        detail,
      },
    ]);
  } catch (error) {
    log.error("audit.record_failed", errorFields(error));
  }
};

/** Sends `body` to `url`, signed, as one delivery: how it went. */
const send = async (
  url: string,
  post: WebhookPost
): Promise<WebhookOutcome> => {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Grasp-Webhooks/1",
        [appWebhookHeaders.id]: post.delivery,
        [appWebhookHeaders.event]: post.event,
        [appWebhookHeaders.timestamp]: String(post.timestamp),
        [appWebhookHeaders.signature]: post.signature,
      },
      body: post.body,
      redirect: "manual",
      signal: AbortSignal.timeout(appWebhookLimits.timeoutMs),
    });
  } catch (error) {
    return {
      outcome: "failed",
      reason:
        error instanceof Error && error.name === "TimeoutError"
          ? "timeout"
          : "network",
    };
  }
  // Nothing of the answer is read but its status.
  await response.body?.cancel();
  if (response.status >= 200 && response.status < 300) {
    return { outcome: "delivered", status: response.status };
  }
  return {
    outcome: "failed",
    reason:
      response.status >= 300 && response.status < 400 ? "redirect" : "status",
    status: response.status,
  };
};

/**
 * Sends one delivery core signed to its webhook's URL (see the header):
 * delivered on a 2xx answer, failed on anything else, refused before
 * anything left when the URL or the request isn't one connect sends.
 */
export const webhookPost = async (
  env: Env,
  request: unknown
): Promise<WebhookOutcome> => {
  const read = webhookPostSchema.safeParse(request);
  if (!read.success) {
    log.warn("webhook.refused", { reason: "invalid" });
    return { outcome: "refused", reason: "invalid" };
  }
  const post = read.data;
  const target = webhookTargetOf(post.url);
  if (!target.ok) {
    const outcome: WebhookOutcome = {
      outcome: "refused",
      reason: target.reason,
    };
    await record(env, { post, origin: undefined, outcome });
    return outcome;
  }
  const outcome = await send(target.url, post);
  await record(env, { post, origin: target.origin, outcome });
  return outcome;
};
