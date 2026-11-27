import type {
  AssistantMessage,
  AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import {
  checkedTurn,
  earlyNext,
  earlyPlainLine,
  onlyLine,
  plainLine,
  waitsForMore,
} from "@grasp-os/shared/interview-turn";
import type { TurnEvent } from "@grasp-os/shared/interview-turn";
import { NAMED } from "@grasp-os/shared/interviewers/stephen";
import { log } from "@grasp-os/shared/log";
import { modelErrors } from "@grasp-os/shared/models";

import { models } from "../models.ts";
import { platformAi } from "../platform-ai.ts";
import {
  briefOf,
  lostThread,
  refusalOf,
  session,
  TurnFailedError,
  write,
} from "./interview.ts";
import type { TurnAsked } from "./interview.ts";
import { interviewerText } from "./interviewer-text.ts";
import { linkHeaders } from "./links.ts";
import type { TurnContext } from "./store.ts";

// One turn of Stephen's as the Stephen Lab holds it (lab.ts, `/api/lab`,
// a local stack's alone): his next line as soon as it is written, and
// what he writes down from what was just said. No interview is held this
// way any more: each is a live conversation with Grasp's ElevenLabs agent
// (voice.ts), whose prompt is its dashboard's. The lab still measures his
// text (interviewer-text.ts) turn by turn, so the turn is kept here, for
// the lab alone, until the lab measures the agent: a quick model says his
// line, in plain named lines, a careful one writes down what was said, as
// the notes step of a conversation does (`write`), both Mistral's on
// Grasp's own key (src/platform-ai.ts). A line that breaks his rules is
// put right before it goes (`asStephenSays`), and a fact whose words
// weren't said is left out (`checkedTurn`).

/** The most the line's model writes: six short lines. */
const lineTokens = 400;

/**
 * What Stephen is told last, after the brief and the format of his line:
 * the language he speaks. His instructions, the brief and their examples
 * are English, and said only at the top they lose out to all that
 * English: a quick model then says a line in English mid-interview, often
 * an example line as it stands. Told last, it is the nearest word to his
 * line.
 */
const languageLast = (locale: TurnAsked["locale"]): string =>
  `Say your line in ${NAMED[locale]}: every word of it, your small words too, also when they answered in another language, and also a line from the examples in your instructions, which you say in ${NAMED[locale]}, never as it stands in English.`;

/** The gateway's own refusals, as the stream ends with them (models.ts). */
const gatewayRefusal = /^The model call was refused \((?<code>[a-z_.]+)\)/u;

/** The text a finished answer holds; it throws when there is none to use. */
const textOfAnswer = (answer: AssistantMessage): string => {
  const text = answer.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
  if (answer.stopReason === "error" || answer.stopReason === "aborted") {
    const code = gatewayRefusal.exec(answer.errorMessage ?? "")?.groups?.code;
    throw code === undefined
      ? new TurnFailedError(
          "Stephen could not answer that. Say it another way.",
          502,
          {
            cause: "declined",
          }
        )
      : refusalOf(code);
  }
  if (text.trim() === "" || answer.stopReason === "length") {
    // Why there was nothing to say, and how much of each kind came, never what.
    log.warn("interview.line_lost", {
      stopReason: answer.stopReason,
      textChars: text.length,
      thinkingChars: answer.content
        .flatMap((block) => (block.type === "thinking" ? [block.thinking] : []))
        .join("").length,
      tokensOut: answer.usage.output,
    });
    throw lostThread();
  }
  return text;
};

interface Turn {
  env: Env;
  turn: TurnAsked;
  context: TurnContext;
  requestId: string;
  system: string;
  brief: string;
  quick: string;
  careful: string;
  signal: AbortSignal;
  send: (event: TurnEvent) => void;
}

/** What a turn's calls took is the lab's: the onboarding counts none of it. */
const notCounted = (): void => undefined;

/** Streams the line's model; `onText` sees everything written so far. */
const speak = async (
  held: Turn,
  model: string,
  onText: (written: string) => void
): Promise<string> => {
  const { env, system, brief, signal } = held;
  const agent = await models(env).interview.agent({
    ...session(model),
    maxTokens: lineTokens,
  });
  const stream: AssistantMessageEventStream = agent.stream(
    agent.model,
    normalizeContext({
      systemPrompt: system,
      messages: [
        {
          role: "user",
          content: `${brief}\n\n${onlyLine}\n${languageLast(held.turn.locale)}`,
          timestamp: Date.now(),
        },
      ],
    }),
    { signal }
  );
  let written = "";
  for await (const event of stream) {
    if (event.type === "text_delta") {
      written += event.delta;
      onText(written);
    }
  }
  return textOfAnswer(await stream.result());
};

/** A promise's outcome, kept to be looked at later: started early, it never goes unhandled. */
type Settled = { ok: true; value: unknown } | { ok: false; error: unknown };

const settled = async (promise: Promise<unknown>): Promise<Settled> => {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
};

/** For a line nobody hears as it is written: the one asked again. */
const unheard = (): void => undefined;

/**
 * One turn: the line as soon as it is written whole (then where the
 * interview goes), what was written down once
 * the line is out, then the whole turn checked. A line the model declines
 * is asked once more of the careful one; anything else that fails is the
 * page's to try again.
 */
const holdTurn = async (held: Turn): Promise<void> => {
  const { turn, quick, careful, send, requestId } = held;
  let early = false;
  let steered = false;
  let notes: Promise<Settled> | null = null;
  const writeNotes = async (): Promise<Settled> => {
    notes ??= settled(write({ ...held, count: notCounted }, careful));
    return await notes;
  };
  // His line goes out whole, never its first sentence ahead of the rest:
  // each part said on its own came out in a voice and tone of its own,
  // loose sentences rather than one line.
  const onText = (written: string) => {
    if (!early) {
      const line = earlyPlainLine(written);
      early = line !== null;
      if (line !== null && line !== false) {
        send({ line });
      }
      // His line is out: what was said is written down from now on,
      // unless he waits for the rest of it.
      if (early && !waitsForMore(written)) {
        void writeNotes();
      }
    }
    if (early && !steered) {
      const next = earlyNext(written);
      steered = next !== null;
      if (next !== null) {
        send({ next });
      }
    }
  };
  let said: string;
  try {
    said = await speak(held, quick, onText);
  } catch (error) {
    if (!(error instanceof TurnFailedError && error.cause === "declined")) {
      throw error;
    }
    // Declined: asked once more, of the careful model. His line then
    // comes with the whole turn.
    said = await speak(held, careful, unheard);
  }
  const line = plainLine(said);
  const written = line.more === true ? null : await writeNotes();
  if (written?.ok === false) {
    throw written.error;
  }
  const noted = written?.value ?? {};
  const { turn: checked, dropped } = checkedTurn(
    { ...line, ...(typeof noted === "object" ? noted : {}) },
    {
      answers: turn.lines.filter(({ from }) => from === "person"),
      known: turn.facts.map(({ id }) => id),
      phase: turn.phase,
    }
  );
  // What he wrote down and was left out used to go unseen: how many and
  // why, so a model that quotes badly shows. Never the words.
  if (dropped.unknownTag + dropped.noText + dropped.notSaid > 0) {
    log.info("interview.notes_dropped", { requestId, ...dropped });
  }
  send({ turn: checked });
};

const encoder = new TextEncoder();

/** One turn to hold, with who it is with given. */
export interface TurnInput {
  env: Env;
  turn: TurnAsked;
  context: TurnContext;
  /** The company's name, while it is read. */
  company: Promise<string>;
  requestId: string;
  ctx: Pick<ExecutionContext, "waitUntil">;
}

/**
 * Holds one turn: the events, a line of JSON at a time, as the lab reads
 * them (scripts/lab/core.ts). What its calls took the onboarding doesn't
 * count: they are the lab's, not anyone's interview.
 */
export const turnStream = async ({
  env,
  turn,
  context,
  company,
  requestId,
  ctx,
}: TurnInput): Promise<Response> => {
  const { line: quick, notes: careful } = platformAi.interview;
  const [{ text: system }, name] = await Promise.all([
    interviewerText(context.kind, turn.locale),
    company,
  ]);
  const cut = new AbortController();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const deliver = async (event: TurnEvent): Promise<void> => {
    try {
      await writer.write(encoder.encode(`${JSON.stringify(event)}\n`));
    } catch {
      // The lab went away: the turn is given up (below).
      cut.abort();
    }
  };
  const send = (event: TurnEvent) => {
    if (!cut.signal.aborted) {
      void deliver(event);
    }
  };
  // Given up because the played person talked on, the lab closes its end:
  // both models are cut off at once.
  const given = async (): Promise<void> => {
    try {
      await writer.closed;
    } catch {
      cut.abort();
    }
  };
  void given();
  const held = (async () => {
    try {
      await holdTurn({
        env,
        turn,
        context,
        requestId,
        system,
        brief: briefOf(turn, context, name),
        quick,
        careful,
        signal: cut.signal,
        send,
      });
    } catch (error) {
      const failed =
        error instanceof TurnFailedError
          ? error
          : refusalOf(modelErrors.codeOf(error));
      if (!(error instanceof TurnFailedError || cut.signal.aborted)) {
        log.error("interview.turn_failed", { requestId });
      }
      send({ error: failed.message, status: failed.status });
    }
    await writer.close().catch(() => null);
  })();
  ctx.waitUntil(held);
  return new Response(readable, {
    headers: {
      ...linkHeaders,
      "content-type": "application/x-ndjson; charset=utf-8",
    },
  });
};
