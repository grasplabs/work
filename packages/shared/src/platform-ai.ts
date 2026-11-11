// Grasp's own AI features, the ones Grasp pays for, on its own keys: what
// the model gateway records each call on Grasp's key as, and what the
// admin's spend overview sums by. Which provider and model each uses is
// fixed in core's code (src/platform-ai.ts), always at the provider's EU
// data residency host.

/** Grasp's own AI features, as the gateway records them. */
export const platformAiFeatures = [
  "conversion",
  "transcription",
  "speech",
  /**
   * Not a feature of Grasp's: the organization's own AI, where it runs on
   * Grasp's key (`graspAi`, @grasp-os/shared/ai-providers). Grasp pays the
   * provider and the organization pays Grasp, so it is told apart from
   * what Grasp's own features cost.
   */
  "organization",
] as const;

/** One of Grasp's own AI features. */
export type PlatformAiFeature = (typeof platformAiFeatures)[number];
