import type { PartialOptions, VoiceConversation } from "@elevenlabs/client";
import {
  interviewLimits,
  interviewPhases,
} from "@grasp-os/shared/interview-links";
import type { InterviewPhase } from "@grasp-os/shared/interview-turn";
import { partFunction } from "@grasp-os/shared/interview-voice";
import type {
  InterviewVoiceRequest,
  VoiceLine,
  VoiceSessionJoin,
} from "@grasp-os/shared/interview-voice";

import { closeVoice, isRefused, openVoice } from "./api.ts";
import type { Refused } from "./api.ts";

// The interview held as one live conversation with Grasp's ElevenLabs
// agent (core's onboarding/voice.ts), as core opens it. ElevenLabs's own
// SDK takes the microphone and plays Stephen's voice; ElevenLabs listens,
// Stephen answers there, and they can talk over him. What the conversation
// tells is handed to the loop (loop.ts) as it happens: their words and his
// as they are heard and said, what he is doing, and the part he goes to.
//
// Whoever can't or won't talk types to the same agent, in a conversation
// without sound (`textOnly`): no microphone is asked for, nothing is
// played, and his answers come as text. The agent must allow that
// override in its dashboard, or ElevenLabs refuses the conversation.
//
// The page starts the conversation with the token core asked for on
// Grasp's key, and tells the agent who it talks with as context: its
// prompt and first line are its own. What was said core can't read there:
// the page sends it with each answer (`said`).
//
// Nothing said leaves the page but to ElevenLabs and core. The SDK and the
// audio transport it brings are loaded when a conversation begins, never
// with the page: they are large, and only a talk needs them.

/** What the session says Stephen is doing. */
export type LiveDoing =
  | "initializing"
  | "idle"
  | "listening"
  | "thinking"
  | "speaking";

/** A stretch of the conversation as it is heard: all its words so far. */
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
  /** Stephen ended it himself after his goodbye: the read-back follows. */
  finished: () => void;
  /**
   * It began, but Stephen never said his first line: the provider refused
   * part of it, or said nothing in time. The session is closed already.
   */
  failed: () => void;
}

/** A conversation the page is in. */
export interface Live {
  /** What core is sent back with each answer and the close. */
  pass: string;
  /** Held without sound: they type, and his answers come as text. */
  textOnly: boolean;
  /** The conversation as the page heard it, for core to write down from. */
  said: () => VoiceLine[];
  /** Hands what they typed to Stephen in the conversation, as their turn. */
  type: (text: string) => void;
  /** They are typing: he waits for it, and doesn't ask whether they are still there. */
  typing: () => void;
  setMuted: (muted: boolean) => Promise<void>;
  /**
   * Stops his voice here at once, or lets it be heard again: what is
   * said in the room goes on, but nothing of it is played.
   */
  hush: (hushed: boolean) => void;
  /**
   * Their words as our own ear's live line sends them while they talk
   * (its `words`): all heard since the last settled words, or those
   * settled now. Shown over the box as they come, through every pause and
   * however long they talk, until the agent's own words for their turn
   * come; what they say after that is the next turn's.
   */
  overheard: (text: string, settled: boolean) => void;
  /** How loud he is and how loud they are, 0 to 1, as the conversation hears it now. */
  levels: () => { his: number; theirs: number };
  /** Ends the conversation; again does nothing. */
  close: () => Promise<void>;
}

const isPhase = (value: unknown): value is InterviewPhase =>
  interviewPhases.some((phase) => phase === value);

/**
 * How long his first line may take to come once the conversation began,
 * in ms: past it, the conversation counts as failed.
 */
const firstLineMs = 10_000;

/** What a client tool answers ElevenLabs: that the page took it. */
const tookIt = "ok";

/**
 * How long their words as our ear heard them stay over the box once no
 * more came, if the agent never takes them up as their turn, in ms.
 */
const overheardMs = 6000;

/** The words of `text` past as many as `before` has: its last word may have grown since, and is still old. */
const after = (text: string, before: string): string => {
  const old = before.split(/\s+/u).filter((word) => word !== "").length;
  return old === 0
    ? text
    : text
        .split(/\s+/u)
        .filter((word) => word !== "")
        .slice(old)
        .join(" ");
};

/** What starts a conversation with the agent: the SDK's own, loaded once it is needed (`loadAgentSdk`). */
export type StartAgent = (
  options: PartialOptions
) => Promise<
  Pick<
    VoiceConversation,
    | "sendContextualUpdate"
    | "sendUserMessage"
    | "sendUserActivity"
    | "setMicMuted"
    | "setVolume"
    | "getInputVolume"
    | "getOutputVolume"
    | "endSession"
  >
>;

/** Where ElevenLabs holds a conversation whose token was asked at its EU residency host. */
const euResidency = {
  origin: "wss://api.eu.residency.elevenlabs.io",
  livekitUrl: "wss://livekit.rtc.eu.residency.elevenlabs.io",
} as const;

/**
 * The SDK, over WebRTC, with its audio worklets served from this site: the
 * page's policy lets scripts come from nowhere else, and refuses them
 * inline.
 */
const loadAgentSdk = async (): Promise<StartAgent> => {
  const [{ Conversation }, raw, concat] = await Promise.all([
    import("@elevenlabs/client"),
    import("@elevenlabs/client/worklets/rawAudioProcessor.js?url"),
    import("@elevenlabs/client/worklets/audioConcatProcessor.js?url"),
  ]);
  return async (options) =>
    await Conversation.startSession({
      ...options,
      workletPaths: {
        rawAudioProcessor: raw.default,
        audioConcatProcessor: concat.default,
      },
    });
};

/**
 * Joins the conversation core opened with the agent, started by `start`;
 * null when it can't be. With `textOnly`, without sound: they type.
 */
export const joinAgent = async (
  join: VoiceSessionJoin,
  on: LiveHandlers,
  textOnly: boolean,
  start?: StartAgent
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
  /**
   * Our own ear's words for their turn now, not yet taken up by the
   * agent's own words for it: those settled, and those still coming. The
   * line's words since its last settled ones carry on from what the agent
   * took up already (`takenSoFar`): that much of them is old.
   */
  let overheardSettled = "";
  let overheardComing = "";
  let comingRaw = "";
  let takenSoFar = "";
  let overheardQuiet = 0;
  /** Whether the agent streams their words as they talk (its `tentative_user_transcript` event). */
  let streamsTheirs = false;
  /** Their turn's words as our ear heard them so far, over the box. */
  const showOverheard = (): void => {
    on.segment({
      id: `you-${theirs}`,
      from: "person",
      text: [overheardSettled, overheardComing]
        .filter((part) => part !== "")
        .join(" "),
      final: false,
    });
  };
  /** The agent took their turn up: what our ear heard of it so far is old. */
  const takeUpOverheard = (): void => {
    takenSoFar = comingRaw;
    overheardSettled = "";
    overheardComing = "";
    window.clearTimeout(overheardQuiet);
  };
  const keep = (line: VoiceLine): void => {
    said.push({
      from: line.from,
      text: line.text.slice(0, interviewLimits.line),
      ...(line.typed === true ? { typed: true as const } : {}),
    });
    if (said.length > interviewLimits.lines) {
      said.splice(0, said.length - interviewLimits.lines);
    }
  };
  try {
    const startSession = start ?? (await loadAgentSdk());
    const conversation = await startSession({
      conversationToken: join.conversationToken,
      connectionType: "webrtc",
      // Without sound the SDK asks for no microphone, and the agent sends text alone.
      textOnly,
      // The token is of the host core asked it at: joined in the EU, the audio stays there.
      ...(join.location === "eu-residency" ? euResidency : {}),
      // The agent takes no overrides: its own prompt and first line stand; who they are comes as context.
      stripAudioTags: true,
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
        // Without sound he never speaks: what he does follows his lines (`onMessage`).
        if (!closed && !textOnly) {
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
        // The agent streams their words itself: our ear's are not needed.
        streamsTheirs = true;
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
          // The agent's words for their turn stand in for what our ear heard of it.
          takeUpOverheard();
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
        if (textOnly) {
          // His line stands, whole: their turn.
          on.doing("listening");
        }
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
      onDisconnect: (details) => {
        if (!closed) {
          closed = true;
          if (begun && details.reason === "agent") {
            // He said goodbye and ended it: the interview is through.
            on.finished();
            return;
          }
          // Dropped from the other side.
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
    // Who they are, and where they left off: the agent's own prompt does the rest.
    if (join.context !== "") {
      conversation.sendContextualUpdate(join.context);
    }
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
      textOnly,
      said: () => [...said],
      overheard: (text, settled) => {
        if (closed || streamsTheirs) {
          return;
        }
        const raw = text.trim();
        const fresh = after(raw, takenSoFar);
        if (settled) {
          // These words are settled: the next come afresh, and nothing of them is old any more.
          takenSoFar = "";
          comingRaw = "";
          overheardComing = "";
          overheardSettled = [overheardSettled, fresh]
            .filter((part) => part !== "")
            .join(" ");
        } else {
          comingRaw = raw;
          overheardComing = fresh;
        }
        showOverheard();
        // Heard by us, but never taken up as their turn (a cough, the room): gone again a while after the last word.
        window.clearTimeout(overheardQuiet);
        overheardQuiet = window.setTimeout(() => {
          if (!closed && (overheardSettled !== "" || overheardComing !== "")) {
            takeUpOverheard();
            showOverheard();
          }
        }, overheardMs);
      },
      levels: () =>
        closed
          ? { his: 0, theirs: 0 }
          : {
              his: conversation.getOutputVolume(),
              theirs: conversation.getInputVolume(),
            },
      type: (text) => {
        if (closed) {
          return;
        }
        typed = text.trim();
        keep({ from: "person", text: typed, typed: true });
        conversation.sendUserMessage(typed);
        on.doing("thinking");
      },
      typing: () => {
        if (!closed) {
          conversation.sendUserActivity();
        }
      },
      // A conversation without sound has no microphone to mute and no voice to hush.
      setMuted: async (muted) => {
        if (!closed && !textOnly) {
          conversation.setMicMuted(muted);
        }
        await Promise.resolve();
      },
      hush: (hushed) => {
        if (!closed && !textOnly) {
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
 * Joins a live conversation for `request`, without sound when `textOnly`:
 * the conversation, or why core opened none; null when core opened one but
 * the page couldn't join it, or the browser has nothing to join it with.
 * Core is told when the page leaves it.
 */
export const joinLive = async (
  request: Extract<InterviewVoiceRequest, { action: "open" }>,
  on: LiveHandlers,
  textOnly: boolean
): Promise<Live | Refused | null> => {
  if (typeof RTCPeerConnection === "undefined") {
    return null;
  }
  const opened = await openVoice(request);
  if (isRefused(opened)) {
    return opened;
  }
  const { pass } = opened;
  let told = false;
  const tellClosed = async (): Promise<void> => {
    if (told) {
      return;
    }
    told = true;
    try {
      await closeVoice({ action: "close", secret: request.secret, pass });
    } catch {
      // Core holds nothing open for it: nothing is lost.
    }
  };
  const live = await joinAgent(opened, on, textOnly);
  if (live === null) {
    await tellClosed();
    return null;
  }
  return {
    ...live,
    close: async () => {
      await live.close();
      await tellClosed();
    },
  };
};
