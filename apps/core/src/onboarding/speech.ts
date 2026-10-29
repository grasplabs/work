import { actorOf } from "@grasp-os/shared/audit";
import type { AuditActor } from "@grasp-os/shared/audit";
import { sha256Hex, toBase64 } from "@grasp-os/shared/encoding";
import { authErrors, requestErrors } from "@grasp-os/shared/errors";
import type { CodedError } from "@grasp-os/shared/errors";
import { log } from "@grasp-os/shared/log";
import { modelErrors } from "@grasp-os/shared/models";
import { isAdmin, roleErrors } from "@grasp-os/shared/roles";
import {
  speechErrors,
  speechRequestMaxBytes,
  speechRequestSchema,
} from "@grasp-os/shared/voice";
import type { SpeechAnswer, SpokenWord } from "@grasp-os/shared/voice";
import { z } from "zod";

import { identify } from "../auth/identity.ts";
import { errorResponse } from "../errors.ts";
import { gatewaySettings } from "../models.ts";
import { boundedText, jsonOf } from "../request-body.ts";
import { keepLine, keptLine, storedKeysOf } from "../speech-cache.ts";
import type { SpokenKey } from "../speech-cache.ts";
import { gatewaySpeech } from "../speech.ts";
import { auditStaffRoute } from "../staff-audit.ts";
import { linkHeaders, linkRefusal } from "./links.ts";
import { speakerVoices, spokenOf, voiceModels } from "./spoken-lines.ts";
import { onboardingStore } from "./store.ts";
import type { Took } from "./store.ts";

// `POST /api/speech` (`@grasp-os/shared/voice`): a line of the onboarding
// said out loud, with when each of its words is said, so the page lights
// the words up as they are said. Ported from the prototype (grasplabs/
// prototype, packages/grasp: worker/speech.ts).
//
// Said through speech synthesis behind its interface (speech.ts: the
// provider now, on-prem later), which goes through the model gateway: the
// deployment's allowlist and rules judge every line, its budgets are
// charged, and the audit log records it, never the line.
//
// What it must not do, and what stops it:
//
// - Say lines for anyone: only someone's interview link, on the device it
//   is open on, while it may be saved (the store's `speechOnLink`), or an
//   admin signed in. A request from another site is refused, as no other
//   site may spend an admin's voice.
// - Tell the company who talked, and when: a line on a link is said by
//   the system, never in anyone's name, as the interview's turns are; the
//   onboarding's own count, which only staff read, has it by purpose.
// - Run up the bill: a line is at most `maxSpeechChars`; a line said
//   before is answered from the cache, for nothing (speech-cache.ts); each
//   link and each admin has seconds of voice a day (`voiceBudgets`); the
//   router limits the endpoint per address, the store counts calls per
//   link, and the gateway's budgets hold too.
// - Say a line in a tone Stephen may not use: the only direction a line
//   takes is one of `voiceTags`, none of them sad, and a line with a
//   bracket of its own is refused, so no direction is slipped in.

/** What the gateway is told every line is for. */
const purpose = "onboarding.speech";

/**
 * Seconds of voice a day: on someone's link, more than an interview of an
 * hour has Stephen say; for an admin, enough to hear the onboarding's
 * pages over and over. A line said before costs none of them.
 */
export const voiceBudgets = { link: 30 * 60, admin: 60 * 60 } as const;

/** `Sec-Fetch-Site` values of a request this site's own pages made. */
const sameSiteFetches = new Set(["same-origin", "none"]);

/** Whom a line is said for: the key its voice counts under, and how it is counted. */
interface Listener {
  who: string;
  /** Seconds said under `who` today. */
  said: number;
  budget: number;
  /** The onboarding's count by purpose: an interview's, or an admin's onboarding. */
  counted: Took["purpose"];
  trigger: AuditActor;
}

/** An answer of this endpoint: never a referrer, never kept by a browser. */
const answered = (body: string): Response =>
  new Response(body, {
    headers: { ...linkHeaders, "content-type": "application/json" },
  });

const refused = (
  status: number,
  error: CodedError,
  requestId: string
): Response => {
  const response = errorResponse(status, error, requestId);
  for (const [name, value] of Object.entries(linkHeaders)) {
    response.headers.set(name, value);
  }
  return response;
};

/** The gateway's refusals, as the page is told them. */
const gatewayRefusals: Partial<
  Record<
    string,
    { status: number; code: Parameters<typeof speechErrors.create>[0] }
  >
> = {
  "model.over_budget": { status: 429, code: "speech.limited" },
  "model.budget_busy": { status: 429, code: "speech.busy" },
  "model.rate_limited": { status: 429, code: "speech.busy" },
  "model.queued": { status: 429, code: "speech.busy" },
  "model.unconfigured": { status: 503, code: "speech.unavailable" },
  "model.not_allowed": { status: 503, code: "speech.unavailable" },
  "model.eu_only": { status: 503, code: "speech.unavailable" },
  "model.sensitive_data": { status: 503, code: "speech.unavailable" },
  "model.unpriced": { status: 503, code: "speech.unavailable" },
};

/** Why the gateway didn't say a line, as the page is told it. */
const failed = (error: unknown, requestId: string): Response => {
  const code = modelErrors.codeOf(error);
  log.warn("speech.failed", { requestId, code });
  const refusal = gatewayRefusals[code ?? ""] ?? {
    status: 502,
    code: "speech.failed",
  };
  return refused(refusal.status, speechErrors.create(refusal.code), requestId);
};

/**
 * The voice model a line is said in: v4 Turbo for a quick line where the
 * deployment allows it, else v4, else the first voice model it allows;
 * `undefined` where it allows none.
 */
const voiceModelFor = (env: Env, quick: boolean): string | undefined => {
  const { voices } = gatewaySettings(env);
  const wanted = quick
    ? [voiceModels.quick, voiceModels.said]
    : [voiceModels.said];
  return wanted.find((model) => voices.includes(model)) ?? voices[0];
};

/**
 * The words of a line as written, from the words said: the direction's
 * words, up to the one that closes it, taken out. The line itself has no
 * bracket, so the first word that ends one ends the direction.
 */
const wordsAsWritten = (
  words: readonly SpokenWord[],
  directed: boolean
): SpokenWord[] => {
  const closes = words.findIndex(({ text }) => text.endsWith("]"));
  return directed && closes !== -1 ? words.slice(closes + 1) : [...words];
};

/** The page's request, read no further than it may be; `undefined` when it isn't one. */
const requestOf = async (request: Request) => {
  const length = Number(request.headers.get("content-length") ?? 0);
  const raw =
    length > speechRequestMaxBytes
      ? undefined
      : await boundedText(request.body, speechRequestMaxBytes);
  const parsed = speechRequestSchema.safeParse(
    raw === undefined ? undefined : jsonOf(raw)
  );
  return parsed.success ? parsed.data : undefined;
};

type Asked = NonNullable<Awaited<ReturnType<typeof requestOf>>>;

/** Whom a line on someone's link is for, or why their link refuses it. */
const onLink = async (
  env: Env,
  link: NonNullable<Asked["link"]>,
  requestId: string
): Promise<Listener | Response> => {
  const found = await onboardingStore(env).speechOnLink(
    await sha256Hex(link.secret),
    await sha256Hex(link.key)
  );
  if (!found.ok) {
    if (found.code === "interview.link_invalid") {
      // Never the secret: only that one opened nothing.
      log.warn("interview.link_invalid", { requestId });
    }
    return linkRefusal(found.code, requestId);
  }
  return {
    ...found.value,
    budget: voiceBudgets.link,
    counted: "interviews",
    trigger: { type: "system" },
  };
};

/** Whom a line for an admin signed in is for, or why it is refused. */
const forAdmin = async (
  request: Request,
  env: Env,
  requestId: string
): Promise<Listener | Response> => {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null && !sameSiteFetches.has(fetchSite)) {
    return refused(403, requestErrors.create("request.forbidden"), requestId);
  }
  // Grasp's staff, who may reach the onboarding alone, among them.
  const person = await identify(env, request.headers);
  if (person === undefined) {
    return refused(401, authErrors.create("auth.unauthenticated"), requestId);
  }
  // A staff member's view is in the client's audit log (staff-audit.ts).
  await auditStaffRoute(env, person, "onboarding.speech");
  if (!isAdmin(person.role)) {
    return refused(403, roleErrors.create("role.forbidden"), requestId);
  }
  const who = `admin:${person.userId}`;
  return {
    who,
    said: await onboardingStore(env).voiceSaid(who),
    budget: voiceBudgets.admin,
    // The admin's own onboarding, as the prototype counted it.
    counted: "reading",
    trigger: actorOf(person),
  };
};

/** How long a line takes to say, in seconds: until its last word ends. */
const secondsOf = (words: readonly SpokenWord[]): number =>
  (words.at(-1)?.endMs ?? 0) / 1000;

/** Counts a line said, after it was: never holds up nor fails the answer. */
const countSaid = async (
  env: Env,
  listener: Listener,
  seconds: number,
  requestId: string
): Promise<void> => {
  try {
    await onboardingStore(env).countVoice(
      listener.who,
      listener.counted,
      seconds
    );
  } catch {
    log.error("speech.count_failed", { requestId });
  }
};

/** Keeps a line said, for the next to ask: an answer is never held up by it. */
const keep = async (
  env: Env,
  key: SpokenKey,
  answer: string,
  requestId: string
): Promise<void> => {
  try {
    await keepLine(env, key, answer);
  } catch {
    log.warn("speech.keep_failed", { requestId });
  }
};

/**
 * Keeps a line said, unless a content purge reached the onboarding since
 * `purges` was taken (the store's `purgeMark`): then it is taken out again
 * right after it was put, as an R2 put can't be conditional, and tried
 * again by the store's alarm until it is gone. A purge that
 * lands after this check finds the line kept, and takes it out itself
 * (the store's `rewriteInterview`).
 */
const keepUnlessPurged = async (
  env: Env,
  key: SpokenKey,
  answer: string,
  purges: number,
  requestId: string
): Promise<void> => {
  await keep(env, key, answer, requestId);
  const store = onboardingStore(env);
  if ((await store.purgeMark()) !== purges) {
    await store.forgetSpoken(await storedKeysOf([key]));
  }
};

/** The answer's shape, as the cache keeps it: checked again when read. */
const keptAnswerSchema = z.object({
  audio: z.string().min(1),
  mime: z.string().min(1),
  words: z.array(
    z.object({ text: z.string(), startMs: z.number(), endMs: z.number() })
  ),
});

/** A line kept before, if one is that reads as an answer. */
const keptAnswer = async (
  env: Env,
  key: SpokenKey,
  requestId: string
): Promise<string | undefined> => {
  try {
    const kept = await keptLine(env, key);
    return kept !== undefined &&
      keptAnswerSchema.safeParse(jsonOf(kept)).success
      ? kept
      : undefined;
  } catch {
    log.warn("speech.cache_unread", { requestId });
    return undefined;
  }
};

/** Says the page's line for `listener`, from the cache when it was said before. */
const say = async (
  env: Env,
  asked: Asked,
  listener: Listener,
  requestId: string
): Promise<Response> => {
  const model = voiceModelFor(env, asked.quick);
  if (model === undefined) {
    return refused(503, speechErrors.create("speech.unavailable"), requestId);
  }
  const spoken = spokenOf(asked.text, asked.language, asked.tone);
  const key: SpokenKey = {
    spoken,
    voice: speakerVoices[asked.speaker],
    model,
    language: asked.language,
  };
  const kept = await keptAnswer(env, key, requestId);
  if (kept !== undefined) {
    return answered(kept);
  }
  // Only a new line costs anything, so only a new line counts against a
  // budget.
  if (listener.said >= listener.budget) {
    return refused(429, speechErrors.create("speech.limited"), requestId);
  }
  // A content purge that lands while the voice says the line may have
  // taken it out of the cache already: taken before the request, the
  // mark says whether one did (`keepUnlessPurged`).
  const purges = await onboardingStore(env).purgeMark();
  let speech: Awaited<ReturnType<ReturnType<typeof gatewaySpeech>["speak"]>>;
  try {
    speech = await gatewaySpeech(env, {
      purpose,
      trigger: listener.trigger,
      work: { onboarding: true },
      requestId,
    }).speak({ text: spoken, voice: key.voice, language: key.language, model });
  } catch (error) {
    return failed(error, requestId);
  }
  const answer: SpeechAnswer = {
    audio: toBase64(speech.audio),
    mime: speech.mime,
    words: wordsAsWritten(speech.words, spoken !== asked.text),
  };
  const body = JSON.stringify(answer);
  await Promise.all([
    keepUnlessPurged(env, key, body, purges, requestId),
    countSaid(env, listener, secondsOf(speech.words), requestId),
  ]);
  return answered(body);
};

/** `POST /api/speech`: a line said, for someone's interview link or an admin. */
export const speechResponse = async (
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
  const asked = await requestOf(request);
  if (asked === undefined) {
    return refused(400, speechErrors.create("speech.invalid"), requestId);
  }
  const listener =
    asked.link === undefined
      ? await forAdmin(request, env, requestId)
      : await onLink(env, asked.link, requestId);
  if (listener instanceof Response) {
    return listener;
  }
  return await say(env, asked, listener, requestId);
};
