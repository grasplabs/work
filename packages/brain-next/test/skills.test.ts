import { describe, expect, it } from "vite-plus/test";

import { selectSkills, skillCardOf, skillsSelectedMax } from "../src/skills.ts";

// A skill's card, read from its SKILL.md by a YAML parser, and selection
// by the task's words as recall's words way matches them. The ways they
// could fail: text that isn't a skill reads as one (no frontmatter, YAML
// that doesn't parse, a key twice, a name outside the format), or YAML
// whose aliases expand without end is expanded; a skill
// that shares no word with the task is picked; a word in another form
// (a plural, an accent, a hyphenated name) is missed; more than a few
// come back.

describe("a skill's card", () => {
  it("reads the name and description of the Agent Skills format, and nothing else as one", () => {
    expect({
      plain: skillCardOf(
        "---\nname: book-invoices\ndescription: How we book invoices.\ntasks: [invoice.book]\n---\n# Steps"
      ),
      crlf: skillCardOf(
        '---\r\nname: refunds\r\ndescription: "Refunds: how, and when."\r\n---\r\n'
      ),
      noFrontmatter: skillCardOf("# Book invoices\n\nname: book-invoices"),
      notYaml: skillCardOf("---\nname: [unclosed\n---\n"),
      twice: skillCardOf("---\nname: a\nname: b\ndescription: Twice.\n---\n"),
      badName: skillCardOf("---\nname: Book Invoices\ndescription: X.\n---\n"),
      noDescription: skillCardOf("---\nname: book-invoices\n---\n"),
      aliasBomb: skillCardOf(
        [
          "---",
          "name: bomb",
          'a: &a ["x","x","x","x","x","x","x","x","x"]',
          ...Array.from(
            { length: 8 },
            (_, index) =>
              `${String.fromCodePoint(98 + index)}: &${String.fromCodePoint(98 + index)} [${Array.from({ length: 9 }, () => `*${String.fromCodePoint(97 + index)}`).join(",")}]`
          ),
          "description: *i",
          "---",
        ].join("\n")
      ),
    }).toStrictEqual({
      plain: { name: "book-invoices", description: "How we book invoices." },
      crlf: { name: "refunds", description: "Refunds: how, and when." },
      noFrontmatter: null,
      notYaml: null,
      twice: null,
      badName: null,
      noDescription: null,
      aliasBomb: null,
    });
  });
});

describe("selecting skills for a task", () => {
  const cards = [
    { name: "book-invoices", description: "How we book supplier invoices." },
    { name: "refunds", description: "Handles a customer's refund." },
    { name: "financiele-afsluiting", description: "De maandafsluiting." },
  ];

  it("picks the skills sharing the task's words in any form, most first, and none that only seem close", () => {
    const names = (task: string) =>
      selectSkills(task, cards).map(({ name }) => name);
    expect({
      plural: names("Book this invoice"),
      most: names("Refund the customer's invoice"),
      accent: names("De financiële afsluiting"),
      none: names("Bake a sourdough loaf"),
      stopWordsAlone: names("the and of"),
    }).toStrictEqual({
      plural: ["book-invoices"],
      most: ["refunds", "book-invoices"],
      accent: ["financiele-afsluiting"],
      none: [],
      stopWordsAlone: [],
    });
  });

  it("answers a few at most", () => {
    const many = Array.from({ length: skillsSelectedMax + 3 }, (_, index) => ({
      name: `invoices-${index}`,
      description: "About invoices.",
    }));
    expect(selectSkills("invoices", many)).toHaveLength(skillsSelectedMax);
  });
});
