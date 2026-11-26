import { toBase64 } from "@grasp-os/shared/encoding";
import { log } from "@grasp-os/shared/log";
import { transcriptionErrors } from "@grasp-os/shared/voice";
import type {
  LiveTranscription,
  TranscriptionEvent,
  TranscriptionOptions,
  TranscriptionSession,
} from "@grasp-os/shared/voice";
import { z } from "zod";

import { models } from "./models.ts";
import type { Listening } from "./models.ts";
import { platformAi } from "./platform-ai.ts";
import { Resampler } from "./resampler.ts";

// Live transcription as core implements it: Grasp's own transcription
// feature (@grasp-os/shared/platform-ai), Mistral's Voxtral realtime
// transcription, over a WebSocket that connect opens to Mistral with
// Grasp's key and relays (connect's `modelSocket`): core sends no key,
// and the browser never sees the upstream. Only for a listening the model
// gateway admitted (models.ts, `models(env).listen`): the rules and the
// budgets let it through first, and the socket is the one its admission
// opens. The caller holds it to the seconds admitted, and says what it
// heard (`Listening.heard`).
//
// Chosen over OpenAI's realtime session, which this used before: that one
// sent its words only once its voice detection settled a stretch, so a
// person saw nothing while they spoke. Voxtral writes words down as they
// are said, a few hundred milliseconds behind (`streamingDelayMs`), the
// same model the interview's live session listens with.
//
// The session wants 16-bit PCM at 16 kHz; the page sends its own rate, so
// the audio is resampled as it comes (`Resampler`). It goes through as it
// comes, and nothing of it is kept: not here, not in a log.
//
// Ordering: the page counts on exactly one `final` for each of its
// commits, in order, holding the whole stretch it closed. Voxtral has no
// stretches of its own: it streams text, behind the audio by its delay.
// A commit asks it to write down what it still holds
// (`input_audio.flush`), and the stretch's final goes out once its words
// stop coming (`settledMs` without one), or at the latest `settleMostMs`
// after the commit: every word since the stretch before (`settlingOf`).

/** The session's own path at the provider, which connect allows with its model. */
const realtimePath = "/v1/audio/transcriptions/realtime";

/** The sample rate the realtime session takes PCM at. */
export const sessionSampleRate = 16_000;

/** How far behind the audio Voxtral may write, for words as they are said. */
const streamingDelayMs = 240;

/** A stretch is settled once no word came for this long after its commit. */
const settledMs = 300;

/** A stretch is settled at the latest this long after its commit. */
const settleMostMs = 1200;

/** The most words to listen out for that the session is given. */
const mostTerms = 100;

/** What the session sends, as far as the relay reads it: the first that fits. */
const serverEventSchema = z.union([
  z.object({ type: z.literal("session.created") }),
  z.object({ type: z.literal("transcription.text.delta"), text: z.string() }),
  z.object({
    type: z.literal("error"),
    error: z.object({ code: z.number().nullish() }).loose(),
  }),
  z.object({ type: z.string() }),
]);

type ServerEvent = z.infer<typeof serverEventSchema>;

/** One of the session's events, read; `undefined` for none it reads. */
const serverEventOf = (data: unknown): ServerEvent | undefined => {
  if (typeof data !== "string") {
    return undefined;
  }
  try {
    return serverEventSchema.safeParse(JSON.parse(data)).data;
  } catch {
    return undefined;
  }
};

/** Events in the order they come, for one reader, until ended. */
class EventQueue implements AsyncIterable<TranscriptionEvent> {
  readonly #queued: TranscriptionEvent[] = [];
  #ended = false;
  #wake: (() => void) | undefined = undefined;

  push(event: TranscriptionEvent): void {
    if (!this.#ended) {
      this.#queued.push(event);
      this.#wake?.();
    }
  }

  end(): void {
    this.#ended = true;
    this.#wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<TranscriptionEvent> {
    while (true) {
      const next = this.#queued.shift();
      if (next !== undefined) {
        yield next;
      } else if (this.#ended) {
        return;
      } else {
        const woken = Promise.withResolvers<null>();
        this.#wake = () => {
          woken.resolve(null);
        };
        // oxlint-disable-next-line no-await-in-loop -- one event at a time
        await woken.promise;
        this.#wake = undefined;
      }
    }
  }
}

/** Where a stretch's words wait for its one final (`settlingOf`). */
interface Settling {
  /** Words written down, as they come. */
  delta: (text: string) => void;
  /** The page closed its stretch. */
  pageCommitted: () => void;
  /** No final will come any more. */
  stop: () => void;
}

/**
 * A partial with the stretch so far for each word that comes, and one
 * final for each of the page's commits, in order, once its words stopped
 * coming.
 */
const settlingOf = (events: EventQueue): Settling => {
  let stretch = "";
  /** When each commit not yet answered was made, oldest first. */
  const commits: number[] = [];
  let lastWordAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined = undefined;
  const settle = (): void => {
    timer = undefined;
    const [oldest] = commits;
    if (oldest === undefined) {
      return;
    }
    const now = Date.now();
    const quietSince = Math.max(lastWordAt, oldest);
    const due = Math.min(quietSince + settledMs, oldest + settleMostMs);
    if (now < due) {
      timer = setTimeout(settle, due - now);
      return;
    }
    commits.shift();
    // The session times no words: a final carries its text alone.
    events.push({ type: "committed", text: stretch.trim(), words: [] });
    stretch = "";
    if (commits.length > 0) {
      settle();
    }
  };
  return {
    delta: (text) => {
      stretch += text;
      lastWordAt = Date.now();
      events.push({ type: "partial", text: stretch.trim() });
    },
    pageCommitted: () => {
      commits.push(Date.now());
      timer ??= setTimeout(settle, settledMs);
    },
    stop: () => {
      clearTimeout(timer);
      commits.length = 0;
    },
  };
};

/**
 * The session's settings: PCM at 16 kHz, the language, the words to
 * listen out for, and a short delay, for words as they are said.
 */
const sessionUpdate = ({ language, keyterms }: TranscriptionOptions): string =>
  JSON.stringify({
    type: "session.update",
    session: {
      audio_format: { encoding: "pcm_s16le", sample_rate: sessionSampleRate },
      language,
      target_streaming_delay_ms: streamingDelayMs,
      ...(keyterms.length === 0
        ? {}
        : { context_bias: keyterms.slice(0, mostTerms) }),
    },
  });

/** The longest the session may take to say it was created. */
const createdWithinMs = 10_000;

/** Waits for the session to say it was created; throws when it won't. */
const created = async (socket: WebSocket): Promise<void> => {
  const { promise, resolve, reject } = Promise.withResolvers<null>();
  const timer = setTimeout(() => {
    reject(new Error("The session wasn't created in time"));
  }, createdWithinMs);
  const heard = (event: MessageEvent): void => {
    const read = serverEventOf(event.data);
    if (read?.type === "session.created") {
      resolve(null);
    } else if (read !== undefined && "error" in read) {
      log.warn("transcription.upstream_error", {
        code: read.error.code ?? undefined,
      });
      reject(new Error("The session was refused"));
    }
  };
  const closed = (): void => {
    reject(new Error("The session closed"));
  };
  socket.addEventListener("message", heard);
  socket.addEventListener("close", closed);
  try {
    await promise;
  } finally {
    clearTimeout(timer);
    socket.removeEventListener("message", heard);
    socket.removeEventListener("close", closed);
  }
};

/**
 * Live transcription for a listening the gateway admitted: a realtime
 * session of its own at the provider, through connect.
 */
export const platformTranscription = (
  listening: Listening
): LiveTranscription => ({
  open: async (options): Promise<TranscriptionSession> => {
    let socket: WebSocket;
    try {
      socket = await listening.socket(
        `${realtimePath}?model=${encodeURIComponent(listening.modelId)}`
      );
    } catch {
      throw transcriptionErrors.create("transcription.failed");
    }
    try {
      await created(socket);
    } catch {
      try {
        socket.close(1000, "Done");
      } catch {
        // Closed already.
      }
      throw transcriptionErrors.create("transcription.failed");
    }
    socket.send(sessionUpdate(options));
    const events = new EventQueue();
    const settling = settlingOf(events);
    const resampler = new Resampler(options.sampleRate, sessionSampleRate);
    let closed = false;
    const ended = (failed: string | undefined): void => {
      if (!closed && failed !== undefined) {
        events.push({ type: "failed", code: failed });
      }
      closed = true;
      settling.stop();
      events.end();
    };
    socket.addEventListener("message", (event) => {
      const heard = serverEventOf(event.data);
      if (heard === undefined) {
        return;
      }
      if ("text" in heard) {
        settling.delta(heard.text);
      } else if ("error" in heard) {
        // Only its code, which names no content.
        log.warn("transcription.upstream_error", {
          code: heard.error.code ?? undefined,
        });
        ended("upstream_error");
        try {
          socket.close(1000, "Done");
        } catch {
          // Closed already.
        }
      }
    });
    socket.addEventListener("close", (event) => {
      ended(event.code === 1000 ? undefined : "upstream_closed");
    });
    socket.addEventListener("error", () => {
      ended("upstream_error");
    });
    const send = (event: object): void => {
      if (!closed) {
        socket.send(JSON.stringify(event));
      }
    };
    return {
      send: (audio) => {
        const resampled = resampler.push(audio);
        if (resampled.byteLength > 0) {
          send({ type: "input_audio.append", audio: toBase64(resampled) });
        }
      },
      commit: () => {
        if (!closed) {
          settling.pageCommitted();
        }
        send({ type: "input_audio.flush" });
      },
      close: () => {
        if (!closed) {
          closed = true;
          settling.stop();
          try {
            socket.close(1000, "Done");
          } catch {
            // Closed already.
          }
        }
        events.end();
      },
      events,
    };
  },
});

/** The transcription model recordings are written down with, as the gateway names it. */
export const transcriptionModel = `${platformAi.transcription.provider}/${platformAi.transcription.model}`;

/** The transcription model live sockets write down with, as the gateway names it. */
export const liveTranscriptionModel = `${platformAi.liveTranscription.provider}/${platformAi.liveTranscription.model}`;

/**
 * Whether a member's dictation is set up here, as the page asks before it
 * offers a microphone (`SessionApi.dictationSetUp`): the gateway's own
 * word on what the relay answers as `transcription.unavailable`
 * (onboarding/transcription.ts), with no call made. Never the day's
 * budget, a busy gateway or a failure: those pass, and a microphone
 * hidden for them would stay hidden.
 */
export const dictationSetUp = async (env: Env): Promise<boolean> =>
  await models(env).canListen(liveTranscriptionModel);
