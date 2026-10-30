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
// feature (@grasp-os/shared/platform-ai), OpenAI's realtime transcription
// session by default, over a WebSocket that connect opens to OpenAI with
// Grasp's key and relays (connect's `modelSocket`): core sends no key,
// and the browser never sees the upstream. Only for a listening the model
// gateway admitted (models.ts, `models(env).listen`): the rules and the
// budgets let it through first, and the socket is the one its admission
// opens. The caller holds it to the seconds admitted, and says what it
// heard (`Listening.heard`).
//
// Chosen over writing each stretch down from a recording as it closes:
// the realtime session hears as it goes, settles at each pause by itself
// and sends its words as they come, which the relay passes on as it did
// before (`partial`, then `final`), at a stretch's end with little delay;
// a recording each stretch would lose the partials, and wait for a whole
// request at the end of each. Connect relays the socket, so the key stays
// there.
//
// The session wants 16-bit PCM at 24 kHz; the page sends its own rate, so
// the audio is resampled as it comes (`Resampler`). It goes through as it
// comes (resampler.ts), and nothing of it is kept: not here, not in a log.
//
// Ordering: the page counts on one `final` for each of its commits, in
// order, and treats any other as settled at a pause. The session settles
// at pauses itself (server VAD) too, so a page's commit can find nothing
// left to settle, which the session answers with its error
// (`input_audio_buffer_commit_empty`) in its turn: an empty `final` goes
// in its place, and finals go out in the order the session took the
// commits (`settlingOf`).

/** The sample rate the realtime session takes PCM at. */
export const sessionSampleRate = 24_000;

/** The session's own path and query at the provider, which connect allows. */
const realtimePath = "/v1/realtime?intent=transcription";

/** The commit the session refuses as empty: answered with an empty final. */
const emptyCommit = "input_audio_buffer_commit_empty";

/** A code safe to pass on: the provider's own error code, never its text. */
const safeCode = /^[a-z_]{1,64}$/u;

/** What the session sends, as far as the relay reads it: the first that fits. */
const serverEventSchema = z.union([
  z.object({
    type: z.literal("input_audio_buffer.committed"),
    item_id: z.string(),
  }),
  z.object({
    type: z.literal("conversation.item.input_audio_transcription.delta"),
    item_id: z.string(),
    delta: z.string(),
  }),
  z.object({
    type: z.literal("conversation.item.input_audio_transcription.completed"),
    item_id: z.string(),
    transcript: z.string(),
  }),
  z.object({
    type: z.literal("conversation.item.input_audio_transcription.failed"),
    item_id: z.string(),
  }),
  z.object({
    type: z.literal("error"),
    error: z.object({ code: z.string().nullish() }).loose(),
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

/** One commit's place in line: an item of the session's, or a page's that found nothing. */
type Settled = { item: string } | { empty: true };

/** Where finals wait to go out in order (`settlingOf`). */
interface Settling {
  committed: (item: string) => void;
  empty: () => void;
  delta: (item: string, delta: string) => void;
  completed: (item: string, transcript: string) => void;
}

/**
 * Finals in the order their audio was committed: an item's once its
 * transcript came, an empty commit's at once when it is next.
 */
const settlingOf = (events: EventQueue): Settling => {
  const line: Settled[] = [];
  const done = new Map<string, string>();
  const deltas = new Map<string, string>();
  const flush = (): void => {
    while (line.length > 0) {
      const [next] = line;
      const text =
        next === undefined || !("item" in next) ? "" : done.get(next.item);
      if (text === undefined) {
        return;
      }
      line.shift();
      if (next !== undefined && "item" in next) {
        done.delete(next.item);
      }
      // The session times no words: a final carries its text alone.
      events.push({ type: "committed", text, words: [] });
    }
  };
  const committed = (item: string): void => {
    if (!line.some((one) => "item" in one && one.item === item)) {
      line.push({ item });
    }
  };
  return {
    committed,
    empty: () => {
      line.push({ empty: true });
      flush();
    },
    delta: (item, delta) => {
      const text = `${deltas.get(item) ?? ""}${delta}`;
      deltas.set(item, text);
      events.push({ type: "partial", text });
    },
    completed: (item, transcript) => {
      committed(item);
      deltas.delete(item);
      done.set(item, transcript.trim());
      flush();
    },
  };
};

/**
 * The session's settings: PCM at 24 kHz, the model the listening was
 * admitted for, the language, and the words to listen out for with what
 * was said before, as its prompt; settled at each pause as well as when
 * the page commits.
 */
const sessionUpdate = (
  model: string,
  { language, keyterms, previousText }: TranscriptionOptions
): string => {
  const prompt = [
    keyterms.length === 0 ? "" : `Names and terms: ${keyterms.join(", ")}.`,
    previousText ?? "",
  ]
    .filter((part) => part !== "")
    .join("\n");
  return JSON.stringify({
    type: "session.update",
    session: {
      type: "transcription",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: sessionSampleRate },
          noise_reduction: { type: "near_field" },
          transcription: {
            model,
            language,
            ...(prompt === "" ? {} : { prompt }),
          },
          turn_detection: { type: "server_vad" },
        },
      },
    },
  });
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
      socket = await listening.socket(realtimePath);
    } catch {
      throw transcriptionErrors.create("transcription.failed");
    }
    socket.send(sessionUpdate(listening.modelId, options));
    const events = new EventQueue();
    const settling = settlingOf(events);
    const resampler = new Resampler(options.sampleRate, sessionSampleRate);
    let closed = false;
    const stop = (code: string): void => {
      if (!closed) {
        events.push({ type: "failed", code });
      }
      closed = true;
      events.end();
      try {
        socket.close(1000, "Done");
      } catch {
        // Closed already.
      }
    };
    socket.addEventListener("message", (event) => {
      const heard = serverEventOf(event.data);
      if (heard === undefined) {
        return;
      }
      if ("delta" in heard) {
        settling.delta(heard.item_id, heard.delta);
      } else if ("transcript" in heard) {
        settling.completed(heard.item_id, heard.transcript);
      } else if ("error" in heard) {
        const code = heard.error.code ?? "";
        if (code === emptyCommit) {
          settling.empty();
          return;
        }
        // Only its code, which names no content.
        log.warn("transcription.upstream_error", { code });
        stop(safeCode.test(code) ? code : "upstream_error");
      } else if ("item_id" in heard) {
        if (heard.type === "input_audio_buffer.committed") {
          settling.committed(heard.item_id);
        } else {
          stop("transcription_failed");
        }
      }
    });
    socket.addEventListener("close", (event) => {
      if (!closed && event.code !== 1000) {
        events.push({ type: "failed", code: "upstream_closed" });
      }
      closed = true;
      events.end();
    });
    socket.addEventListener("error", () => {
      if (!closed) {
        events.push({ type: "failed", code: "upstream_error" });
      }
      closed = true;
      events.end();
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
          send({
            type: "input_audio_buffer.append",
            audio: toBase64(resampled),
          });
        }
      },
      commit: () => {
        // The session answers one with nothing left to settle with its
        // error, in its turn: an empty final then (`emptyCommit`).
        send({ type: "input_audio_buffer.commit" });
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
        events.end();
      },
      events,
    };
  },
});
