import { describe, expect, it } from "vite-plus/test";

import { diffLines, withContext } from "./line-diff.ts";

/** How a diff marks each kind of line. */
const marks = { same: " ", added: "+", removed: "-" } as const;

/** Each line as a diff prints it, with its numbers in both files. */
const printed = (before: string, after: string): string[] =>
  diffLines(before, after).map(
    (line) =>
      `${marks[line.kind]}${line.text} ${line.before ?? "."}/${line.after ?? "."}`
  );

describe(diffLines, () => {
  it("marks no line of a file that didn't change", () => {
    expect(printed("a\nb\n", "a\nb\n")).toStrictEqual([" a 1/1", " b 2/2"]);
  });

  it("marks a changed line removed and added, numbered in each file", () => {
    expect(printed("a\nb\nc\n", "a\nB\nc\n")).toStrictEqual([
      " a 1/1",
      "-b 2/.",
      "+B ./2",
      " c 3/3",
    ]);
  });

  it("numbers the lines after an insertion by the new file", () => {
    expect(printed("a\nc\nd\n", "a\nb\nc\nd\n")).toStrictEqual([
      " a 1/1",
      "+b ./2",
      " c 2/3",
      " d 3/4",
    ]);
  });

  it("keeps lines that moved apart in common", () => {
    expect(printed("x\na\ny\nb\n", "a\nz\nb\n")).toStrictEqual([
      "-x 1/.",
      " a 2/1",
      "-y 3/.",
      "+z ./2",
      " b 4/3",
    ]);
  });

  it("has a new file all added and a deleted one all removed", () => {
    expect([printed("", "a\nb"), printed("a\n", "")]).toStrictEqual([
      ["+a ./1", "+b ./2"],
      ["-a 1/."],
    ]);
  });
});

describe(withContext, () => {
  it("leaves out unchanged lines far from a change", () => {
    const before = Array.from({ length: 20 }, (_, line) => `${line}`).join(
      "\n"
    );
    const after = before.replace("\n10\n", "\nten\n");

    expect(
      withContext(diffLines(before, after)).map((line) =>
        line.kind === "gap" ? `gap ${line.lines}` : line.text
      )
    ).toStrictEqual([
      "gap 7",
      "7",
      "8",
      "9",
      "10",
      "ten",
      "11",
      "12",
      "13",
      "gap 6",
    ]);
  });
});
