import type { Speaker } from "@grasp-os/shared/voice";

// Grasp's own AI features, the ones Grasp pays for, fixed in code:
// changing a provider, a model or a voice is a change here, released as
// any change is. Each goes through the model gateway (models.ts) with
// Grasp's own key for its provider, which connect holds, always at the
// provider's EU data residency host (`platformRouteOf`, @grasp-os/shared/
// ai-providers): keeping it in the EU is Grasp's to do, so no deployment
// turns a feature off for it. A provider Grasp has no key for leaves its
// feature unavailable, never served by another.

/**
 * Each speaker's voice, by its Mistral ID: Voxtral 3's own preset voices,
 * each of which says any language the model does. Stephen's is "Rob"; the
 * sample speakers are three more, each clearly not Stephen.
 */
const voices = {
  stephen: "voice_485",
  lisa: "voice_590",
  mark: "voice_1788",
  tim: "voice_591",
} as const satisfies Record<Exclude<Speaker, "claire">, string>;

/**
 * Each speaker's voice in the admin's onboarding, by its ElevenLabs ID.
 * Stephen's is "Adam", the voice Eleven v4 is shown with: young,
 * confident, conversational. Claire's is "Jessica": playful, bright and
 * warm. The sample speakers are ElevenLabs's own voices, each clearly
 * not Stephen. As before Grasp moved its speech to KugelAudio, then
 * Mistral.
 */
const onboardingVoices = {
  stephen: "s3TPKV1kjDlVtZbl4Ksh",
  claire: "r1KmysJdVYZjJCm4mL3b",
  lisa: "EXAVITQu4vr4xnSDxMaL",
  mark: "cjVigY5qzO86Huf0OWal",
  tim: "TX3LPaxmHKxFdv7VOQHJ",
} as const satisfies Record<Speaker, string>;

/**
 * Where a live interview is held (`platformAi.liveInterview`): with
 * Grasp's ElevenLabs agent, or as a voice session at Mistral.
 */
const liveInterview: "elevenlabs" | "mistral" = "elevenlabs";

/**
 * Stephen's voice in an interview held with the ElevenLabs agent: the
 * agent's own voice, so the guide before it and anything said outside the
 * conversation sound like the one who talks with them (the owner's ask,
 * 2026-11-26). The sample speakers keep the admin's onboarding's.
 */
const agentVoices = {
  ...onboardingVoices,
  stephen: "cjVigY5qzO86Huf0OWal",
} as const satisfies Record<Speaker, string>;

/**
 * Each feature's provider and model: OpenAI's GPT-4o Transcribe writes
 * down a recording, and Mistral's Voxtral realtime transcription speech as
 * it is said, live (`liveTranscription`: a dictation, an interview typed
 * turn by turn); Mistral's Voxtral TTS 3 says an
 * interview's lines (`speech`), and ElevenLabs's Eleven v4 the admin's
 * onboarding (`onboardingSpeech`), each with its own voices; and Mistral
 * holds the interview itself. Its `line` model writes what the
 * interviewer says while someone waits for it: Mistral Small, the model
 * Mistral's own voice agents answer with, for how soon its first words
 * come. Its `notes` model writes down what was said, which nobody waits
 * for and the interview is for: Mistral Medium. An interview can also be
 * held as one live voice session at Mistral (`conversation`, its voice
 * agents): Mistral Small answers, Voxtral's realtime transcription
 * listens and Voxtral TTS 3 speaks, in Stephen's voice, the models
 * Mistral names for a voice agent.
 */
export const platformAi = {
  transcription: { provider: "openai", model: "gpt-4o-transcribe" },
  liveTranscription: {
    provider: "mistral",
    model: "voxtral-mini-transcribe-realtime-3",
  },
  speech: {
    provider: "mistral",
    model: "voxtral-mini-tts-3-0",
    voices,
  },
  onboardingSpeech: {
    provider: "elevenlabs",
    model: "eleven_v4",
    voices: onboardingVoices,
  },
  /** An interview's lines while it is held with the ElevenLabs agent: in the agent's voice. */
  agentSpeech: {
    provider: "elevenlabs",
    model: "eleven_v4",
    voices: agentVoices,
  },
  interview: {
    provider: "mistral",
    line: "mistral/mistral-small-latest",
    notes: "mistral/mistral-medium-latest",
  },
  /**
   * The interview held as a live conversation with Grasp's ElevenLabs
   * agent: who Stephen is, what he says first, and what he is told is
   * sent with each conversation (core's onboarding/voice.ts); his voice,
   * his ears and the model he answers with are the agent's, as its
   * dashboard sets them. The agent is Grasp's own; the browser joins it
   * with a token core asks for on Grasp's key.
   */
  agent: {
    provider: "elevenlabs",
    id: "agent_4601m8c6sznzezb9dms6fm6jp5vm",
  },
  /**
   * Where a live interview is held: with the ElevenLabs agent (`agent`),
   * or as a voice session at Mistral (`conversation`).
   */
  liveInterview,
  conversation: {
    provider: "mistral",
    model: "mistral-small-latest",
    listening: "voxtral-mini-transcribe-realtime-3",
    speaking: "voxtral-mini-tts-3",
    voice: voices.stephen,
  },
} as const;

/** Whether `model` is one the interview runs on, as the gateway names it. */
export const isInterviewModel = (model: string): boolean =>
  model === platformAi.interview.line || model === platformAi.interview.notes;

/** Where a live interview is held here: as the deployment says (`INTERVIEW_LIVE_VOICE`), or as `platformAi` does. */
export const liveInterviewOf = (
  env: Pick<Env, "INTERVIEW_LIVE_VOICE"> | undefined
): "mistral" | "elevenlabs" =>
  env?.INTERVIEW_LIVE_VOICE === "mistral" ||
  env?.INTERVIEW_LIVE_VOICE === "elevenlabs"
    ? env.INTERVIEW_LIVE_VOICE
    : platformAi.liveInterview;
