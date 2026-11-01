import { cardToBlockKit } from "@chat-adapter/slack";
import { cardToAdaptiveCard } from "@chat-adapter/teams/cards";
import type { TeamsCardElement } from "@chat-adapter/teams/cards";
import type { CardChild, CardElement, PostableCard } from "chat";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import {
  answerCard,
  cancelAction,
  confirmAction,
  heldWritesCard,
  maxSources,
  maxValuesPerWrite,
  maxWritesOnCard,
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
  {
    name: `answer (${locale})`,
    card: answerCard({
      locale,
      text: "You have a call with Jan at 10:00. [Source 1]",
      sources: [{ title: "Calls.docx", url: `${grasp}/knowledge/calls` }],
      chatUrl: `${grasp}/chat/1`,
    }),
  },
  {
    name: `largest answer (${locale})`,
    card: answerCard({
      locale,
      text: heavy(200_000),
      sources: Array.from({ length: maxSources + 5 }, (_, index) => ({
        title: heavy(5000),
        url: `${grasp}/knowledge/${index}/${"a".repeat(2000)}`,
      })),
      chatUrl: `${grasp}/chat/${"a".repeat(2000)}`,
    }),
  },
  {
    name: `one held write (${locale})`,
    card: heldWritesCard({
      locale,
      writes: [write(1)],
      openUrl: `${grasp}/held`,
    }),
  },
  {
    name: `largest held writes (${locale})`,
    card: heldWritesCard({
      locale,
      writes: largest(),
      check: { read: "record", where: heavy(5000) },
      openUrl: `${grasp}/held/${"a".repeat(2000)}`,
    }),
  },
  ...outcomes.map((outcome) => ({
    name: `largest held writes, ${outcome} (${locale})`,
    card: heldWritesCard({
      locale,
      writes: largest("unknown"),
      check: { read: "mail" },
      openUrl: `${grasp}/held/${"a".repeat(2000)}`,
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
      heldWritesCard({ locale: "nl", writes, openUrl: `${grasp}/held` })
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
        {
          type: "Action.OpenUrl",
          title: "Openen in Grasp",
          action: undefined,
          press: null,
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
        sendsToGrasp: texts.includes(say("cardTooLong", "de")),
      };
    };
    const openUrl = `${grasp}/held`;

    expect({
      tooLong: pressesOf(
        heldWritesCard({
          locale: "de",
          writes: [write(1, { value: "x".repeat(20_000) })],
          openUrl,
        })
      ),
      tooMany: pressesOf(
        heldWritesCard({
          locale: "de",
          writes: Array.from({ length: maxWritesOnCard + 1 }, (_, index) =>
            write(index)
          ),
          openUrl,
        })
      ),
      running: pressesOf(
        heldWritesCard({
          locale: "de",
          writes: [write(1, { state: "done" }), write(2, { state: "running" })],
          openUrl,
        })
      ),
      ended: pressesOf(
        heldWritesCard({
          locale: "de",
          writes: [write(1)],
          openUrl,
          outcome: "expired",
        })
      ),
    }).toStrictEqual({
      tooLong: { presses: 0, sendsToGrasp: true },
      tooMany: { presses: 0, sendsToGrasp: true },
      running: { presses: 0, sendsToGrasp: false },
      ended: { presses: 0, sendsToGrasp: false },
    });
  });

  it("links an answer's sources only to https addresses, numbered", () => {
    const { texts } = inTeams(
      answerCard({
        locale: "fr",
        text: "Voici la réponse.",
        sources: [
          { title: "Calls [draft]", url: `${grasp}/knowledge/calls` },
          { title: "Trap", url: ["javascript", "alert(1)"].join(":") },
        ],
        chatUrl: `${grasp}/chat/1`,
      })
    );

    expect(texts).toStrictEqual([
      "Voici la réponse.",
      "Sources",
      `[1. Calls draft](${grasp}/knowledge/calls)`,
      "2. Trap",
    ]);
  });

  it("cuts an answer too long for Teams and links to the whole of it in Grasp", () => {
    const text = "Ein langer Satz über die Rechnungen. ".repeat(2000);
    const { texts, actions } = inTeams(
      answerCard({
        locale: "de",
        text,
        sources: [],
        chatUrl: `${grasp}/chat/1`,
      })
    );
    const [shown = ""] = texts;

    expect({
      cut: shown.length < text.length && shown.endsWith("…"),
      says: texts.includes(say("answerTooLong", "de")),
      links: actions.map(({ title, url }) => ({ title, url })),
    }).toStrictEqual({
      cut: true,
      says: true,
      links: [{ title: "In Grasp öffnen", url: `${grasp}/chat/1` }],
    });
  });

  it("links to the answer in Grasp when it lists only some of its sources", () => {
    const { texts, actions } = inTeams(
      answerCard({
        locale: "en",
        text: "Here is the answer.",
        sources: Array.from({ length: maxSources + 1 }, (_, index) => ({
          title: `Doc ${index + 1}`,
          url: `${grasp}/knowledge/${index}`,
        })),
        chatUrl: `${grasp}/chat/1`,
      })
    );

    expect({
      listed: texts.filter((text) => text.startsWith("[")).length,
      links: actions.map(({ url }) => url),
    }).toStrictEqual({ listed: maxSources, links: [`${grasp}/chat/1`] });
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

describe("Stephen's cards in Slack", () => {
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
