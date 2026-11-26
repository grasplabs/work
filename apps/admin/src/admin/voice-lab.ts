/**
 * The Voice Lab's session: a try-out of holding an interview as one live
 * voice session at Mistral (its voice agents: speech to text, the model
 * and the voice in one session, with turn-taking and talking over him
 * done there), beside the interview as core holds it turn by turn. A
 * prototype to hear the difference, for Grasp's staff alone: nobody's
 * interview runs on it, nothing said in it is kept, and no client's
 * deployment is touched.
 *
 * The admin opens the session itself, with Grasp's own Mistral key from
 * Secrets Store, as Ask Grasp asks OpenAI (src/admin/ask.ts): the key
 * never leaves this Worker. The page gets what Mistral answers, a
 * short-lived token for one room and where that room is, and its audio
 * then goes between the browser and Mistral directly. That is the point of
 * the try-out and its cost: in a client's deployment every call to a
 * provider goes through connect, and audio the browser sends itself does
 * not. Whether an interview may ever run this way is decided on what this
 * shows.
 *
 * The interviewer is told who he is and how the interview goes in the
 * words core tells him (@grasp-os/shared/interviewers), without what
 * only core's own turns need (what he writes down, the shape he answers
 * in), and with what a spoken session needs instead.
 */
import "@tanstack/react-start/server-only";
import {
  inLanguage,
  LISTENING,
  partsOf,
  WHO,
} from "@grasp-os/shared/interviewers/stephen";
import { log } from "@grasp-os/shared/log";
import { interviewLocaleSchema } from "@grasp-os/shared/onboarding";
import type { InterviewLocale } from "@grasp-os/shared/onboarding";
import { z } from "zod";

import type { Staff } from "../access.ts";
import { adminDatabase, audit } from "../db/act.ts";
import { ifStored, storeSecret } from "../deploy/context.ts";

/** Where Mistral's voice agent sessions are opened and closed: its own host, in the EU. */
const sessionsUrl = "https://api.mistral.ai/v1/audio/sessions";

/** How long opening or closing a session may take. */
const sessionTimeoutMs = 20_000;

/**
 * What the session runs on: the models Mistral names for a voice agent
 * (its docs' Agent configuration), the same family the interview's own
 * turns use in core (apps/core/src/platform-ai.ts).
 */
const models = {
  llm: "mistral-small-latest",
  stt: "voxtral-mini-transcribe-realtime-3",
  tts: "voxtral-mini-tts-3",
} as const;

/**
 * When Mistral hears someone start and stop talking: its own detection, at
 * its defaults. Once the thresholds were set here (a start of 0.3, below
 * the end's 0.33), no session opened any more, most likely refused for
 * them; how talking over him is heard is Mistral's until its docs say
 * which values it takes.
 */
const turnDetection = {} as const;

/** Stephen's voice, by its Mistral ID, as core says his lines (apps/core/src/platform-ai.ts). */
const voice = "voice_485";

/**
 * The interviewer's first line, said as the session connects: the first
 * question of an employee's interview, in each language as the
 * instructions give it in English.
 */
const firstLines: Record<InterviewLocale, string> = {
  en: "First your work as a whole, then one part of it up close. What do you do here, in a sentence or two?",
  nl: "Eerst je werk als geheel, daarna één onderdeel ervan van dichtbij. Wat doe je hier, in een of twee zinnen?",
  de: "Zuerst Ihre Arbeit als Ganzes, dann ein Teil davon aus der Nähe. Was machen Sie hier, in ein oder zwei Sätzen?",
  fr: "D’abord votre travail dans son ensemble, puis une partie de plus près. Que faites-vous ici, en une ou deux phrases ?",
  es: "Primero tu trabajo en conjunto, luego una parte de cerca. ¿Qué haces aquí, en una o dos frases?",
};

/** How he asks for an example where nothing can be shared. */
const EXAMPLE =
  "Then ask whether there is one real example they could show someone later. Nothing can be shared in this conversation.";

/** What he does in the last part, with no screen to read back from. */
const READ_BACK =
  "Say back what you learned, in three or four short sentences, as how the work goes, and ask whether it is right. Put right what they correct. When it is right, thank them by their first name if you know it, and say that this is where it ends.";

/**
 * What a spoken session needs that core's turns don't: everything he
 * writes is said out loud, there is no screen, and his first line is out
 * already.
 */
const spokenOf = (firstLine: string): string => `# This conversation
This is a try-out: a colleague at Grasp plays an employee of a practice company, to hear how you hold an interview out loud. Hold it as you would any interview.
- You talk and they talk, live. Everything you write is said out loud exactly as you write it: write only the words you say. No labels, no lists, no brackets, no notes to yourself.
- They can talk over you. When they do, stop, take what they said, and go on from there. Do not repeat the line you were cut off in unless they ask.
- There is no screen, no button and no file: where these instructions point to one, say in a few words that it is not there in this try-out, and go on.
- You write nothing down here, so nothing carries a mark. What you learned is what was said in this conversation.
- You do not know their name, their team or their team lead: say "I was told" where a lead would be named. The work to learn about is not named yet: in part 3, take the piece that repeats most and costs them most time, by what they said in part 2, and learn that one. Nothing is told to you each turn about what is still open or what the team already told: keep track of what you still miss yourself.
- Your first line was said already: "${firstLine}" Their first answer is to that. Do not say it again.`;

/** Everything the session's model is told, in the language of the conversation. */
export const instructionsOf = (locale: InterviewLocale): string =>
  inLanguage(
    [
      WHO,
      partsOf(EXAMPLE, READ_BACK),
      LISTENING,
      spokenOf(firstLines[locale]),
    ].join("\n\n"),
    locale
  );

/** The language the try-out is held in. */
export const voiceLabInputSchema = z.object({
  locale: interviewLocaleSchema,
});
export type VoiceLabInput = z.infer<typeof voiceLabInputSchema>;

/** A session's ID as Mistral gives one: nothing that reads as a path. */
export const voiceSessionIdSchema = z.string().regex(/^[\w-]{1,128}$/u);

/** Why no session was opened: Grasp's key isn't in the store, or Mistral didn't open one. */
export type VoiceLabRefusal = "no_key" | "not_opened";

/**
 * A session as the page connects to it: its ID, the token for its one
 * room, and where the room is. Never Grasp's key.
 */
export type VoiceLabSession =
  | {
      id: string;
      participantToken: string;
      serverUrl: string;
      /** When the session ends by itself, as Mistral says it: an ISO 8601 time. */
      expiresAt: string;
      refused: null;
    }
  | {
      id: null;
      refused: VoiceLabRefusal;
      /** What Mistral answered, by its HTTP status alone; null when it wasn't asked or didn't answer. */
      status: number | null;
    };

const openedSchema = z.object({
  id: voiceSessionIdSchema,
  participant_token: z.string().min(1),
  server_url: z.url({ protocol: /^wss$/u }),
  expires_at: z.iso.datetime({ offset: true }),
});

/** What Mistral is asked for: the session, whole, as its API takes it. */
export const sessionRequestOf = ({ locale }: VoiceLabInput) => ({
  instructions: instructionsOf(locale),
  llm: { model: models.llm },
  stt: { model: models.stt, language: locale, turn_detection: turnDetection },
  tts: { model: models.tts, voice_id: voice },
  welcome_message: firstLines[locale],
  turn: { allow_interruptions: true },
});

const refused = (
  reason: VoiceLabRefusal,
  status: number | null = null
): VoiceLabSession => ({
  id: null,
  refused: reason,
  status,
});

/** Grasp's Mistral key, or null when it isn't in Secrets Store. */
const keyOf = async (env: Env): Promise<string | null> =>
  await ifStored(async () => await storeSecret(env, "MISTRAL_API_KEY"));

/**
 * Opens a session for `staff`, on record as theirs, with its language:
 * never anything said in it.
 */
export const openVoiceSession = async (
  env: Env,
  staff: Staff,
  input: VoiceLabInput
): Promise<VoiceLabSession> => {
  const apiKey = await keyOf(env);
  if (apiKey === null) {
    return refused("no_key");
  }
  await audit(adminDatabase(env.DB), staff, {
    action: "admin.voice_lab",
    detail: { locale: input.locale },
  });
  try {
    const response = await fetch(sessionsUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(sessionRequestOf(input)),
      signal: AbortSignal.timeout(sessionTimeoutMs),
    });
    const opened = openedSchema.safeParse(
      response.ok ? await response.json() : undefined
    );
    if (!opened.success) {
      // The status alone: Mistral's answer may repeat what it was sent.
      log.warn("admin.voice_lab_not_opened", { status: response.status });
      // Its status only where it refused: an answer that came back but
      // couldn't be joined says nothing more by "200".
      return refused("not_opened", response.ok ? null : response.status);
    }
    return {
      id: opened.data.id,
      participantToken: opened.data.participant_token,
      serverUrl: opened.data.server_url,
      expiresAt: opened.data.expires_at,
      refused: null,
    };
  } catch {
    log.warn("admin.voice_lab_not_opened", { status: 0 });
    return refused("not_opened");
  }
};

/**
 * What Mistral kept of a call, in counts alone: how often he spoke, and
 * how often it heard them talk over him and cut him off. Never what was
 * said.
 */
export interface CallRecord {
  spoke: number;
  cutOff: number;
}

const recordSchema = z.object({
  transcripts: z
    .array(
      z.looseObject({
        role: z.string(),
        is_interruption: z.boolean().optional(),
      })
    )
    .nullish(),
});

/** The counts of a session's record, as Mistral answers it. */
export const recordOf = (answer: unknown): CallRecord | null => {
  const parsed = recordSchema.safeParse(answer);
  if (!parsed.success) {
    return null;
  }
  const his = (parsed.data.transcripts ?? []).filter(
    ({ role }) => role === "assistant"
  );
  return {
    spoke: his.length,
    cutOff: his.filter(({ is_interruption }) => is_interruption === true)
      .length,
  };
};

/**
 * Closes a session at Mistral, once the page left its room, and answers
 * what Mistral kept of it, as counts (`recordOf`): read before it is
 * closed, as a closed one may be gone. It ends by itself when it expires,
 * so one that can't be read or closed is only logged.
 */
export const closeVoiceSession = async (
  env: Env,
  sessionId: string
): Promise<CallRecord | null> => {
  const apiKey = await keyOf(env);
  if (apiKey === null) {
    return null;
  }
  const headers = { authorization: `Bearer ${apiKey}` };
  let record: CallRecord | null = null;
  try {
    const response = await fetch(`${sessionsUrl}/${sessionId}`, {
      headers,
      signal: AbortSignal.timeout(sessionTimeoutMs),
    });
    record = response.ok ? recordOf(await response.json()) : null;
    if (!response.ok) {
      await response.body?.cancel();
      log.warn("admin.voice_lab_not_read", { status: response.status });
    }
  } catch {
    log.warn("admin.voice_lab_not_read", { status: 0 });
  }
  try {
    const response = await fetch(`${sessionsUrl}/${sessionId}`, {
      method: "DELETE",
      headers,
      signal: AbortSignal.timeout(sessionTimeoutMs),
    });
    await response.body?.cancel();
    if (!response.ok && response.status !== 404) {
      log.warn("admin.voice_lab_not_closed", { status: response.status });
    }
  } catch {
    log.warn("admin.voice_lab_not_closed", { status: 0 });
  }
  return record;
};
