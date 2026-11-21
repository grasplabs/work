// Agent activity's own words, in English. The product gives them in its languages through
// GraspWords (src/words); a caller's `words`, `aria-label` and `workingLabel` still win until the
// breaking release's step 5. A word with a title or the steps in it is a function.
import { summaryOf } from "./format";
import type { AgentActivityWords as AgentActivityOwnWords } from "./types";

const steps: AgentActivityOwnWords = {
  states: {
    waiting: "Waiting",
    working: "Working",
    done: "Done",
    failed: "Failed",
    skipped: "Skipped",
  },
  showMore: "Show more",
  showLess: "Show less",
  input: "Input",
  result: "Result",
  error: "Why it failed",
  stepFailed: (title) => `${title} failed`,
  summarize: summaryOf,
};

export const agentActivityWords = {
  ...steps,
  /** Its name, for a screen reader and an agent (`aria-label`). */
  name: "Agent activity",
  /** What the line says while the run goes on between two steps (`workingLabel`). */
  working: "Working",
};

export type AgentActivityCatalogueWords = typeof agentActivityWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    agentActivity: AgentActivityCatalogueWords;
  }
}
