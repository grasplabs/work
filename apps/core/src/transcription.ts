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
// Ordering: the page counts on exactly one `final` for each of its
// commits, in order, holding the whole stretch it closed. The session
// also settles at pauses by itself (server VAD), into items of their own,
// and their transcripts may come after a later item's: a stretch split at
// a pause can have its first part written down after the page committed
// the rest. So the relay sends no final for an item the session settled
// at a pause: each item goes into the page's stretch it was committed in
// (the session commits in the order it takes the audio), and a stretch's
// one final goes out once the page committed it and every item in it was
// written down, its items' words in their order (`settlingOf`). An item
// was settled at a pause when the session said its speech stopped
// (`input_audio_buffer.speech_stopped`) before committing it; any other
// commit answers the page's. A page's commit can find nothing left to
// settle, which the session answers with its error
// (`input_audio_buffer_commit_empty`) in its turn: that closes the stretch
// with what its pauses settled, or an empty final.

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
    type: z.literal("input_audio_buffer.speech_stopped"),
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

/** One of the page's stretches: the session's items in it, in order. */
interface Stretch {
  items: string[];
  /** The page committed it, and the session answered that commit. */
  closed: boolean;
}

/** Where a stretch's words wait for its one final (`settlingOf`). */
interface Settling {
  /** The page asked to settle what it sent so far. */
  pageCommitted: () => void;
  /** The session said the speech of `item` stopped: settled at a pause. */
  speechStopped: (item: string) => void;
  committed: (item: string) => void;
  empty: () => void;
  delta: (item: string, delta: string) => void;
  completed: (item: string, transcript: string) => void;
}

/**
 * One final for each of the page's commits, in order: the words of every
 * item of its stretch, once the session answered the commit and wrote
 * each item down, whatever order the transcripts came in.
 */
const settlingOf = (events: EventQueue): Settling => {
  const stretches: Stretch[] = [];
  const stretchOf = new Map<string, Stretch>();
  const texts = new Map<string, string>();
  const deltas = new Map<string, string>();
  const atPause = new Set<string>();
  const committedItems = new Set<string>();
  /** The page's commits the session hasn't answered yet. */
  let unanswered = 0;
  /** The stretch being sent: the page hasn't committed it yet. */
  const open = (): Stretch => {
    const last = stretches.at(-1);
    if (last !== undefined && !last.closed) {
      return last;
    }
    const next: Stretch = { items: [], closed: false };
    stretches.push(next);
    return next;
  };
  /** What a stretch has said so far: each item's words, or its partial. */
  const sayingOf = (stretch: Stretch): string =>
    stretch.items
      .map((item) => texts.get(item) ?? deltas.get(item) ?? "")
      .filter((text) => text !== "")
      .join(" ");
  const flush = (): void => {
    for (;;) {
      const [first] = stretches;
      if (
        first === undefined ||
        !first.closed ||
        !first.items.every((item) => texts.has(item))
      ) {
        return;
      }
      stretches.shift();
      const text = sayingOf(first);
      for (const item of first.items) {
        texts.delete(item);
        deltas.delete(item);
        stretchOf.delete(item);
        atPause.delete(item);
        committedItems.delete(item);
      }
      // The session times no words: a final carries its text alone.
      events.push({ type: "committed", text, words: [] });
    }
  };
  /** The stretch `item` is in, put in the one being sent when new. */
  const placed = (item: string): Stretch => {
    const known = stretchOf.get(item);
    if (known !== undefined) {
      return known;
    }
    const stretch = open();
    stretch.items.push(item);
    stretchOf.set(item, stretch);
    return stretch;
  };
  /** The page's oldest unanswered commit is answered: its stretch closes. */
  const answered = (stretch: Stretch): void => {
    unanswered -= 1;
    stretch.closed = true;
  };
  return {
    pageCommitted: () => {
      unanswered += 1;
    },
    speechStopped: (item) => {
      atPause.add(item);
    },
    committed: (item) => {
      if (committedItems.has(item)) {
        return;
      }
      committedItems.add(item);
      // Its partial may have placed it already: in the stretch being sent.
      const stretch = placed(item);
      if (!atPause.has(item) && unanswered > 0) {
        answered(stretch);
      }
      flush();
    },
    empty: () => {
      if (unanswered > 0) {
        answered(open());
      }
      flush();
    },
    delta: (item, delta) => {
      deltas.set(item, `${deltas.get(item) ?? ""}${delta}`);
      events.push({ type: "partial", text: sayingOf(placed(item)) });
    },
    completed: (item, transcript) => {
      placed(item);
      texts.set(item, transcript.trim());
      deltas.delete(item);
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
        } else if (heard.type === "input_audio_buffer.speech_stopped") {
          settling.speechStopped(heard.item_id);
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
        // error, in its turn (`emptyCommit`): the stretch closes on what
        // its pauses settled.
        if (!closed) {
          settling.pageCommitted();
        }
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
