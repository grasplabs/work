// Grasp's own AI features, the ones Grasp pays for, on its own keys: what
// the model ledger records each call on Grasp's key as, and what the
// admin's spend overview sums by. Which provider and model each uses is
// fixed in core's code (src/platform-ai.ts), always at the provider's EU
// data residency host.

/** Grasp's own AI features, as the ledger records them. */
export const platformAiFeatures = [
  "conversion",
  "transcription",
  "speech",
] as const;

/** One of Grasp's own AI features. */
export type PlatformAiFeature = (typeof platformAiFeatures)[number];
