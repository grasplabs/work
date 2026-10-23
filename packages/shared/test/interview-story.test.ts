import { describe, expect, it } from "vite-plus/test";

import type { InterviewFact } from "../src/interview-links.ts";
import {
  agreedFacts,
  agreedKey,
  interviewStoryRequestSchema,
  readBackMost,
  readBackParts,
  storyKey,
  storyOf,
} from "../src/interview-story.ts";

// The read-back's rules (src/interview-story.ts): pure logic, so tested on
// its own. Ported with the rules from the prototype (grasplabs/prototype,
// packages/grasp: src/lib/interview-story.test.ts, and the read-back in
// src/lib/interview-turn.test.ts).

const lines = [
  { id: "f1", text: "You weigh the parcel." },
  { id: "f2", text: "You write the weight on the label." },
  { id: "f3", text: "You put the parcel on the belt." },
];

const fact = (
  id: string,
  tag: InterviewFact["tag"],
  more: Partial<InterviewFact> = {}
): InterviewFact => ({ id, tag, text: id, record: id, ...more });

const ids = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`);

const idsOf = (parts: ReturnType<typeof readBackParts>) =>
  parts.map((part) => part.facts.map(({ id }) => id));

describe("a part of the read-back, told as a story", () => {
  it("keeps the sentences with the lines each tells, in the order they are said", () => {
    const story = storyOf(
      {
        sentences: [
          {
            say: "You weigh the parcel and write its weight on the label.",
            ids: ["f1", "f2"],
          },
          { say: "Then it goes on the belt.", ids: ["f3"] },
        ],
      },
      lines
    );
    expect(story).toStrictEqual([
      {
        say: "You weigh the parcel and write its weight on the label.",
        ids: ["f1", "f2"],
      },
      { say: "Then it goes on the belt.", ids: ["f3"] },
    ]);
  });

  it("says a line that no sentence tells as it stands, so nothing they agree to goes unsaid", () => {
    const story = storyOf(
      {
        sentences: [
          {
            say: "You weigh the parcel and write its weight on the label.",
            ids: ["f1", "f2"],
          },
        ],
      },
      lines
    );
    expect(story?.at(-1)).toStrictEqual({
      say: "You put the parcel on the belt.",
      ids: ["f3"],
    });
  });

  it("leaves out a sentence that tells no line, and lights a line up only once", () => {
    const story = storyOf(
      {
        sentences: [
          { say: "Okay, let me sum up.", ids: [] },
          { say: "You weigh the parcel.", ids: ["f1", "f9"] },
          {
            say: "You write the weight on the label and put it on the belt.",
            ids: ["f1", "f2", "f3"],
          },
        ],
      },
      lines
    );
    expect(story).toStrictEqual([
      { say: "You weigh the parcel.", ids: ["f1"] },
      {
        say: "You write the weight on the label and put it on the belt.",
        ids: ["f2", "f3"],
      },
    ]);
  });

  it.each([
    [
      "longer than the lines",
      {
        sentences: [
          {
            say: "You weigh the parcel on the scale by the door, which is the grey one, and you take your time for it because it matters a lot to everyone.",
            ids: ["f1", "f2", "f3"],
          },
        ],
      },
    ],
    [
      "a sentence that runs on",
      { sentences: [{ say: "word ".repeat(80), ids: ["f1"] }] },
    ],
    ["no sentences", { sentences: [] }],
    [
      "only lines that aren't there",
      { sentences: [{ say: "Something else.", ids: ["f9"] }] },
    ],
    ["not a story at all", "no"],
  ])("is no story when it is %s", (_, told) => {
    expect(storyOf(told, lines)).toBeNull();
  });

  it("is asked for with lines that are lines, and refused without any", () => {
    const link = { secret: "s".repeat(43), key: "k".repeat(43) };
    const asked = (more: object) =>
      interviewStoryRequestSchema.safeParse({ ...link, locale: "nl", ...more });
    expect({
      claire: asked({ interviewer: "claire", lines }).data?.interviewer,
      stephen: asked({ lines }).data?.interviewer,
      none: asked({ lines: [] }).success,
      unnamed: asked({ lines: [...lines, { id: "", text: "x" }] }).success,
      twice: asked({ lines: [...lines, lines[0]] }).success,
      more: asked({ lines, name: "Anna" }).success,
    }).toStrictEqual({
      claire: "claire",
      stephen: "stephen",
      none: false,
      unnamed: false,
      twice: false,
      more: false,
    });
  });

  it("is of exactly the lines it was told from: a changed line is another story", () => {
    const [first, ...rest] = lines;
    expect({
      same: storyKey(lines) === storyKey(lines.map((line) => ({ ...line }))),
      changed:
        storyKey(lines) ===
        storyKey([{ id: "f1", text: "You weigh the box." }, ...rest]),
      fewer: storyKey(lines) === storyKey(rest),
      first: first?.id,
    }).toStrictEqual({ same: true, changed: false, fewer: false, first: "f1" });
  });
});

describe("the read-back", () => {
  it("comes in parts of a few lines: the steps, what goes differently, then the numbers and the result", () => {
    const parts = readBackParts([
      ...ids("n", 4).map((id) => fact(id, "number")),
      ...ids("s", 5).map((id) => fact(id, "step")),
      ...ids("e", 4).map((id) => fact(id, "exception")),
    ]);
    expect({
      groups: parts.map(({ group }) => group),
      ids: idsOf(parts),
    }).toStrictEqual({
      groups: ["steps", "differently", "result"],
      ids: [ids("s", 5), ids("e", 4), ids("n", 4)],
    });
  });

  it("reads small parts together: five short answers are one page, not five", () => {
    const parts = readBackParts([
      fact("a", "number"),
      fact("b", "step"),
      fact("c", "exception"),
      fact("d", "system"),
      fact("e", "ai"),
    ]);
    expect({
      groups: parts.map(({ group }) => group),
      ids: idsOf(parts),
    }).toStrictEqual({
      groups: ["together"],
      ids: [["e", "b", "d", "c", "a"]],
    });
  });

  it("never reads more than a few lines at once", () => {
    const steps = readBackParts(
      Array.from({ length: 12 }, (_, index) => fact(`s${index}`, "step"))
    );
    const many = readBackParts(
      Array.from({ length: 30 }, (_, index) =>
        fact(`m${index}`, index % 2 === 1 ? "step" : "number")
      )
    );
    expect({
      first: steps.map(({ first }) => first),
      longest: Math.max(
        ...[...steps, ...many].map(({ facts }) => facts.length)
      ),
    }).toStrictEqual({ first: [true, false], longest: readBackMost });
  });

  it("keeps what the person added in the part they added it to", () => {
    const parts = readBackParts([
      ...["a", "b", "c", "d", "e"].map((id) => fact(id, "step")),
      ...["f", "g", "h", "i"].map((id) => fact(id, "number")),
      fact("j", "number", { pin: 0 }),
    ]);
    expect(idsOf(parts)).toStrictEqual([
      ["a", "b", "c", "d", "e", "j"],
      ["f", "g", "h", "i"],
    ]);
  });

  it("makes two pages of a short interview, not five", () => {
    const parts = readBackParts([
      fact("a", "ai"),
      fact("b", "wish"),
      ...["c", "d", "e", "f", "g", "h"].map((id) => fact(id, "step")),
      fact("i", "exception"),
      fact("j", "exception"),
      fact("k", "number"),
      fact("l", "done"),
    ]);
    expect(parts.map(({ facts }) => facts.length)).toStrictEqual([7, 5]);
  });

  it("has nothing to read when nothing was written down", () => {
    expect(readBackParts([])).toStrictEqual([]);
  });

  it("does not read again what was agreed to before: back to add something, only what is new", () => {
    const parts = readBackParts([
      fact("a", "step", { agreed: true }),
      fact("b", "number", { agreed: true }),
      fact("c", "step"),
    ]);
    expect(idsOf(parts)).toStrictEqual([["c"]]);
  });
});

describe("what counts", () => {
  const facts = [
    fact("a", "step", { agreed: true }),
    fact("b", "step", { agreed: true, out: true }),
    fact("c", "number"),
  ];

  it("is only what they agreed to and kept", () => {
    expect(agreedFacts(facts).map(({ id }) => id)).toStrictEqual(["a"]);
  });

  it("changes with what is agreed to, and not with what is still being read back", () => {
    const now = agreedKey(facts);
    expect({
      nothing: agreedKey([fact("c", "number")]),
      unagreed: agreedKey([...facts, fact("d", "step")]) === now,
      added: agreedKey([...facts, fact("d", "step", { agreed: true })]) === now,
      changed:
        agreedKey([
          fact("a", "step", { agreed: true, record: "Weigh the box." }),
        ]) === now,
    }).toStrictEqual({
      nothing: "",
      unagreed: true,
      added: false,
      changed: false,
    });
  });
});
