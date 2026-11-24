import { describe, expect, it } from "vite-plus/test";

import { chatPresence, placementOn } from "./chat-presence.ts";

// Where the chat opens on a page: where it was put, where the page allows
// it, or where the page allows first; nowhere on a page that allows none.

describe(placementOn, () => {
  it("opens where it was put, where the page allows it", () => {
    expect(placementOn(chatPresence.everywhere, "floating")).toBe("floating");
  });

  it("opens where the page allows first, where it doesn't allow that", () => {
    expect(placementOn(chatPresence.fullscreenOnly, "docked")).toBe(
      "fullscreen"
    );
  });

  it("opens nowhere on a page that allows it nowhere", () => {
    expect(placementOn(chatPresence.hidden, "docked")).toBeUndefined();
  });
});
