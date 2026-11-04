import type { ProjectCursor } from "@grasp-os/shared/projects";
import { useState } from "react";

import type { Session } from "../core.ts";
import { useCoreAction } from "../use-core-action.ts";

// A project's items and members come a page at a time (core's
// `projects.items` and `projects.members`): the page shows the first, as
// `projects.get` read it, and Show more reads the next after the last one
// shown. A project read again (a change, then a refresh) starts from its
// first page again.

/** What a page is read after: the last one shown, by when it came in, its type and ID. */
interface Paged {
  type: string;
  id: string;
  addedAt: string;
}

/** The cursor after `last`. */
const cursorAfter = ({ type, id, addedAt }: Paged): ProjectCursor => ({
  at: addedAt,
  type,
  id,
});

/**
 * `first`, the first page `from` (the project as read) holds, and the
 * pages read after it since: all of them, whether more follow, and how to
 * read the next.
 */
export const usePages = <T extends Paged>(
  from: object,
  first: readonly T[],
  firstMore: boolean,
  read: (
    session: Session,
    after: ProjectCursor
  ) => Promise<{ list: T[]; more: boolean }>
) => {
  const { busy, failure, run } = useCoreAction();
  const [loaded, setLoaded] = useState<{
    from: object;
    rest: T[];
    more: boolean;
  }>();
  // Pages read for another reading of the project are dropped.
  const current = loaded?.from === from ? loaded : undefined;
  const all = [...first, ...(current?.rest ?? [])];
  const more = current?.more ?? firstMore;
  const readMore = async (): Promise<void> => {
    const last = all.at(-1);
    if (last === undefined) {
      return;
    }
    const page = await run(
      async (session) => await read(session, cursorAfter(last))
    );
    if (page !== undefined) {
      // An item or member that moved later since (a share changed) may
      // come again: shown once.
      const shown = new Set(all.map(({ type, id }) => `${type}:${id}`));
      setLoaded({
        from,
        rest: [
          ...(current?.rest ?? []),
          ...page.list.filter(({ type, id }) => !shown.has(`${type}:${id}`)),
        ],
        more: page.more,
      });
    }
  };
  return { all, more, readMore, busy, failure };
};
