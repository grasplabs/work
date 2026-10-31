/**
 * The AI providers connect reaches in core's tests (test/connect-providers.ts):
 * Anthropic, OpenAI, Mistral, OpenRouter and an organization's own
 * OpenAI-compatible endpoint, each at its own host. Each answers the
 * replies a test planned for the key it is sent (`aiProvidersControlUrl`),
 * one per request, and refuses a key it has no plan for, as a provider
 * refuses a key it doesn't know. Every request it got is kept, with all of
 * its headers, so a test can read where a key went and in which header.
 *
 * OpenAI's audio endpoints, which Grasp's own speech and transcription
 * reach (@grasp-os/shared/platform-ai), answer as OpenAI does when no reply
 * is planned for the key: speech with silence, 25 ms for each character of
 * the line, as 24 kHz PCM (`speechPcmBytesPerChar`); a recording with
 * `writtenText`; and a realtime transcription socket with a delta of
 * `partialText` for the first audio of each stretch, and `writtenText` for
 * each commit that has audio, or OpenAI's error for one that has none.
 * Every socket's opening, events and close are kept (`realtimeControlUrl`).
 *
 * Serialized into the providers Worker with `toString()`, so it closes
 * over nothing: what it needs is in its own body.
 */

/** What the fake writes down, from a recording or a realtime commit. */
export const writtenText = "Hello there";

/** The delta a realtime stretch is first heard as. */
export const partialText = "Hello";

/** What a stretch settled at a pause (`{ pause: true }`) is written down as. */
export const pausedText = "Before the pause";

/** Bytes of speech the fake says for each character: 25 ms of 24 kHz PCM. */
export const speechPcmBytesPerChar = 1200;

/**
 * Where tests read the realtime sockets (GET: each one's opening, events,
 * audio bytes and close code, oldest first), and act as OpenAI on those
 * open: POST `{ close: code }` closes them, `{ error: code }` sends an
 * error event on them, and `{ pause: true }` settles the stretch so far at
 * a pause, as server VAD does, its transcript held back until after the
 * next commit's (`pausedText`).
 */
export const realtimeControlUrl = "https://ai-providers-control.test/realtime";

/** One realtime socket the fake took, as tests read it. */
export interface RealtimeSocket {
  path: string;
  authorization: string | null;
  /** The session it was told to set up (`session.update`). */
  session: unknown;
  /** Each client event's type, in order. */
  events: string[];
  /** The audio it got, in bytes, in total. */
  audioBytes: number;
  /** The first samples it got, as 16-bit little-endian values. */
  firstSamples: number[];
  /** How it closed, if it did: from core's side, or the fake's. */
  closed: number | null;
  /** How many stretches it settled at a pause (`{ pause: true }`). */
  paused: number;
}

/** Where tests plan replies (POST) and read the requests a key sent (GET). */
export const aiProvidersControlUrl = "https://ai-providers-control.test/";

/** The host of the organization's OpenAI-compatible endpoint in the tests. */
export const compatibleHost = "llm.acme-ai.test";

/**
 * One planned reply: a refusal (`status`, with its `headers`), a whole
 * stream (`sse`), a stream that sends `begin` and then nothing more until
 * its reader goes away (`hold`), no answer at all until the request is
 * dropped (`hang`), a redirect elsewhere (`redirect`), or OpenAI's own
 * answer once a test releases it by name (`release`, `releaseUrl`).
 */
export type PlannedReply =
  | { status: number; headers?: Record<string, string>; body?: unknown }
  | { sse: string }
  | { hold: string }
  | { hang: true }
  | { redirect: string }
  | { release: string };

/** Where tests release a reply held by name: POST `{ release }`. */
export const releaseUrl = "https://ai-providers-control.test/release";

/** One request a provider got, as it got it. */
export interface ProviderRequest {
  host: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  /** The key it carried, from `x-api-key` or a bearer token. */
  key: string | null;
  /** Set once its sender dropped it while it waited for an answer (`hang`). */
  dropped?: true;
}

export const aiProvidersFake = () => {
  const hosts = new Set([
    "api.anthropic.com",
    "api.openai.com",
    "api.mistral.ai",
    "openrouter.ai",
    "llm.acme-ai.test",
  ]);
  const plans = new Map<string, PlannedReply[]>();
  /** The held replies tests released, by name. */
  const released = new Set<string>();
  const seen: ProviderRequest[] = [];
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- self-contained: its source is embedded
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const isReply = (value: unknown): value is PlannedReply =>
    isRecord(value) &&
    (typeof value.status === "number" ||
      typeof value.sse === "string" ||
      typeof value.hold === "string" ||
      value.hang === true ||
      typeof value.redirect === "string" ||
      typeof value.release === "string");
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- self-contained: its source is embedded
  const keyOf = (request: Request): string | null => {
    const apiKey = request.headers.get("x-api-key");
    if (apiKey !== null) {
      return apiKey;
    }
    const bearer = /^Bearer (?<key>.+)$/u.exec(
      request.headers.get("authorization") ?? ""
    );
    return bearer?.groups?.key ?? null;
  };
  const encoder = new TextEncoder();
  const realtime: {
    record: RealtimeSocket;
    /** What tests asked of it, done from its own request (`acting`). */
    asked: ({ close: number } | { error: string } | { pause: true })[];
  }[] = [];
  /** A realtime transcription session, as OpenAI holds one. */
  const openRealtime = (request: Request, url: URL): Response => {
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    const record: RealtimeSocket = {
      path: url.pathname + url.search,
      authorization: request.headers.get("authorization"),
      session: null,
      events: [],
      audioBytes: 0,
      firstSamples: [],
      closed: null,
      paused: 0,
    };
    const asked: ({ close: number } | { error: string } | { pause: true })[] =
      [];
    /** Items settled at a pause whose transcripts are still held back. */
    const late: string[] = [];
    realtime.push({ record, asked });
    let items = 0;
    let current: string | null = null;
    const send = (event: Record<string, unknown>): void => {
      server.send(JSON.stringify(event));
    };
    // A socket is only used from the request it came with: what tests ask
    // of it is done from here, every few ms.
    const acting = setInterval(() => {
      for (const act of asked.splice(0)) {
        if ("close" in act) {
          record.closed ??= act.close;
          server.close(act.close, "");
        } else if ("pause" in act) {
          // Server VAD settles what was said so far, by itself.
          if (current !== null) {
            send({
              type: "input_audio_buffer.speech_stopped",
              item_id: current,
            });
            send({ type: "input_audio_buffer.committed", item_id: current });
            late.push(current);
            current = null;
          }
          record.paused += 1;
        } else {
          server.send(
            JSON.stringify({
              type: "error",
              error: { type: "server_error", code: act.error, message: "" },
            })
          );
        }
      }
    }, 10);
    server.addEventListener("message", (event) => {
      const parsed: unknown = JSON.parse(String(event.data));
      if (!isRecord(parsed) || typeof parsed.type !== "string") {
        return;
      }
      record.events.push(parsed.type);
      if (parsed.type === "session.update") {
        record.session = parsed.session;
        send({ type: "session.updated" });
      } else if (
        parsed.type === "input_audio_buffer.append" &&
        typeof parsed.audio === "string"
      ) {
        const bytes = Uint8Array.from(
          atob(parsed.audio),
          (char) => char.codePointAt(0) ?? 0
        );
        record.audioBytes += bytes.length;
        const view = new DataView(bytes.buffer);
        for (
          let at = 0;
          at + 1 < bytes.length && record.firstSamples.length < 8;
          at += 2
        ) {
          record.firstSamples.push(view.getInt16(at, true));
        }
        if (current === null) {
          items += 1;
          current = `item_${items}`;
          send({
            type: "conversation.item.input_audio_transcription.delta",
            item_id: current,
            delta: "Hello",
          });
        }
      } else if (parsed.type === "input_audio_buffer.commit") {
        if (current === null) {
          send({
            type: "error",
            error: {
              type: "invalid_request_error",
              code: "input_audio_buffer_commit_empty",
              message: "Nothing in the buffer",
            },
          });
          return;
        }
        send({ type: "input_audio_buffer.committed", item_id: current });
        send({
          type: "conversation.item.input_audio_transcription.completed",
          item_id: current,
          transcript: "Hello there",
        });
        current = null;
        // What a pause settled before comes last: its transcript was late.
        for (const item of late.splice(0)) {
          send({
            type: "conversation.item.input_audio_transcription.completed",
            item_id: item,
            transcript: "Before the pause",
          });
        }
      }
    });
    server.addEventListener("close", (event) => {
      record.closed ??= event.code;
      clearInterval(acting);
    });
    return new Response(null, { status: 101, webSocket: client });
  };
  /** How OpenAI's audio endpoints answer when nothing is planned. */
  const audioAnswer = (
    request: Request,
    url: URL,
    body: string
  ): Response | undefined => {
    if (url.hostname !== "api.openai.com") {
      return undefined;
    }
    if (
      url.pathname === "/v1/realtime" &&
      request.headers.get("upgrade") === "websocket"
    ) {
      return openRealtime(request, url);
    }
    if (url.pathname === "/v1/audio/speech") {
      const asked: unknown = JSON.parse(body);
      const input =
        isRecord(asked) && typeof asked.input === "string" ? asked.input : "";
      return new Response(new Uint8Array(input.length * 1200), {
        headers: {
          "content-type": "audio/pcm",
          "x-request-id": `req-speech-${seen.length}`,
        },
      });
    }
    if (url.pathname === "/v1/audio/transcriptions") {
      return Response.json(
        { text: "Hello there" },
        { headers: { "x-request-id": `req-heard-${seen.length}` } }
      );
    }
    return undefined;
  };
  /** The realtime sockets (GET), or OpenAI acting on those open (POST). */
  const realtimeControl = async (request: Request): Promise<Response> => {
    if (request.method === "POST") {
      const parsed: unknown = await request.json();
      for (const { record, asked } of realtime) {
        if (record.closed !== null || !isRecord(parsed)) {
          continue;
        }
        if (typeof parsed.close === "number") {
          asked.push({ close: parsed.close });
        } else if (typeof parsed.error === "string") {
          asked.push({ error: parsed.error });
        } else if (parsed.pause === true) {
          asked.push({ pause: true });
        }
      }
      return new Response(null, { status: 204 });
    }
    return Response.json(realtime.map(({ record }) => record));
  };
  const refusal = {
    type: "error",
    error: { type: "api_error", message: "Refused by the fake provider" },
  };
  /** How the provider answers `reply`. */
  const answerOf = async (
    reply: PlannedReply,
    request: Request,
    seenAs: ProviderRequest
  ): Promise<Response> => {
    if ("status" in reply) {
      return Response.json(reply.body ?? refusal, {
        status: reply.status,
        headers: reply.headers ?? {},
      });
    }
    if ("redirect" in reply) {
      return new Response(null, {
        status: 307,
        headers: { location: reply.redirect },
      });
    }
    if ("hang" in reply) {
      // No answer for longer than any test waits: the request is dropped
      // by its sender first, and it notes that it was. A timer, so workerd
      // doesn't take the wait for a Worker that hung.
      const dropped = Promise.withResolvers<true>();
      request.signal.addEventListener(
        "abort",
        () => {
          seenAs.dropped = true;
          dropped.resolve(true);
        },
        { once: true }
      );
      await Promise.race([scheduler.wait(10 * 60_000), dropped.promise]);
      return new Response("Too late", { status: 504 });
    }
    if ("hold" in reply) {
      const { readable, writable } = new TransformStream<Uint8Array>();
      const writer = writable.getWriter();
      void writer.write(encoder.encode(reply.hold));
      return new Response(readable, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    if ("release" in reply) {
      // Never expected: a held reply is answered where it is planned for.
      return new Response("Held", { status: 500 });
    }
    return new Response(reply.sse, {
      headers: {
        "content-type": "text/event-stream",
        "request-id": `req-${seen.length}`,
      },
    });
  };
  /** Plans replies (POST), or lists what reached the providers (GET). */
  const control = async (request: Request, url: URL): Promise<Response> => {
    if (request.method === "POST") {
      const asked: unknown = await request.json();
      if (
        !isRecord(asked) ||
        typeof asked.key !== "string" ||
        !Array.isArray(asked.replies) ||
        !asked.replies.every(isReply)
      ) {
        return new Response("Not a plan", { status: 400 });
      }
      plans.set(asked.key, [...(plans.get(asked.key) ?? []), ...asked.replies]);
      return new Response(null, { status: 204 });
    }
    // Every request whose headers or body carry the text `anywhere` names
    // (a key, or a placeholder that should be nowhere).
    const anywhere = url.searchParams.get("anywhere") ?? "";
    return Response.json(
      seen.filter((one) => JSON.stringify(one).includes(anywhere))
    );
  };
  return {
    handles: (url: URL): boolean =>
      hosts.has(url.hostname) || url.hostname === "ai-providers-control.test",
    answer: async (request: Request, url: URL): Promise<Response> => {
      if (url.href === "https://ai-providers-control.test/realtime") {
        return await realtimeControl(request);
      }
      if (url.href === "https://ai-providers-control.test/release") {
        const asked: unknown = await request.json();
        if (isRecord(asked) && typeof asked.release === "string") {
          released.add(asked.release);
        }
        return new Response(null, { status: 204 });
      }
      if (url.hostname === "ai-providers-control.test") {
        return await control(request, url);
      }
      const key = keyOf(request);
      const body = await request.text();
      const seenAs: ProviderRequest = {
        host: url.hostname,
        method: request.method,
        path: url.pathname + url.search,
        headers: Object.fromEntries(request.headers),
        body,
        key,
      };
      seen.push(seenAs);
      const reply = key === null ? undefined : plans.get(key)?.shift();
      if (reply !== undefined && "release" in reply) {
        // Waited for on a timer of this request's own: nothing of another
        // request's is touched.
        while (!released.has(reply.release)) {
          // oxlint-disable-next-line no-await-in-loop -- until released
          await scheduler.wait(10);
        }
        return (
          audioAnswer(request, url, body) ?? new Response(null, { status: 204 })
        );
      }
      if (reply === undefined && key !== null) {
        const audio = audioAnswer(request, url, body);
        if (audio !== undefined) {
          return audio;
        }
      }
      // A key it was told nothing of: refused, as a provider refuses a key
      // it doesn't know.
      return reply === undefined
        ? Response.json(
            {
              type: "error",
              error: { type: "authentication_error", message: "invalid key" },
            },
            { status: 401 }
          )
        : await answerOf(reply, request, seenAs);
    },
  };
};
