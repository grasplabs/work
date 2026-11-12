/**
 * The AI providers connect reaches in core's tests (test/connect-providers.ts):
 * Anthropic, OpenAI, Mistral, OpenRouter and an organization's
 * own OpenAI-compatible endpoint, each at its own host. Each answers the
 * replies a test planned for the key it is sent (`aiProvidersControlUrl`),
 * one per request, and refuses a key it has no plan for, as a provider
 * refuses a key it doesn't know. Every request it got is kept, with all of
 * its headers, so a test can read where a key went and in which header.
 *
 * Mistral's speech and transcription, which Grasp's own features reach
 * (@grasp-os/shared/platform-ai), answer as the provider does when no
 * reply is planned for the key: a line as a WAV file of
 * `speechHeaderBytes` and `speechBytesPerChar` bytes of audio for each
 * character said, each said in `secondsPerCharacter`, a direction in
 * brackets not said, and a voice Grasp didn't choose refused; a recording
 * with `writtenText`; and a realtime transcription socket with a delta of
 * `partialText` for the first audio of each stretch, behind it by the
 * delay the session was told, and the rest of `writtenText` at once when
 * that audio is flushed, nothing for a flush with no audio. Every socket's opening, events and close are kept
 * (`realtimeControlUrl`).
 *
 * A key can instead be bridged to the test (`bridgeUrl`): each request
 * that carries it waits, unanswered, until the test takes it and says how
 * to answer, one command at a time (`BridgeCommand`), so a test's own
 * code decides every answer as the requests come (test/model-provider.ts).
 *
 * Serialized into the providers Worker with `toString()`, so it closes
 * over nothing: what it needs is in its own body.
 */

/** What the fake writes down, from a recording or a realtime commit. */
export const writtenText = "Hello there";

/** The delta a realtime stretch is first heard as. */
export const partialText = "Hello";

/** How long after a flush the rest of a stretch comes, once tests ask for it late (`{ late: true }`). */
export const lateMs = 150;

/** Bytes of a line's WAV header, before its audio. */
export const speechHeaderBytes = 44;

/** Bytes of audio the fake says for each character of a line: 24 kHz, 16-bit, mono. */
export const speechBytesPerChar = 1200;

/** How long the fake takes to say each character of a line. */
export const secondsPerCharacter = 0.025;

/**
 * Where tests read the realtime sockets (GET: each one's opening, events,
 * audio bytes and close code, oldest first), and act as Mistral on those
 * open: POST `{ close: code }` closes them, `{ error: code }` sends an
 * error event on them, and `{ late: true }` has the rest of each stretch
 * come `lateMs` after its flush from then on.
 */
export const realtimeControlUrl = "https://ai-providers-control.test/realtime";

/** One realtime socket the fake took, as tests read it. */
export interface RealtimeSocket {
  /** The host it was opened at: Mistral's. */
  host: string;
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

/**
 * Where tests bridge a key (POST `{ key }`), take the requests that
 * carried it since they last looked, with those whose caller went away
 * (GET `?key=`), and answer one (POST `{ id, commands }`).
 */
export const bridgeUrl = "https://ai-providers-control.test/bridge";

/**
 * How the test answers a bridged request: a refusal (`status`), or a
 * stream it opens, writes to and ends, as it likes, over as many posts as
 * it likes. A request given no command waits until its caller goes away.
 */
export type BridgeCommand =
  | { status: number; headers?: Record<string, string>; body?: unknown }
  | { open: Record<string, string> }
  | { write: string }
  | { end: true };

/** A bridged request, as the test takes it. */
export interface BridgedRequest {
  id: string;
  host: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

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
    "eu.api.openai.com",
    "api.mistral.ai",
    "openrouter.ai",
    "llm.acme-ai.test",
  ]);
  const plans = new Map<string, PlannedReply[]>();
  /** The held replies tests released, by name. */
  const released = new Set<string>();
  const seen: ProviderRequest[] = [];
  /** The keys bridged to the test. */
  const bridged = new Set<string>();
  /** Each bridged request, by its ID: what it waits on and how it stands. */
  const bridge = new Map<
    string,
    {
      key: string;
      request: BridgedRequest;
      taken: boolean;
      commands: BridgeCommand[];
      /** Its caller went away; told to the test once (`told`). */
      gone: boolean;
      told: boolean;
    }
  >();
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
    const apiKey =
      request.headers.get("x-api-key") ?? request.headers.get("xi-api-key");
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
    asked: ({ close: number } | { error: number } | { late: true })[];
  }[] = [];
  /** A realtime transcription session, as Mistral holds one. */
  const openRealtime = (request: Request, url: URL): Response => {
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    const record: RealtimeSocket = {
      host: url.hostname,
      path: url.pathname + url.search,
      authorization: request.headers.get("authorization"),
      session: null,
      events: [],
      audioBytes: 0,
      firstSamples: [],
      closed: null,
    };
    const asked: ({ close: number } | { error: number } | { late: true })[] =
      [];
    realtime.push({ record, asked });
    /** Whether audio came since the last flush: a stretch being said. */
    let saying = false;
    /** The stretch's first word, on its way: behind the audio, as the session is told to write. */
    let first: ReturnType<typeof setTimeout> | undefined = undefined;
    /** Whether the rest of a stretch comes late after its flush. */
    let late = false;
    const send = (event: Record<string, unknown>): void => {
      if (record.closed === null) {
        server.send(JSON.stringify(event));
      }
    };
    send({ type: "session.created", session: {} });
    // A socket is only used from the request it came with: what tests ask
    // of it is done from here, every few ms.
    const acting = setInterval(() => {
      for (const act of asked.splice(0)) {
        if ("close" in act) {
          record.closed ??= act.close;
          server.close(act.close, "");
        } else if ("late" in act) {
          late = true;
        } else {
          send({ type: "error", error: { code: act.error, message: "" } });
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
        // As Mistral: no settings once audio has started.
        if (record.audioBytes > 0) {
          send({
            type: "error",
            error: {
              code: 400,
              message:
                "Session fields cannot be changed after audio has started.",
            },
          });
          return;
        }
        record.session = parsed.session;
        send({ type: "session.updated", session: parsed.session });
      } else if (
        parsed.type === "input_audio.append" &&
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
        if (!saying) {
          saying = true;
          const delay =
            isRecord(record.session) &&
            typeof record.session.target_streaming_delay_ms === "number"
              ? record.session.target_streaming_delay_ms
              : 0;
          first = setTimeout(() => {
            first = undefined;
            send({ type: "transcription.text.delta", text: "Hello" });
          }, delay);
        }
      } else if (parsed.type === "input_audio.flush" && saying) {
        saying = false;
        // A flush has what is held back written down at once.
        if (first !== undefined) {
          clearTimeout(first);
          first = undefined;
          send({ type: "transcription.text.delta", text: "Hello" });
        }
        const rest = { type: "transcription.text.delta", text: " there" };
        if (late) {
          setTimeout(() => {
            send(rest);
          }, 150);
        } else {
          send(rest);
        }
      }
    });
    server.addEventListener("close", (event) => {
      record.closed ??= event.code;
      clearInterval(acting);
    });
    return new Response(null, { status: 101, webSocket: client });
  };
  /** A RIFF mark's four letters, as bytes. */
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- self-contained: its source is embedded
  const lettersOf = (mark: string): number[] =>
    [0, 1, 2, 3].map((at) => mark.codePointAt(at) ?? 0);
  /** A WAV file of `dataBytes` of silence: 24 kHz, 16-bit, mono. */
  const wavOf = (dataBytes: number): Uint8Array => {
    const wav = new Uint8Array(44 + dataBytes);
    const view = new DataView(wav.buffer);
    wav.set(lettersOf("RIFF"), 0);
    view.setUint32(4, 36 + dataBytes, true);
    wav.set(lettersOf("WAVE"), 8);
    wav.set(lettersOf("fmt "), 12);
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 24_000, true);
    view.setUint32(28, 48_000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    wav.set(lettersOf("data"), 36);
    view.setUint32(40, dataBytes, true);
    return wav;
  };
  /** A line without its directions: what is in brackets is never said. */
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- self-contained: its source is embedded
  const saidOf = (input: string): string => {
    let said = input;
    for (;;) {
      const opens = said.indexOf("[");
      const closes = said.indexOf("]", opens);
      if (opens === -1 || closes === -1) {
        return said;
      }
      said = said.slice(0, opens) + said.slice(closes + 1);
    }
  };
  /**
   * Mistral's line said: the audio in base64, a WAV file as long as its
   * characters take to say; a voice Grasp didn't choose is refused, as
   * Mistral refuses a voice it doesn't have.
   */
  const spokenLine = (body: string): Response => {
    const voices = [
      "voice_3150",
      "voice_478",
      "voice_590",
      "voice_1788",
      "voice_3149",
    ];
    const asked: unknown = JSON.parse(body);
    const voice = isRecord(asked) ? asked.voice_id : undefined;
    if (typeof voice !== "string" || !voices.includes(voice)) {
      return Response.json(
        { detail: `Voice ${String(voice)} not found.` },
        { status: 404 }
      );
    }
    const input =
      isRecord(asked) && typeof asked.input === "string" ? asked.input : "";
    // The fake's lines are plain text, one code point to a character.
    const wav = wavOf(saidOf(input).length * 1200);
    let binary = "";
    for (const byte of wav) {
      binary += String.fromCodePoint(byte);
    }
    return Response.json(
      { audio_data: btoa(binary) },
      { headers: { "x-request-id": `req-speech-${seen.length}` } }
    );
  };
  /** How Mistral's audio endpoints answer when nothing is planned. */
  const audioAnswer = (
    request: Request,
    url: URL,
    body: string
  ): Response | undefined => {
    if (url.hostname !== "api.mistral.ai") {
      return undefined;
    }
    if (
      url.pathname === "/v1/audio/transcriptions/realtime" &&
      request.headers.get("upgrade") === "websocket"
    ) {
      return openRealtime(request, url);
    }
    if (request.method !== "POST") {
      return undefined;
    }
    if (url.pathname === "/v1/audio/speech") {
      return spokenLine(body);
    }
    if (url.pathname === "/v1/audio/transcriptions") {
      return Response.json(
        { model: "voxtral-mini-transcribe-3-0", text: "Hello there" },
        { headers: { "x-request-id": `req-heard-${seen.length}` } }
      );
    }
    return undefined;
  };
  /** The realtime sockets (GET), or Mistral acting on those open (POST). */
  const realtimeControl = async (request: Request): Promise<Response> => {
    if (request.method === "POST") {
      const parsed: unknown = await request.json();
      for (const { record, asked } of realtime) {
        if (record.closed !== null || !isRecord(parsed)) {
          continue;
        }
        if (typeof parsed.close === "number") {
          asked.push({ close: parsed.close });
        } else if (typeof parsed.error === "number") {
          asked.push({ error: parsed.error });
        } else if (parsed.late === true) {
          asked.push({ late: true });
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
  /** Bridges a key, hands the test its requests, or takes its commands. */
  const bridgeControl = async (
    request: Request,
    url: URL
  ): Promise<Response> => {
    if (request.method === "GET") {
      const key = url.searchParams.get("key") ?? "";
      const fresh: BridgedRequest[] = [];
      const gone: string[] = [];
      for (const [id, one] of bridge) {
        if (one.key !== key) {
          continue;
        }
        if (!one.taken) {
          one.taken = true;
          fresh.push(one.request);
        }
        if (one.gone && !one.told) {
          one.told = true;
          gone.push(id);
        }
      }
      return Response.json({ requests: fresh, gone });
    }
    const asked: unknown = await request.json();
    if (isRecord(asked) && typeof asked.key === "string") {
      bridged.add(asked.key);
      return new Response(null, { status: 204 });
    }
    if (
      isRecord(asked) &&
      typeof asked.id === "string" &&
      Array.isArray(asked.commands)
    ) {
      const one = bridge.get(asked.id);
      if (one === undefined) {
        return new Response("No such request", { status: 404 });
      }
      for (const command of asked.commands) {
        if (isRecord(command)) {
          // SAFETY: the test's own commands, from test/model-provider.ts.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
          one.commands.push(command as BridgeCommand);
        }
      }
      return new Response(null, { status: 204 });
    }
    return new Response("Not a bridge request", { status: 400 });
  };
  /** Answers a bridged request as the test's commands say, as they come. */
  const answerBridged = async (
    request: Request,
    url: URL,
    key: string,
    body: string
  ): Promise<Response> => {
    const id = crypto.randomUUID();
    const commands: BridgeCommand[] = [];
    const one = {
      key,
      request: {
        id,
        host: url.hostname,
        method: request.method,
        path: url.pathname + url.search,
        headers: Object.fromEntries(request.headers),
        body,
      },
      taken: false,
      commands,
      gone: false,
      told: false,
    };
    bridge.set(id, one);
    request.signal.addEventListener("abort", () => {
      one.gone = true;
    });
    const nextCommand = async (): Promise<BridgeCommand | undefined> => {
      while (one.commands.length === 0 && !one.gone) {
        // oxlint-disable-next-line no-await-in-loop -- until the test says
        await scheduler.wait(5);
      }
      return one.commands.shift();
    };
    const first = await nextCommand();
    if (first === undefined) {
      return new Response("Gone", { status: 499 });
    }
    if ("status" in first) {
      return Response.json(first.body ?? refusal, {
        status: first.status,
        headers: first.headers ?? {},
      });
    }
    if (!("open" in first)) {
      return new Response("Not opened", { status: 500 });
    }
    const { readable, writable } = new TransformStream<Uint8Array>();
    const writer = writable.getWriter();
    const watchClosed = async (): Promise<void> => {
      try {
        await writer.closed;
      } catch {
        // Its reader went away.
        one.gone = true;
      }
    };
    void watchClosed();
    const pump = async (): Promise<void> => {
      try {
        for (;;) {
          // oxlint-disable-next-line no-await-in-loop -- in order, as told
          const command = await nextCommand();
          if (command === undefined || "end" in command) {
            break;
          }
          if ("write" in command) {
            // oxlint-disable-next-line no-await-in-loop -- in order, as told
            await writer.write(encoder.encode(command.write));
          }
        }
        await writer.close();
      } catch {
        // Its reader went away: nobody reads the rest.
        one.gone = true;
      }
    };
    void pump();
    return new Response(readable, {
      headers: {
        "content-type": "text/event-stream",
        "request-id": `req-${id}`,
        ...first.open,
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
      if (url.href.startsWith("https://ai-providers-control.test/bridge")) {
        return await bridgeControl(request, url);
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
      if (key !== null && bridged.has(key)) {
        return await answerBridged(request, url, key, body);
      }
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
