import { describe, expect, it } from "vite-plus/test";

import { frameLocation, locationHold, pageAt } from "./location-hold.ts";

/** A hold at `/`, with the page's and the frame's sides recorded. */
const held = () => {
  const hold = locationHold("/");
  const page: string[] = [];
  const frame: string[] = [];
  hold.moved = (href) => {
    page.push(href);
  };
  const location = frameLocation(hold);
  location.follow((href) => {
    frame.push(href);
  });
  return { hold, location, page, frame };
};

describe("where an App is, between the page's address and its frame", () => {
  it("takes the frame's own moves coming back as echoes, however the page spells them", () => {
    const { hold, location, frame } = held();
    // The frame moves twice before the page draws either, the page
    // drawing what the frame named /café as its percent-encoded self.
    location.moved("/café", true);
    location.moved("/notes", false);
    pageAt(hold, "/caf%C3%A9");
    pageAt(hold, "/notes");
    expect({ followed: frame, told: hold.told }).toStrictEqual({
      followed: [],
      told: [],
    });
  });

  it("follows Back to an address the frame was at, once the page moved on its own", () => {
    const { hold, location, frame } = held();
    location.moved("/café", true);
    // The page never drew it: Back took it elsewhere first.
    pageAt(hold, "/inbox");
    // Back again, to /café: the person's move, which the frame follows,
    // not an echo of the frame's first.
    pageAt(hold, "/caf%C3%A9");
    expect(frame).toStrictEqual(["/inbox", "/caf%C3%A9"]);
  });

  it("keeps a bounded list of the frame's moves the page has yet to draw", () => {
    const { hold, location } = held();
    for (let at = 0; at < 200; at += 1) {
      location.moved(`/hops/${String(at)}`, false);
    }
    expect(hold.told.length).toBeLessThanOrEqual(50);
  });
});
