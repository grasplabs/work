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
 * it is said, live (`liveTranscription`: a dictation, the words over the
 * box in an interview); ElevenLabs's Eleven v4 says an interview's lines
 * outside its conversation (`speech`) and the admin's onboarding
 * (`onboardingSpeech`), each with its own voices; and Mistral's models
 * write for an interview (`interview`). Its `notes` model writes down
 * what was said, which nobody waits for and the interview is for: Mistral
 * Medium. Its `line` model is the quick one, Mistral Small: it tells the
 * read-back as a story while someone waits for it (onboarding/story.ts),
 * and writes Stephen's line in a turn of the Stephen Lab's
 * (onboarding/lab-turn.ts). A live interview is a conversation with
 * Grasp's ElevenLabs agent (`agent`).
 */
export const platformAi = {
  transcription: { provider: "openai", model: "gpt-4o-transcribe" },
  liveTranscription: {
    provider: "mistral",
    model: "voxtral-mini-transcribe-realtime-3",
  },
  /** An interview's lines: in the voice of the agent that holds it live. */
  speech: {
    provider: "elevenlabs",
    model: "eleven_v4",
    voices: agentVoices,
  },
  onboardingSpeech: {
    provider: "elevenlabs",
    model: "eleven_v4",
    voices: onboardingVoices,
  },
  interview: {
    provider: "mistral",
    line: "mistral/mistral-small-latest",
    notes: "mistral/mistral-medium-latest",
  },
  /**
   * The interview held as a live conversation with Grasp's ElevenLabs
   * agent (core's onboarding/voice.ts): who Stephen is, what he says
   * first, his voice, his ears and the model he answers with are the
   * agent's, as its dashboard sets them. The agent is Grasp's own; the
   * browser joins it with a token core asks for on Grasp's key.
   */
  agent: {
    provider: "elevenlabs",
    id: "agent_4601m8c6sznzezb9dms6fm6jp5vm",
  },
} as const;

/** Whether `model` is one the interview runs on, as the gateway names it. */
export const isInterviewModel = (model: string): boolean =>
  model === platformAi.interview.line || model === platformAi.interview.notes;
