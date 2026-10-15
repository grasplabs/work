import { unknownOutcomeListLimit } from "@grasp-os/shared/connect";
import type { UnknownOutcomeCursor } from "@grasp-os/shared/connect";

/**
 * Every page of a list of calls of unknown outcome, newest first: each
 * page is at most {@link unknownOutcomeListLimit}, and a full one goes on
 * after its last one. Each is an open obligation, holding a run or a key,
 * so none past the first page may go unlisted.
 */
export const everyPage = async <Item extends { cursor: UnknownOutcomeCursor }>(
  read: (before?: UnknownOutcomeCursor) => Promise<Item[]>
): Promise<Item[]> => {
  const all: Item[] = [];
  let before: UnknownOutcomeCursor | undefined;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- each page goes on from the last
    const page = await read(before);
    all.push(...page);
    const last = page.at(-1);
    if (page.length < unknownOutcomeListLimit || last === undefined) {
      return all;
    }
    before = last.cursor;
  }
};
