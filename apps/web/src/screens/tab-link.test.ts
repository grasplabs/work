import { describe, expect, it } from "vite-plus/test";

import type { LinkEnded } from "./core-link.ts";
import { TabLinks } from "./tab-link.ts";

// The tab's one link for its App frames (spec 11.2), with a stand-in for
// the connection to core: what the link would say once it ends is all
// the tab hears of it. How sharing it could go wrong, each tried below:
// frames each opening their own; a frame closing taking the link from
// the others; a link that ended for its person reused by the next frame
// (as someone else's), or one whose first connection failed and never
// tries again; a frame that left
// still being told; ending one link twice, or late, closing its
// successor.

/** A stand-in link, and what happened to it. */
interface Fake {
  readonly id: number;
  closed: boolean;
  /** Its first connection failed for good, as the connection says. */
  failedToStart: boolean;
  /** Says the link ended, as the connection does once it finds out. */
  end: (why: LinkEnded) => void;
  close: () => void;
}

/** A tab whose links are stand-ins, numbered as they're opened. */
const tab = () => {
  const opened: Fake[] = [];
  const links = new TabLinks<Fake>((onEnded) => {
    const link: Fake = {
      id: opened.length + 1,
      closed: false,
      failedToStart: false,
      end: onEnded,
      close: () => {
        link.closed = true;
      },
    };
    opened.push(link);
    return link;
  });
  return { links, opened };
};

/** A frame joining the tab: what it was told of the link ending. */
const frameOn = (links: TabLinks<Fake>) => {
  const told: LinkEnded[] = [];
  const joined = links.join((why) => {
    told.push(why);
  });
  return { ...joined, told };
};

describe("the tab's link for its App frames", () => {
  it("is one for every frame of the tab, and stays when frames close", () => {
    const { links, opened } = tab();
    const first = frameOn(links);
    const second = frameOn(links);

    first.leave();
    second.leave();
    // Another page's frame, after the last one closed.
    const third = frameOn(links);

    expect({
      same: first.link === second.link && second.link === third.link,
      opened: opened.length,
      closed: opened.map(({ closed }) => closed),
    }).toStrictEqual({ same: true, opened: 1, closed: [false] });
  });

  it("ends for every frame on it once its person's session ends, and the next frame gets a new one", () => {
    const { links, opened } = tab();
    const first = frameOn(links);
    const second = frameOn(links);
    const gone = frameOn(links);
    gone.leave();

    first.link.end("principal-changed");
    // Said again, or by a frame late: nothing more happens.
    first.link.end("signed-out");
    second.end("signed-out");
    const next = frameOn(links);

    expect({
      first: first.told,
      second: second.told,
      gone: gone.told,
      closed: opened.map(({ closed }) => closed),
      next: next.link.id,
    }).toStrictEqual({
      first: ["principal-changed"],
      second: ["principal-changed"],
      gone: [],
      closed: [true, false],
      next: 2,
    });
  });

  it("tells every frame it ended, even when stopping one of them throws", () => {
    const { links } = tab();
    const throwing = links.join(() => {
      throw new Error("The page failed to show it.");
    });
    const after = frameOn(links);

    const ending = (): void => {
      throwing.end("signed-out");
    };

    expect(ending).toThrow(AggregateError);
    expect(after.told).toStrictEqual(["signed-out"]);
  });

  it("gives up on a link whose first connection failed, so trying again connects anew", () => {
    const { links, opened } = tab();
    const failed = frameOn(links);
    if (opened[0] !== undefined) {
      opened[0].failedToStart = true;
    }

    // The person tries again, or opens another App.
    const again = frameOn(links);

    expect({
      again: again.link.id,
      failed: failed.told,
      closed: opened.map(({ closed }) => closed),
    }).toStrictEqual({ again: 2, failed: [], closed: [true, false] });
  });

  it("ends for every frame when one learns from core that the session is someone else's", () => {
    const { links, opened } = tab();
    const learning = frameOn(links);
    const other = frameOn(links);

    learning.end("principal-changed");
    const next = frameOn(links);
    // The old link ending late changes nothing for the new one.
    other.end("signed-out");
    opened[0]?.end("signed-out");

    expect({
      learning: learning.told,
      other: other.told,
      next: next.told,
      closed: opened.map(({ closed }) => closed),
    }).toStrictEqual({
      learning: ["principal-changed"],
      other: ["principal-changed"],
      next: [],
      closed: [true, false],
    });
  });
});
