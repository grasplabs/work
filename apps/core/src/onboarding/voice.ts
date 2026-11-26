import { platformRouteOf } from "@grasp-os/shared/ai-providers";
import {
  fromBase64Url,
  sha256Hex,
  toBase64Url,
} from "@grasp-os/shared/encoding";
import { requestErrors } from "@grasp-os/shared/errors";
import { checkedTurn } from "@grasp-os/shared/interview-turn";
import type { SaidAnswer } from "@grasp-os/shared/interview-turn";
import {
  interviewVoiceMaxBytes,
  interviewVoiceRequestSchema,
} from "@grasp-os/shared/interview-voice";
import type {
  InterviewVoiceRequest,
  VoiceAnswered,
  VoiceLine,
  VoiceSessionJoin,
} from "@grasp-os/shared/interview-voice";
import { NAMED } from "@grasp-os/shared/interviewers/stephen";
import { log } from "@grasp-os/shared/log";
import { modelErrors } from "@grasp-os/shared/models";
import type { InterviewKind } from "@grasp-os/shared/onboarding";
import { z } from "zod";

import { derivedHmacKey } from "../derived-keys.ts";
import { errorResponse } from "../errors.ts";
import { models } from "../models.ts";
import { platformAi } from "../platform-ai.ts";
import { usualHostsOf } from "../platform-hosts.ts";
import { boundedText, jsonOf } from "../request-body.ts";
import { interviewCaller } from "./interview-caller.ts";
import { briefOf, companyOf, TurnFailedError, write } from "./interview.ts";
import type { TurnAsked } from "./interview.ts";
import { interviewerText } from "./interviewer-text.ts";
import { linkHeaders, linkRefusal, noCallerRefusal } from "./links.ts";
import { onboardingStore } from "./store.ts";
import type { TurnContext } from "./store.ts";
import { heardBudgets } from "./transcription.ts";

// An interview held as one live conversation with Grasp's ElevenLabs
// agent (`platformAi.agent`), as the page asks for it at
// /api/interview/voice (@grasp-os/shared/interview-voice). ElevenLabs
// listens, Stephen answers and speaks there, and the person can talk over
// him, or types to him in a conversation without sound; core opens the
// conversation and writes down what was said.
//
// - Open: who they are comes from the store, on their own link
//   (`turnContext`). Core asks ElevenLabs for a conversation token
//   through the model gateway, with Grasp's key, which connect holds, and
//   answers the page the token, who the agent talks with, which the page
//   tells it as context, and a pass that ties the conversation to the link
//   and the account it was opened for. The page starts the conversation
//   with ElevenLabs's own SDK. Each one opened is counted against the
//   link's listening for the day at what it is expected to last.
// - Answer: core doesn't read the conversation at ElevenLabs. Once one
//   more answer of theirs is heard, the page sends the conversation as it
//   heard it (`said`), and core has the notes' model write down what was
//   said; every fact is checked against their last three answers in it
//   (`checkedTurn`), a typed one's words as they stand. A pass from
//   another link or account writes nothing down.
// - Answer, in the read-back (`reading`): what they put right after the
//   conversation, typed, said, or changed on their screen (`edit`), is
//   written down the same way, with the lines read back told to the notes'
//   model. No conversation is open then, so it takes no pass: the link and
//   its account are checked, as for every request here.
// - Close: the page left the conversation, which it ends at ElevenLabs
//   itself. Core has nothing open there to close.
//
// Its audio goes between the browser and ElevenLabs, never through
// connect: a Worker can't relay a live call. That exception to "every
// external call goes through connect" is the owner's decision, made for
// this. The agent's prompt, first line, voice and flow are its own, as its
// dashboard sets them: it takes no overrides, and his lines are not
// checked in code.

/** What the gateway is told the conversation and its notes are for. */
const purpose = "onboarding.interview";

/** How long an interview's conversation is expected to last, as its cost is estimated: an employee's, a lead's. */
const expectedSeconds: Record<InterviewKind, number> = {
  own: 15 * 60,
  lead: 25 * 60,
};

/** How long a pass holds: longer than any interview may run (`minutes`, at most 240). */
const passMs = 5 * 60 * 60_000;

/** What the pass is signed for, kept apart from every other key derived from the same secret. */
const passPurpose = "grasp-os onboarding voice session";

/**
 * Which Stephen holds a conversation, as the interview keeps it
 * (`turnRan`): the agent, by its ID. Its prompt is its dashboard's, which
 * core can't mark: a change there keeps this name.
 */
const agentVersion = `agent-${platformAi.agent.id}`;

// ---- The pass ----------------------------------------------------------

const passClaimsSchema = z.strictObject({
  /** The link's secret mark: the conversation belongs to that link. */
  link: z.string().min(1),
  /** The account it was opened for. */
  account: z.string().min(1),
  /** When it stops holding, in ms since the epoch. */
  until: z.int().positive(),
});
type PassClaims = z.input<typeof passClaimsSchema>;

const passKey = async (env: Env, usage: "sign" | "verify") =>
  await derivedHmacKey(env, passPurpose, [usage]);

/** The pass for `claims`: what it says, and core's mark on it. */
const passOf = async (env: Env, claims: PassClaims): Promise<string> => {
  const payload = toBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
  const mac = await crypto.subtle.sign(
    "HMAC",
    await passKey(env, "sign"),
    new TextEncoder().encode(payload)
  );
  return `${payload}.${toBase64Url(new Uint8Array(mac))}`;
};

/** Whether core made `pass` for this link and account, and it still holds. */
const holdsPass = async (
  env: Env,
  pass: string,
  link: string,
  account: string
): Promise<boolean> => {
  const [payload, mac, ...rest] = pass.split(".");
  if (payload === undefined || mac === undefined || rest.length > 0) {
    return false;
  }
  try {
    const signed = await crypto.subtle.verify(
      "HMAC",
      await passKey(env, "verify"),
      fromBase64Url(mac),
      new TextEncoder().encode(payload)
    );
    if (!signed) {
      return false;
    }
    const claims = passClaimsSchema.safeParse(
      JSON.parse(new TextDecoder().decode(fromBase64Url(payload)))
    );
    return (
      claims.success &&
      claims.data.link === link &&
      claims.data.account === account &&
      Date.now() < claims.data.until
    );
  } catch {
    return false;
  }
};

// ---- What was said ------------------------------------------------------

/** The conversation as the page heard it (`said`), without its empty lines. */
const heardOf = (said: readonly VoiceLine[]): VoiceLine[] =>
  said
    .map(({ from, text, typed }) => ({
      from,
      text: text.trim(),
      ...(typed === true ? { typed } : {}),
    }))
    .filter(({ text }) => text !== "");

/** What ElevenLabs answers for a conversation token. */
const agentTokenSchema = z.object({ token: z.string().min(1).max(8192) });

/**
 * Their answers in `lines` as the notes are checked against them: what
 * they said since the first `noted` answers as one answer, with the ones
 * just before it that nothing of Stephen's came between, so a quote
 * across a pause the agent split an answer at stands, also where part of it
 * was written down before. Quotes stand in it or in the two before. An
 * answer counts as typed, its words as they stand, only when every part
 * of it was.
 */
const joinedSince = (
  lines: readonly VoiceLine[],
  noted: number
): SaidAnswer[] => {
  const theirs = lines.flatMap((line, at) =>
    line.from === "person"
      ? [{ text: line.text, typed: line.typed === true, at }]
      : []
  );
  let start = Math.min(noted, theirs.length);
  while (
    start > 0 &&
    start < theirs.length &&
    theirs[start - 1]?.at === (theirs[start]?.at ?? 0) - 1
  ) {
    start -= 1;
  }
  const last = theirs.slice(start);
  return [
    ...theirs.slice(0, start).map(({ text, typed }) => ({ text, typed })),
    {
      text: last.map(({ text }) => text).join(" "),
      typed: last.every(({ typed }) => typed),
    },
  ];
};

// ---- The route ----------------------------------------------------------

/** A 2xx answer's JSON; undefined for any other answer, or one that isn't JSON. Read once, whole. */
const jsonOrNothing = async (answered: Response): Promise<unknown> => {
  if (!answered.ok) {
    await answered.body?.cancel();
    return undefined;
  }
  try {
    const json: unknown = await answered.json();
    return json;
  } catch {
    return undefined;
  }
};

/** Why a request went wrong, as the page is told it. */
const failed = (message: string, status: number): Response =>
  Response.json({ error: message, status }, { status, headers: linkHeaders });

interface Asked {
  env: Env;
  context: TurnContext;
  secretMark: string;
  account: string;
  requestId: string;
  ctx: Pick<ExecutionContext, "waitUntil">;
}

/**
 * What Grasp's ElevenLabs agent is told as a conversation begins, as a
 * contextual update: who it talks with, the language they chose and, on
 * a resume, what was said before. Its prompt, its first line and its flow
 * are the agent's own, as its dashboard sets them, which takes no
 * overrides: this is context, never an instruction to it.
 */
const agentContextOf = (
  context: TurnContext,
  company: string,
  asked: Extract<InterviewVoiceRequest, { action: "open" }>,
  before: readonly VoiceLine[]
): string =>
  [
    context.kind === "lead"
      ? `You are talking with ${context.name}, who leads ${context.team === "" ? "a team" : context.team}${company === "" ? "" : ` at ${company}`}.`
      : `You are talking with ${context.name}${context.team === "" ? "" : `, from ${context.team}`}${company === "" ? "" : ` at ${company}`}.`,
    `They chose to talk in ${NAMED[asked.locale]}.`,
    ...(before.length === 0
      ? []
      : [
          asked.event === "add"
            ? "They agreed to the summary before and came back to add or correct something."
            : "They are back to an interview they left. Go on where it stood; don't start over.",
          "The conversation before:",
          ...before
            .slice(-40)
            .map(
              (line) =>
                `${line.from === "stephen" ? "You" : context.name}: ${line.text}`
            ),
        ]),
  ].join("\n");

/**
 * Opens a conversation with Grasp's ElevenLabs agent, and answers the
 * page what it starts it with: a token for it, asked with Grasp's key
 * through the gateway, and what the agent is told as it begins
 * (`agentContextOf`).
 */
const open = async (
  { env, context, secretMark, account, requestId }: Omit<Asked, "ctx">,
  asked: Extract<InterviewVoiceRequest, { action: "open" }>
): Promise<Response> => {
  // A conversation listens as live transcription does, and from the same
  // budget a day: each one opened is counted at what it is expected to
  // last, so a link can't open them without end.
  const listening = await onboardingStore(env).transcriptionOnLink(
    secretMark,
    account
  );
  if (!listening.ok) {
    return linkRefusal(listening.code, requestId);
  }
  const { who } = listening.value;
  const seconds = expectedSeconds[context.kind];
  // What the agent is told is ready before anything is held: nothing
  // fails between holding the listening and asking ElevenLabs.
  const company = await companyOf(env);
  // Held before ElevenLabs is asked, in one write with the check, so
  // conversations opened side by side can't each find the budget unspent;
  // given back when none opens.
  const held = await onboardingStore(env).reserveListening(
    who,
    seconds,
    heardBudgets.link
  );
  if (held === null) {
    log.warn("interview.voice_budget_spent", { requestId });
    return failed(
      "That is as long as the interview can run today. Come back tomorrow to go on.",
      429
    );
  }
  const notOpened = async (
    why: { code: string } | { status: number }
  ): Promise<Response> => {
    log.warn("interview.voice_not_opened", { requestId, ...why });
    await onboardingStore(env).releaseListening(who);
    return failed("The interview could not start. Try again.", 503);
  };
  const { agent } = platformAi;
  let answered: Response;
  try {
    answered = await models(env).converse(
      {
        model: `${agent.provider}/${agent.id}`,
        purpose,
        trigger: { type: "system" },
        work: { onboarding: true },
        requestId,
        seconds,
      },
      AbortSignal.timeout(10_000)
    );
  } catch (error) {
    return await notOpened({ code: modelErrors.codeOf(error) ?? "unknown" });
  }
  // ElevenLabs's answer is read for its token alone: a refusal's status is
  // all the log keeps of it.
  const token = agentTokenSchema.safeParse(await jsonOrNothing(answered));
  if (!token.success) {
    return await notOpened({ status: answered.status });
  }
  // In the onboarding's use, as a line said is.
  await onboardingStore(env).meter({
    purpose: "interviews",
    // Its own kind, never Stephen's voice alone: the agent listens,
    // answers and speaks.
    model: "conversation",
    seconds,
  });
  await onboardingStore(env).turnRan(secretMark, {
    mark: agent.id,
    interviewer: "stephen",
    locale: asked.locale,
    version: agentVersion,
  });
  const join: VoiceSessionJoin = {
    conversationToken: token.data.token,
    location:
      platformRouteOf(agent.provider, usualHostsOf(env))?.region === "eu"
        ? "eu-residency"
        : "us",
    context: agentContextOf(
      context,
      company,
      asked,
      asked.event === "start" ? [] : asked.before
    ),
    pass: await passOf(env, {
      link: secretMark,
      account,
      until: Date.now() + passMs,
    }),
  };
  return Response.json(join, { headers: linkHeaders });
};

/**
 * Writes down what was said since the answers already noted; in the
 * read-back, what they put right in the lines read back.
 */
const answer = async (
  { env, context, requestId, ctx }: Asked,
  asked: Extract<InterviewVoiceRequest, { action: "answer" }>
): Promise<Response> => {
  // Grasp's own notes' model (`platformAi.interview`), whatever models
  // the organization set up.
  const notesModel = platformAi.interview.notes;
  const lines = heardOf(asked.said);
  const answers = lines.filter(({ from }) => from === "person");
  const answeredNow = (turn: VoiceAnswered["turn"]): Response =>
    Response.json(
      {
        noted: Math.max(asked.noted, answers.length),
        turn,
      } satisfies VoiceAnswered,
      { headers: linkHeaders }
    );
  // Nothing new of theirs was heard yet: nothing to write down.
  if (answers.length <= asked.noted) {
    return answeredNow(null);
  }
  const [{ text: system }, company] = await Promise.all([
    interviewerText(context.kind, asked.locale),
    companyOf(env),
  ]);
  // Up to their last words, where the brief ends: what Stephen said after
  // them is his, not what was just said.
  const lastAnswer = lines.findLastIndex(({ from }) => from === "person");
  const turn: TurnAsked = {
    // An answer, also when they came back to add something: `adding` says
    // that, and "add" is only the event that opens it. In the read-back,
    // their answer to the lines read back.
    event: asked.reading === undefined ? "answer" : "readback",
    locale: asked.locale,
    // The whole conversation: before this one too, on a resume and in the
    // read-back. Quotes are checked in this one's alone.
    lines: [...asked.before, ...lines.slice(0, lastAnswer + 1)],
    facts: asked.facts,
    phase: asked.phase,
    minutes: asked.minutes,
    ...(asked.reading === undefined ? {} : { reading: asked.reading }),
    adding: asked.adding,
  };
  const counting: Promise<void>[] = [];
  let noted: unknown;
  try {
    noted = await write(
      {
        env,
        system,
        brief: briefOf(turn, context, company),
        signal: AbortSignal.timeout(60_000),
        count: (took) => {
          if (took !== null) {
            counting.push(onboardingStore(env).meter(took));
          }
        },
      },
      notesModel
    );
  } catch (error) {
    const message =
      error instanceof TurnFailedError
        ? error.message
        : "Stephen lost his thread. Say it once more.";
    return failed(
      message,
      error instanceof TurnFailedError ? error.status : 502
    );
  } finally {
    ctx.waitUntil(Promise.allSettled(counting));
  }
  const { turn: checked, dropped } = checkedTurn(
    // Never waiting for the rest: the agent decided their turn ended, and
    // Stephen answered it already. What the notes' model answers holds
    // facts and changes alone (`notesSchema`).
    {
      ...(typeof noted === "object" && noted !== null ? noted : {}),
      more: false,
    },
    {
      answers: joinedSince(lines, asked.noted),
      known: asked.facts.map(({ id }) => id),
      phase: asked.phase,
    }
  );
  if (dropped.unknownTag + dropped.noText + dropped.notSaid > 0) {
    log.info("interview.notes_dropped", { requestId, ...dropped });
  }
  const { edit } = asked;
  if (edit !== undefined) {
    // They changed the line on their screen themselves: exactly that
    // change, their words as they stand, whatever the notes' model made of
    // it. Only the line for the record is the model's, in English.
    const record = checked.changes.find(({ id }) => id === edit.id)?.record;
    return answeredNow({
      facts: [],
      changes: [{ id: edit.id, text: edit.text, record: record ?? edit.text }],
      phase: asked.phase,
    });
  }
  return answeredNow({
    facts: checked.facts,
    changes: checked.changes,
    phase: asked.phase,
  });
};

/** Someone's live conversation, as the page asks for it: open, after an answer, or close. */
export const interviewVoiceResponse = async (
  request: Request,
  env: Env,
  requestId: string,
  ctx: Pick<ExecutionContext, "waitUntil">
): Promise<Response> => {
  if (request.method !== "POST") {
    return errorResponse(
      405,
      requestErrors.create("request.not_found"),
      requestId
    );
  }
  // Who asks, before anything they sent is read (interview-caller.ts).
  const caller = await interviewCaller(env, request.headers);
  if (typeof caller === "string") {
    return noCallerRefusal(caller, requestId);
  }
  const length = Number(request.headers.get("content-length") ?? 0);
  const raw =
    length > interviewVoiceMaxBytes
      ? undefined
      : await boundedText(request.body, interviewVoiceMaxBytes);
  const parsed = interviewVoiceRequestSchema.safeParse(
    raw === undefined ? undefined : jsonOf(raw)
  );
  if (!parsed.success) {
    return linkRefusal("interview.invalid", requestId);
  }
  const asked = parsed.data;
  const secretMark = await sha256Hex(asked.secret);
  // A close is taken on its pass alone, signed for this link and this
  // account: also once they withdrew or the interviews were paused. The
  // page ended the conversation at ElevenLabs itself.
  if (asked.action === "close") {
    if (!(await holdsPass(env, asked.pass, secretMark, caller.account))) {
      log.warn("interview.voice_pass_refused", { requestId });
      return linkRefusal("interview.invalid", requestId);
    }
    // What the conversation held of the day's listening and didn't use
    // is given back, once.
    await onboardingStore(env).settleListeningOnLink(secretMark);
    return new Response(null, { status: 204, headers: linkHeaders });
  }
  const found = await onboardingStore(env).turnContext(
    secretMark,
    caller.account
  );
  if (!found.ok) {
    if (found.code === "interview.link_invalid") {
      log.warn("interview.link_invalid", { requestId });
    }
    return linkRefusal(found.code, requestId);
  }
  const held: Asked = {
    env,
    context: found.value,
    secretMark,
    account: caller.account,
    requestId,
    ctx,
  };
  if (asked.action === "open") {
    return await open(held, asked);
  }
  const { edit, reading } = asked;
  // A line changed on screen is one of the lines read back to them.
  const editFits =
    edit === undefined ||
    (reading !== undefined && asked.facts.some(({ id }) => id === edit.id));
  if (!editFits) {
    return linkRefusal("interview.invalid", requestId);
  }
  // An answer of a conversation comes with the pass core opened it with.
  if (
    reading === undefined &&
    (asked.pass === undefined ||
      !(await holdsPass(env, asked.pass, secretMark, caller.account)))
  ) {
    log.warn("interview.voice_pass_refused", { requestId });
    return linkRefusal("interview.invalid", requestId);
  }
  return await answer(held, asked);
};
