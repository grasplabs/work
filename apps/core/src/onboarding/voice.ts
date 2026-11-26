import {
  fromBase64Url,
  sha256Hex,
  toBase64Url,
} from "@grasp-os/shared/encoding";
import { requestErrors } from "@grasp-os/shared/errors";
import {
  interviewLimits,
  interviewPhases,
} from "@grasp-os/shared/interview-links";
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
import { NAMED } from "@grasp-os/shared/interviewers/stephen";
import { log } from "@grasp-os/shared/log";
import { modelErrors } from "@grasp-os/shared/models";
import type {
  InterviewKind,
  InterviewLocale,
} from "@grasp-os/shared/onboarding";
import { z } from "zod";

import { derivedHmacKey } from "../derived-keys.ts";
import { errorResponse } from "../errors.ts";
import { models } from "../models.ts";
import { platformAi } from "../platform-ai.ts";
import { boundedText, jsonOf } from "../request-body.ts";
import { interviewCaller } from "./interview-caller.ts";
import {
  briefOf,
  companyOf,
  situationOf,
  spokenLast,
  TurnFailedError,
  write,
} from "./interview.ts";
import type { Situation, TurnAsked } from "./interview.ts";
import { interviewerText, voiceText } from "./interviewer-text.ts";
import { voiceVersion } from "./lab-marks.ts";
import { linkHeaders, linkRefusal, noCallerRefusal } from "./links.ts";
import { onboardingStore } from "./store.ts";
import type { TurnContext } from "./store.ts";
import { heardBudgets } from "./transcription.ts";

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

/** How long a pass holds: longer than any interview may run (`minutes`, at most 240). */
const passMs = 5 * 60 * 60_000;

/** What the pass is signed for, kept apart from every other key derived from the same secret. */
const passPurpose = "grasp-os onboarding voice session";

/**
 * When Mistral hears someone start and stop talking: its own detection, at
 * its defaults. Once the thresholds were set here (a start of 0.3, below
 * the end's 0.33), no session opened any more, most likely refused for
 * them; how talking over him is heard is Mistral's until its docs say
 * which values it takes.
 */
const turnDetection = {} as const;

/**
 * What Stephen says as the session connects, said for him so the first
 * words come at once: the first question of the interview (`partsOf`,
 * `leadPartsOf`), where they left off, or what they came back to add.
 */
const welcome: Record<
  InterviewLocale,
  Record<"own" | "lead" | "resume" | "add" | "back", string>
> = {
  en: {
    own: "Hi, I’m Stephen—nice to meet you. We’ll start with a quick look at your work overall, then zoom in on one part of it. In a sentence or two, what do you do here?",
    lead: "Hi, I’m Stephen—nice to meet you. We’ll start with what your team handles overall, then who takes care of what. In a few words, what does your team do?",
    resume: "Welcome back. Let's go on where we left off.",
    back: "Welcome back.",
    add: "Welcome back. What would you like to add or put right?",
  },
  nl: {
    own: "Hoi, ik ben Stephen, leuk je te spreken. We beginnen met een kort beeld van je werk in grote lijnen, en daarna zoomen we in op één onderdeel. Wat doe je hier, in een paar zinnen?",
    lead: "Hoi, ik ben Stephen, leuk je te spreken. We beginnen met wat je team in grote lijnen doet, en daarna wie wat oppakt. Waar houdt je team zich mee bezig?",
    resume: "Welkom terug. Laten we verdergaan waar we gebleven waren.",
    back: "Welkom terug.",
    add: "Welkom terug. Wat wil je toevoegen of rechtzetten?",
  },
  de: {
    own: "Hallo, ich bin Stephen, freut mich. Wir schauen uns erst kurz deine Arbeit im Überblick an und gehen dann auf einen Teil genauer ein. Was machst du hier in ein, zwei Sätzen?",
    lead: "Hallo, ich bin Stephen, freut mich. Wir starten mit dem Überblick über dein Team und schauen dann, wer was übernimmt. Wofür ist dein Team zuständig?",
    resume: "Willkommen zurück. Machen wir da weiter, wo wir aufgehört haben.",
    back: "Willkommen zurück.",
    add: "Willkommen zurück. Was möchtest du ergänzen oder richtigstellen?",
  },
  fr: {
    own: "Bonjour, je suis Stephen, ravi de vous rencontrer. On va d’abord voir votre travail dans les grandes lignes, puis zoomer sur une partie précise. En une ou deux phrases, que faites-vous ici ?",
    lead: "Bonjour, je suis Stephen, ravi de vous rencontrer. On va d’abord voir ce que gère votre équipe dans l’ensemble, puis qui s’occupe de quoi. En quelques mots, que fait votre équipe ?",
    resume: "Bon retour. Reprenons là où nous nous étions arrêtés.",
    back: "Bon retour.",
    add: "Bon retour. Que souhaitez-vous ajouter ou corriger ?",
  },
  es: {
    own: "Hola, soy Stephen, encantado. Empezaremos con una vista rápida de tu trabajo en general y luego entraremos en detalle en una parte. En una o dos frases, ¿a qué te dedicas aquí?",
    lead: "Hola, soy Stephen, encantado. Empezaremos viendo de qué se encarga tu equipo en general y luego quién lleva cada parte. En pocas palabras, ¿qué hace tu equipo?",
    resume: "Bienvenido de nuevo. Sigamos donde lo dejamos.",
    back: "Bienvenido de nuevo.",
    add: "Bienvenido de nuevo. ¿Qué te gustaría añadir o corregir?",
  },
};

/** What he says as they switch the language on screen, before his last line again in it. */
const switched: Record<InterviewLocale, string> = {
  en: "Sure, let's go on in English.",
  nl: "Prima, we gaan verder in het Nederlands.",
  de: "Gern, machen wir auf Deutsch weiter.",
  fr: "Très bien, continuons en français.",
  es: "Claro, sigamos en español.",
};

/**
 * What he says first: the first question, said after a quick hello; or,
 * back where they left off, his last line again whole, as they may not
 * have heard all of it when they paused or talked over it; or, in the
 * language they just switched to, that line again in it (`restated`),
 * never the old language's words in the new one's voice.
 */
const welcomeOf = (
  locale: InterviewLocale,
  said: "own" | "lead" | "resume" | "add" | "language",
  before: readonly VoiceLine[],
  restated: string | null
): string => {
  const lines = welcome[locale];
  if (said === "language") {
    return restated === null
      ? switched[locale]
      : `${switched[locale]} ${restated}`;
  }
  const last = before.at(-1);
  if (said === "resume" && last?.from === "stephen" && last.text !== "") {
    return `${lines.back} ${last.text}`;
  }
  return lines[said];
};

const restatedSchema = z.strictObject({ line: z.string().min(1).max(1200) });

/**
 * His last line in the language they switched to, by the model that
 * writes his lines; null when there is none, or it couldn't be had, and
 * he only says that he goes on in it.
 */
const restatedIn = async (
  env: Env,
  locale: InterviewLocale,
  before: readonly VoiceLine[],
  signal: AbortSignal
): Promise<string | null> => {
  const last = before.at(-1);
  if (last?.from !== "stephen" || last.text.trim() === "") {
    return null;
  }
  const model = platformAi.interview.line;
  try {
    const { output, usage } = await models(env).interview.call({
      model,
      purpose,
      trigger: { type: "system" },
      work: { onboarding: true },
      effort: "low",
      system: `You translate what an interviewer just said into ${NAMED[locale]}. It may be cut off mid-sentence: then say the whole thought as he meant it. Keep his meaning, his tone and any names as they are. Answer with the line only.`,
      input: last.text,
      schema: restatedSchema,
      maxTokens: 400,
      signal,
    });
    await onboardingStore(env).meter({
      purpose: "interviews",
      model,
      tokensIn: usage.inputTokens,
      tokensCached: usage.cacheRead,
      tokensOut: usage.outputTokens,
    });
    return output.line.trim();
  } catch {
    return null;
  }
};

/** What he asks after a minute of silence. */
const stillThere: Record<InterviewLocale, string> = {
  en: "Are you still there?",
  nl: "Ben je er nog?",
  de: "Bist du noch da?",
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
      "Call this, silently, when you go to another part of the interview, with that part's name, before your first line of it. Never say the part's name aloud.",
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
  name: string,
  locale: InterviewLocale
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
    "",
    spokenLast(locale),
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
  /** The part he went to last. */
  phase: InterviewPhase | null;
  /** The part their last answer was given in: before he went on from it. */
  answeredIn: InterviewPhase | null;
}

/** What Mistral's answer says of a session; null when it isn't one. */
const heardOf = (answer: unknown): Heard | null => {
  const kept = keptSchema.safeParse(answer);
  if (!kept.success) {
    return null;
  }
  const lines: VoiceLine[] = [];
  let phase: InterviewPhase | null = null;
  let answeredIn: InterviewPhase | null = null;
  for (const turn of kept.data.transcripts ?? []) {
    const text = turn.content?.trim() ?? "";
    if (turn.role === "user" && text !== "") {
      lines.push({ from: "person", text });
      answeredIn = phase;
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
  return { lines, phase, answeredIn };
};

/**
 * Their answers in `lines` as the notes are checked against them: what
 * they said since the first `noted` answers as one answer, with the ones
 * just before it that nothing of Stephen's came between, so a quote
 * across a pause Mistral split an answer at stands, also where part of it
 * was written down before. Quotes stand in it or in the two before.
 */
const joinedSince = (
  lines: readonly VoiceLine[],
  noted: number
): { text: string }[] => {
  const theirs = lines.flatMap((line, at) =>
    line.from === "person" ? [{ text: line.text, at }] : []
  );
  let start = Math.min(noted, theirs.length);
  while (
    start > 0 &&
    start < theirs.length &&
    theirs[start - 1]?.at === (theirs[start]?.at ?? 0) - 1
  ) {
    start -= 1;
  }
  return [
    ...theirs.slice(0, start).map(({ text }) => ({ text })),
    {
      text: theirs
        .slice(start)
        .map(({ text }) => text)
        .join(" "),
    },
  ];
};

// ---- The route ----------------------------------------------------------

/** A 2xx answer's JSON; undefined for any other answer, or one that isn't JSON. Read once, whole. */
/** A word of a refusal's, as the log keeps it: a string or number, cut short. */
const refusalWord = (value: unknown): string =>
  typeof value === "string" || typeof value === "number"
    ? String(value).slice(0, 200)
    : "";

/**
 * What Mistral says it refused in a request, without what it was sent:
 * each field it names (`loc`, `param`) and its words on why (`msg`,
 * `message`, `type`, `code`), never the `input` it may echo back.
 */
export const refusalDetailOf = (body: unknown): string[] => {
  if (typeof body !== "object" || body === null) {
    return [];
  }
  const fieldsOf = (entry: object): string =>
    [
      "loc" in entry && Array.isArray(entry.loc)
        ? entry.loc.map(refusalWord).join(".")
        : "",
      ..."param msg message type code"
        .split(" ")
        .map((key) =>
          key in entry ? refusalWord(Reflect.get(entry, key)) : ""
        ),
    ]
      .filter((part) => part !== "")
      .join(" | ");
  // Mistral may wrap the validation's own answer in its `message`.
  const inner =
    "message" in body &&
    typeof body.message === "object" &&
    body.message !== null
      ? body.message
      : body;
  const detail = "detail" in inner ? inner.detail : undefined;
  const entries: unknown[] = Array.isArray(detail) ? detail : [body];
  return entries
    .flatMap((entry) =>
      typeof entry === "object" && entry !== null ? [fieldsOf(entry)] : []
    )
    .filter((line) => line !== "")
    .slice(0, 8);
};

const jsonOrNothing = async (answered: Response): Promise<unknown> => {
  if (!answered.ok) {
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
  // A session listens as live transcription does, and from the same budget
  // a day: each one opened is counted at what it is expected to last, so a
  // link can't open them without end.
  const listening = await onboardingStore(env).transcriptionOnLink(
    secretMark,
    account
  );
  if (!listening.ok) {
    return linkRefusal(listening.code, requestId);
  }
  const { who } = listening.value;
  const seconds = expectedSeconds[context.kind];
  // What he is told is ready before anything is held: nothing fails
  // between holding the listening and asking Mistral.
  const [voice, company] = await Promise.all([
    voiceText(context.kind, asked.locale),
    companyOf(env),
  ]);
  // Held before Mistral is asked, in one write with the check, so sessions
  // opened side by side can't each find the budget unspent; given back
  // when none opens.
  const heldOn = await onboardingStore(env).reserveListening(
    who,
    seconds,
    heardBudgets.link
  );
  if (heldOn === null) {
    log.warn("interview.voice_budget_spent", { requestId });
    return failed(
      "That is as long as the interview can run today. Come back tomorrow to go on.",
      429
    );
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
  const before = asked.event === "start" ? [] : asked.before;
  const said = asked.event === "start" ? context.kind : asked.event;
  const restated =
    said === "language"
      ? await restatedIn(env, asked.locale, before, AbortSignal.timeout(8000))
      : null;
  const { conversation } = platformAi;
  let answered: Response;
  try {
    answered = await models(env).converse({
      model: `${conversation.provider}/${conversation.model}`,
      purpose,
      trigger: { type: "system" },
      work: { onboarding: true },
      requestId,
      seconds,
      session: {
        instructions: instructionsOf(
          voice.text,
          // Back to add something is what the event says, whatever else came.
          situationOf(
            { ...asked, adding: asked.event === "add" },
            context,
            company
          ),
          before,
          context.name,
          asked.locale
        ),
        stt: {
          model: conversation.listening,
          language: asked.locale,
          turn_detection: turnDetection,
        },
        tts: { model: conversation.speaking, voice_id: conversation.voice },
        welcome_message: welcomeOf(asked.locale, said, before, restated),
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
    await onboardingStore(env).releaseListening(who, seconds, heldOn);
    return failed("The interview could not start. Try again.", 503);
  }
  // A refusal's body is read for what Mistral names as wrong, and only that.
  const refusal = answered.ok
    ? []
    : refusalDetailOf(await answered.json().catch(() => null));
  const raw = await jsonOrNothing(answered);
  const opened = openedSchema.safeParse(raw);
  if (!opened.success) {
    // Mistral's answer may repeat what it was sent: only its status, and
    // the fields it refused with its words on why.
    log.warn("interview.voice_not_opened", {
      requestId,
      status: answered.status,
      ...(refusal.length === 0 ? {} : { refused: refusal.join(" ; ") }),
    });
    // Opened, but with nothing to join it by: closed, as nobody else can.
    const unusable = openedIdSchema.safeParse(raw);
    if (answered.ok && unusable.success) {
      await closeQuietly(env, unusable.data.id, requestId);
    }
    await onboardingStore(env).releaseListening(who, seconds, heldOn);
    return failed("The interview could not start. Try again.", 503);
  }
  const { id, participant_token, server_url, expires_at } = opened.data;
  let pass: string;
  try {
    // In the onboarding's use, as a line said is.
    await onboardingStore(env).meter({
      purpose: "interviews",
      // Its own kind, never Stephen's voice alone: the session listens,
      // answers and speaks.
      model: "conversation",
      seconds,
    });
    await onboardingStore(env).turnRan(secretMark, {
      mark: voice.mark,
      interviewer: "stephen",
      locale: asked.locale,
      version: voiceVersion,
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
  // Grasp's own notes' model, as an interview's turns write theirs
  // (`platformAi.interview`), whatever models the organization set up.
  const notesModel = platformAi.interview.notes;
  const [heard, company] = await Promise.all([
    heardIn(env, session, requestId),
    companyOf(env),
  ]);
  if (heard === null) {
    return failed("What was said could not be read. Try again.", 502);
  }
  const answers = heard.lines.filter(({ from }) => from === "person");
  const phase = heard.phase ?? asked.phase;
  const voice = await voiceText(context.kind, asked.locale);
  const answeredNow = (
    turn: VoiceAnswered["turn"],
    situation: Situation
  ): Response =>
    Response.json(
      {
        noted: Math.max(asked.noted, answers.length),
        // As the page may send them back (`before`): each line and their
        // number within what a request takes.
        lines: heard.lines
          .slice(-interviewLimits.lines)
          .map(({ from, text }) => ({
            from,
            text: text.slice(0, interviewLimits.line),
          })),
        turn,
        instructions: instructionsOf(
          voice.text,
          situationOf(situation, context, company),
          asked.before,
          context.name,
          asked.locale
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
    // The part they answered in, as a turn's brief has it.
    phase: heard.answeredIn ?? asked.phase,
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
    // Never waiting for the rest: Mistral decided their turn ended, and
    // Stephen answered it already. What the notes' model answers holds
    // facts and changes alone (`notesSchema`).
    {
      ...(typeof noted === "object" && noted !== null ? noted : {}),
      more: false,
    },
    {
      answers: joinedSince(heard.lines, asked.noted),
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
