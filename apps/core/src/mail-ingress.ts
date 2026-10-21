import { sha256HexOfBytes } from "@grasp-os/shared/encoding";
import { requestErrors } from "@grasp-os/shared/errors";
import { readAtMost } from "@grasp-os/shared/http";
import { log } from "@grasp-os/shared/log";
import {
  mailFromHeader,
  mailIngressMaxBytes,
  mailIngressMaxSkewMs,
  mailRejectedStatus,
  mailSentAtHeader,
  mailSha256Header,
  mailSignatureHeader,
  mailSizeHeader,
  mailToHeader,
  verifyMail,
} from "@grasp-os/shared/mail-ingress";
import type { SignedMail } from "@grasp-os/shared/mail-ingress";

import { errorResponse } from "./errors.ts";
import { acceptedSecrets } from "./router-secret.ts";
import { receiveEmail } from "./workflows/inbound-email.ts";

// Raw mail over HTTP (@grasp-os/shared/mail-ingress): the router's mail
// sorter, or an on-prem mail bridge, hands core a message as Email
// Routing would, and core takes it with the same `receiveEmail`. Its
// answer is the message's disposition: 202 taken, 422 bounced for good
// (with the reason), anything else failed for now, for the sender to try
// again.

/** A request's body, as the byte stream workerd gives it. */
const bodyOf = (request: Request): ReadableStream<Uint8Array> | null =>
  request.body;

/** `bytes` as a stream, as Email Routing hands a message's. */
const bytesStream = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(bytes);
      controller.close();
    },
  });

/** Why a delivery was refused. Logged; the sender only sees 403. */
type Refusal =
  | "not_configured"
  | "unsigned"
  | "stale"
  | "bad_signature"
  | "digest_mismatch";

const forbidden = (requestId: string, reason: Refusal): Response => {
  log.warn("mail.ingress_refused", { reason, requestId });
  return errorResponse(
    403,
    requestErrors.create("request.forbidden"),
    requestId
  );
};

/** Whether any of core's router secrets signed `mail` as `signature`. */
const signedByRouter = async (
  env: Env,
  mail: SignedMail,
  signature: string
): Promise<boolean> => {
  // Checked with every accepted secret, so the time taken doesn't tell
  // which one matched.
  const results = await Promise.all(
    acceptedSecrets(env).map(
      async (secret) => await verifyMail(secret, mail, signature)
    )
  );
  return results.includes(true);
};

/**
 * Takes one message from the raw-mail ingress, after the router-secret
 * check: only a delivery signed for exactly this recipient, sender, body
 * and time, within `mailIngressMaxSkewMs`, reaches `receiveEmail`. Logs
 * no address and nothing the message says: its hash and size alone.
 */
export const mailIngressResponse = async (
  request: Request,
  env: Env,
  requestId: string
): Promise<Response> => {
  const body = bodyOf(request);
  if (request.method !== "POST" || body === null) {
    return errorResponse(
      404,
      requestErrors.create("request.not_found"),
      requestId
    );
  }
  if (!env.ROUTER_SECRET) {
    return forbidden(requestId, "not_configured");
  }
  const { headers } = request;
  const to = headers.get(mailToHeader);
  const from = headers.get(mailFromHeader);
  const sha256 = headers.get(mailSha256Header);
  const sentAt = headers.get(mailSentAtHeader);
  const signature = headers.get(mailSignatureHeader);
  const size = Number(headers.get(mailSizeHeader) ?? Number.NaN);
  if (
    to === null ||
    from === null ||
    sha256 === null ||
    sentAt === null ||
    signature === null ||
    !Number.isSafeInteger(size)
  ) {
    return forbidden(requestId, "unsigned");
  }
  const sent = Date.parse(sentAt);
  if (
    Number.isNaN(sent) ||
    Math.abs(Date.now() - sent) > mailIngressMaxSkewMs
  ) {
    return forbidden(requestId, "stale");
  }
  const mail = { to, from, sha256, size, sentAt };
  if (!(await signedByRouter(env, mail, signature))) {
    return forbidden(requestId, "bad_signature");
  }
  // The signed size bounds the read; the bytes must be the signed ones.
  const raw = await readAtMost(body, Math.min(size, mailIngressMaxBytes));
  if (
    raw === undefined ||
    raw.byteLength !== size ||
    (await sha256HexOfBytes(raw)) !== sha256
  ) {
    return forbidden(requestId, "digest_mismatch");
  }

  const outcome: { rejected?: string } = {};
  await receiveEmail(
    {
      to,
      from,
      raw: bytesStream(raw),
      setReject: (reason) => {
        outcome.rejected = reason;
      },
    },
    env
  );
  log.info("mail.ingress_taken", {
    requestId,
    message: sha256,
    size,
    disposition: outcome.rejected === undefined ? "taken" : "bounced",
  });
  return outcome.rejected === undefined
    ? new Response(null, { status: 202 })
    : Response.json(
        { reason: outcome.rejected },
        { status: mailRejectedStatus }
      );
};
