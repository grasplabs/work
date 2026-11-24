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
 * Each speaker's voice, by its KugelAudio ID, from the voices of its
 * public catalog its documentation plays (docs.kugelaudio.com, "Using
 * Voices", read on 2026-11-19). Stephen's is "James Whitfield" and
 * Claire's "Samantha Ferris", both English voices; the one model says
 * every language in any voice. The sample speakers are catalog voices
 * too, each clearly not Stephen: Lisa "Julia Ziegler", Mark "Noah
 * Tremblay", Tim "Daniel Krüger".
 */
const voices = {
  stephen: "1656",
  claire: "1071",
  lisa: "2222",
  mark: "1073",
  tim: "2220",
} as const satisfies Record<Speaker, string>;

/**
 * Each feature's provider and model: OpenAI's GPT-4o Transcribe writes
 * down speech, live and recorded, and KugelAudio's Kugel 3.5 says the
 * lines.
 */
export const platformAi = {
  transcription: { provider: "openai", model: "gpt-4o-transcribe" },
  speech: { provider: "kugelaudio", model: "kugel-3.5", voices },
} as const;
