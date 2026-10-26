import { randomToken, sha256Hex } from "@grasp-os/shared/encoding";
import { requestErrors } from "@grasp-os/shared/errors";
import {
  interviewErrors,
  interviewRequestMaxBytes,
  interviewRequestSchema,
} from "@grasp-os/shared/interview-links";
import type {
  InterviewElsewhere,
  InterviewSession,
} from "@grasp-os/shared/interview-links";
import { log } from "@grasp-os/shared/log";

import { errorResponse } from "../errors.ts";
import { boundedText, jsonOf } from "../request-body.ts";
import { onboardingStore } from "./store.ts";
import type { LinkAnswer, LinkRefusal } from "./store.ts";

// Everyone's own interview link (`@grasp-os/shared/interview-links`): the
// page's calls, `POST /api/interview`, with the link's secret, and the
// device's key once it has one, in the body. How it can fail, from the
// threat model (GRA-307, L1 to L11), and what stops it:
//
// - A link guessed (L1): its secret is 256 bits, made from core's key and
//   a random id per person (link-secret.ts); the store keeps the id and
//   the secret's hash, and is only ever given hashes.
// - The secret leaking (L2): it is in the URL's fragment, which no browser
//   sends, and in request bodies; never in a log, an error, the audit log
//   or a referrer (`no-referrer` on every answer here and on the page).
// - Someone else with the link, the company's admin among them (L3): the
//   first device to open it is given a key of 256 bits, and only its hash
//   is kept; reading, saving and deleting need it, and anyone else is told
//   the interview is open elsewhere, and nothing that was said.
// - Two tabs losing a save (L4): saves are versioned, and one from an
//   older copy is refused with the copy kept.
// - Opening too early, while paused, or too late (L5, L6, L8): a link
//   opens once it was sent (the store's alarm, by its day and its lead),
//   while the interviews run and the agreements are in; after the plan's
//   last day what was said can be read and deleted, and nothing more.
//   Deleting works at any time on the device the link opened on.
// - Someone taken off the list (L7): their link, and what they said, go
//   with them, and their link answers as one that never was (L10).
// - A lost device (L9): staff give a new start (staff-rpc.ts).
// - Floods (L11): the router limits this endpoint per address; the store
//   counts calls per link.
// - The company learning who talked, and when: what someone does on their
//   link is in the onboarding's own log, which only staff read, never in
//   the audit log, which the company's admin reads.
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
const statusFor: Record<LinkRefusal | "interview.invalid", number> = {
  "interview.link_invalid": 404,
  "interview.not_yet": 403,
  "interview.paused": 423,
  "interview.closed": 410,
  "interview.elsewhere": 403,
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
  code: LinkRefusal | "interview.invalid",
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

/** What a session answers the device: its key, the one time it is given. */
const sessionOf = (
  value:
    | (Omit<InterviewSession, "key"> & { issued: boolean })
    | InterviewElsewhere,
  key: string
): InterviewSession | InterviewElsewhere => {
  if (value.state === "elsewhere") {
    return value;
  }
  const { issued, ...session } = value;
  return issued ? { ...session, key } : session;
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
  const keyMark = body.key === undefined ? null : await sha256Hex(body.key);
  const done = (result: LinkAnswer<unknown>) => {
    if (!result.ok && result.code === "interview.link_invalid") {
      // Never the secret: only that one opened nothing.
      log.warn("interview.link_invalid", { requestId });
    }
  };
  switch (body.action) {
    case "session": {
      const key = randomToken();
      const result = await store.openLink(
        secretMark,
        keyMark,
        await sha256Hex(key)
      );
      done(result);
      return answer(result, requestId, (value) => json(sessionOf(value, key)));
    }
    case "save": {
      const result = await store.saveInterview(
        secretMark,
        keyMark ?? "",
        body.version,
        body.progress
      );
      done(result);
      return answer(result, requestId, (value) =>
        json(value, value.saved ? 200 : 409)
      );
    }
    case "delete": {
      const result = await store.deleteInterview(secretMark, keyMark ?? "");
      done(result);
      return answer(result, requestId, (value) => json(value));
    }
    case "participate": {
      const result = await store.participate(
        secretMark,
        keyMark ?? "",
        body.notice
      );
      done(result);
      return answer(result, requestId, (value) => json(value));
    }
    case "approve": {
      const result = await store.approve(secretMark, keyMark ?? "", body.facts);
      done(result);
      return answer(result, requestId, (value) =>
        json(value, value.approved ? 200 : 409)
      );
    }
    case "withdraw": {
      const result = await store.withdraw(secretMark, keyMark ?? "");
      done(result);
      return answer(result, requestId, (value) => json(value));
    }
    default: {
      return body satisfies never;
    }
  }
};
