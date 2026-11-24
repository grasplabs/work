import type { FrameLocation } from "./page-host.ts";

// Where in the App its frame is, between the page's address and the
// frame's router: one object for the frame's whole life, so a new address
// the page draws reaches the start running now, and the next start opens
// where the last one was. The frame moves faster than the page draws, so
// the page drawing an address the frame was at on its way is the frame's
// own move coming back, never one to follow; anything else the page draws
// (Back, Forward, a link of its own) the frame follows. The two sides spell
// one address differently (`/café` and `/caf%C3%A9`), so they are compared
// as a URL parser reads them.

/** The most of the frame's moves the page has yet to draw that are kept. */
const toldMax = 50;

/** Where the App is, between the page and the frame (`FrameLocation`). */
export interface LocationHold {
  /** Where the App is now, as the page or the frame last said. */
  href: string;
  /** Tells the frame running now where the page went, while one runs. */
  toFrame: ((href: string) => void) | undefined;
  /** Tells the page where the frame went, while it carries the address. */
  moved: ((href: string, push: boolean) => void) | undefined;
  /** Where the frame went that the page hasn't drawn yet, oldest first, as `sameAddress` reads them. */
  told: string[];
}

/** `href` as a URL parser reads it: one spelling for one address. */
const sameAddress = (href: string): string => {
  const url = new URL(href, "https://app.invalid");
  return `${url.pathname}${url.search}${url.hash}`;
};

/** A hold that starts at `href`. */
export const locationHold = (href: string): LocationHold => ({
  href,
  toFrame: undefined,
  moved: undefined,
  told: [],
});

/** The frame's side of `hold` (`FrameLocation`). */
export const frameLocation = (hold: LocationHold): FrameLocation => ({
  current: () => hold.href,
  moved: (href, push) => {
    hold.href = href;
    if (hold.moved !== undefined) {
      hold.told.push(sameAddress(href));
      if (hold.told.length > toldMax) {
        hold.told.shift();
      }
      hold.moved(href, push);
    }
  },
  follow: (toFrame) => {
    hold.toFrame = toFrame;
  },
});

/**
 * The page's side of `hold`: its address now says the App is at `at`. The
 * frame's own move coming back goes nowhere; anything else the frame
 * follows, and what the frame said before it is stale from then on.
 */
export const pageAt = (hold: LocationHold, at: string): void => {
  const address = sameAddress(at);
  const told = hold.told.indexOf(address);
  if (told !== -1) {
    hold.told.splice(0, told + 1);
    return;
  }
  hold.told = [];
  if (address !== sameAddress(hold.href)) {
    hold.href = at;
    hold.toFrame?.(at);
  }
};
