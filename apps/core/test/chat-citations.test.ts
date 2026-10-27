import { chatCitationsMax, citedQuoteMax } from "@grasp-os/shared/chat";
import { describe, expect, it } from "vite-plus/test";

import { citedIn } from "../src/chat-messages.ts";

// How an answer's note links become its citations: a parser, so unit
// tests. That core records what a chat's code was given, and shows its
// answers with these, is tested through a chat (agent-brain.test.ts).

const given =
  (...ids: string[]) =>
  (id: string): boolean =>
    ids.includes(id);

/** What an answer shows: its text and citations, not where its links are. */
const shown = (
  text: string,
  cites: (id: string) => boolean
): Omit<ReturnType<typeof citedIn>, "links"> => {
  const { links: _links, ...rest } = citedIn(text, cites);
  return rest;
};

describe(citedIn, () => {
  it("keeps a link to a given note, in one form, whatever its title or brackets", () => {
    expect(
      shown(
        'See [A](grasp:note/a "title"), [A again](<grasp:note/a>) and [B]( grasp:note/b (b) ).',
        given("a", "b")
      )
    ).toStrictEqual({
      text: "See [A](grasp:note/a), [A again](grasp:note/a) and [B](grasp:note/b).",
      citations: [
        { kind: "document", documentId: "a" },
        { kind: "document", documentId: "b" },
      ],
    });
  });

  it("leaves no link to a note that isn't given, inline, by reference or as an autolink", () => {
    expect(
      shown(
        'See [X](grasp:note/x "t"), [Y][1], <grasp:note/z> and [A](grasp:note/a).\n\n[1]: grasp:note/y',
        given("a")
      )
    ).toStrictEqual({
      text: "See X, [Y][1], <z> and [A](grasp:note/a).\n\n[1]: y",
      citations: [{ kind: "document", documentId: "a" }],
    });
  });

  it("leaves no note scheme spelled another way: nested, escaped, as a character reference or in capitals", () => {
    expect(
      shown(
        [
          "[N](grasp:grasp:note/note/x)",
          "[E](grasp:note\\/x)",
          "[C](grasp&#58;note/x)",
          "[H](grasp&#x3A;note&sol;x)",
          "[U](GRASP:Note/x)",
          "<grasp:grasp:note/note/x>",
          "[A <grasp:note/x>](grasp:note/a)",
        ].join(" "),
        given("a")
      )
    ).toStrictEqual({
      text: "[N](x) E [C](grasp&amp;#58;note/x) [H](grasp&amp;#x3A;note&amp;sol;x) [U](x) <x> [A <x>](grasp:note/a)",
      citations: [{ kind: "document", documentId: "a" }],
    });
  });

  it("leaves code as it is written, and cites nothing in it", () => {
    const code =
      "```js\nconst a = '&#65; grasp:note/a \\/';\n```\nUse `[A](grasp:note/a)`, or:\n~~~\n[B](grasp:note/b)\n~~~";
    expect(shown(code, given("a", "b"))).toStrictEqual({
      text: code,
      citations: [],
    });
  });

  it("cleans what only looks like code: an unclosed span, one across a paragraph, a fence with a backtick after it", () => {
    expect(
      shown(
        "`[X](grasp:note/x)\n\n[Y](grasp:note/y)`\n``` a`b\n[Z](grasp:note/z)",
        given()
      )
    ).toStrictEqual({
      text: "`X\n\nY`\n``` a`b\nZ",
      citations: [],
    });
  });

  it("cites at most the first notes it may, and shows the links past them as text", () => {
    const ids = Array.from(
      { length: chatCitationsMax + 1 },
      (_, index) => `n${index}`
    );
    const { text, citations } = citedIn(
      `${ids.map((id) => `[${id}](grasp:note/${id})`).join(" ")} [n0](grasp:note/n0)`,
      given(...ids)
    );
    const last = ids.at(-1) ?? "";
    expect({
      citations: citations.length,
      lastShownAsText: text.includes(` ${last} `),
      lastLinked: text.includes(`grasp:note/${last}`),
      firstAgain: text.endsWith("[n0](grasp:note/n0)"),
    }).toStrictEqual({
      citations: chatCitationsMax,
      lastShownAsText: true,
      lastLinked: false,
      firstAgain: true,
    });
  });

  it("keeps an answer's own private-use marks from standing for a link", () => {
    const mark = String.fromCodePoint(0xe0_00);
    expect(
      shown(`${mark}0${mark} [A](grasp:note/a)`, given("a"))
    ).toStrictEqual({
      text: "0 [A](grasp:note/a)",
      citations: [{ kind: "document", documentId: "a" }],
    });
  });

  it("knows where each kept link starts, the words it links and the quote its title holds", () => {
    const longQuote = "x".repeat(citedQuoteMax + 1);
    const answer = [
      "`[C](grasp:note/a)` &#58; [X](grasp:note/x) then",
      "[sixteen weeks](grasp:note/a 'Leave lasts \t sixteen \"weeks\".')",
      String.raw`[paid](<grasp:note/b> "Leave is \*paid\*.")`,
      "[again](grasp:note/a ( ))",
      `[long](grasp:note/b "${longQuote}").`,
    ].join(" ");
    const { text, links } = citedIn(answer, given("a", "b"));
    expect({
      links: links.map(({ documentId, text: words, quote }) => ({
        documentId,
        words,
        quote,
      })),
      inPlace: links.every(({ at, documentId, text: words }) =>
        text.startsWith(`[${words}](grasp:note/${documentId})`, at)
      ),
    }).toStrictEqual({
      links: [
        {
          documentId: "a",
          words: "sixteen weeks",
          quote: 'Leave lasts sixteen "weeks".',
        },
        { documentId: "b", words: "paid", quote: "Leave is *paid*." },
        { documentId: "a", words: "again", quote: null },
        { documentId: "b", words: "long", quote: null },
      ],
      inPlace: true,
    });
  });
});
