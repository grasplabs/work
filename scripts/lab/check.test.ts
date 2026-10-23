/**
 * The check of the judge against a person (check.ts): which questions are
 * asked, how agreement is counted, and that the page never shows what the
 * judge said. Pure logic, tested on its own.
 */
import { describe, expect, it } from "vite-plus/test";

import { agreementOf, checkPage, pickItems } from "./check.ts";
import type { CheckItem } from "./check.ts";

const item = (
  n: number,
  judge: boolean,
  kind: CheckItem["kind"] = "said"
): CheckItem => ({
  id: `f3f2/p-p1/${kind}/${n}`,
  interview: "f3f2/p-p1",
  kind,
  text: `Fact ${n}`,
  judge,
});

const all = [
  ...Array.from({ length: 40 }, (_, n) => item(n, true)),
  ...Array.from({ length: 8 }, (_, n) => item(100 + n, false, "supported")),
];

describe("the check of the judge against a person", () => {
  it("asks every question the judge said no to, then fills up with its yeses, the same pick every time", () => {
    const picked = pickItems(all, 20);
    expect({
      count: picked.length,
      noes: picked.filter((each) => !each.judge).length,
      same: pickItems(all, 20).map((each) => each.id),
    }).toStrictEqual({
      count: 20,
      noes: 8,
      same: picked.map((each) => each.id),
    });
  });

  it("counts how often they agree, by kind, and lists where they differ", () => {
    expect(
      agreementOf(
        [
          item(1, true),
          item(2, true),
          item(3, false, "supported"),
          item(4, true),
        ],
        {
          "f3f2/p-p1/said/1": true,
          "f3f2/p-p1/said/2": false,
          "f3f2/p-p1/supported/3": false,
        }
      )
    ).toStrictEqual({
      answered: 3,
      agreed: 2,
      byKind: {
        said: { answered: 2, agreed: 1 },
        supported: { answered: 1, agreed: 1 },
      },
      differ: [{ item: item(2, true), person: false }],
    });
  });

  it("shows the conversation and the questions, and nothing of what the judge said", () => {
    const page = checkPage(
      [
        {
          id: "f3f2/p-p1",
          name: "Sanne de Vries",
          lines: [{ from: "person", text: "I open the <mail>." }],
        },
      ],
      [item(1, false)]
    );
    expect({
      escaped: page.includes("I open the &lt;mail&gt;."),
      asked: page.includes('data-id="f3f2/p-p1/said/1"'),
      judge: page.includes('"judge"'),
    }).toStrictEqual({ escaped: true, asked: true, judge: false });
  });
});
