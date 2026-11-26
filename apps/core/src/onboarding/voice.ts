import {
  fromBase64Url,
  sha256Hex,
  toBase64Url,
} from "@grasp-os/shared/encoding";
import { requestErrors } from "@grasp-os/shared/errors";
import { interviewPhases } from "@grasp-os/shared/interview-links";
import { checkedTurn } from "@grasp-os/shared/interview-turn";
import type { InterviewPhase } from "@grasp-os/shared/interview-turn";
import {
  interviewVoiceMaxBytes,
  interviewVoiceRequestSchema,
  partFunction,
} from "@grasp-os/shared/interview-voice";
import type {
  InterviewVoiceRequest,
  VoiceAnswered,
  VoiceLine,
  VoiceSessionJoin,
} from "@grasp-os/shared/interview-voice";
import {
  inLanguage,
  leadPartsOf,
  LISTENING,
  partsOf,
  WHO,
} from "@grasp-os/shared/interviewers/stephen";
import { log } from "@grasp-os/shared/log";
import { modelErrors } from "@grasp-os/shared/models";
import type {
  InterviewKind,
  InterviewLocale,
} from "@grasp-os/shared/onboarding";
import { z } from "zod";

import { derivedHmacKey } from "../derived-keys.ts";
import { errorResponse } from "../errors.ts";
import { modelForRole, modelSettings, models } from "../models.ts";
import { platformAi } from "../platform-ai.ts";
import { boundedText, jsonOf } from "../request-body.ts";
import { interviewCaller } from "./interview-caller.ts";
import {
  briefOf,
  companyOf,
  situationOf,
  TurnFailedError,
  write,
} from "./interview.ts";
import type { Situation, TurnAsked } from "./interview.ts";
import { interviewerText } from "./interviewer-text.ts";
import { stephenVersion } from "./lab-marks.ts";
import { linkHeaders, linkRefusal, noCallerRefusal } from "./links.ts";
import { onboardingStore } from "./store.ts";
import type { TurnContext } from "./store.ts";

// An interview held as one live voice session at Mistral (its voice
// agents), as the page asks for it at /api/interview/voice
// (@grasp-os/shared/interview-voice). Mistral listens, Stephen answers and
// speaks there, and the person can talk over him; core decides what he is
// told and writes down what was said.
//
// - Open: who they are comes from the store, on their own link, as for a
//   turn (`turnContext`). Core opens the session through the model gateway
//   with Grasp's key, which connect holds, and answers the page only the
//   room's token and address, and a pass that ties the session to the
//   link and the account it was opened for.
// - Answer: once one more answer of theirs stands in Mistral's transcript,
//   core reads it through connect and has the notes' model write down what
//   was said, as a turn does; every fact is checked against the last three
//   answers of that transcript (`checkedTurn`), never against anything the
//   page sends. Core answers what Stephen is told from then on: what he
//   wrote down, what is still open, the time, which the page hands the
//   session. A pass from another link or account opens nothing: nobody
//   reads someone else's session.
// - Close: the session ends at Mistral.
//
// Its audio goes between the browser and Mistral, never through connect:
// a Worker can't relay a live call. That exception to "every external
// call goes through connect" is the owner's decision, made for this. His
// lines are no longer checked in code (one question, no praise): the
// instructions alone hold him to them.

/** What the gateway is told the session and its notes are for. */
const purpose = "onboarding.interview";

/** How long an interview's session is expected to last, as its cost is estimated: an employee's, a lead's. */
const expectedSeconds: Record<InterviewKind, number> = {
  own: 15 * 60,
  lead: 25 * 60,
};

/** How long a pass holds: longer than any interview runs. */
const passMs = 2 * 60 * 60_000;

/** What the pass is signed for, kept apart from every other key derived from the same secret. */
const passPurpose = "grasp-os onboarding voice session";

/**
 * When Mistral hears someone start and stop talking, as the chance its
 * voice detection gives that they are talking: sent whole, never left to
 * the session, where talking over him went unheard in the Voice Lab. A
 * low start, so a few words over him stop him.
 */
const turnDetection = {
  start_threshold: 0.3,
  end_threshold: 0.33,
  min_silence_ms: 500,
} as const;

/** How he asks for an example: the page shows where to drop it. */
const EXAMPLE =
  "Then ask for one real example to share: their screen shows where to drop it.";

/** What he does in the last part: the screen reads back what was written down. */
const READ_BACK = `Say one short line that you will now read back what was written down, and call ${partFunction} with readback. The screen reads it back.`;

/** What a live session needs that a turn doesn't: everything he writes is said out loud. */
const SPOKEN = `# This conversation
You talk and they talk, live and out loud. Everything you write is said exactly as you write it: write only the words you say. No labels, no lists, no brackets, no notes to yourself.
- They can talk over you. When they do, stop, take what they said, and go on from there. Do not repeat the line you were cut off in unless they ask.
- What they say is written down for you by someone else, from what they said: you only talk.
- Each time you go to another part of the interview, call ${partFunction} with the name of that part first, then say your line.
- What follows is renewed after each of their answers: always go by the latest.`;

/** What a session is told whole, before where the interview stands, and its mark. */
const voiceTextOf = async (
  kind: InterviewKind,
  locale: InterviewLocale
): Promise<{ text: string; mark: string }> => {
  const parts =
    kind === "lead" ? leadPartsOf(READ_BACK) : partsOf(EXAMPLE, READ_BACK);
  const text = inLanguage([WHO, parts, LISTENING, SPOKEN].join("\n\n"), locale);
  return { text, mark: await sha256Hex(text) };
};

/**
 * What Stephen says as the session connects, said for him so the first
 * words come at once: the first question of the interview (`partsOf`,
 * `leadPartsOf`), where they left off, or what they came back to add.
 */
const welcome: Record<
  InterviewLocale,
  Record<"own" | "lead" | "resume" | "add", string>
> = {
  en: {
    own: "First your work as a whole, then one part of it up close. What do you do here, in a sentence or two?",
    lead: "First the work of your team as a whole, then who does what. What does your team take care of, in a few words?",
    resume: "Welcome back. Let's go on where we left off.",
    add: "Welcome back. What would you like to add or put right?",
  },
  nl: {
    own: "Eerst je werk als geheel, daarna één onderdeel ervan van dichtbij. Wat doe je hier, in een of twee zinnen?",
    lead: "Eerst het werk van je team als geheel, daarna wie wat doet. Waar zorgt je team voor, in een paar woorden?",
    resume: "Welkom terug. Laten we verdergaan waar we gebleven waren.",
    add: "Welkom terug. Wat wil je toevoegen of rechtzetten?",
  },
  de: {
    own: "Zuerst Ihre Arbeit als Ganzes, dann ein Teil davon aus der Nähe. Was machen Sie hier, in ein oder zwei Sätzen?",
    lead: "Zuerst die Arbeit Ihres Teams als Ganzes, dann wer was macht. Worum kümmert sich Ihr Team, in ein paar Worten?",
    resume: "Willkommen zurück. Machen wir da weiter, wo wir aufgehört haben.",
    add: "Willkommen zurück. Was möchten Sie ergänzen oder richtigstellen?",
  },
  fr: {
    own: "D’abord votre travail dans son ensemble, puis une partie de plus près. Que faites-vous ici, en une ou deux phrases ?",
    lead: "D’abord le travail de votre équipe dans son ensemble, puis qui fait quoi. De quoi votre équipe s’occupe-t-elle, en quelques mots ?",
    resume: "Bon retour. Reprenons là où nous nous étions arrêtés.",
    add: "Bon retour. Que souhaitez-vous ajouter ou corriger ?",
  },
  es: {
    own: "Primero tu trabajo en conjunto, luego una parte de cerca. ¿Qué haces aquí, en una o dos frases?",
    lead: "Primero el trabajo de tu equipo en conjunto, luego quién hace qué. ¿De qué se encarga tu equipo, en pocas palabras?",
    resume: "Bienvenido de nuevo. Sigamos donde lo dejamos.",
    add: "Bienvenido de nuevo. ¿Qué te gustaría añadir o corregir?",
  },
};

/** What he asks after a minute of silence. */
const stillThere: Record<InterviewLocale, string> = {
  en: "Are you still there?",
  nl: "Ben je er nog?",
  de: "Sind Sie noch da?",
  fr: "Vous êtes toujours là ?",
  es: "¿Sigues ahí?",
};

/**
 * A session nobody talks in ends by itself: after a minute of silence
 * Stephen asks once whether they are still there, and after another the
 * session ends. A tab left open bills nothing for long; resuming opens a
 * new one.
 */
const inactivityOf = (locale: InterviewLocale) => ({
  timeout_ms: 60_000,
  max_reminders: 1,
  messages: [stillThere[locale]],
});

/** The function Stephen calls as he goes to another part (`partFunction`). */
const partTool = {
  type: "function",
  function: {
    name: partFunction,
    description:
      "Call this when you go to another part of the interview, with that part's name, before your first line of it.",
    strict: true,
    parameters: {
      type: "object",
      properties: { part: { type: "string", enum: interviewPhases } },
      required: ["part"],
      additionalProperties: false,
    },
  },
} as const;

/**
 * What Stephen is told: who he is and how the interview goes, then where
 * it stands now, and on a new session after a resume, the conversation
 * so far, which that session doesn't know.
 */
const instructionsOf = (
  text: string,
  situation: string[],
  before: readonly VoiceLine[],
  name: string
): string =>
  [
    text,
    "",
    ...situation,
    ...(before.length === 0
      ? []
      : [
          "",
          "The conversation before this session:",
          before
            .map(
              (line) =>
                `${line.from === "stephen" ? "Stephen" : name}: ${line.text}`
            )
            .join("\n"),
        ]),
  ].join("\n");

// ---- The pass ----------------------------------------------------------

const passClaimsSchema = z.strictObject({
  /** The session's ID at Mistral. */
  session: z.string().regex(/^[\w-]{1,128}$/u),
  /** The link's secret mark: the session belongs to that link. */
  link: z.string().min(1),
  /** The account it was opened for. */
  account: z.string().min(1),
  /** When it stops holding, in ms since the epoch. */
  until: z.int().positive(),
});
type PassClaims = z.infer<typeof passClaimsSchema>;

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

/**
 * The session a pass names, when core made it for this link and account
 * and it still holds; null for any other.
 */
const sessionOfPass = async (
  env: Env,
  pass: string,
  link: string,
  account: string
): Promise<string | null> => {
  const [payload, mac, ...rest] = pass.split(".");
  if (payload === undefined || mac === undefined || rest.length > 0) {
    return null;
  }
  try {
    const signed = await crypto.subtle.verify(
      "HMAC",
      await passKey(env, "verify"),
      fromBase64Url(mac),
      new TextEncoder().encode(payload)
    );
    if (!signed) {
      return null;
    }
    const claims = passClaimsSchema.safeParse(
      JSON.parse(new TextDecoder().decode(fromBase64Url(payload)))
    );
    return claims.success &&
      claims.data.link === link &&
      claims.data.account === account &&
      Date.now() < claims.data.until
      ? claims.data.session
      : null;
  } catch {
    return null;
  }
};

// ---- What Mistral answers ------------------------------------------------

/** A session's ID at Mistral: nothing that reads as more of a path. */
const sessionIdSchema = z.string().regex(/^[\w-]{1,128}$/u);

/** Whatever else came with it, the ID of a session Mistral opened. */
const openedIdSchema = z.object({ id: sessionIdSchema });

const openedSchema = z.object({
  id: sessionIdSchema,
  participant_token: z.string().min(1),
  server_url: z.url({ protocol: /^wss$/u }),
  expires_at: z.iso.datetime({ offset: true }),
});

/** A function Stephen called, as the transcript has it. */
const toolCallSchema = z.object({
  name: z.string(),
  arguments: z.string().nullish(),
});

/** One turn of a session's transcript: theirs, his, or a tool's, which tells nothing here. */
const transcriptTurnSchema = z.object({
  role: z.string(),
  content: z.string().nullish(),
  tool_calls: z.array(toolCallSchema).nullish(),
});

/** What Mistral kept of a session: its transcript, none while it has written none down yet. */
const keptSchema = z.object({
  transcripts: z.array(transcriptTurnSchema).nullish(),
});

/** The part `call` names, when it is a call of `partFunction` naming one. */
const partOf = (call: {
  name: string;
  arguments?: string | null | undefined;
}): InterviewPhase | null => {
  if (
    call.name !== partFunction ||
    call.arguments === null ||
    call.arguments === undefined
  ) {
    return null;
  }
  try {
    const named: unknown = JSON.parse(call.arguments);
    const part =
      typeof named === "object" && named !== null && "part" in named
        ? named.part
        : null;
    return interviewPhases.find((phase) => phase === part) ?? null;
  } catch {
    return null;
  }
};

/** A session as Mistral wrote it down: the conversation, and the part Stephen last went to. */
interface Heard {
  lines: VoiceLine[];
  phase: InterviewPhase | null;
}

/** What Mistral's answer says of a session; null when it isn't one. */
const heardOf = (answer: unknown): Heard | null => {
  const kept = keptSchema.safeParse(answer);
  if (!kept.success) {
    return null;
  }
  const lines: VoiceLine[] = [];
  let phase: InterviewPhase | null = null;
  for (const turn of kept.data.transcripts ?? []) {
    const text = turn.content?.trim() ?? "";
    if (turn.role === "user" && text !== "") {
      lines.push({ from: "person", text });
    }
    if (turn.role === "assistant") {
      for (const call of turn.tool_calls ?? []) {
        phase = partOf(call) ?? phase;
      }
      // What was played: cut off where they talked over him.
      if (text !== "") {
        lines.push({ from: "stephen", text });
      }
    }
  }
  return { lines, phase };
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

/** Closes `session` at Mistral; one that won't close ends by itself when it expires. */
const closeQuietly = async (
  env: Env,
  session: string,
  requestId: string
): Promise<void> => {
  try {
    const answered = await models(env).closeConversation(session);
    await answered.body?.cancel();
    if (!answered.ok && answered.status !== 404) {
      log.warn("interview.voice_not_closed", {
        requestId,
        status: answered.status,
      });
    }
  } catch {
    log.warn("interview.voice_not_closed", { requestId, status: 0 });
  }
};

/** Why a request went wrong, as the page is told it. */
const failed = (message: string, status: number): Response =>
  Response.json({ error: message, status }, { status, headers: linkHeaders });

/** The models it runs on: the notes' model, the organization's careful one. */
const notesModelOf = async (env: Env): Promise<string | undefined> => {
  const settings = await modelSettings(env);
  return settings.models.length > 0
    ? modelForRole(settings, "careful")
    : undefined;
};

interface Asked {
  env: Env;
  context: TurnContext;
  secretMark: string;
  account: string;
  requestId: string;
  ctx: Pick<ExecutionContext, "waitUntil">;
}

/** Opens the session, and answers the page what it joins it with. */
const open = async (
  { env, context, secretMark, account, requestId }: Asked,
  asked: Extract<InterviewVoiceRequest, { action: "open" }>
): Promise<Response> => {
  // Nothing said could be written down: no session is opened, nor paid for.
  if ((await notesModelOf(env)) === undefined) {
    log.error("interview.no_model", { requestId });
    return failed("The interview is not set up yet.", 503);
  }
  // The session they left, when they come back with its pass: closed, so
  // only one runs for a link.
  const earlier =
    asked.previous === undefined
      ? null
      : await sessionOfPass(env, asked.previous, secretMark, account);
  if (earlier !== null) {
    await closeQuietly(env, earlier, requestId);
  }
  const [voice, company] = await Promise.all([
    voiceTextOf(context.kind, asked.locale),
    companyOf(env),
  ]);
  const before = asked.event === "start" ? [] : asked.before;
  const said = asked.event === "start" ? context.kind : asked.event;
  const { conversation } = platformAi;
  let answered: Response;
  try {
    answered = await models(env).converse({
      model: `${conversation.provider}/${conversation.model}`,
      purpose,
      trigger: { type: "system" },
      work: { onboarding: true },
      requestId,
      seconds: expectedSeconds[context.kind],
      session: {
        instructions: instructionsOf(
          voice.text,
          situationOf(asked, context, company),
          before,
          context.name
        ),
        stt: {
          model: conversation.listening,
          language: asked.locale,
          turn_detection: turnDetection,
        },
        tts: { model: conversation.speaking, voice_id: conversation.voice },
        welcome_message: welcome[asked.locale][said],
        turn: {
          allow_interruptions: true,
          inactivity: inactivityOf(asked.locale),
        },
        tools: [partTool],
      },
    });
  } catch (error) {
    const code = modelErrors.codeOf(error);
    log.warn("interview.voice_not_opened", {
      requestId,
      ...(code === undefined ? {} : { code }),
    });
    return failed("The interview could not start. Try again.", 503);
  }
  const raw = await jsonOrNothing(answered);
  const opened = openedSchema.safeParse(raw);
  if (!opened.success) {
    // The status alone: Mistral's answer may repeat what it was sent.
    log.warn("interview.voice_not_opened", {
      requestId,
      status: answered.status,
    });
    // Opened, but with nothing to join it by: closed, as nobody else can.
    const unusable = openedIdSchema.safeParse(raw);
    if (answered.ok && unusable.success) {
      await closeQuietly(env, unusable.data.id, requestId);
    }
    return failed("The interview could not start. Try again.", 503);
  }
  const { id, participant_token, server_url, expires_at } = opened.data;
  let pass: string;
  try {
    await onboardingStore(env).turnRan(secretMark, {
      mark: voice.mark,
      interviewer: "stephen",
      locale: asked.locale,
      version: stephenVersion,
    });
    pass = await passOf(env, {
      session: id,
      link: secretMark,
      account,
      until: Date.now() + passMs,
    });
  } catch (error) {
    // Open at Mistral, with no pass the page could close it by.
    await closeQuietly(env, id, requestId);
    throw error;
  }
  const join: VoiceSessionJoin = {
    id,
    participantToken: participant_token,
    serverUrl: server_url,
    expiresAt: expires_at,
    pass,
  };
  return Response.json(join, { headers: linkHeaders });
};

/** Reads what Mistral wrote down of `session`; null when it couldn't be read. */
const heardIn = async (
  env: Env,
  session: string,
  requestId: string
): Promise<Heard | null> => {
  try {
    const answered = await models(env).readConversation(session);
    if (!answered.ok) {
      await answered.body?.cancel();
      log.warn("interview.voice_not_read", {
        requestId,
        status: answered.status,
      });
      return null;
    }
    return heardOf(await answered.json());
  } catch {
    log.warn("interview.voice_not_read", { requestId, status: 0 });
    return null;
  }
};

/** Writes down what was said since the answers already noted, and answers what Stephen is told now. */
const answer = async (
  { env, context, requestId, ctx }: Asked,
  asked: Extract<InterviewVoiceRequest, { action: "answer" }>,
  session: string
): Promise<Response> => {
  const [heard, company, notesModel] = await Promise.all([
    heardIn(env, session, requestId),
    companyOf(env),
    notesModelOf(env),
  ]);
  if (heard === null) {
    return failed("What was said could not be read. Try again.", 502);
  }
  if (notesModel === undefined) {
    log.error("interview.no_model", { requestId });
    return failed("The interview is not set up yet.", 503);
  }
  const answers = heard.lines.filter(({ from }) => from === "person");
  const phase = heard.phase ?? asked.phase;
  const voice = await voiceTextOf(context.kind, asked.locale);
  const answeredNow = (
    turn: VoiceAnswered["turn"],
    situation: Situation
  ): Response =>
    Response.json(
      {
        noted: Math.max(asked.noted, answers.length),
        lines: heard.lines,
        turn,
        instructions: instructionsOf(
          voice.text,
          situationOf(situation, context, company),
          asked.before,
          context.name
        ),
      } satisfies VoiceAnswered,
      { headers: linkHeaders }
    );
  // Nothing new of theirs in the transcript yet: nothing to write down.
  if (answers.length <= asked.noted) {
    return answeredNow(null, { ...asked, phase });
  }
  const { text: system } = await interviewerText(context.kind, asked.locale);
  // Up to their last words, as a turn's brief ends: what Stephen said after
  // them is his, not what was just said.
  const lastAnswer = heard.lines.findLastIndex(({ from }) => from === "person");
  const turn: TurnAsked = {
    // An answer, also when they came back to add something: `adding` says
    // that, and "add" is only the event that opens it.
    event: "answer",
    locale: asked.locale,
    // The whole conversation, as a turn's brief has it: before this
    // session too, on a resume. Quotes are checked in this session's alone.
    lines: [...asked.before, ...heard.lines.slice(0, lastAnswer + 1)],
    facts: asked.facts,
    phase,
    minutes: asked.minutes,
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
    typeof noted === "object" && noted !== null ? noted : {},
    {
      // What they said since the last notes, as one answer: Mistral may
      // split a spoken answer at a pause, or several may come in while
      // notes are written. Quotes stand in it or in the two before.
      answers: [
        ...answers.slice(0, asked.noted),
        {
          text: answers
            .slice(asked.noted)
            .map(({ text }) => text)
            .join(" "),
        },
      ],
      known: asked.facts.map(({ id }) => id),
      phase,
    }
  );
  if (dropped.unknownTag + dropped.noText + dropped.notSaid > 0) {
    log.info("interview.notes_dropped", { requestId, ...dropped });
  }
  // What he is told next counts what was just written down, as the page
  // will hold it.
  const written = [
    ...asked.facts.flatMap((fact) => {
      const change = checked.changes.find(({ id }) => id === fact.id);
      if (change === undefined) {
        return [fact];
      }
      return change.text === null ? [] : [{ ...fact, text: change.text }];
    }),
    ...checked.facts.map((fact, at) => ({
      id: `new-${at + 1}`,
      tag: fact.tag,
      text: fact.text,
    })),
  ];
  return answeredNow(
    { facts: checked.facts, changes: checked.changes, phase },
    { ...asked, phase, facts: written }
  );
};

/** Someone's live voice session, as the page asks for it: open, after an answer, or close. */
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
  // A session is closed on its pass alone, signed for this link and this
  // account: also once they withdrew or the interviews were paused, so
  // nothing of theirs stays open at Mistral.
  if (asked.action === "close") {
    const session = await sessionOfPass(
      env,
      asked.pass,
      secretMark,
      caller.account
    );
    if (session === null) {
      log.warn("interview.voice_pass_refused", { requestId });
      return linkRefusal("interview.invalid", requestId);
    }
    await closeQuietly(env, session, requestId);
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
  const session = await sessionOfPass(
    env,
    asked.pass,
    secretMark,
    caller.account
  );
  if (session === null) {
    log.warn("interview.voice_pass_refused", { requestId });
    return linkRefusal("interview.invalid", requestId);
  }
  return await answer(held, asked, session);
};
