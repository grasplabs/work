import { actorOf } from "@grasp-os/shared/audit";
import type { AuditActor } from "@grasp-os/shared/audit";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { authErrors, requestErrors } from "@grasp-os/shared/errors";
import type { CodedError } from "@grasp-os/shared/errors";
import { interviewErrors } from "@grasp-os/shared/interview-links";
import { log } from "@grasp-os/shared/log";
import { isAdmin, roleErrors } from "@grasp-os/shared/roles";
import {
  transcriptionCloseCodes,
  transcriptionCommitSchema,
  transcriptionErrors,
  transcriptionFrameMaxBytes,
  transcriptionStartSchema,
  transcriptionTextMaxBytes,
} from "@grasp-os/shared/voice";
import type {
  TranscriptionMessage,
  TranscriptionSession,
} from "@grasp-os/shared/voice";
import type { z } from "zod";

import { identify } from "../auth/identity.ts";
import { errorResponse } from "../errors.ts";
import { jsonOf } from "../request-body.ts";
import { isOwnOrigin } from "../rpc.ts";
import { gatewayTranscription } from "../transcription.ts";
import { onboardingStore } from "./store.ts";
import type { Took } from "./store.ts";

// `GET /api/transcription` (`@grasp-os/shared/voice`): what someone says
// on the onboarding's pages, written down as they say it. The page streams
// its microphone to its own origin over a WebSocket, as `connect-src
// 'self'` allows and nothing else; core relays it to live transcription
// behind its interface (src/transcription.ts), which reaches the provider
// through the deployment's AI Gateway. No provider token or host ever
// reaches the browser (GRA-361, A2).
//
// The socket's protocol, one session per socket:
//
// - Open: `GET /api/transcription`, `Upgrade: websocket`, from the
//   deployment's own origin (426 without the upgrade, 403 from any other
//   origin, or none). The URL carries nothing secret.
// - The page's first frame, within `startWaitMs`, is text: `{"type":
//   "start", "language", "sampleRate", "previousText"?, "link"?: {"secret",
//   "key"}}` (`transcriptionStartSchema`). With `link`, someone's own
//   interview link, on the device it opened on; without, an admin signed
//   in, by the session cookie the upgrade carried.
// - Core answers `{"type": "ready", "session", "maxSeconds"}` once the
//   upstream is open, or an `error` frame and closes.
// - Then the page sends binary frames of audio, 16-bit little-endian PCM,
//   mono, at `sampleRate`, each at most `transcriptionFrameMaxBytes`, and
//   `{"type": "commit"}` to settle what was said so far. Audio before
//   `ready` is refused.
// - Core sends `{"type": "partial", "text"}` as it hears, and `{"type":
//   "final", "text", "words"}` once settled, words timed in ms.
// - `{"type": "error", "code", "message"}` comes before core closes for
//   any reason but an ordinary end; the close code says how
//   (`transcriptionCloseCodes`): 1000 ended, 1008 refused, 1011 failed.
// - When either side closes, core closes the other.
//
// What it must not do, and what stops it:
//
// - Listen for anyone (GRA-361, C4): only someone's own link, on the
//   device it is open on, while it may be saved (the store's
//   `transcriptionOnLink`, as a line said), or an admin signed in. Another
//   person's link, an unknown one and a removed person's answer as at the
//   speech endpoint. Nothing reaches the upstream before that, and nothing
//   but `start` is read until it.
// - Lend an admin's cookie to another site: browsers send cookies with
//   any WebSocket upgrade, so the upgrade must come from the deployment's
//   own origin (`isOwnOrigin`), as `/rpc`'s.
// - Keep the audio (A1): each frame is passed on and dropped; only its
//   length is counted. Nothing heard is logged, counted or audited.
// - Run up the bill (C1): a socket hears at most `maxSessionSeconds` of
//   audio, then ends, so a link is checked again before more; each link
//   and each admin has minutes a day (`heardBudgets`); the router limits
//   sockets opened per address, and the store counts them per link.
// - Tell the company who talked, and when: a session on a link is noted
//   in the onboarding's own log, which only staff read; an admin's is in
//   the audit log, opened and closed, with its ID and seconds.

/** How long the page has to send `start`. */
const startWaitMs = 10_000;

/** The most audio one socket takes, in seconds: then the page opens another. */
export const maxSessionSeconds = 15 * 60;

/**
 * Seconds of audio heard a day: on someone's link, more than an hour's
 * interview has them talk; for an admin, enough to try the pages.
 */
export const heardBudgets = { link: 60 * 60, admin: 30 * 60 } as const;

/** Bytes of one second of audio at `sampleRate`: 16-bit, mono. */
const bytesPerSecond = (sampleRate: number): number => sampleRate * 2;

type Start = z.output<typeof transcriptionStartSchema>;

/** Whom a session is for: what it is counted under, and how it is noted. */
interface Hearer {
  who: string;
  /** Seconds heard under `who` today, before this session. */
  heard: number;
  budget: number;
  counted: Took["purpose"];
  by: AuditActor;
  /** The person whose link it is on, for the onboarding's own log. */
  person?: string;
}

/** Whom a session on someone's link is for, or why their link refuses it. */
const onLink = async (
  env: Env,
  link: NonNullable<Start["link"]>,
  requestId: string
): Promise<Hearer | CodedError> => {
  const found = await onboardingStore(env).transcriptionOnLink(
    await sha256Hex(link.secret),
    await sha256Hex(link.key)
  );
  if (!found.ok) {
    if (found.code === "interview.link_invalid") {
      // Never the secret: only that one opened nothing.
      log.warn("interview.link_invalid", { requestId });
    }
    return interviewErrors.create(found.code);
  }
  const { who, heard, person } = found.value;
  return {
    who,
    heard,
    budget: heardBudgets.link,
    counted: "interviews",
    // As a line said on a link: by the system, never in anyone's name.
    by: { type: "system" },
    person,
  };
};

/** Whom a session for an admin signed in is for, or why it is refused. */
const forAdmin = async (
  env: Env,
  headers: Headers
): Promise<Hearer | CodedError> => {
  // Grasp's staff, who may reach the onboarding alone, among them.
  const person = await identify(env, headers);
  if (person === undefined) {
    return authErrors.create("auth.unauthenticated");
  }
  if (!isAdmin(person.role)) {
    return roleErrors.create("role.forbidden");
  }
  const { who, heard } = await onboardingStore(env).heardForAdmin(
    person.userId
  );
  return {
    who,
    heard,
    budget: heardBudgets.admin,
    // The admin's own onboarding, as their lines said are counted.
    counted: "reading",
    by: actorOf(person),
  };
};

/** Sends `message` to the page, if its socket is still open. */
const tell = (socket: WebSocket, message: TranscriptionMessage): void => {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
};

/** Closes `socket` as it may still be: a socket closed already stays so. */
const closeQuietly = (socket: WebSocket, code: number): void => {
  try {
    socket.close(code, code === transcriptionCloseCodes.ended ? "Done" : "");
  } catch {
    // Closed already.
  }
};

/** How a session ended, as the audit log and the onboarding's log name it. */
type Ended = "page" | "upstream" | "failed" | "refused" | "limited" | "expired";

/** The close code for how a session ended (`transcriptionCloseCodes`). */
const closeCodeOf = (ended: Ended): number => {
  if (ended === "refused" || ended === "limited") {
    return transcriptionCloseCodes.refused;
  }
  return ended === "failed"
    ? transcriptionCloseCodes.failed
    : transcriptionCloseCodes.ended;
};

/** One page's socket, and the session it relays to. */
class Relay {
  readonly #env: Env;
  readonly #headers: Headers;
  readonly #socket: WebSocket;
  readonly #requestId: string;
  readonly #ctx: Pick<ExecutionContext, "waitUntil">;
  readonly #id = crypto.randomUUID();
  #state: "waiting" | "starting" | "open" | "ended" = "waiting";
  #deadline: ReturnType<typeof setTimeout> | undefined = undefined;
  #session: TranscriptionSession | undefined = undefined;
  #hearer: Hearer | undefined = undefined;
  #rate = 0;
  /** Bytes of audio passed on, and the most this socket may. */
  #bytes = 0;
  #maxBytes = 0;
  /** Whether the most was set by the day's budget rather than the socket's length. */
  #byBudget = false;

  constructor(
    env: Env,
    headers: Headers,
    socket: WebSocket,
    requestId: string,
    ctx: Pick<ExecutionContext, "waitUntil">
  ) {
    this.#env = env;
    this.#headers = headers;
    this.#socket = socket;
    this.#requestId = requestId;
    this.#ctx = ctx;
  }

  listen(): void {
    this.#socket.addEventListener("message", (event) => {
      const data: unknown = event.data;
      this.#heard(data);
    });
    this.#socket.addEventListener("close", () => {
      this.#end("page");
    });
    this.#socket.addEventListener("error", () => {
      this.#end("page");
    });
    this.#deadline = setTimeout(() => {
      this.#refuse(transcriptionErrors.create("transcription.invalid"));
    }, startWaitMs);
  }

  #heard(data: unknown): void {
    if (this.#state === "waiting" && typeof data === "string") {
      // Runs for as long as the socket is open: the socket keeps it alive.
      void this.#start(data);
    } else if (this.#state === "open" && typeof data === "string") {
      this.#control(data);
    } else if (this.#state === "open" && data instanceof ArrayBuffer) {
      this.#audio(data);
    } else if (this.#state !== "ended") {
      // Audio before `start`, or anything before `ready`.
      this.#refuse(transcriptionErrors.create("transcription.invalid"));
    }
  }

  async #start(text: string): Promise<void> {
    this.#state = "starting";
    clearTimeout(this.#deadline);
    const parsed = transcriptionStartSchema.safeParse(
      text.length > transcriptionTextMaxBytes ? undefined : jsonOf(text)
    );
    if (!parsed.success) {
      this.#refuse(transcriptionErrors.create("transcription.invalid"));
      return;
    }
    const start = parsed.data;
    let hearer: Hearer | CodedError;
    try {
      hearer =
        start.link === undefined
          ? await forAdmin(this.#env, this.#headers)
          : await onLink(this.#env, start.link, this.#requestId);
    } catch {
      log.error("transcription.check_failed", { requestId: this.#requestId });
      this.#fail(transcriptionErrors.create("transcription.failed"));
      return;
    }
    if (this.#isEnded()) {
      return;
    }
    if (hearer instanceof Error) {
      this.#refuse(hearer);
      return;
    }
    if (hearer.heard >= hearer.budget) {
      this.#refuse(transcriptionErrors.create("transcription.limited"));
      return;
    }
    await this.#open(start, hearer);
  }

  async #open(start: Start, hearer: Hearer): Promise<void> {
    let session: TranscriptionSession;
    try {
      // The page names none: what to listen out for is the store's.
      const keyterms = await onboardingStore(this.#env).listeningTerms(
        hearer.person
      );
      session = await gatewayTranscription(this.#env).open({
        language: start.language,
        keyterms,
        sampleRate: start.sampleRate,
        ...(start.previousText === undefined
          ? {}
          : { previousText: start.previousText }),
      });
    } catch (error) {
      const code = transcriptionErrors.codeOf(error) ?? "transcription.failed";
      log.warn("transcription.unopened", { requestId: this.#requestId, code });
      this.#fail(transcriptionErrors.create(code));
      return;
    }
    // The page left while it opened.
    if (this.#isEnded()) {
      session.close();
      return;
    }
    this.#session = session;
    try {
      await onboardingStore(this.#env).transcriptionOpened(this.#note(hearer));
    } catch {
      log.error("transcription.note_failed", { requestId: this.#requestId });
      this.#fail(transcriptionErrors.create("transcription.failed"));
      return;
    }
    this.#hearer = hearer;
    if (this.#isEnded()) {
      // Ended while it was noted, which `#end` couldn't count yet.
      this.#ctx.waitUntil(this.#count("page"));
      return;
    }
    this.#rate = start.sampleRate;
    const left = hearer.budget - hearer.heard;
    this.#byBudget = left < maxSessionSeconds;
    this.#maxBytes = Math.floor(
      Math.min(left, maxSessionSeconds) * bytesPerSecond(this.#rate)
    );
    this.#state = "open";
    tell(this.#socket, {
      type: "ready",
      session: this.#id,
      maxSeconds: Math.min(maxSessionSeconds, Math.floor(left)),
    });
    void this.#relay(session);
  }

  /** Passes on what the upstream hears, until it ends. */
  async #relay(session: TranscriptionSession): Promise<void> {
    for await (const event of session.events) {
      if (this.#isEnded()) {
        return;
      }
      if (event.type === "partial") {
        tell(this.#socket, { type: "partial", text: event.text });
      } else if (event.type === "committed") {
        tell(this.#socket, {
          type: "final",
          text: event.text,
          words: event.words,
        });
      } else {
        log.warn("transcription.upstream_failed", {
          requestId: this.#requestId,
          code: event.code,
        });
        this.#fail(transcriptionErrors.create("transcription.failed"));
        return;
      }
    }
    this.#end("upstream");
  }

  /** Whether the session ended, while an await gave the page time to end it. */
  #isEnded(): boolean {
    return this.#state === "ended";
  }

  #control(text: string): void {
    const parsed = transcriptionCommitSchema.safeParse(
      text.length > transcriptionTextMaxBytes ? undefined : jsonOf(text)
    );
    if (parsed.success) {
      this.#session?.commit();
    } else {
      this.#refuse(transcriptionErrors.create("transcription.invalid"));
    }
  }

  #audio(data: ArrayBuffer): void {
    const size = data.byteLength;
    if (size === 0 || size > transcriptionFrameMaxBytes || size % 2 !== 0) {
      this.#refuse(transcriptionErrors.create("transcription.invalid"));
      return;
    }
    if (this.#bytes + size > this.#maxBytes) {
      if (this.#byBudget) {
        this.#refuse(transcriptionErrors.create("transcription.limited"));
      } else {
        this.#end(
          "expired",
          transcriptionErrors.create("transcription.expired")
        );
      }
      return;
    }
    this.#bytes += size;
    this.#session?.send(new Uint8Array(data));
  }

  #refuse(error: CodedError): void {
    const limited =
      transcriptionErrors.codeOf(error) === "transcription.limited";
    this.#end(limited ? "limited" : "refused", error);
  }

  #fail(error: CodedError): void {
    this.#end("failed", error);
  }

  /**
   * Ends the session once, whoever ended it: the upstream closed with
   * the page, the page with the upstream, and what it heard counted.
   */
  #end(ended: Ended, error?: CodedError): void {
    if (this.#isEnded()) {
      return;
    }
    this.#state = "ended";
    clearTimeout(this.#deadline);
    this.#session?.close();
    if (error !== undefined) {
      tell(this.#socket, {
        type: "error",
        code: error.code,
        message: error.message,
      });
    }
    closeQuietly(this.#socket, closeCodeOf(ended));
    if (this.#hearer !== undefined) {
      this.#ctx.waitUntil(this.#count(ended));
    }
  }

  async #count(ended: Ended): Promise<void> {
    const hearer = this.#hearer;
    if (hearer === undefined) {
      return;
    }
    try {
      await onboardingStore(this.#env).transcriptionClosed({
        ...this.#note(hearer),
        who: hearer.who,
        purpose: hearer.counted,
        seconds:
          this.#rate === 0 ? 0 : this.#bytes / bytesPerSecond(this.#rate),
        ended,
      });
    } catch {
      log.error("transcription.count_failed", { requestId: this.#requestId });
    }
  }

  #note(hearer: Hearer) {
    return {
      id: this.#id,
      by: hearer.by,
      ...(hearer.person === undefined ? {} : { person: hearer.person }),
    };
  }
}

/** `GET /api/transcription`: a live transcription, for someone's link or an admin. */
export const transcriptionResponse = (
  request: Request,
  env: Env,
  requestId: string,
  ctx: Pick<ExecutionContext, "waitUntil">
): Response => {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    const response = errorResponse(
      426,
      requestErrors.create("request.upgrade_required"),
      requestId
    );
    response.headers.set("Upgrade", "websocket");
    return response;
  }
  if (!isOwnOrigin(request, env)) {
    return errorResponse(
      403,
      requestErrors.create("request.forbidden"),
      requestId
    );
  }
  const { 0: client, 1: server } = new WebSocketPair();
  // Audio as bytes, in order, rather than a `Blob` read later.
  server.binaryType = "arraybuffer";
  server.accept();
  new Relay(env, request.headers, server, requestId, ctx).listen();
  return new Response(null, { status: 101, webSocket: client });
};
