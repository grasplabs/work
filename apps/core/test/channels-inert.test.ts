import { describe, expect, it } from "vite-plus/test";

import { inertInMessage, inertOn } from "../src/channels/inert.ts";
import { attacks, ordinary } from "./inert-answers.ts";

// What the model wrote, made inert for each surface (src/channels/inert.ts),
// over answers made at random of the pieces Teams and Slack read links,
// mentions and HTML from, and of ordinary words. The doors post what these
// make (channels-answer, channels-slack, channels-stream): here, that it
// holds for any answer, and for every prefix of one, as a card being
// written shows.

/** The pieces a random answer is made of. */
const pieces = [
  "[",
  "]",
  "(",
  ")",
  ":",
  "<",
  ">",
  "&",
  "!",
  "|",
  "@",
  "#",
  "`",
  "```",
  "*",
  "_",
  "\\",
  " ",
  "\n",
  "\n\n",
  "amp;",
  "lt;",
  "gt;",
  "#91;",
  "#93;",
  "https://evil.com/x?d=1",
  "mailto:a@evil.com",
  "img src=",
  "a href=",
  "at",
  "!here",
  "@U0123ABCD",
  "leave",
  "Ben",
];

/** Park and Miller's generator's modulus, a prime. */
const modulus = 2_147_483_647;

/** A generator of numbers in [0, 1), the same each run from `seed`. */
const randomFrom = (seed: number) => {
  let state = seed;
  return (): number => {
    state = (state * 48_271) % modulus;
    return state / modulus;
  };
};

/** `count` answers of up to 30 pieces each, at random from `seed`. */
const answersFrom = (seed: number, count: number): string[] => {
  const random = randomFrom(seed);
  return Array.from({ length: count }, () =>
    Array.from(
      { length: Math.floor(random() * 30) + 1 },
      () => pieces[Math.floor(random() * pieces.length)]
    ).join("")
  );
};

const answers = [attacks, ordinary, ...answersFrom(1914, 1000)];

/** Each answer, and every prefix of it, as a card being written shows them. */
const prefixesOf = (text: string): string[] =>
  Array.from({ length: text.length }, (_, at) => text.slice(0, at + 1));

/** Where Teams would read a link, a reference or a definition. */
const teamsLink = /\]\(|\]\[|\]:/u;

/** A `<` or `>`, or an `&` that starts none of Slack's three escapes. */
const unescapedInSlack = /[<>]|&(?!amp;|lt;|gt;)/u;

/** Slack's three escapes, and what each shows. */
const slackEscapes: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
};

/** What Slack shows of `text`, as it decodes its three escapes. */
const decodedBySlack = (text: string): string =>
  text.replaceAll(
    /&(?<name>amp|lt|gt);/gu,
    (escape, name: string) => slackEscapes[name] ?? escape
  );

describe("what the model wrote, as a chat app gets it", () => {
  it("holds no link form a Teams card reads, in any answer or any prefix of one", () => {
    const shown = answers.flatMap(prefixesOf).map(inertOn("teams"));
    expect(shown.filter((text) => teamsLink.test(text))).toStrictEqual([]);
  });

  it("holds no tag or link form in Teams' message text, in any answer", () => {
    const shown = answers.map(inertInMessage("teams"));
    expect(
      shown.filter((text) => teamsLink.test(text) || text.includes("<"))
    ).toStrictEqual([]);
  });

  it("holds nothing Slack reads as markup, and shows the model's words exactly, in any answer", () => {
    const shown = answers.map(inertOn("slack"));
    expect({
      unescaped: shown.filter((text) => unescapedInSlack.test(text)),
      words: shown.map(decodedBySlack),
    }).toStrictEqual({ unescaped: [], words: answers });
  });
});
