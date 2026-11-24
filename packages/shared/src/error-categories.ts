/** Why a failure happened, as the host classifies it: the one list. */
export const errorCategories = [
  "source",
  "contract",
  "domain",
  "authorization",
  "operational",
  "uncertain",
  "safety",
] as const;

export type ErrorCategory = (typeof errorCategories)[number];
