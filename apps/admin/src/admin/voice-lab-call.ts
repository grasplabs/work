/**
 * One call of the Voice Lab, in the browser: the page joins the session
 * the admin opened for it (src/admin/voice-lab.ts) through Mistral's own
 * voice agent SDK, which takes the microphone, plays the interviewer's
 * voice, and tells what happens in the session. What it tells is kept
 * here as the page shows it: where the call stands, what he is doing, the
 * conversation as it is written down, and when each of his answers began
 * (src/admin/voice-lab-heard.ts).
 *
 * Nothing said is kept anywhere but in this page, until it is left.
 *
 * Mistral's SDK and the audio transport it brings are loaded when a call
 * begins, never with the page: they are large, and only the browser runs
 * them.
 */
import {
  closeVoiceSessionFn,
  openVoiceSessionFn,
} from "./voice-lab-functions.ts";
import { withSegment } from "./voice-lab-heard.ts";
import type { Moment, Segment } from "./voice-lab-heard.ts";
import type { VoiceLabInput, VoiceLabRefusal } from "./voice-lab.ts";

/** What the interviewer is doing, as the session says it. */
export type AgentState =
  | "initializing"
  | "idle"
  | "listening"
  | "thinking"
  | "speaking";

/** Why a call isn't on: it couldn't be opened, or it broke off. */
export type CallTrouble = VoiceLabRefusal | "not_connected" | "broke_off";

/** A call as the page shows it. */
export interface Call {
  /** Not begun, being set up, on, or over. */
  stands: "idle" | "connecting" | "live" | "over";
  agent: AgentState | null;
  muted: boolean;
  said: Segment[];
  moments: Moment[];
  trouble: CallTrouble | null;
  /** What the session itself said went wrong, in its own words, for whoever looks into it. */
  detail: string | null;
}

export const noCall: Call = {
  stands: "idle",
  agent: null,
  muted: false,
  said: [],
  moments: [],
  trouble: null,
  detail: null,
};

/** A call under way: how to mute it and how to end it. */
export interface Calling {
  setMuted: (muted: boolean) => void;
  end: () => void;
}

/** Thrown when the admin opened no session, with why. */
class NotOpenedError extends Error {
  override name = "NotOpenedError";
  readonly refused: VoiceLabRefusal;

  constructor(refused: VoiceLabRefusal) {
    super(`No voice session: ${refused}`);
    this.refused = refused;
  }
}

/**
 * Begins a call for `input`: `show` gets the call each time it changes.
 * What comes back mutes and ends it; ending it leaves the room and has
 * the admin close the session at Mistral.
 */
export const beginCall = (
  input: VoiceLabInput,
  show: (call: Call) => void
): Calling => {
  let call: Call = { ...noCall, stands: "connecting" };
  /** They ended it: nothing that still comes back of it shows any more. */
  let ended = false;
  /** Set once the page is in the room: how to leave it. */
  let leave: (() => Promise<void>) | null = null;
  let mute: ((muted: boolean) => Promise<void>) | null = null;
  const set = (next: Partial<Call>): void => {
    if (ended) {
      return;
    }
    call = { ...call, ...next };
    show(call);
  };
  const timed = (what: Moment["what"]): void => {
    set({ moments: [...call.moments, { at: performance.now(), what }] });
  };
  show(call);
  const join = async (): Promise<void> => {
    const { initSession } =
      await import("@mistralai/mistralai/extra/voice-agents/browser");
    if (ended) {
      return;
    }
    const session = await initSession({
      createSession: async () => {
        const opened = await openVoiceSessionFn({ data: input });
        if (opened.refused !== null) {
          throw new NotOpenedError(opened.refused);
        }
        return {
          id: opened.id,
          participantToken: opened.participantToken,
          serverUrl: opened.serverUrl,
          createdAt: new Date(),
          expiresAt: new Date(opened.expiresAt),
        };
      },
      deleteSession: async (sessionId) => {
        await closeVoiceSessionFn({ data: { sessionId } });
      },
    });
    mute = async (muted) => {
      await session.setInputEnabled(!muted);
    };
    session.on("transcript", ({ id, role, content, final }) => {
      set({ said: withSegment(call.said, { id, role, content, final }) });
      if (role === "user" && final) {
        timed("said");
      }
    });
    session.on("agent_state_changed", ({ state }) => {
      set({ agent: state });
      if (state === "speaking") {
        timed("speaks");
      }
    });
    session.on("error", ({ message, fatal }) => {
      set(
        fatal ? { trouble: "broke_off", detail: message } : { detail: message }
      );
    });
    session.on("disconnected", () => {
      set({ stands: "over", agent: null });
    });
    // Ended while it was set up: left only once joining has settled, as
    // the SDK takes the microphone at the end of it, and a close before
    // that would leave the microphone on.
    try {
      if (!ended) {
        await session.connect();
      }
    } finally {
      if (ended) {
        await session.close();
      }
    }
    leave = async () => {
      await session.close();
    };
    set({ stands: "live" });
  };
  void (async () => {
    try {
      await join();
    } catch (error) {
      // A session the admin didn't open says why itself; anything else is
      // told in the SDK's own words, for whoever looks into it.
      const refused = error instanceof NotOpenedError ? error.refused : null;
      set({
        stands: "over",
        agent: null,
        trouble: refused ?? "not_connected",
        detail:
          refused === null && error instanceof Error ? error.message : null,
      });
    }
  })();
  return {
    setMuted: (muted) => {
      const was = call.muted;
      set({ muted });
      void (async () => {
        try {
          await mute?.(muted);
        } catch {
          // The microphone is as it was: the page says so.
          set({ muted: was });
        }
      })();
    },
    end: () => {
      set({ stands: "over", agent: null });
      ended = true;
      // In the room, it is left now; still joining, once that has settled.
      void leave?.();
    },
  };
};
