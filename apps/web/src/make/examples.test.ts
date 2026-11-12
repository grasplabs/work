import { describe, expect, it } from "vite-plus/test";

import { examplesFor } from "./examples.ts";

// The ideas Make something offers: the organization's own processes first.

describe("the ideas to start from", () => {
  it("offers three, those of the processes the organization serves first", () => {
    expect({
      own: examplesFor(["i2r", null, "o2c"]).map(({ process }) => process),
      none: examplesFor([]).map(({ process }) => process),
    }).toStrictEqual({
      own: ["o2c", "i2r", "p2p"],
      none: ["p2p", "h2r", "r2r"],
    });
  });
});
