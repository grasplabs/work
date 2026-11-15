import { sha256Hex } from "@grasp-os/shared/encoding";
import { requestErrors } from "@grasp-os/shared/errors";
import {
  interviewErrors,
  interviewRequestMaxBytes,
  interviewRequestSchema,
} from "@grasp-os/shared/interview-links";
import { log } from "@grasp-os/shared/log";

import { errorResponse } from "../errors.ts";
import { boundedText, jsonOf } from "../request-body.ts";
import { interviewCaller } from "./interview-caller.ts";
import type { NoCaller } from "./interview-caller.ts";
import { eraseOwedOfPersonQuietly } from "./new-brain.ts";
import { onboardingStore } from "./store.ts";
import type { LinkAnswer, LinkRefusal } from "./store.ts";

// Everyone's own interview link (`@grasp-os/shared/interview-links`): the
// page's calls, `POST /api/interview`, with the link's secret in the body
// and the session of the company's sign-in on the request
// (interview-caller.ts). How it can fail, from the threat model (GRA-307,
// L1 to L11, and GRA-1790), and what stops it:
//
// - A link guessed (L1): its secret is 256 bits, made from core's key and
//   a random id per person (link-secret.ts); the store keeps the id and
//   the secret's hash, and is only ever given hashes.
// - The secret leaking (L2): it is in the URL's fragment, which no browser
//   sends, and in request bodies; never in a log, an error, the audit log
//   or a referrer (`no-referrer` on every answer here and on the page).
// - Someone else with the link, the company's admin among them (L3): the
//   interview belongs to the account that first opened it signed in with
//   the address the link was sent to, verified by the company's sign-in
//   (GRA-1790); everything on it needs that account's session, and anyone
//   else is told the link opens nothing, as for one that never was.
// - Two tabs losing a save (L4): saves are versioned, and one from an
//   older copy is refused with the copy kept.
// - Opening too early, while paused, or too late (L5, L6, L8): a link
//   opens once it was sent (the store's alarm, by its day and its lead),
//   while the interviews run and the agreements are in; after the plan's
//   last day what was said can be read and deleted, and nothing more.
//   Deleting works at any time for the account the link belongs to.
// - Someone taken off the list (L7): their link, and what they said, go
//   with them, and their link answers as one that never was (L10).
// - A lost device (L9): nothing to do; they sign in on another one. Staff
//   give a new start from Grasp's admin when an interview went wrong
//   (admin-command.ts).
// - Floods (L11): the router limits this endpoint per address; the store
//   counts calls per link.
// - The company learning who talked, and when: what someone does on their
//   link is in the onboarding's own log, which only staff read, never in
//   the audit log, which the company's admin reads. Their sign-in is in
//   their company's own sign-in records, as every sign-in is, and the page
//   says so before they sign in (GRA-1790); Grasp records it nowhere the
//   company reads, and makes no membership for them while the gate is
//   closed.
//
// And from the threat model of read-back approval (GRA-329, T1 to T8):
//
// - Recording or a model before they agreed to take part (T1): `participate`
//   keeps the notice they read, its purpose and audience; every turn, story
//   and live transcription is refused without it (the store's
//   `#participating`).
// - An edited fact keeping its approval (T2): `approve` names each fact's
//   revision, a hash of exactly what was read back and kept; only a fact
//   whose saved revision was approved counts, whatever the page says.
// - An approval replayed or sent twice, or a lost answer (T3, T7): the
//   receipt is made from the revisions approved, so the same approval
//   answers the same receipt; one of a revision no longer kept is refused
//   with the copy kept.
// - Withdrawing (T5): `withdraw` stops recording, models, drawing and the
//   brain at once, and takes out what the brain has that rests on them.

/** The HTTP status of each refusal. */
const statusFor: Record<
  LinkRefusal | "interview.invalid" | "interview.sign_in",
  number
> = {
  "interview.link_invalid": 404,
  "interview.sign_in": 401,
  "interview.not_yet": 403,
  "interview.paused": 423,
  "interview.closed": 410,
  "interview.deleted": 410,
  "interview.limited": 429,
  "interview.invalid": 400,
  "interview.not_participating": 403,
  "interview.notice_changed": 409,
  "interview.withdrawn": 410,
};

/** Every answer here: never a referrer, never kept by a cache. */
export const linkHeaders = {
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
} as const;

export const linkRefusal = (
  code: LinkRefusal | "interview.invalid" | "interview.sign_in",
  requestId: string
): Response => {
  const response = errorResponse(
    statusFor[code],
    interviewErrors.create(code),
    requestId
  );
  for (const [name, value] of Object.entries(linkHeaders)) {
    response.headers.set(name, value);
  }
  return response;
};

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: linkHeaders });

/** The store's answer as a response: its value, or its refusal. */
const answer = <T>(
  result: LinkAnswer<T>,
  requestId: string,
  shown: (value: T) => Response
): Response =>
  result.ok ? shown(result.value) : linkRefusal(result.code, requestId);

/**
 * The answer to a request that names nobody who may open an interview
 * (interview-caller.ts): one another site sent is forbidden; one with no
 * session of the company's sign-in is asked to sign in.
 */
export const noCallerRefusal = (why: NoCaller, requestId: string): Response => {
  if (why === "sign_in") {
    return linkRefusal("interview.sign_in", requestId);
  }
  const response = errorResponse(
    403,
    requestErrors.create("request.forbidden"),
    requestId
  );
  for (const [name, value] of Object.entries(linkHeaders)) {
    response.headers.set(name, value);
  }
  return response;
};

/** The interview page's calls: session, save, delete, and taking part, approving and withdrawing. */
export const interviewResponse = async (
  request: Request,
  env: Env,
  requestId: string
): Promise<Response> => {
  if (request.method !== "POST") {
    return errorResponse(
      405,
      requestErrors.create("request.not_found"),
      requestId
    );
  }
  // Who asks, before anything they sent is read.
  const caller = await interviewCaller(env, request.headers);
  if (typeof caller === "string") {
    return noCallerRefusal(caller, requestId);
  }
  const { account } = caller;
  const length = Number(request.headers.get("content-length") ?? 0);
  const raw =
    length > interviewRequestMaxBytes
      ? undefined
      : await boundedText(request.body, interviewRequestMaxBytes);
  const parsed = interviewRequestSchema.safeParse(
    raw === undefined ? undefined : jsonOf(raw)
  );
  if (!parsed.success) {
    return linkRefusal("interview.invalid", requestId);
  }
  const body = parsed.data;
  const store = onboardingStore(env);
  const secretMark = await sha256Hex(body.secret);
  // Whose link it is, and the teams whose claims they back, read before
  // a request that may drop them: what it takes out leaves the new Brain
  // in the same request (onboarding/new-brain.ts).
  const ownBrainWork = async () => {
    const person = await store.personOfLink(secretMark);
    return {
      person,
      backed: person === null ? [] : await store.claimTeamsOf(person),
    };
  };
  const done = (result: LinkAnswer<unknown>) => {
    if (!result.ok && result.code === "interview.link_invalid") {
      // Never the secret: only that one opened nothing.
      log.warn("interview.link_invalid", { requestId });
    }
  };
  switch (body.action) {
    case "session": {
      const result = await store.openLink(secretMark, caller);
      done(result);
      return answer(result, requestId, (value) => json(value));
    }
    case "save": {
      const { person, backed } = await ownBrainWork();
      const result = await store.saveInterview(
        secretMark,
        account,
        body.version,
        body.progress
      );
      done(result);
      // What it took out of their interview leaves the new Brain now
      // (onboarding/new-brain.ts); what it added is handed over.
      await eraseOwedOfPersonQuietly(env, person, backed);
      return answer(result, requestId, (value) =>
        json(value, value.saved ? 200 : 409)
      );
    }
    case "delete": {
      const { person, backed } = await ownBrainWork();
      const result = await store.deleteInterview(secretMark, account);
      done(result);
      // What it took out of their interview leaves the new Brain now
      // (onboarding/new-brain.ts); what it added is handed over.
      await eraseOwedOfPersonQuietly(env, person, backed);
      return answer(result, requestId, (value) => json(value));
    }
    case "participate": {
      const result = await store.participate(secretMark, account, body.notice);
      done(result);
      return answer(result, requestId, (value) => json(value));
    }
    case "approve": {
      const { person, backed } = await ownBrainWork();
      const result = await store.approve(secretMark, account, body.facts);
      done(result);
      // What it took out of their interview leaves the new Brain now
      // (onboarding/new-brain.ts); what it added is handed over.
      await eraseOwedOfPersonQuietly(env, person, backed);
      return answer(result, requestId, (value) =>
        json(value, value.approved ? 200 : 409)
      );
    }
    case "withdraw": {
      const { person, backed } = await ownBrainWork();
      const result = await store.withdraw(secretMark, account);
      done(result);
      // What it took out of their interview leaves the new Brain now
      // (onboarding/new-brain.ts); what it added is handed over.
      await eraseOwedOfPersonQuietly(env, person, backed);
      return answer(result, requestId, (value) => json(value));
    }
    default: {
      return body satisfies never;
    }
  }
};
