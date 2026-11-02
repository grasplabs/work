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
 * Each speaker's voice, by its ElevenLabs ID. Stephen's is "Adam", the
 * voice Eleven v4 is shown with: young, confident, conversational.
 * Claire's is "Jessica": playful, bright and warm, checked by ElevenLabs
 * in English, Dutch, German and Spanish, not in French. The sample
 * speakers are ElevenLabs's own voices, each clearly not Stephen.
 */
const voices = {
  stephen: "s3TPKV1kjDlVtZbl4Ksh",
  claire: "r1KmysJdVYZjJCm4mL3b",
  lisa: "EXAVITQu4vr4xnSDxMaL",
  mark: "cjVigY5qzO86Huf0OWal",
  tim: "TX3LPaxmHKxFdv7VOQHJ",
} as const satisfies Record<Speaker, string>;

/**
 * Each feature's provider and model: OpenAI's GPT-5.4 mini reads PDFs
 * (text and page images, so scans too), GPT-4o Transcribe writes down
 * speech, live and recorded, and ElevenLabs's Eleven v4 says the lines,
 * v4 Turbo a line only known as it is said, with the same voices.
 */
export const platformAi = {
  conversion: { provider: "openai", model: "gpt-5.4-mini" },
  transcription: { provider: "openai", model: "gpt-4o-transcribe" },
  speech: {
    provider: "elevenlabs",
    model: "eleven_v4",
    quickModel: "eleven_v4_turbo",
    voices,
  },
} as const;
