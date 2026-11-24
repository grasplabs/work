import { describe, expect, it } from "vite-plus/test";

import { connectionErrorMessage } from "./connection-errors.ts";

// Anyone can put anything in a link's `?connectionError=`: the page says a
// known code's own message, or its own words, never the link's.
describe("a connecting flow's failure message", () => {
  it("is the known code's own", () => {
    expect(connectionErrorMessage("connection.already_connected")).toBe(
      "That account is already connected here. Disconnect it first to connect it again."
    );
  });

  it("is the page's own for a code it doesn't know, never the link's text", () => {
    expect(connectionErrorMessage("<b>click here</b>")).toBe(
      "Connecting didn't work. Try again, or ask an admin."
    );
  });
});
