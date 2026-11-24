import { describe, expect, it } from "vite-plus/test";

import { signInErrorMessage } from "./sign-in-errors.ts";

// Anyone can put anything in a sign-in link's `?error=`: the page says only
// its own words, never the link's.
describe("a refused sign-in's message", () => {
  it("is the page's own for a code it doesn't know, never the link's text", () => {
    const planted = "Your account is locked. Call +1 555 0100";
    expect(signInErrorMessage(planted)).toBe(
      "Sign-in didn't work. Try again, or ask an admin."
    );
  });
});
