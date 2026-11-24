import type { AiReadiness } from "../setup.ts";

/** The concepts of the setup's first three steps, at `/setup?concept=`. */
export const concepts = ["a", "b", "c"] as const;
export type Concept = (typeof concepts)[number];

export const isConcept = (value: unknown): value is Concept =>
  value === "a" || value === "b" || value === "c";

/** The three steps the concepts cover. */
export type ConceptStep = "welcome" | "ai" | "about";

export const isConceptStep = (value: unknown): value is ConceptStep =>
  value === "welcome" || value === "ai" || value === "about";

/** What every concept is given: the step, who the admin is, what core told, and the ways on. */
export interface ConceptProps {
  step: ConceptStep;
  /** The admin's first name. */
  admin: string;
  data: { ai: AiReadiness | null };
  today: Date;
  go: (step: ConceptStep) => void;
  /** Past the plan: on to the setup's next step as it is today. */
  onward: () => void;
}
