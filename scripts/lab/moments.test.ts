/**
 * The moments written by hand (moments.ts): the open set of the
 * next-question bench. Each must be fair: end on what the person said,
 * cover every rule, and be about work that is in no answer key, so a pass
 * is never a line he was shown.
 */
import { describe, expect, it } from "vite-plus/test";

import { momentSchema } from "./cases.ts";
import { openKeys } from "./keys/index.ts";
import { handMoments, signals } from "./moments.ts";

describe("the moments written by hand", () => {
  it("each have an id of their own, end on what the person said, and keep as a moment is kept", () => {
    expect({
      ids: new Set(handMoments.map((moment) => moment.id)).size,
      notByThem: handMoments
        .filter((moment) => moment.lines.at(-1)?.from !== "person")
        .map(({ id }) => id),
      notKept: handMoments
        .filter((moment) => !momentSchema.safeParse(moment).success)
        .map(({ id }) => id),
    }).toStrictEqual({ ids: handMoments.length, notByThem: [], notKept: [] });
  });

  it("cover every rule at least once, and are about work that is in no answer key", () => {
    const covered = new Set(handMoments.map((moment) => moment.signal));
    const companies = new Set(
      Object.values(openKeys).map((key) => key.company.name)
    );
    expect({
      uncovered: signals.filter((signal) => !covered.has(signal)),
      inAKey: handMoments
        .filter((moment) => companies.has(moment.who.company))
        .map(({ id }) => id),
    }).toStrictEqual({ uncovered: [], inAKey: [] });
  });
});
