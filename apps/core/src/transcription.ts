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
// A session for each stretch: the page counts on exactly one `final` for
// each of its commits, in order, holding the whole stretch it closed, and
// goes on sending the next stretch without waiting for it. Mistral's
// session sends words only (`transcription.text.delta`, each final, to be
// added to the ones before), behind the audio by `streamingDelayMs`, and
// says a stretch is whole in one way alone: once its audio is ended
// (`input_audio.end`), it writes down what it still held back and sends
// the whole text (`transcription.done`), which ends that session. So each
// stretch has a session of its own: a commit ends the audio of the one
// being said, whose `done` is the stretch's final, and opens the next,
// which takes the audio that comes meanwhile once it is open. No word can
// be in another stretch's final, and no final goes out before its words
// are whole. A final that doesn't come within `doneWaitMs` fails the
// whole listening, and the page has its stretches written down from their
// recordings. A commit with nothing sent settles as an empty final.
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
 * How long a stretch's whole text may take once its audio ended, in ms,
 * before the listening counts as failed: well above the page's own wait
 * for a stretch's words, after which it has the recording written down.
 */
export const doneWaitMs = 5000;

/** What the session sends, as far as the relay reads it: the first that fits. */
const serverEventSchema = z.union([
  z.object({ type: z.literal("transcription.text.delta"), text: z.string() }),
  z.object({ type: z.literal("transcription.done"), text: z.string() }),
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

/** One stretch of what someone says, and the session it is written down in. */
interface Stretch {
  /** Its session's socket, once open. */
  socket: WebSocket | undefined;
  /** What to send its session once it is open, in order. */
  waiting: string[];
  /** Whether any audio was sent to it. */
  heard: boolean;
  /** Its words so far, as the session wrote them. */
  text: string;
  /** Its audio ended: the page committed it. */
  ending: boolean;
  /** Its whole text, once the session said it is. */
  written: PromiseWithResolvers<string>;
  /** Fails the listening if its whole text doesn't come. */
  overdue: ReturnType<typeof setTimeout> | undefined;
}

const newStretch = (): Stretch => ({
  socket: undefined,
  waiting: [],
  heard: false,
  text: "",
  ending: false,
  written: Promise.withResolvers<string>(),
  overdue: undefined,
});

/** Closes `socket` as it may still be: a socket closed already stays so. */
const closeQuietly = (socket: WebSocket | undefined): void => {
  try {
    socket?.close(1000, "Done");
  } catch {
    // Closed already.
  }
};

/** Sends `message` to a stretch's session, once it is open. */
const tell = (stretch: Stretch, message: object): void => {
  const text = JSON.stringify(message);
  if (stretch.socket === undefined) {
    stretch.waiting.push(text);
  } else {
    stretch.socket.send(text);
  }
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
 * session at the provider for each stretch, through connect.
 */
export const platformTranscription = (
  listening: Listening
): LiveTranscription => ({
  open: async (options): Promise<TranscriptionSession> => {
    const events = new EventQueue();
    const resampler = new Resampler(options.sampleRate, sessionSampleRate);
    /** The stretches whose sessions are open, or opening. */
    const open = new Set<Stretch>();
    let closed = false;
    /** Ends the listening: every session closed, with `code` as why it failed. */
    const end = (code?: string): void => {
      if (closed) {
        return;
      }
      closed = true;
      if (code !== undefined) {
        events.push({ type: "failed", code });
      }
      for (const stretch of open) {
        clearTimeout(stretch.overdue);
        closeQuietly(stretch.socket);
      }
      open.clear();
      events.end();
    };
    /** Reads what a stretch's session sends, until its whole text came. */
    const read = (stretch: Stretch, socket: WebSocket): void => {
      socket.addEventListener("message", (event) => {
        const heard = serverEventOf(event.data);
        if (heard === undefined || closed) {
          return;
        }
        if (heard.type === "transcription.done" && "text" in heard) {
          clearTimeout(stretch.overdue);
          open.delete(stretch);
          stretch.written.resolve(heard.text.trim());
          closeQuietly(socket);
        } else if ("text" in heard) {
          // As Mistral sends it: each delta brings its own spaces.
          stretch.text += heard.text;
          // Once committed, its words go out whole, as its final.
          if (!stretch.ending) {
            events.push({ type: "partial", text: stretch.text.trim() });
          }
        } else if ("error" in heard) {
          // Only its code, which names no content.
          log.warn("transcription.upstream_error", {
            code: heard.error.code ?? undefined,
          });
          end("upstream_error");
        }
      });
      socket.addEventListener("close", (event) => {
        if (!open.has(stretch)) {
          // Its whole text came: closed from here.
          return;
        }
        // The session being said ending by itself ends the listening; one
        // that owes its text, or closes any other way, fails it.
        end(
          event.code === 1000 && !stretch.ending ? undefined : "upstream_closed"
        );
      });
      socket.addEventListener("error", () => {
        if (open.has(stretch)) {
          end("upstream_error");
        }
      });
    };
    /** Opens a stretch's session, and sends what waited for it. */
    const start = async (stretch: Stretch): Promise<void> => {
      open.add(stretch);
      const socket = await listening.socket(realtimePathOf(listening.modelId));
      if (closed) {
        closeQuietly(socket);
        return;
      }
      stretch.socket = socket;
      read(stretch, socket);
      socket.send(sessionUpdate(options));
      for (const message of stretch.waiting.splice(0)) {
        socket.send(message);
      }
    };
    /** The stretch being said. */
    let saying = newStretch();
    try {
      await start(saying);
    } catch {
      throw transcriptionErrors.create("transcription.failed");
    }
    /** The final before this one, gone out: finals go out in order. */
    let before: Promise<void> = Promise.resolve();
    /** Sends a stretch's final once it is whole, after the ones before it. */
    const settle = async (
      earlier: Promise<void>,
      written: Promise<string>
    ): Promise<void> => {
      await earlier;
      const text = await written;
      // The session times no words: a final carries its text alone.
      events.push({ type: "committed", text, words: [] });
    };
    return {
      send: (audio) => {
        const resampled = resampler.push(audio);
        if (resampled.byteLength > 0 && !closed) {
          saying.heard = true;
          tell(saying, {
            type: "input_audio.append",
            audio: toBase64(resampled),
          });
        }
      },
      commit: () => {
        if (closed) {
          return;
        }
        const stretch = saying;
        if (!stretch.heard) {
          // Nothing sent since the commit before: nothing to write down.
          before = settle(before, Promise.resolve(""));
          return;
        }
        stretch.ending = true;
        // Has the session write down what it still held back, then say
        // the stretch's whole text.
        tell(stretch, { type: "input_audio.flush" });
        tell(stretch, { type: "input_audio.end" });
        stretch.overdue = setTimeout(() => {
          end("upstream_timeout");
        }, doneWaitMs);
        before = settle(before, stretch.written.promise);
        saying = newStretch();
        const next = saying;
        void (async () => {
          try {
            await start(next);
          } catch {
            end("upstream_unopened");
          }
        })();
      },
      close: () => {
        end();
      },
      events,
    };
  },
});
