/**
 * A source the onboarding gives the Brain that stands only while what it
 * rests on does: a team claim (`claim:<source>`, GRA-1946) or a drawing of
 * a team's piece of work (`drawing:<source>`, GRA-1748), each by the id
 * the onboarding minted for it.
 */
export interface FallingSource {
  producer: "claim" | "drawing";
  id: string;
}

/**
 * Sources a change would take down (the store's `#recountStanding`, its
 * intake, a document's removal) while the Brain may still have them in
 * use: thrown inside the change's transaction, so nothing of it commits
 * until they are out (the store's `#fallenFirst`).
 */
export class SourcesFallError extends Error {
  override name = "SourcesFallError";

  readonly sources: readonly FallingSource[];

  constructor(sources: readonly FallingSource[]) {
    super("The onboarding's sources fall: out of the Brain first.");
    this.sources = sources;
  }
}

/**
 * Takes `sources` out of use in the Brain's shared store, as core's
 * onboarding object does (onboarding/object.ts), throwing when it can't;
 * then erases each it can, so the Brain's ledger keeps it out after a
 * restore too. The sources it erased: their erasure is owed no more.
 */
export type SourceRemover = (
  sources: readonly FallingSource[]
) => Promise<readonly FallingSource[]>;
