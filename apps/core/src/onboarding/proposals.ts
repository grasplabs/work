import type { StandingDrawing } from "./store.ts";

/**
 * What Grasp proposes for a team's routine (GRA-1750, opportunities.ts),
 * as the onboarding asks it: each drawing that stands with no proposal
 * kept is owed one, and the store's alarm asks it as work of its own, one
 * at a time, claimed before it is asked and tried again after a minute,
 * five and thirty, as its drawings are (`proposeNext`). Never in a
 * page's request. Given by core's Worker (onboarding/object.ts), as the
 * store can't import core's opportunities.
 */
export interface Proposer {
  /** Of the drawings `sources` (their ids in the Brain), those with no proposal kept. */
  owed: (sources: readonly string[]) => Promise<string[]>;
  /**
   * Asks the model what `drawing` could become and keeps the answer; erases
   * it again when `stands` says the drawing fell while the model answered.
   * Throws when no model answered, or the write or erasure failed: the
   * store tries again later, and erases (`forget`) once its row is due when
   * the drawing fell meanwhile.
   */
  propose: (drawing: StandingDrawing, stands: () => boolean) => Promise<void>;
  /** Erases what is kept at the drawing `source`, which fell: safe to repeat. */
  forget: (source: string) => Promise<void>;
}
