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
 * Each feature's provider and model: OpenAI's GPT-4o Transcribe writes
 * down speech, live and recorded, and Mistral's Voxtral TTS 3 says the
 * lines. An interview is held as one live voice session at Mistral (its
 * voice agents): Mistral Small answers, Voxtral's realtime transcription
 * listens and Voxtral TTS 3 speaks, in Stephen's voice, the models
 * Mistral names for a voice agent.
 */
export const platformAi = {
  transcription: { provider: "openai", model: "gpt-4o-transcribe" },
  speech: {
    provider: "mistral",
    model: "voxtral-mini-tts-3-0",
    voices,
  },
  conversation: {
    provider: "mistral",
    model: "mistral-small-latest",
    listening: "voxtral-mini-transcribe-realtime-3",
    speaking: "voxtral-mini-tts-3",
    voice: voices.stephen,
  },
} as const;
