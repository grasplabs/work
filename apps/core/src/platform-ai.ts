import type { Speaker } from "@grasp-os/shared/voice";

// Grasp's own AI features, the ones Grasp pays for, fixed in code:
// changing a provider, a model or a voice is a change here, released as
// any change is. Each goes through the model gateway (models.ts) with
// Grasp's own key for its provider, which connect holds, always at the
// provider's EU host (`platformRouteOf`, @grasp-os/shared/ai-providers):
// keeping it in the EU is Grasp's to do, so no deployment turns a feature
// off for it. A provider Grasp has no key for leaves its feature
// unavailable, never served by another.

/**
 * Each speaker's voice, by its Mistral ID: Voxtral 3's preset voices, one
 * a speaker, said in every language the onboarding speaks. Mistral has a
 * man's preset voice in English alone, so each is an English voice
 * speaking the other languages: Stephen's is "James" and Claire's is
 * "Sheila" (US); the sample speakers are British, each clearly not
 * Stephen. A voice of Grasp's own, saved at Mistral, takes a preset's
 * place by its ID here.
 */
const voices = {
  stephen: "voice_3150",
  claire: "voice_478",
  lisa: "voice_590",
  mark: "voice_1788",
  tim: "voice_3149",
} as const satisfies Record<Speaker, string>;

/**
 * Each feature's provider and model: OpenAI's GPT-5.4 mini reads PDFs
 * (text and page images, so scans too); Mistral's Voxtral says the lines
 * (TTS 3) and writes down speech, live as someone speaks (Transcribe
 * Realtime 3) and from a recording (Mini Transcribe 3).
 */
export const platformAi = {
  conversion: { provider: "openai", model: "gpt-5.4-mini" },
  transcription: {
    provider: "mistral",
    model: "voxtral-mini-transcribe-realtime-3-0",
    recordedModel: "voxtral-mini-transcribe-3-0",
  },
  speech: {
    provider: "mistral",
    model: "voxtral-mini-tts-3-0",
    voices,
  },
} as const;
