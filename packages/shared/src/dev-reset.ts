// Where a local stack starts the onboarding over (core's
// onboarding/dev-reset.ts): a local stack only; a deployed core has no
// such route.

export const devResetPath = "/api/dev/onboarding/start-over";

// Where a local stack finds the link of whoever is signed in (core's
// onboarding/dev-reset.ts), so `/interview#dev` always opens an interview
// there: a local stack only, as above.

export const devInterviewLinkPath = "/api/dev/onboarding/interview-link";
