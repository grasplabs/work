import { toBase64 } from "@grasp-os/shared/encoding";
import { transcriptionErrors } from "@grasp-os/shared/voice";
import type {
  LiveTranscription,
  SpokenWord,
  TranscriptionEvent,
  TranscriptionOptions,
  TranscriptionSession,
} from "@grasp-os/shared/voice";
import { z } from "zod";

import type { Listening } from "./models.ts";

// Live transcription as core implements it (`elevenlabs-gateway`):
// ElevenLabs's Scribe v2 realtime, over a WebSocket core opens to the
// deployment's AI Gateway with `fetch` and `Upgrade: websocket`, on the
// path speech takes, with the key the gateway stores: core sends none, and
// the browser never sees the upstream. Only for a listening the model
// gateway admitted (models.ts, `models(env).listen`): the allowlist, the
// rules and the budgets let it through first, and the way to the upstream
// is the one its admission hands over. The caller holds it to the seconds
// admitted, and says what it heard (`Listening.heard`).
//
// Audio goes through as it comes, and nothing of it is kept: not here,
// not in a log. ElevenLabs is asked to keep nothing either
// (`enable_logging=false`).

/** The longest an upstream may take to accept the socket. */
const openTimeoutMs = 10_000;

/** A word as Scribe times it, in seconds; `spacing` between words. */
const scribeWordSchema = z.object({
  text: z.string(),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  type: z.string().optional(),
});

/** What Scribe sends, as far as the relay reads it: the first that fits. */
const scribeMessageSchema = z.union([
  z.object({ message_type: z.literal("partial_transcript"), text: z.string() }),
  z.object({
    message_type: z.literal("committed_transcript_with_timestamps"),
    text: z.string(),
    words: z.array(scribeWordSchema).default([]),
  }),
  z.object({ message_type: z.string() }),
]);

/** A message type of Scribe's that says it stopped: an error, a limit. */
const stoppedType = /error|exceeded|limit/u;

/** A code safe to pass on: Scribe's own message type, never its text. */
const safeCode = /^[a-z_]{1,64}$/u;

/** Scribe's words, timed in ms, without the spacing between them. */
const wordsOf = (words: readonly z.infer<typeof scribeWordSchema>[]) =>
  words
    .filter(({ type }) => type === undefined || type === "word")
    .map(({ text, start, end }): SpokenWord => ({
      text,
      startMs: Math.round(start * 1000),
      endMs: Math.round(end * 1000),
    }));

/** What one of Scribe's messages is to the session; `undefined` for none. */
const eventOf = (data: unknown): TranscriptionEvent | undefined => {
  if (typeof data !== "string") {
    return undefined;
  }
  let raw: unknown = undefined;
  try {
    raw = JSON.parse(data);
  } catch {
    return undefined;
  }
  const parsed = scribeMessageSchema.safeParse(raw);
  if (!parsed.success) {
    return undefined;
  }
  const message = parsed.data;
  if ("text" in message && message.message_type === "partial_transcript") {
    return { type: "partial", text: message.text };
  }
  if ("words" in message) {
    return {
      type: "committed",
      text: message.text,
      words: wordsOf(message.words),
    };
  }
  // A committed transcript without timings comes with the one with them
  // (`include_timestamps`): only that one is passed on.
  if (stoppedType.test(message.message_type)) {
    return {
      type: "failed",
      code: safeCode.test(message.message_type)
        ? message.message_type
        : "upstream_error",
    };
  }
  return undefined;
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

/** The realtime endpoint's query: the session's settings, and nothing kept. */
const queryOf = (
  modelId: string,
  { language, keyterms, sampleRate }: TranscriptionOptions
) => {
  const query = new URLSearchParams({
    model_id: modelId,
    language_code: language,
    audio_format: `pcm_${sampleRate}`,
    // Settles at each pause as well as when the page commits.
    commit_strategy: "vad",
    include_timestamps: "true",
    enable_logging: "false",
  });
  for (const term of keyterms) {
    query.append("keyterms", term);
  }
  return query;
};

/** Opens the upstream socket; throws `transcription.*` when it won't open. */
const openUpstream = async (
  { route, modelId }: Listening,
  options: TranscriptionOptions
): Promise<WebSocket> => {
  let response: Response;
  try {
    response = await route.transport(
      `${route.base}/v1/speech-to-text/realtime?${queryOf(modelId, options).toString()}`,
      {
        headers: { ...route.headers, Upgrade: "websocket" },
        signal: AbortSignal.timeout(openTimeoutMs),
      }
    );
  } catch {
    throw transcriptionErrors.create("transcription.failed");
  }
  const socket = response.webSocket;
  if (socket === null) {
    await response.body?.cancel();
    throw transcriptionErrors.create("transcription.failed");
  }
  socket.accept();
  return socket;
};

/**
 * Live transcription through the deployment's AI Gateway, for a listening
 * it admitted: a socket of its own to ElevenLabs's realtime endpoint.
 */
export const gatewayTranscription = (
  listening: Listening
): LiveTranscription => ({
  open: async (options): Promise<TranscriptionSession> => {
    const socket = await openUpstream(listening, options);
    const events = new EventQueue();
    let { previousText } = options;
    let closed = false;
    socket.addEventListener("message", (event) => {
      const heard = eventOf(event.data);
      if (heard !== undefined) {
        events.push(heard);
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
    const chunk = (audio: Uint8Array, commit: boolean): void => {
      if (closed) {
        return;
      }
      socket.send(
        JSON.stringify({
          message_type: "input_audio_chunk",
          audio_base_64: toBase64(audio),
          commit,
          sample_rate: options.sampleRate,
          // Only with the first chunk: what was said before it.
          ...(previousText === undefined
            ? {}
            : { previous_text: previousText }),
        })
      );
      previousText = undefined;
    };
    return {
      send: (audio) => {
        chunk(audio, false);
      },
      commit: () => {
        chunk(new Uint8Array(), true);
      },
      close: () => {
        if (!closed) {
          closed = true;
          socket.close(1000, "Done");
        }
        events.end();
      },
      events,
    };
  },
});
