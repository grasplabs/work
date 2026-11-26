import { interviewPhases } from "@grasp-os/shared/interview-links";
import type { InterviewPhase } from "@grasp-os/shared/interview-turn";
import { partFunction } from "@grasp-os/shared/interview-voice";
import type { InterviewVoiceRequest } from "@grasp-os/shared/interview-voice";

import { closeVoice, isRefused, openVoice } from "./api.ts";
import type { Refused } from "./api.ts";

// The interview held as one live voice session at Mistral (core's
// onboarding/voice.ts): the page joins the session's room with what core
// answers, through Mistral's own voice agent SDK, which takes the
// microphone and plays Stephen's voice. Mistral listens, Stephen answers
// there, and they can talk over him. What the session tells is handed to
// the conversation (loop.ts) as it happens: their words and his as they
// are heard and said, what he is doing, and the part he goes to. Nothing
// said leaves the page but to Mistral; what is written down core reads
// from Mistral's own transcript.
//
// The SDK and the audio transport it brings are loaded when a session
// begins, never with the page: they are large, and only a talk needs them.

/** What the session says Stephen is doing. */
export type LiveDoing =
  | "initializing"
  | "idle"
  | "listening"
  | "thinking"
  | "speaking";

/** A stretch of the conversation as Mistral writes it down: all its words so far. */
export interface LiveSegment {
  id: string;
  from: "person" | "stephen";
  text: string;
  /** No more of it comes. */
  final: boolean;
}

/** What the session tells, as it happens. */
export interface LiveHandlers {
  segment: (segment: LiveSegment) => void;
  doing: (doing: LiveDoing) => void;
  /** Stephen goes to another part of the interview (`partFunction`). */
  part: (part: InterviewPhase) => void;
  /** It ended without the page closing it: dropped, or it broke off. */
  ended: () => void;
}

/** A session the page is in. */
export interface Live {
  /** What core is sent back with each answer and the close. */
  pass: string;
  /** What Stephen is told from now on: it takes effect at his next turn. */
  instruct: (instructions: string) => Promise<void>;
  setMuted: (muted: boolean) => Promise<void>;
  /**
   * Stops his voice here at once, or lets it be heard again: what is
   * said in the room goes on, but nothing of it is played.
   */
  hush: (hushed: boolean) => void;
  /** Leaves the room and closes the session at Mistral; again does nothing. */
  close: () => Promise<void>;
}

/** Thrown when core opened no session, with why. */
class NotOpenedError extends Error {
  override name = "NotOpenedError";
  readonly refused: Refused;

  constructor(refused: Refused) {
    super(`No voice session: ${refused.message}`);
    this.refused = refused;
  }
}

const isPhase = (value: unknown): value is InterviewPhase =>
  interviewPhases.some((phase) => phase === value);

/**
 * Joins a live session for `request`: the session, or why core opened
 * none; null when the session opened but the page couldn't join it, or
 * the browser has nothing to join it with. A session that couldn't be
 * joined is closed at Mistral.
 */
export const joinLive = async (
  request: Extract<InterviewVoiceRequest, { action: "open" }>,
  on: LiveHandlers
): Promise<Live | Refused | null> => {
  if (typeof RTCPeerConnection === "undefined") {
    return null;
  }
  let pass: string | null = null;
  let closed = false;
  try {
    const { initSession } =
      await import("@mistralai/mistralai/extra/voice-agents/browser");
    const session = await initSession({
      createSession: async () => {
        const opened = await openVoice(request);
        if (isRefused(opened)) {
          throw new NotOpenedError(opened);
        }
        ({ pass } = opened);
        return {
          id: opened.id,
          participantToken: opened.participantToken,
          serverUrl: opened.serverUrl,
          createdAt: new Date(),
          expiresAt: new Date(opened.expiresAt),
        };
      },
      deleteSession: async () => {
        if (pass !== null) {
          await closeVoice({ action: "close", secret: request.secret, pass });
        }
      },
      functionHandlers: {
        // The page answers his move to another part; core reads it from Mistral's transcript.
        [partFunction]: (args) => {
          const { part } = args;
          if (isPhase(part)) {
            on.part(part);
          }
          return { ok: true };
        },
      },
    });
    const close = async (): Promise<void> => {
      if (closed) {
        return;
      }
      closed = true;
      try {
        await session.close();
      } catch {
        // Nothing more to let go of: it ends by itself when it expires.
      }
    };
    session.on("transcript", ({ id, role, content, final }) => {
      if (!closed) {
        on.segment({
          id,
          from: role === "user" ? "person" : "stephen",
          text: content,
          final,
        });
      }
    });
    session.on("agent_state_changed", ({ state }) => {
      if (!closed) {
        on.doing(state);
      }
    });
    session.on("error", ({ fatal }) => {
      if (fatal && !closed) {
        void close();
        on.ended();
      }
    });
    session.on("disconnected", () => {
      if (!closed) {
        // Dropped from the other side: the session is still closed at Mistral.
        void close();
        on.ended();
      }
    });
    try {
      await session.connect();
    } catch (error) {
      await close();
      throw error;
    }
    const joined = pass;
    if (joined === null) {
      await close();
      return null;
    }
    return {
      pass: joined,
      instruct: async (instructions) => {
        if (!closed) {
          await session.update({ instructions });
        }
      },
      setMuted: async (muted) => {
        if (!closed) {
          await session.setInputEnabled(!muted);
        }
      },
      hush: (hushed) => {
        const voice = session.remoteTrack;
        if (voice !== null) {
          voice.enabled = !hushed;
        }
      },
      close,
    };
  } catch (error) {
    if (error instanceof NotOpenedError) {
      return error.refused;
    }
    return null;
  }
};
