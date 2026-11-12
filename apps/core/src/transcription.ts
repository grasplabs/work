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

import type { Listening } from "./models.ts";
import { Resampler } from "./resampler.ts";

// Live transcription as core implements it: Grasp's own transcription
// feature (@grasp-os/shared/platform-ai), Mistral's realtime transcription
// session, over a WebSocket that connect opens to Mistral with Grasp's key
// and relays (connect's `modelSocket`): core sends no key, and the browser
// never sees the upstream. Only for a listening the model gateway admitted
// (models.ts, `models(env).listen`): the rules and the budgets let it
// through first, and the socket is the one its admission opens. The caller
// holds it to the seconds admitted, and says what it heard
// (`Listening.heard`).
//
// Chosen over writing each stretch down from a recording as it closes:
// the realtime session hears as it goes and sends its words as they come,
// which the relay passes on (`partial`, then `final`); a recording each
// stretch would lose the partials, and wait for a whole request at the end
// of each. Connect relays the socket, so the key stays there.
//
// The session is told 16-bit PCM at 16 kHz, Mistral's own rate; the page
// sends its own rate, so the audio is resampled as it comes (`Resampler`).
// It goes through as it comes (resampler.ts), and nothing of it is kept:
// not here, not in a log.
//
// Settling: the page counts on exactly one `final` for each of its
// commits, in order, holding the whole stretch it closed. The session
// sends words only (`transcription.text.delta`, each final, to be added to
// the ones before), a little behind the audio (`streamingDelayMs`), and
// names no end of a stretch: its one `transcription.done` ends the whole
// session. So a commit flushes the audio sent so far
// (`input_audio.flush`), which has the session write down what it still
// held back, and the stretch's final goes out once no more words came for
// `settleMs`: the session says nothing when a flush is through. Words
// that come later than that open the next stretch, so none are lost. A
// commit with nothing said settles as an empty final.
//
// The realtime session takes names and terms to listen out for
// (`context_bias`) and no free text, so what was said just before, which
// the page may still send (`previousText`), goes nowhere.

/** The sample rate the realtime session is sent PCM at: Mistral's own. */
export const sessionSampleRate = 16_000;

/** The session's own path and query at the provider, which connect allows. */
const realtimePathOf = (model: string): string =>
  `/v1/audio/transcriptions/realtime?model=${model}`;

/**
 * How far behind the audio the session writes, in ms: Mistral's own
 * starting point between quick (80) and sure (2,400).
 */
const streamingDelayMs = 480;

/**
 * How long after a commit, and after each word that still comes, a
 * stretch waits for more before its final goes out: above what the
 * session takes to write down flushed audio, below what someone waits for
 * their words.
 */
export const settleMs = 700;

/** What the session sends, as far as the relay reads it: the first that fits. */
const serverEventSchema = z.union([
  z.object({ type: z.literal("transcription.text.delta"), text: z.string() }),
  z.object({
    type: z.literal("error"),
    error: z.object({ code: z.union([z.number(), z.string()]).nullish() }),
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
  /** The page asked to settle what it sent so far. */
  pageCommitted: () => void;
  /** The session wrote more words down. */
  delta: (text: string) => void;
  /** No final goes out any more. */
  stop: () => void;
}

/**
 * One final for each of the page's commits, in order: the words that
 * came since the one before, once none came for `settleMs` after the
 * commit. Commits that settle together share the words between them: the
 * first has them all.
 */
const settlingOf = (events: EventQueue): Settling => {
  /** The stretch being said, as the session wrote it so far. */
  let saying = "";
  /** The page's commits whose final hasn't gone out. */
  let unsettled = 0;
  let quiet: ReturnType<typeof setTimeout> | undefined = undefined;
  const settle = (): void => {
    quiet = undefined;
    for (; unsettled > 0; unsettled -= 1) {
      // The session times no words: a final carries its text alone.
      events.push({ type: "committed", text: saying.trim(), words: [] });
      saying = "";
    }
  };
  const wait = (): void => {
    clearTimeout(quiet);
    quiet = setTimeout(settle, settleMs);
  };
  return {
    pageCommitted: () => {
      unsettled += 1;
      wait();
    },
    delta: (text) => {
      // As Mistral sends it: each delta brings its own spaces.
      saying += text;
      events.push({ type: "partial", text: saying.trim() });
      if (unsettled > 0) {
        wait();
      }
    },
    stop: () => {
      clearTimeout(quiet);
    },
  };
};

/**
 * The session's settings, sent before any audio, as Mistral takes none
 * after: PCM at 16 kHz, the language, how far behind it writes, and the
 * words to listen out for.
 */
const sessionUpdate = ({ language, keyterms }: TranscriptionOptions): string =>
  JSON.stringify({
    type: "session.update",
    session: {
      audio_format: { encoding: "pcm_s16le", sample_rate: sessionSampleRate },
      target_streaming_delay_ms: streamingDelayMs,
      language,
      ...(keyterms.length === 0 ? {} : { context_bias: keyterms }),
    },
  });

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
      socket = await listening.socket(realtimePathOf(listening.modelId));
    } catch {
      throw transcriptionErrors.create("transcription.failed");
    }
    socket.send(sessionUpdate(options));
    const events = new EventQueue();
    const settling = settlingOf(events);
    const resampler = new Resampler(options.sampleRate, sessionSampleRate);
    let closed = false;
    /** Ends the session's events, with `code` as why unless it was closed. */
    const end = (code?: string): void => {
      if (!closed && code !== undefined) {
        events.push({ type: "failed", code });
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
        end("upstream_error");
        try {
          socket.close(1000, "Done");
        } catch {
          // Closed already.
        }
      }
    });
    socket.addEventListener("close", (event) => {
      end(event.code === 1000 ? undefined : "upstream_closed");
    });
    socket.addEventListener("error", () => {
      end("upstream_error");
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
        // Has the session write down what it still held back.
        send({ type: "input_audio.flush" });
      },
      close: () => {
        if (!closed) {
          closed = true;
          try {
            socket.close(1000, "Done");
          } catch {
            // Closed already.
          }
        }
        settling.stop();
        events.end();
      },
      events,
    };
  },
});
