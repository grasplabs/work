import { unknownOutcomeListLimit } from "@grasp-os/shared/connect";
import type { UnknownOutcomeCursor } from "@grasp-os/shared/connect";

import type { CoreConnection } from "../core-connection.ts";
import type { Session } from "../core.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";

// Calls of unknown outcome come a page at a time (at most
// `unknownOutcomeListLimit` each, a full one going on after its last).
// Each is an open obligation, holding a run or a key, so none past the
// first page may go unlisted: these read every page, each within its own
// few seconds, so many pages never run out one deadline, and stop at the
// first that fails.

interface Paged {
  cursor: UnknownOutcomeCursor;
}

/**
 * Every page `read` answers, newest first, each page read on its own; the
 * first that fails (or is given up on) fails the whole, and no page is
 * asked for after it.
 */
export const everyPage = async <Item extends Paged>(
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

/**
 * `everyPage`, each page loaded as `loadFromCore` loads a page's data,
 * within its own few seconds: ready once every page is, or as the first
 * page that isn't (out of reach, refused), after which no page is asked
 * for. Given `left`, nothing more is asked once the page is left.
 */
export const loadEveryPage = async <Item extends Paged>(
  core: Pick<CoreConnection, "withSession">,
  read: (session: Session, before?: UnknownOutcomeCursor) => Promise<Item[]>,
  left?: AbortSignal
): Promise<Loaded<Item[]>> => {
  const all: Item[] = [];
  let before: UnknownOutcomeCursor | undefined;
  for (;;) {
    const after = before;
    // oxlint-disable-next-line no-await-in-loop -- each page goes on from the last
    const page = await loadFromCore(
      core,
      async (session) => await read(session, after),
      left
    );
    if (page.state !== "ready") {
      return page;
    }
    all.push(...page.data);
    const last = page.data.at(-1);
    if (page.data.length < unknownOutcomeListLimit || last === undefined) {
      return { state: "ready", data: all };
    }
    before = last.cursor;
  }
};
