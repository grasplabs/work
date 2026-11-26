import {
  interviewLimits,
  interviewPhases,
} from "@grasp-os/shared/interview-links";
import type { InterviewPhase } from "@grasp-os/shared/interview-turn";
import { partFunction } from "@grasp-os/shared/interview-voice";
import type {
  AgentJoin,
  InterviewVoiceRequest,
  MistralJoin,
  VoiceAnswered,
  VoiceLine,
} from "@grasp-os/shared/interview-voice";

import { closeVoice, isRefused, openVoice } from "./api.ts";
import type { Refused } from "./api.ts";

// The interview held as one live voice session (core's onboarding/voice.ts),
// as core opens it: a conversation with Grasp's ElevenLabs agent, or a
// session at Mistral. Either way the provider's own SDK takes the
// microphone and plays Stephen's voice; the provider listens, Stephen
// answers there, and they can talk over him. What the session tells is
// handed to the conversation (loop.ts) as it happens: their words and his
// as they are heard and said, what he is doing, and the part he goes to.
//
// - ElevenLabs: the page starts the conversation with the token core
//   asked for on Grasp's key, and sends what core says Stephen is told and
//   says first as the agent's overrides. What was said core can't read
//   there: the page sends it with each answer (`said`). Where the
//   interview stands after each answer reaches him as a contextual update.
// - Mistral: the page joins the session's room with what core answers;
//   what is written down core reads from Mistral's own transcript.
//
// Nothing said leaves the page but to the provider and core. The SDKs and
// the audio transport they bring are loaded when a session begins, never
// with the page: they are large, and only a talk needs them.

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
  /**
   * It began, but Stephen never said his first line: the provider refused
   * part of it, or said nothing in time. The session is closed already.
   */
  failed: () => void;
}

/** A session the page is in. */
export interface Live {
  /** What core is sent back with each answer and the close. */
  pass: string;
  /** What Stephen is told from now on, as core answered it: it takes effect at his next turn. */
  instruct: (
    told: Pick<VoiceAnswered, "instructions" | "situation">
  ) => Promise<void>;
  /**
   * The conversation of this session as the page heard it, for core to
   * write down from; null where core reads the provider's own transcript.
   */
  said: () => VoiceLine[] | null;
  /**
   * Hands what they typed to Stephen in the session, as their turn; null
   * where the session takes no typing.
   */
  type: ((text: string) => void) | null;
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

type OpenRequest = Extract<InterviewVoiceRequest, { action: "open" }>;

/**
 * Joins the session at Mistral core opened (`first`): its room, through
 * Mistral's SDK. Should the SDK ask for another, core opens it.
 */
const joinMistral = async (
  first: MistralJoin,
  request: OpenRequest,
  on: LiveHandlers
): Promise<Live | Refused | null> => {
  let pass: string | null = null;
  let closed = false;
  let given: MistralJoin | null = first;
  try {
    const { initSession } =
      await import("@mistralai/mistralai/extra/voice-agents/browser");
    const session = await initSession({
      createSession: async () => {
        const opened = given ?? (await openVoice(request));
        given = null;
        if (isRefused(opened)) {
          throw new NotOpenedError(opened);
        }
        if (opened.via !== "mistral") {
          throw new Error("Not a session at Mistral");
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
      instruct: async ({ instructions }) => {
        if (!closed) {
          await session.update({ instructions });
        }
      },
      said: () => null,
      type: null,
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

/**
 * How long his first line may take to come once the conversation began,
 * in ms: past it, the conversation counts as failed.
 */
const firstLineMs = 10_000;

/** What a client tool answers ElevenLabs: that the page took it. */
const tookIt = "ok";

/**
 * Starts the conversation with Grasp's ElevenLabs agent core opened
 * (`join`), through ElevenLabs's own SDK, over WebRTC: with the token core
 * asked for, and what core says Stephen is told and says first as the
 * agent's overrides. Its audio worklets come from this origin, as the
 * page's policy lets scripts come from nowhere else.
 */
const joinAgent = async (
  join: AgentJoin,
  on: LiveHandlers
): Promise<Live | null> => {
  let closed = false;
  /** The conversation as heard here: what core writes down from. */
  const said: VoiceLine[] = [];
  /** Their stretch being heard now, and how many came before. */
  let theirs = 0;
  let hisCount = 0;
  /** What they typed last, not yet heard back from the agent, if it echoes it. */
  let typed: string | null = null;
  /** Whether his first line came. */
  let begun = false;
  /** Ends a conversation his first line never came in: set once it began. */
  let fail: ((why: string) => void) | null = null;
  const keep = (line: VoiceLine): void => {
    said.push({
      from: line.from,
      text: line.text.slice(0, interviewLimits.line),
    });
    if (said.length > interviewLimits.lines) {
      said.splice(0, said.length - interviewLimits.lines);
    }
  };
  try {
    const [{ Conversation }, raw, concat] = await Promise.all([
      import("@elevenlabs/client"),
      import("@elevenlabs/client/worklets/rawAudioProcessor.js?url"),
      import("@elevenlabs/client/worklets/audioConcatProcessor.js?url"),
    ]);
    const conversation = await Conversation.startSession({
      conversationToken: join.conversationToken,
      connectionType: "webrtc",
      overrides: {
        agent: {
          prompt: { prompt: join.prompt },
          firstMessage: join.firstMessage,
          language: join.language,
        },
      },
      workletPaths: {
        rawAudioProcessor: raw.default,
        audioConcatProcessor: concat.default,
      },
      clientTools: {
        // He goes to another part: the page follows; the notes hear of it from the page.
        [partFunction]: (parameters: unknown) => {
          const part =
            typeof parameters === "object" &&
            parameters !== null &&
            "part" in parameters
              ? parameters.part
              : null;
          if (!closed && isPhase(part)) {
            on.part(part);
          }
          return tookIt;
        },
      },
      onStatusChange: ({ status }) => {
        if (!closed && status === "connecting") {
          on.doing("initializing");
        }
      },
      onModeChange: ({ mode }) => {
        if (!closed) {
          on.doing(mode === "speaking" ? "speaking" : "listening");
        }
      },
      onIncomingEvent: (event: unknown) => {
        // Their words as they are heard, before the agent settles on them.
        if (
          closed ||
          typeof event !== "object" ||
          event === null ||
          !("type" in event) ||
          event.type !== "tentative_user_transcript" ||
          !("tentative_user_transcription_event" in event)
        ) {
          return;
        }
        const heard = event.tentative_user_transcription_event;
        const text =
          typeof heard === "object" &&
          heard !== null &&
          "user_transcript" in heard &&
          typeof heard.user_transcript === "string"
            ? heard.user_transcript
            : "";
        if (text !== "") {
          on.segment({
            id: `you-${theirs}`,
            from: "person",
            text,
            final: false,
          });
        }
      },
      onMessage: ({ role, message }) => {
        if (closed) {
          return;
        }
        if (role === "user") {
          if (typed !== null && message.trim() === typed) {
            // What they typed, heard back: it stands already.
            typed = null;
            return;
          }
          keep({ from: "person", text: message });
          on.segment({
            id: `you-${theirs}`,
            from: "person",
            text: message,
            final: true,
          });
          theirs += 1;
          // Heard: he thinks of his answer until his voice comes.
          on.doing("thinking");
          return;
        }
        begun = true;
        keep({ from: "stephen", text: message });
        on.segment({
          id: `his-${hisCount}`,
          from: "stephen",
          text: message,
          final: true,
        });
        hisCount += 1;
      },
      onAgentResponseCorrection: ({ corrected_agent_response }) => {
        // Talked over: what was said of his line is what was played.
        const at = said.findLastIndex(({ from }) => from === "stephen");
        if (!closed && at !== -1) {
          said[at] = {
            from: "stephen",
            text: corrected_agent_response.slice(0, interviewLimits.line),
          };
        }
      },
      onError: (message: string) => {
        // What ElevenLabs said went wrong, for whoever looks: never what was said.
        console.warn("[interview] ElevenLabs:", message);
        if (!begun) {
          fail?.(message);
        }
      },
      onDisconnect: () => {
        if (!closed) {
          // Dropped from the other side, or he ended it.
          closed = true;
          on.ended();
        }
      },
    });
    const close = async (): Promise<void> => {
      if (closed) {
        return;
      }
      closed = true;
      try {
        await conversation.endSession();
      } catch {
        // Nothing more to let go of: the agent ends it by itself.
      }
    };
    // Begun, but without his first line, it is no conversation: closed, and the page goes on without it.
    fail = (why) => {
      if (closed || begun) {
        return;
      }
      console.warn("[interview] Stephen's first line never came:", why);
      void close();
      on.failed();
    };
    window.setTimeout(() => {
      fail?.("nothing in time");
    }, firstLineMs);
    return {
      pass: join.pass,
      instruct: async ({ situation }) => {
        if (!closed) {
          conversation.sendContextualUpdate(
            `Where the interview stands now (it replaces what you were told of it before):\n${situation}`
          );
        }
        await Promise.resolve();
      },
      said: () => [...said],
      type: (text) => {
        if (closed) {
          return;
        }
        typed = text.trim();
        keep({ from: "person", text: typed });
        conversation.sendUserMessage(typed);
        on.doing("thinking");
      },
      setMuted: async (muted) => {
        if (!closed) {
          conversation.setMicMuted(muted);
        }
        await Promise.resolve();
      },
      hush: (hushed) => {
        if (!closed) {
          conversation.setVolume({ volume: hushed ? 0 : 1 });
        }
      },
      close,
    };
  } catch {
    closed = true;
    return null;
  }
};

/**
 * Joins a live session for `request`: the session, or why core opened
 * none; null when the session opened but the page couldn't join it, or
 * the browser has nothing to join it with. A session at Mistral that
 * couldn't be joined is closed there.
 */
export const joinLive = async (
  request: OpenRequest,
  on: LiveHandlers
): Promise<Live | Refused | null> => {
  if (typeof RTCPeerConnection === "undefined") {
    return null;
  }
  let opened: Awaited<ReturnType<typeof openVoice>>;
  try {
    opened = await openVoice(request);
  } catch {
    return null;
  }
  if (isRefused(opened)) {
    return opened;
  }
  return opened.via === "elevenlabs"
    ? await joinAgent(opened, on)
    : await joinMistral(opened, request, on);
};
