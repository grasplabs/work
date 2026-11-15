import { cardToBlockKit } from "@chat-adapter/slack";
import { cardToAdaptiveCard } from "@chat-adapter/teams/cards";
import type { TeamsCardElement } from "@chat-adapter/teams/cards";
import { convertEmojiPlaceholders } from "chat";
import type { CardChild, CardElement, PostableCard } from "chat";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import {
  answerCards,
  ratingCard,
  cancelAction,
  confirmAction,
  heldWritesCard,
  maxValuesPerWrite,
  maxWritesOnCard,
  piecesOf,
  pressOf,
  signInCard,
} from "../src/channels/cards.tsx";
import type {
  HeldWriteView,
  PressOutcome,
  WriteState,
} from "../src/channels/cards.tsx";
import {
  channelLocales,
  fill,
  holesIn,
  languageOf,
  lineNames,
  say,
} from "../src/channels/words.ts";
import type { ChannelLocale } from "../src/channels/words.ts";

// What Stephen sends in a chat app (src/channels/): his cards, rendered by
// the Teams adapter, and his lines in five languages. How it can go wrong:
//
// - A card Teams refuses: over its size, with more buttons than it shows,
//   or an element or a card version it doesn't render. The whole message
//   is lost, and the person hears nothing.
// - A press that confirms more, or other, than the card showed: Confirm on
//   a card whose values were cut, or whose writes already ran.
// - A link that isn't one: a source's `javascript:` address on a button.
// - A line left half written: a placeholder said out loud, a language
//   missing, or a translation that names other values than the English.
// - The wrong language: a Dutch question answered in English because it
//   names an English system, or a "👍" that switches the language.
//
// The cards are rendered with the adapter's own Adaptive Card renderer
// (`@chat-adapter/teams/cards`). The adapter's main entry loads
// Microsoft's Teams SDK, whose CommonJS (jwks-rsa, express) the test
// pool's module runner can't load from workerd; the renderer is the same
// card conversion without the SDK's classes.

/** What Teams takes in one card: 28 KB for the message that carries it. */
const teamsMessageBytes = 28 * 1024;

/** The most actions Teams shows on a card. */
const teamsMaxActions = 6;

/** The newest Adaptive Card version Teams renders on every client. */
const teamsCardVersion = 1.5;

/** The element and action types Teams renders in an Adaptive Card. */
const teamsTypes = new Set([
  "AdaptiveCard",
  "TextBlock",
  "RichTextBlock",
  "TextRun",
  "Image",
  "ImageSet",
  "Container",
  "ColumnSet",
  "Column",
  "FactSet",
  "ActionSet",
  "Table",
  "TableRow",
  "TableCell",
  "Input.Text",
  "Input.Number",
  "Input.Date",
  "Input.Time",
  "Input.Toggle",
  "Input.ChoiceSet",
  "Action.OpenUrl",
  "Action.Submit",
  "Action.ShowCard",
  "Action.ToggleVisibility",
  "Action.Execute",
]);

/** A card action, as Teams reads it. */
const teamsActionSchema = z.object({
  type: z.string(),
  title: z.string().optional(),
  url: z.string().optional(),
  data: z
    .object({ actionId: z.string().optional(), value: z.string().optional() })
    .optional(),
});

/** The elements the Teams adapter renders; any other it leaves out. */
const teamsElements = new Set<string>([
  "actions",
  "divider",
  "fields",
  "image",
  "link",
  "section",
  "table",
  "text",
  "text_input",
]);

const rendersInTeams = (child: CardChild): boolean =>
  teamsElements.has(child.type) &&
  (child.type !== "section" || child.children.every(rendersInTeams));

/** Whether the Teams adapter renders every element of a card. */
const isTeamsCard = (
  card: CardElement
): card is CardElement & TeamsCardElement =>
  card.children.every(rendersInTeams);

/** The card as the Teams adapter sends it, and what Teams checks of it. */
const inTeams = ({ card }: PostableCard) => {
  if (!isTeamsCard(card)) {
    throw new Error("The card has an element the Teams adapter leaves out");
  }
  const adaptive = cardToAdaptiveCard(card);
  const message = JSON.stringify({
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: adaptive,
      },
    ],
  });
  const types = new Set<string>();
  const texts: string[] = [];
  const facts: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item);
      }
      return;
    }
    if (typeof node !== "object" || node === null) {
      return;
    }
    const type: unknown = Reflect.get(node, "type");
    if (typeof type === "string") {
      types.add(type);
    }
    const text: unknown = Reflect.get(node, "text");
    if (typeof text === "string") {
      texts.push(text);
    }
    const fact = [Reflect.get(node, "title"), Reflect.get(node, "value")];
    if (type === undefined && fact.every((part) => typeof part === "string")) {
      facts.push(fact.join(": "));
    }
    for (const value of Object.values(node)) {
      walk(value);
    }
  };
  walk(adaptive);
  const actions = z.array(teamsActionSchema).parse(adaptive.actions ?? []);
  return {
    bytes: new TextEncoder().encode(message).length,
    version: Number(adaptive.version),
    types: [...types],
    actions,
    texts,
    facts,
  };
};

/** Whether Teams takes the card. */
const withinTeams = (postable: PostableCard) => {
  const { bytes, version, types, actions } = inTeams(postable);
  return {
    fits: bytes <= teamsMessageBytes,
    version: version <= teamsCardVersion,
    unknownTypes: types.filter((type) => !teamsTypes.has(type)),
    actions: actions.length <= teamsMaxActions,
    links: actions
      .filter((action) => action.type === "Action.OpenUrl")
      .every((action) => action.url?.startsWith("https://") === true),
  };
};

const allWithin = {
  fits: true,
  version: true,
  unknownTypes: [],
  actions: true,
  links: true,
};

const grasp = "https://acme.grasp.test";

/** Text that costs the most per character on a card: escaped or 4 bytes. */
const heavy = (chars: number): string =>
  Array.from(
    { length: chars },
    (_, at) => ["\u0001", "😀", '"', "\\"][at % 4]
  ).join("");

const write = (
  index: number,
  {
    state = "held",
    value = "Monday 3 November, 10:00",
  }: { state?: WriteState; value?: string } = {}
): HeldWriteView => ({
  id: `held_${index}`,
  inputHash: `${index}`.padStart(64, "a"),
  title: `Put a call with Jan in your calendar (${index})`,
  values: [
    { label: "When", value },
    { label: "With", value: "jan@acme.test" },
  ],
  state,
});

/** As many writes, values and characters as a card could be given. */
const largest = (state: WriteState = "held"): HeldWriteView[] =>
  Array.from({ length: maxWritesOnCard + 5 }, (_, index) => ({
    id: `held_${index}`.padEnd(64, "x"),
    inputHash: "f".repeat(64),
    title: heavy(5000),
    values: Array.from({ length: maxValuesPerWrite + 5 }, () => ({
      label: heavy(5000),
      value: heavy(50_000),
    })),
    state,
  }));

const outcomes: PressOutcome[] = [
  "allDone",
  "cancelled",
  "stopped",
  "unknownOutcome",
  "expired",
  "changedSince",
];

/** Every card Stephen sends, small and as large as it gets, in each language. */
const everyCard = channelLocales.flatMap((locale) => [
  ...answerCards({
    locale,
    text: "You have a call with Jan at 10:00.",
    rate: crypto.randomUUID(),
  }).map((card, at) => ({ name: `answer ${at} (${locale})`, card })),
  ...answerCards({
    locale,
    text: heavy(200_000),
    rate: crypto.randomUUID(),
  }).map((card, at) => ({ name: `largest answer ${at} (${locale})`, card })),
  {
    name: `rating (${locale})`,
    card: ratingCard({ locale, rate: crypto.randomUUID() }),
  },
  {
    name: `one held write (${locale})`,
    card: heldWritesCard({ locale, writes: [write(1)] }),
  },
  {
    name: `largest held writes (${locale})`,
    card: heldWritesCard({
      locale,
      writes: largest(),
      check: { read: "record", where: heavy(5000) },
    }),
  },
  ...outcomes.map((outcome) => ({
    name: `largest held writes, ${outcome} (${locale})`,
    card: heldWritesCard({
      locale,
      writes: largest("unknown"),
      check: { read: "mail" },
      outcome,
    }),
  })),
  {
    name: `sign in (${locale})`,
    card: signInCard({ locale, url: `${grasp}/sign-in?link=abc` }),
  },
]);

describe("Stephen's cards in Teams", () => {
  it("are all within Teams' size, action, version and element limits", () => {
    expect(
      Object.fromEntries(
        everyCard.map(({ name, card }) => [name, withinTeams(card)])
      )
    ).toStrictEqual(
      Object.fromEntries(everyCard.map(({ name }) => [name, allWithin]))
    );
  });

  it("asks for a press on held writes with exactly the writes it shows", () => {
    const writes = [write(1), write(2)];
    const { actions, texts, facts } = inTeams(
      heldWritesCard({ locale: "nl", writes })
    );

    expect({
      buttons: actions.map(({ type, title, data }) => ({
        type,
        title,
        action: data?.actionId,
        press: pressOf(data?.value),
      })),
      says: texts.includes(say("heldMany", "nl", { count: 2 })),
      values: facts,
    }).toStrictEqual({
      buttons: [
        {
          type: "Action.Submit",
          title: "Bevestigen",
          action: confirmAction,
          press: writes.map(({ id, inputHash }) => ({ id, inputHash })),
        },
        {
          type: "Action.Submit",
          title: "Annuleren",
          action: cancelAction,
          press: writes.map(({ id, inputHash }) => ({ id, inputHash })),
        },
      ],
      says: true,
      values: [
        "When: Monday 3 November, 10:00",
        "With: jan@acme.test",
        "When: Monday 3 November, 10:00",
        "With: jan@acme.test",
      ],
    });
  });

  it("never asks for a press on values it couldn't show whole, or on writes that ran", () => {
    const pressesOf = (postable: PostableCard) => {
      const { actions, texts } = inTeams(postable);
      return {
        presses: actions.filter((action) => action.type === "Action.Submit")
          .length,
        // A conversation in a chat app is no chat in Grasp (GRA-1919):
        // nothing on the card leads there.
        links: actions.filter((action) => action.type === "Action.OpenUrl")
          .length,
        saysTooLong: texts.includes(say("cardTooLong", "de")),
      };
    };

    expect({
      tooLong: pressesOf(
        heldWritesCard({
          locale: "de",
          writes: [write(1, { value: "x".repeat(20_000) })],
        })
      ),
      tooMany: pressesOf(
        heldWritesCard({
          locale: "de",
          writes: Array.from({ length: maxWritesOnCard + 1 }, (_, index) =>
            write(index)
          ),
        })
      ),
      running: pressesOf(
        heldWritesCard({
          locale: "de",
          writes: [write(1, { state: "done" }), write(2, { state: "running" })],
        })
      ),
      ended: pressesOf(
        heldWritesCard({
          locale: "de",
          writes: [write(1)],
          outcome: "expired",
        })
      ),
    }).toStrictEqual({
      tooLong: { presses: 0, links: 0, saysTooLong: true },
      tooMany: { presses: 0, links: 0, saysTooLong: true },
      running: { presses: 0, links: 0, saysTooLong: false },
      ended: { presses: 0, links: 0, saysTooLong: false },
    });
  });

  it("presses only what a card of held writes carries", () => {
    expect({
      none: pressOf(),
      notJson: pressOf("confirm"),
      empty: pressOf("[]"),
      extra: pressOf('[{"id":"a","inputHash":"b","run":"all"}]'),
      one: pressOf('[{"id":"a","inputHash":"b"}]'),
    }).toStrictEqual({
      none: null,
      notJson: null,
      empty: null,
      extra: null,
      one: [{ id: "a", inputHash: "b" }],
    });
  });
});

/** Values for every line's room, the same in each language. */
const values = {
  count: 3,
  where: "Sales register.xlsx",
  workflow: "Weekly report",
  link: "https://acme.grasp.test/decisions/d-1",
  from: "19 October",
  to: "25 October",
  change: "12%",
  hours: 31,
  label: "How do I report sick?",
  requests: 4,
  pace: 380,
  included: 400,
  url: "https://acme.grasp.test/workflows/requests",
};

/** Block Kit's limits, as Slack documents them for a message's blocks. */
const slackLimits = {
  blocks: 50,
  sectionText: 3000,
  headerText: 150,
  contextElements: 10,
  actionsElements: 25,
  buttonText: 75,
  buttonValue: 2000,
  url: 3000,
};

/** A Block Kit node's own text: its `text`, or its text object's. */
const slackTextOf = (node: unknown): string => {
  const text: unknown =
    typeof node === "object" && node !== null
      ? Reflect.get(node, "text")
      : undefined;
  if (typeof text === "string") {
    return text;
  }
  const inner: unknown =
    typeof text === "object" && text !== null
      ? Reflect.get(text, "text")
      : undefined;
  return typeof inner === "string" ? inner : "";
};

/** How many elements a Block Kit node holds. */
const elementsIn = (node: object): number => {
  const elements: unknown = Reflect.get(node, "elements");
  return Array.isArray(elements) ? elements.length : 0;
};

/** The limits one Block Kit node breaks, itself and not its children. */
const breaksOf = (node: object): string[] => {
  const type: unknown = Reflect.get(node, "type");
  const text = slackTextOf(node).length;
  const value: unknown = Reflect.get(node, "value");
  const url: unknown = Reflect.get(node, "url");
  const broken: [boolean, string][] = [
    [type === "section" && text > slackLimits.sectionText, "sectionText"],
    [type === "header" && text > slackLimits.headerText, "headerText"],
    [
      type === "context" && elementsIn(node) > slackLimits.contextElements,
      "contextElements",
    ],
    [
      type === "actions" && elementsIn(node) > slackLimits.actionsElements,
      "actionsElements",
    ],
    [type === "button" && text > slackLimits.buttonText, "buttonText"],
    [
      type === "button" &&
        typeof value === "string" &&
        value.length > slackLimits.buttonValue,
      "buttonValue",
    ],
    [typeof url === "string" && url.length > slackLimits.url, "url"],
  ];
  return broken.filter(([is]) => is).map(([, name]) => name);
};

/** What of a card Block Kit would refuse, by the limit it breaks. */
const pastSlack = (postable: PostableCard): string[] => {
  const blocks = cardToBlockKit(postable.card);
  const past = new Set<string>(
    blocks.length > slackLimits.blocks ? ["blocks"] : []
  );
  const walk = (node: unknown): void => {
    if (typeof node !== "object" || node === null) {
      return;
    }
    if (!Array.isArray(node)) {
      for (const broken of breaksOf(node)) {
        past.add(broken);
      }
    }
    for (const value of Object.values(node)) {
      walk(value);
    }
  };
  walk(blocks);
  return [...past];
};

/** Every character but the white space between them, in order. */
const ink = (said: string): string => said.replaceAll(/\s/gu, "");

/** The text of each section of a card, as Block Kit carries it. */
const sectionTexts = (postable: PostableCard): string[] => {
  const texts: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node !== "object" || node === null) {
      return;
    }
    if (Reflect.get(node, "type") === "section") {
      const text: unknown = Reflect.get(node, "text");
      const said: unknown =
        typeof text === "object" && text !== null
          ? Reflect.get(text, "text")
          : undefined;
      if (typeof said === "string") {
        texts.push(said);
      }
    }
    for (const value of Object.values(node)) {
      walk(value);
    }
  };
  walk(cardToBlockKit(postable.card));
  return texts;
};

/** A generator of the same numbers each run, from `seed` (Park–Miller). */
const numbersFrom = (seed: number) => {
  const modulus = 2_147_483_647;
  let state = seed % modulus || 1;
  return (): number => {
    state = (state * 48_271) % modulus;
    return state / modulus;
  };
};

/**
 * An answer as a model may write it, from `seed`: paragraphs of prose in
 * Latin, CJK and emoji, indented list items, and fenced code with blank
 * lines and indentation inside, some of each long enough to need cutting.
 */
const answerFrom = (seed: number): string => {
  const random = numbersFrom(seed);
  const pick = (choices: readonly string[]): string =>
    choices[Math.floor(random() * choices.length)] ?? "";
  const words = [
    "invoice",
    "Rechnung",
    "請求書",
    "發票",
    "😀",
    "👩‍💻",
    "café",
    "naïve",
  ];
  const sentence = () =>
    `${Array.from({ length: 3 + Math.floor(random() * 30) }, () => pick(words)).join(" ")}${pick([".", "!", "?", "。"])}`;
  const blocks = Array.from({ length: 1 + Math.floor(random() * 40) }, () => {
    const kind = pick(["prose", "prose", "list", "code", "long"]);
    if (kind === "list") {
      return Array.from(
        { length: 1 + Math.floor(random() * 4) },
        (_, at) => `${"  ".repeat(at % 3)}- ${sentence()}`
      ).join("\n");
    }
    if (kind === "code") {
      const lines = Array.from({ length: 2 + Math.floor(random() * 900) }, () =>
        pick(["    x = 1", "", "def f():", "\treturn x", "  # 注释 😀"])
      );
      return ["```py", ...lines, "```"].join("\n");
    }
    const sentences = kind === "long" ? 200 : 1 + Math.floor(random() * 8);
    return `${pick(["", "  ", "\t"])}${Array.from({ length: sentences }, sentence).join(" ")}`;
  });
  return blocks.join(pick(["\n\n", "\n\n\n", "\n  \n"]));
};

/** What a section's text costs a card, in bytes as JSON. */
const cardBytes = (text: string): number =>
  new TextEncoder().encode(JSON.stringify(text)).length - 2;

/** What is wrong with `pieces` of `text`: none of it, for pieces as they must be. */
const wrongWith = (text: string, pieces: readonly string[]) => ({
  joinedBack: pieces.join("") === text,
  empty: pieces.filter((piece) => piece === "").length,
  tooLarge: pieces.filter(
    (piece) => piece.length > 3000 || cardBytes(piece) > 16 * 1024
  ).length,
});

const allRight = { joinedBack: true, empty: 0, tooLarge: 0 };

describe("an answer in pieces", () => {
  it("keeps every character where it was, indentation and blank lines too, when it fits one message", () => {
    const text =
      "Here:\n\n```python\ndef f():\n    x = 1\n\n    return x\n```\n\n- a\n\n  - nested b";
    expect(piecesOf(text, "en")).toStrictEqual([text]);
  });

  it("joins back to exactly the answer, with no piece empty and each within a section, for answers of every kind", () => {
    const answers = Array.from({ length: 60 }, (_, at) => answerFrom(at + 1));
    expect(
      answers.map((text) => wrongWith(text, piecesOf(text, "en")))
    ).toStrictEqual(answers.map(() => allRight));
  });

  it("never cuts inside a character cluster, wherever the cluster falls against a section's end", () => {
    const clusters = {
      flag: "🇳🇱",
      skinTone: "👍🏽",
      family: "👨‍👩‍👧‍👦",
      tagFlag: "🏴󠁧󠁢󠁳󠁣󠁴󠁿",
    };
    const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });
    const cutsInside = Object.fromEntries(
      Object.entries(clusters).map(([name, cluster]) => {
        const inside: number[] = [];
        for (let offset = 0; offset < cluster.length + 2; offset += 1) {
          const text = `${"a".repeat(offset)}${cluster.repeat(2000)}`;
          const boundaries = new Set(
            Array.from(graphemes.segment(text), ({ index }) => index)
          );
          let at = 0;
          for (const piece of piecesOf(text, "en").slice(0, -1)) {
            at += piece.length;
            if (!boundaries.has(at)) {
              inside.push(offset);
            }
          }
        }
        return [name, inside];
      })
    );
    expect(cutsInside).toStrictEqual(
      Object.fromEntries(Object.keys(clusters).map((name) => [name, []]))
    );
  });

  it("cuts what a model may write to break it, each into pieces that join back to it", () => {
    const hostile = {
      stars: "*".repeat(64 * 1024),
      emphasis: "*a".repeat(16 * 1024),
      quotes: `${"> ".repeat(32_000)}deep`,
      fenceOpening: `\`\`\`${"a".repeat(2997)}\n${"code line\n".repeat(500)}\`\`\``,
      // One character cluster longer than a section: a letter and its marks.
      cluster: `a${"\u0301".repeat(5000)} and after`,
      pairs: "😀".repeat(5000),
    };
    expect(
      Object.fromEntries(
        Object.entries(hostile).map(([name, text]) => [
          name,
          wrongWith(text, piecesOf(text, "en")),
        ])
      )
    ).toStrictEqual(
      Object.fromEntries(Object.keys(hostile).map((name) => [name, allRight]))
    );
  });
});

describe("Stephen's cards in Slack", () => {
  it("posts no section that is only white space, and loses nothing else, where a cut falls before blank lines", () => {
    const answers = {
      blankLines: `${"a".repeat(2999)}\n\n\n${"b".repeat(3500)}`,
      spaces: `start ${" ".repeat(4000)} end`,
    };
    const shown = Object.fromEntries(
      Object.entries(answers).map(([name, text]) => {
        const sections = answerCards({ locale: "en", text }).flatMap((card) =>
          sectionTexts(card)
        );
        return [
          name,
          {
            onlyWhiteSpace: sections.filter((section) => /^\s*$/u.test(section))
              .length,
            whole: ink(sections.join("")) === ink(text),
          },
        ];
      })
    );
    expect(shown).toStrictEqual({
      blankLines: { onlyWhiteSpace: 0, whole: true },
      spaces: { onlyWhiteSpace: 0, whole: true },
    });
  });

  it("measures an answer as Slack is sent it, emoji names and all, so none of it is cut", () => {
    const text = "{{emoji:chart_up}} ".repeat((64 * 1024) / 19);
    const sections = answerCards({ locale: "en", text }).flatMap((card) =>
      sectionTexts(card)
    );
    expect({
      lengthened: convertEmojiPlaceholders(text, "slack").length > text.length,
      eachWithin: sections.every((section) => section.length <= 3000),
      whole:
        ink(sections.join("")) === ink(convertEmojiPlaceholders(text, "slack")),
    }).toStrictEqual({ lengthened: true, eachWithin: true, whole: true });
  });

  it("posts an answer too long for one message whole, across messages that each fit Teams and Slack, cut where a paragraph or sentence ends, its thumbs under the last", () => {
    const sentence = "Ein langer Satz über die Rechnungen des Quartals. ";
    const paragraphs = Array.from(
      { length: 40 },
      (_, at) => `${at}. ${sentence.repeat(30 + (at % 7) * 20).trim()}`
    );
    // And one paragraph that is a single sentence too long for any message.
    const text = [...paragraphs, "x".repeat(40_000)].join("\n\n");
    const rate = crypto.randomUUID();
    const cards = answerCards({ locale: "de", text, rate });
    const inSlack = cards.map((card) => sectionTexts(card));
    const teams = cards.map((card) => inTeams(card));
    const shownInTeams = teams.flatMap(({ texts }) => texts).join("");
    const pieces = inSlack.flat();

    expect({
      several: cards.length > 1,
      withinTeams: cards.every(
        (card) =>
          JSON.stringify(withinTeams(card)) === JSON.stringify(allWithin)
      ),
      withinSlack: cards.every((card) => pastSlack(card).length === 0),
      wholeInTeams: ink(shownInTeams) === ink(text),
      wholeInSlack: ink(pieces.join("")) === ink(text),
      // Each piece ends where a sentence or paragraph does, but for the
      // one sentence no message holds.
      cutAtSentences: pieces
        .filter((piece) => !piece.startsWith("x"))
        .every((piece) => piece.trimEnd().endsWith(".")),
      links: teams.flatMap(({ actions }) =>
        actions.filter((action) => action.type === "Action.OpenUrl")
      ),
      thumbs: teams.map(
        ({ actions }) =>
          actions.filter((action) => action.data?.value === rate).length
      ),
    }).toStrictEqual({
      several: true,
      withinTeams: true,
      withinSlack: true,
      wholeInTeams: true,
      wholeInSlack: true,
      cutAtSentences: true,
      links: [],
      thumbs: [...Array.from({ length: cards.length - 1 }, () => 0), 2],
    });
  });

  it("are all within Block Kit's block, text, button and link limits", () => {
    expect(
      Object.fromEntries(
        everyCard.map(({ name, card }) => [name, pastSlack(card)])
      )
    ).toStrictEqual(
      Object.fromEntries(everyCard.map(({ name }) => [name, []]))
    );
  });
});

describe("Stephen's lines", () => {
  it("are in all five languages, naming the same values as the English", () => {
    const differ = lineNames.flatMap((name) =>
      channelLocales
        .filter(
          (locale) =>
            holesIn(name, locale).toSorted().join(",") !==
            holesIn(name, "en").toSorted().join(",")
        )
        .map((locale) => `${name} (${locale})`)
    );
    const empty = lineNames.flatMap((name) =>
      channelLocales
        .filter((locale) => fill(name, locale, values).trim() === "")
        .map((locale) => `${name} (${locale})`)
    );

    expect({ differ, empty }).toStrictEqual({ differ: [], empty: [] });
  });

  it("leave no placeholder when filled in", () => {
    const left = lineNames.flatMap((name) =>
      channelLocales
        .filter((locale) => /[{}]/u.test(fill(name, locale, values)))
        .map((locale) => `${name} (${locale})`)
    );

    expect({
      left,
      heldMany: say("heldMany", "es", values),
    }).toStrictEqual({
      left: [],
      heldMany:
        "Me gustaría hacer estos 3 cambios, en este orden. No pasa nada hasta que los confirmes.",
    });
  });

  it("refuse a line missing a value it names", () => {
    expect(() => fill("checkRecord", "de", { count: 3 })).toThrow(
      "checkRecord"
    );
  });
});

describe("the language of a message", () => {
  it("is the language of its own words, names of systems aside", () => {
    const cases: [string, ChannelLocale][] = [
      ["What's on my calendar tomorrow?", "en"],
      ["Can you send Jan the minutes from Monday?", "en"],
      ["Wat staat er morgen in mijn agenda?", "nl"],
      ["Kun je de Excel van Q3 openen in SharePoint?", "nl"],
      ["Wat is de status van de offerte voor Acme?", "nl"],
      ["Was steht morgen in meinem Kalender?", "de"],
      ["Kannst du mir die Rechnung von Müller schicken?", "de"],
      ["Bitte zeig mir das Excel im SharePoint.", "de"],
      ["Qu'est-ce que j'ai demain dans mon agenda ?", "fr"],
      ["Pouvez-vous envoyer le compte rendu à Jan ?", "fr"],
      ["¿Qué tengo mañana en mi agenda?", "es"],
      ["Envíame el Excel de ventas, por favor", "es"],
      ["que tengo manana", "es"],
      // Words two languages write count for neither.
      ["Wie geht es dir?", "de"],
      ["Summarize AI news", "en"],
      ["Meeting Mon 3pm", "en"],
      // Letters in names don't outweigh the words around them.
      ["Show me the report from Jörg Müller", "en"],
      ["Send the Dijkstra file to Jan", "en"],
    ];

    expect(cases.map(([text]) => [text, languageOf(text, "en")])).toStrictEqual(
      cases
    );
  });

  it("stays what it was when the words don't tell", () => {
    expect(
      [
        "👍",
        "ok",
        "Thanks!",
        "SharePoint",
        "Q3",
        "",
        "Jan de Vries",
        "Jörg Müller",
      ].map((text) => languageOf(text, "nl"))
    ).toStrictEqual(["nl", "nl", "nl", "nl", "nl", "nl", "nl", "nl"]);
  });
});
