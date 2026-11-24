/**
 * The name of the onboarding's one Durable Object (store.ts): apart, so
 * core's Brain module (brain-next.ts) reaches it without importing the
 * store, which reaches the Brain itself (new-brain.ts).
 */
export const onboardingStoreName = "onboarding";
