import { describe, expect, it } from "vite-plus/test";

import { piecesOf } from "./speech.ts";

// A line is said a sentence at a time: each piece where it stands in the
// line, so its words light up in place.

describe(piecesOf, () => {
  it.each([
    [
      "Okay. What do you do first?  And then?",
      [
        { text: "Okay.", from: 0 },
        { text: "What do you do first?", from: 6 },
        { text: "And then?", from: 29 },
      ],
    ],
    [
      " Thank you… Next!",
      [
        { text: "Thank you…", from: 1 },
        { text: "Next!", from: 12 },
      ],
    ],
    ["No full stop at the end", [{ text: "No full stop at the end", from: 0 }]],
    ["v2.3 is out.", [{ text: "v2.3 is out.", from: 0 }]],
    ["   ", []],
  ])("cuts %j into its sentences", (line, pieces) => {
    expect(piecesOf(line)).toStrictEqual(pieces);
  });
});
