import type { Locale } from "../i18n.ts";
import { pcmBytes, transcriptionRate } from "./pcm.ts";

// The live line (prototype `data/scribe.ts`): what someone says, sent as
// they say it over a WebSocket to core on the page's own origin
// (`GET /api/transcription`), which relays it to the transcription
// upstream; their words come back while they talk. Core takes the link's
// secret and the device's key in the first frame, and picks the words to
// listen for itself. Only stretches of speech are sent, and a little
// silence now and then, so the upstream doesn't hang up while nobody
// speaks.
//
// It is a faster way to the same words and never the only one: without a
// line, or when a stretch's words don't come in time, `end` gives nothing,
// and the ear has the stretch written down from its recording.

/** Where the onboarding's pages open a live transcription (`transcriptionPath` in `@grasp-os/shared/voice`). */
const transcriptionPath = "/api/transcription";
/** The most bytes one audio frame may hold. */
const frameMaxBytes = 32 * 1024;
/** The upstream closes on a stretch shorter than 0.3 seconds: a shorter one is filled up with silence to this first, in seconds. */
const leastSeconds = 0.4;
/** How long the words of a closed stretch may take, in ms, before its recording is written down instead. */
const wordsMs = 1500;
/** The upstream hangs up after fifteen seconds without sound: a little silence goes out this often while nobody speaks, in ms. */
const keepMs = 8000;
/** How long a line that was refused is left alone before it is tried again, in ms; one that dropped, much shorter. */
const refusedAgainMs = 30_000;
const droppedAgainMs = 2000;
/** How long the line may take to say it listens, in ms. */
const readyMs = 10_000;
/** The close code core refuses with: a new line would only meet it again soon. */
const refusedCode = 1008;

/** What a live line is opened with. */
export interface LiveLineOptions {
  locale: Locale;
  link: { secret: string; key: string };
  /** What is heard so far of the stretch being sent, all of it, every time there is more. */
  onPartial: (text: string) => void;
  /** The line is listening, or not any more. */
  onLive: (live: boolean) => void;
}

/** A live line, as the ear uses it. */
export interface LiveLine {
  /** They speak: the second kept before goes out, and what follows as it comes. False without a line. */
  begin: (before: Int16Array) => boolean;
  /** The next of what they say, while a stretch goes out. */
  send: (sound: Int16Array) => void;
  /** They fell quiet: the stretch's words, or nothing when they don't come in time. */
  end: () => Promise<string | null>;
  /** The stretch counts for nothing. */
  drop: () => void;
  /** Lets go of the line. */
  close: () => void;
}

/** What core says on the line, as far as the page reads it. */
const messageOf = (data: unknown): { type: string; text: string } | null => {
  if (typeof data !== "string") {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const type = "type" in parsed ? parsed.type : undefined;
    const text = "text" in parsed ? parsed.text : undefined;
    return typeof type === "string"
      ? { type, text: typeof text === "string" ? text.trim() : "" }
      : null;
  } catch {
    return null;
  }
};

/** Two pieces of what was said, as one. */
const both = (first: string, then: string): string =>
  [first, then].filter((piece) => piece !== "").join(" ");

/** Where the line is opened: this origin, over a WebSocket. */
const lineUrl = (): string => {
  const url = new URL(transcriptionPath, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
};

/** A closed stretch whose words are still to come. */
interface Owed {
  take: (words: string | null) => void;
}

/** Opens the live line, and opens it again whenever it drops, until closed. */
export const openLiveLine = (options: LiveLineOptions): LiveLine => {
  let socket: WebSocket | null = null;
  let ready = false;
  let closed = false;
  let sending = false;
  /** How much went out since the last stretch was closed, in samples. */
  let sent = 0;
  /** The words of this stretch the upstream settled by itself, at a pause. */
  let settled = "";
  /** The stretches closed whose words are still to come, oldest first. */
  const owed: Owed[] = [];
  let keeping = 0;
  let again = 0;
  let waiting = 0;

  const out = (sound: Int16Array): void => {
    if (!ready || socket === null) {
      return;
    }
    sent += sound.length;
    const bytes = pcmBytes(sound);
    try {
      for (let at = 0; at < bytes.length; at += frameMaxBytes) {
        socket.send(bytes.subarray(at, at + frameMaxBytes));
      }
    } catch {
      // Lost: the close says so.
    }
  };

  /** The line is gone: whoever waits for words gets none, and it is opened again in a while. */
  const lost = (refused: boolean): void => {
    const was = ready;
    ready = false;
    sending = false;
    sent = 0;
    settled = "";
    socket = null;
    window.clearInterval(keeping);
    window.clearTimeout(waiting);
    for (const entry of owed.splice(0)) {
      entry.take(null);
    }
    if (was) {
      options.onLive(false);
    }
    if (!closed) {
      window.clearTimeout(again);
      const wait = refused ? refusedAgainMs : droppedAgainMs;
      // oxlint-disable-next-line no-use-before-define -- opening and losing call each other
      again = window.setTimeout(open, wait);
    }
  };

  const heard = (data: unknown): void => {
    const message = messageOf(data);
    if (message === null) {
      return;
    }
    if (message.type === "ready") {
      ready = true;
      window.clearTimeout(waiting);
      window.clearInterval(keeping);
      keeping = window.setInterval(() => {
        if (!sending) {
          out(new Int16Array(transcriptionRate / 10));
        }
      }, keepMs);
      options.onLive(true);
    } else if (message.type === "partial") {
      // While the words of the stretch before are still to come, these are still of that one.
      if (sending && owed.length === 0) {
        options.onPartial(both(settled, message.text));
      }
    } else if (message.type === "final") {
      const entry = owed.shift();
      if (entry !== undefined) {
        entry.take(message.text);
      } else if (sending) {
        // A pause the upstream settled by itself, in the middle of a stretch.
        settled = both(settled, message.text);
        options.onPartial(settled);
      }
    }
  };

  const open = (): void => {
    if (closed || typeof WebSocket === "undefined") {
      return;
    }
    let mine: WebSocket;
    try {
      mine = new WebSocket(lineUrl());
    } catch {
      lost(true);
      return;
    }
    socket = mine;
    mine.binaryType = "arraybuffer";
    mine.addEventListener("open", () => {
      mine.send(
        JSON.stringify({
          type: "start",
          language: options.locale,
          sampleRate: transcriptionRate,
          link: options.link,
        })
      );
    });
    mine.addEventListener("message", (event) => {
      if (socket === mine) {
        heard(event.data);
      }
    });
    mine.addEventListener("close", (event) => {
      if (socket === mine) {
        lost(event.code === refusedCode);
      }
    });
    waiting = window.setTimeout(() => {
      if (socket === mine && !ready) {
        mine.close(1000);
        lost(false);
      }
    }, readyMs);
  };

  /** Closes the stretch being sent; its words come back, or nothing when they don't in time. */
  const close = async (): Promise<string | null> => {
    sending = false;
    const least = Math.round(leastSeconds * transcriptionRate);
    if (sent < least) {
      out(new Int16Array(least - sent));
    }
    sent = 0;
    const first = settled;
    settled = "";
    const words = Promise.withResolvers<string | null>();
    let late = 0;
    const entry: Owed = {
      take: (text) => {
        window.clearTimeout(late);
        words.resolve(text === null ? null : both(first, text));
      },
    };
    // Not waited for any longer: when its words do come, they are nobody's.
    late = window.setTimeout(() => {
      entry.take = () => {
        // Too late.
      };
      words.resolve(null);
    }, wordsMs);
    owed.push(entry);
    try {
      socket?.send(JSON.stringify({ type: "commit" }));
    } catch {
      // Lost: the close says so.
    }
    return await words.promise;
  };

  open();

  return {
    begin: (before) => {
      if (!ready || sending) {
        return sending && ready;
      }
      sending = true;
      settled = "";
      out(before);
      return true;
    },
    send: (sound) => {
      if (sending) {
        out(sound);
      }
    },
    end: async () => (sending && ready ? await close() : null),
    drop: () => {
      if (sending && ready) {
        void close();
      }
      sending = false;
    },
    close: () => {
      closed = true;
      window.clearTimeout(again);
      const was = socket;
      lost(false);
      was?.close(1000);
    },
  };
};
