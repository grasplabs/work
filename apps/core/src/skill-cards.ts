/** What a listing keeps of a skill version: when to use it. */
export interface SkillCardText {
  description: string;
}

/**
 * Each skill version's card, by its key and version (brain-next.ts), which
 * never change (the store never writes a version over); null for one
 * whose text declares no card of its own name. Read once per isolate. A
 * card is only ever used for a version the store answered its reader just
 * now, and a response holds the cards it needs in a map of its own, so
 * emptying this one never takes a card from it. Its own module so a test
 * can fill it to its bound.
 */
export const skillCards = new Map<string, SkillCardText | null>();

/** Most cards kept: each is small. */
export const skillCardsKept = 1000;
