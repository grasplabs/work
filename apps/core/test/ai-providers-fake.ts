/**
 * The AI providers connect reaches in core's tests (test/connect-providers.ts):
 * Anthropic, OpenAI, Mistral, OpenRouter and an organization's
 * own OpenAI-compatible endpoint, each at its own host. Each answers the
 * replies a test planned for the key it is sent (`aiProvidersControlUrl`),
 * one per request, and refuses a key it has no plan for, as a provider
 * refuses a key it doesn't know. Every request it got is kept, with all of
 * its headers, so a test can read where a key went and in which header.
 *
 * ElevenLabs's speech and OpenAI's transcription, which Grasp's own
 * features reach (@grasp-os/shared/platform-ai), answer as the provider
 * does when no reply is planned for the key: a line as audio with
 * `speechBytesPerChar` bytes for each character it says, each said in
 * `secondsPerCharacter`, and a voice Grasp didn't choose refused; a
 * recording with `writtenText`; and a realtime transcription socket with a delta of
 * `partialText` for the first audio of each stretch, and `writtenText` for
 * each commit that has audio, or OpenAI's error for one that has none.
 * Every socket's opening, events and close are kept (`realtimeControlUrl`).
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

/** Bytes of audio the fake says for each character of a line. */
export const speechBytesPerChar = 400;

/** How long the fake takes to say each character of a line. */
export const secondsPerCharacter = 0.03;

/**
 * Where tests read the realtime sockets (GET: each one's opening, events,
 * audio bytes and close code, oldest first), and act as Mistral on those
 * open: POST `{ close: code }` closes them, and `{ error: code }` sends an
 * error event on them.
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
 * stream (`sse`), a stream that sends `hold` and then nothing more until
 * its reader goes away, or, with `resume`, until a test releases it by
 * name and it sends the `rest` (a model pausing mid-answer), no answer at
 * all until the request is dropped (`hang`), a redirect elsewhere
 * (`redirect`), or OpenAI's own answer once a test releases it by name
 * (`release`, `releaseUrl`).
 */
export type PlannedReply =
  | { status: number; headers?: Record<string, string>; body?: unknown }
  | { sse: string }
  | { hold: string; resume?: { release: string; rest: string } }
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
  /**
   * Set once its sender dropped it while it waited for an answer (`hang`),
   * or while its answer was held (`hold`).
   */
  dropped?: true;
  /** Set once its held answer's beginning was taken off its stream (`hold`). */
  begun?: true;
}

export const aiProvidersFake = () => {
  const hosts = new Set([
    "api.anthropic.com",
    "api.openai.com",
    "eu.api.openai.com",
    "api.mistral.ai",
    "api.elevenlabs.io",
    "api.eu.residency.elevenlabs.io",
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
    asked: ({ close: number } | { error: number })[];
  }[] = [];
  /**
   * A realtime transcription session, as Mistral's Voxtral holds one: it
   * says it was created, writes the first audio of a stretch down as
   * `partialText`, and the rest (" there") once silence follows it. Its
   * settings changed after audio came, it errs (3051) as Mistral does.
   */
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
    const asked: ({ close: number } | { error: number })[] = [];
    realtime.push({ record, asked });
    /** Words of the stretch being said were written down already. */
    let heard = false;
    /** Audio came: the settings are fixed. */
    let started = false;
    const send = (event: Record<string, unknown>): void => {
      server.send(JSON.stringify(event));
    };
    send({ type: "session.created", session: {} });
    // A socket is only used from the request it came with: what tests ask
    // of it is done from here, every few ms.
    const acting = setInterval(() => {
      for (const act of asked.splice(0)) {
        if ("close" in act) {
          record.closed ??= act.close;
          server.close(act.close, "");
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
        // The older model takes neither, as Mistral's refused them.
        if (
          url.search.includes("2602") &&
          isRecord(parsed.session) &&
          ("context_bias" in parsed.session || "language" in parsed.session)
        ) {
          send({
            type: "error",
            error: {
              message:
                "Model 'voxtral-mini-transcribe-realtime-2602' does not support context biasing.",
              code: 3051,
            },
          });
          return;
        }
        if (started) {
          send({
            type: "error",
            error: {
              message:
                "Session fields cannot be changed after audio has started.",
              code: 3051,
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
        started = true;
        const silent = bytes.every((byte) => byte === 0);
        if (!heard && !silent) {
          heard = true;
          send({ type: "transcription.text.delta", text: "Hello" });
        } else if (heard && silent) {
          heard = false;
          send({ type: "transcription.text.delta", text: " there" });
        }
      }
    });
    server.addEventListener("close", (event) => {
      record.closed ??= event.code;
      clearInterval(acting);
    });
    return new Response(null, { status: 101, webSocket: client });
  };
  /**
   * ElevenLabs's line said with timestamps: the audio in base64, and when
   * each character of the line is said; a voice Grasp didn't choose is
   * refused, as ElevenLabs refuses a voice the account doesn't have.
   */
  const elevenLabsLine = (url: URL, body: string): Response => {
    const voices = [
      "s3TPKV1kjDlVtZbl4Ksh",
      "r1KmysJdVYZjJCm4mL3b",
      "EXAVITQu4vr4xnSDxMaL",
      "cjVigY5qzO86Huf0OWal",
      "3svOJAOhuPHXwQC2H5eq",
      "TX3LPaxmHKxFdv7VOQHJ",
    ];
    const voice =
      /^\/v1\/text-to-speech\/(?<voice>[^/]+)\/with-timestamps$/u.exec(
        url.pathname
      )?.groups?.voice;
    if (voice === undefined || !voices.includes(voice)) {
      return Response.json(
        {
          detail: {
            status: "voice_not_found",
            message: `A voice with the voice_id ${voice} was not found.`,
          },
        },
        { status: 404 }
      );
    }
    const asked: unknown = JSON.parse(body);
    const text =
      isRecord(asked) && typeof asked.text === "string" ? asked.text : "";
    // The fake's lines are plain text, one code point to a character.
    // oxlint-disable-next-line typescript/no-misused-spread -- see above
    const characters = [...text];
    // `secondsPerCharacter`, written out: the fake closes over nothing.
    const seconds = 0.03;
    return Response.json(
      {
        // `speechBytesPerChar`, written out, as below.
        audio_base64: btoa("\0".repeat(characters.length * 400)),
        alignment: {
          characters,
          character_start_times_seconds: characters.map(
            (_, at) => at * seconds
          ),
          character_end_times_seconds: characters.map(
            (_, at) => (at + 1) * seconds
          ),
        },
      },
      { headers: { "request-id": `req-speech-${seen.length}` } }
    );
  };
  /**
   * How ElevenLabs answers: a token for a conversation with one of the
   * account's agents, never the key it was asked with, or a line said.
   */
  const elevenLabsAnswer = (
    request: Request,
    url: URL,
    body: string
  ): Response | undefined => {
    if (
      request.method === "GET" &&
      url.pathname === "/v1/convai/conversation/token"
    ) {
      return url.searchParams.get("agent_id")?.startsWith("agent_") === true
        ? Response.json({ token: `conversation-token-${seen.length}` })
        : Response.json(
            { detail: { status: "agent_not_found" } },
            { status: 404 }
          );
    }
    return request.method === "POST" ? elevenLabsLine(url, body) : undefined;
  };
  /** How Mistral's live transcription, ElevenLabs's speech and conversation tokens and OpenAI's audio endpoints answer when nothing is planned. */
  const audioAnswer = (
    request: Request,
    url: URL,
    body: string
  ): Response | undefined => {
    if (url.hostname === "api.mistral.ai") {
      if (
        url.pathname === "/v1/audio/transcriptions/realtime" &&
        request.headers.get("upgrade") === "websocket"
      ) {
        return openRealtime(request, url);
      }
      return undefined;
    }
    // Grasp's own ElevenLabs answers at its EU residency host, or its US one.
    if (
      url.hostname === "api.elevenlabs.io" ||
      url.hostname === "api.eu.residency.elevenlabs.io"
    ) {
      return elevenLabsAnswer(request, url, body);
    }
    // Grasp's own project answers at OpenAI's EU host, or its US one.
    if (
      url.hostname !== "api.openai.com" &&
      url.hostname !== "eu.api.openai.com"
    ) {
      return undefined;
    }
    if (url.pathname === "/v1/audio/transcriptions") {
      // As OpenAI does: the audio's format by the file name's extension
      // alone, and a name without one it takes refused.
      // No backslash in here: the source is embedded in a template string.
      const name =
        /name="file"; filename="(?<name>[^"]*)"/u.exec(body)?.groups?.name ??
        "";
      const dot = name.lastIndexOf(".");
      const extension = dot === -1 ? undefined : name.slice(dot + 1);
      const takes = [
        "flac",
        "m4a",
        "mp3",
        "mp4",
        "mpeg",
        "mpga",
        "oga",
        "ogg",
        "wav",
        "webm",
      ];
      if (extension === undefined || !takes.includes(extension)) {
        return Response.json(
          {
            error: {
              message: `Invalid file format. Supported formats: ${JSON.stringify(takes)}`,
              type: "invalid_request_error",
              param: null,
              code: null,
            },
          },
          { status: 400 }
        );
      }
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
        } else if (typeof parsed.error === "number") {
          asked.push({ error: parsed.error });
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
      const reader = { gone: false };
      const watchClosed = async (): Promise<void> => {
        try {
          await writer.closed;
        } catch {
          reader.gone = true;
          seenAs.dropped = true;
        }
      };
      void watchClosed();
      const { resume } = reply;
      const resumed = (): boolean =>
        resume !== undefined && released.has(resume.release);
      // Held for longer than any test waits, as `hang` is.
      const endsAt = Date.now() + 10 * 60_000;
      const answer = async (): Promise<void> => {
        try {
          // Settled once what reads the stream took it: sent on its way.
          await writer.write(encoder.encode(reply.hold));
          seenAs.begun = true;
          // Waited out on a timer of this request's own: with nothing left
          // to wait on, workerd would take the paused stream for a Worker
          // that hung and break it off, which no provider pausing does.
          while (!reader.gone && !resumed() && Date.now() < endsAt) {
            // oxlint-disable-next-line no-await-in-loop -- until released, or gone
            await scheduler.wait(10);
          }
          if (resume !== undefined && resumed() && !reader.gone) {
            await writer.write(encoder.encode(resume.rest));
          }
          await writer.close();
        } catch {
          // Its reader went away: nobody reads the rest.
        }
      };
      void answer();
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
      // A bridged key's speech and transcription answer as the provider
      // does: only its text requests wait for the test.
      const voiced = /^[/]v1[/](?:audio[/]|realtime$)/u.test(url.pathname);
      if (key !== null && bridged.has(key) && !voiced) {
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
