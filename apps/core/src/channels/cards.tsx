import {
  Actions,
  Button,
  Card,
  CardText,
  Field,
  Fields,
  LinkButton,
  Section,
  toCardElement,
} from "chat";
import type { CardElement, PostableCard } from "chat";
import type { Root, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { z } from "zod";

import { say } from "./words.ts";
import type { ChannelLocale, LineName } from "./words.ts";

// What Stephen sends in a chat app, written once as Chat SDK cards: each
// adapter renders a card natively (an Adaptive Card in Teams, Block Kit in
// Slack), with a text fallback where there is none. The words are his
// lines (words.ts), in the person's language. A press on a button reaches
// the channel layer as `onAction` with the button's id and value.
//
// A card holds what other people wrote: an answer, a document's title, the
// values of a change. Each platform caps what one message may carry, and a
// card over the cap is refused whole, so the cards measure that text as
// they put it on and stop before the cap. An answer too long for one
// message goes whole, over as many as it takes (`answerCards`). A card of
// held writes never asks for a press on values it couldn't show in full.
// Nothing on a card links to the conversation in Grasp: a chat app's
// conversation is no chat there (GRA-1919).

/**
 * How much text from outside Grasp one card carries, in bytes as JSON
 * (UTF-8, escapes included): the rest of Teams' 28 KB for a card is left
 * for Stephen's own lines and the card's structure. Slack's limits are
 * checked with its adapter (GRA-751).
 */
const outsideBytes = 16 * 1024;

/**
 * The most characters of text in one section of a card: Slack's limit for
 * a section's text in Block Kit, past which its adapter cuts it
 * (`SECTION_TEXT_MAX_CHARS`). Its conversions (bold, emoji) only shorten.
 */
const sectionChars = 3000;

/** The most held writes one card shows; more can't be confirmed on it. */
export const maxWritesOnCard = 10;

/** The most values one held write shows; more can't be confirmed on it. */
export const maxValuesPerWrite = 10;

/** The longest a title, a label or a link may be on a card, in characters. */
const maxTitleChars = 200;
const maxLabelChars = 100;
const maxUrlChars = 2048;

const encoder = new TextEncoder();

/** What a text adds to a card's JSON, in bytes. */
const sizeOf = (text: string): number =>
  encoder.encode(JSON.stringify(text)).length - 2;

const ellipsis = "…";

/** The outside text a card has room for, spent as it is put on. */
interface Room {
  left: number;
}

/** A text as it fits, and whether that is all of it. */
interface Fitted {
  text: string;
  whole: boolean;
}

/**
 * As much of `text` as fits in `maxChars` characters and the room left,
 * cut at a whole character and marked with an ellipsis when cut.
 */
const fit = (text: string, maxChars: number, room: Room): Fitted => {
  const mark = sizeOf(ellipsis);
  let taken = "";
  let chars = 0;
  let spent = 0;
  for (const character of text) {
    const cost = sizeOf(character);
    if (chars === maxChars || spent + cost > room.left - mark) {
      room.left -= spent + mark;
      return { text: `${taken}${ellipsis}`, whole: false };
    }
    taken += character;
    chars += 1;
    spent += cost;
  }
  room.left -= spent;
  return { text: taken, whole: true };
};

/**
 * A link's address when a card may carry it: https only, and short enough
 * to send whole (a cut address leads nowhere).
 */
const linkable = (url: string): string | null => {
  if (url.length > maxUrlChars || !URL.canParse(url)) {
    return null;
  }
  return new URL(url).protocol === "https:" ? url : null;
};

/** Grasp's own address on a card: always https. */
const ownLink = (url: string): string => {
  const address = linkable(url);
  if (address === null) {
    throw new Error("A card links only to Grasp's own https address");
  }
  return address;
};

/** The card as each adapter takes it. */
const cardOf = (element: unknown): CardElement => {
  const card = toCardElement(element);
  if (card === null) {
    throw new Error("Not a card");
  }
  return card;
};

/** An answer, as a chat app shows it. */
export interface AnswerCard {
  locale: ChannelLocale;
  /** The answer, in Markdown. */
  text: string;
  /**
   * The request the answer is for (stephen-requests.ts), where the person
   * can rate it with a thumb: Helpful or Not helpful.
   */
  rate?: string | undefined;
}

/** A thumb on an answer, by the request it is for (stephen-requests.ts). */
export const helpfulAction = "answer.helpful";
export const notHelpfulAction = "answer.not_helpful";

/** Helpful and Not helpful, under an answer that is a request's. */
const RateButtons = ({
  locale,
  rate,
}: {
  locale: ChannelLocale;
  rate: string | undefined;
}) =>
  rate === undefined
    ? null
    : [
        <Button id={helpfulAction} key="up" value={rate}>
          {`👍 ${say("helpful", locale)}`}
        </Button>,
        <Button id={notHelpfulAction} key="down" value={rate}>
          {`👎 ${say("notHelpful", locale)}`}
        </Button>,
      ];

/** Whether a piece of an answer fits one section of a card. */
const fitsSection = (piece: string): boolean =>
  piece.length <= sectionChars && sizeOf(piece) <= outsideBytes;

/**
 * A piece of an answer: `text`, exactly as the answer has it, so the
 * pieces joined are the answer; and, for a cut inside fenced code, the
 * fence's opening line it reopens with (`opens`) and the marker it closes
 * with (`closes`), so each piece shows as code where it is code.
 */
export interface AnswerPiece {
  text: string;
  opens: string;
  closes: string;
}

/** A fenced code block of an answer: where its code starts and it ends. */
interface Fence {
  /** Where its code starts, past its opening line. */
  code: number;
  end: number;
  /** Its opening line, as written, with the line's end. */
  opening: string;
  /** What closes it: its opening's run of backticks or tildes. */
  marker: string;
}

/** The fenced code blocks of `text`, as CommonMark reads it (mdast). */
const fencesOf = (text: string): Fence[] => {
  const fences: Fence[] = [];
  const walk = (node: Root | RootContent): void => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (node.type === "code" && start !== undefined && end !== undefined) {
      const line = text.slice(start, text.indexOf("\n", start) + 1 || end);
      // Indented code has no fence, and nothing to close.
      const marker = /^(?:`{3,}|~{3,})/u.exec(line.trimStart())?.[0];
      if (marker !== undefined && line.endsWith("\n")) {
        fences.push({ code: start + line.length, end, opening: line, marker });
      }
    }
    if ("children" in node) {
      for (const child of node.children) {
        walk(child);
      }
    }
  };
  walk(fromMarkdown(text));
  return fences;
};

/** Where a paragraph ends: a blank line, and any more after it. */
const paragraphBreaks = /\n[^\S\n]*\n(?:[^\S\n]*\n)*/gu;

/**
 * `text` in pieces that each fit a section, untouched when it fits one,
 * cut where a reader pauses: after a paragraph's blank lines, else between
 * sentences (`Intl.Segmenter`, in the person's language), else, for a
 * sentence no section holds, between characters (graphemes). Every
 * character stays where it was: the pieces' `text` joined is `text`. A cut
 * inside fenced code closes the fence and reopens it in the next piece.
 */
export const piecesOf = (
  text: string,
  locale: ChannelLocale
): AnswerPiece[] => {
  if (fitsSection(text)) {
    return [{ text, opens: "", closes: "" }];
  }
  const fences = fencesOf(text);
  const fenceAt = (cut: number) =>
    fences.find(({ code, end }) => cut > code && cut < end);
  const paragraphs = Array.from(
    text.matchAll(paragraphBreaks),
    (match) => match.index + match[0].length
  );
  const segmenters = (["sentence", "grapheme"] as const).map(
    (granularity) => new Intl.Segmenter(locale, { granularity })
  );
  const pieces: AnswerPiece[] = [];
  let start = 0;
  let opens = "";
  while (start < text.length) {
    const from = start;
    const opening = opens;
    /** The piece from here to `cut`, if it fits a section. */
    const pieceTo = (cut: number): AnswerPiece | undefined => {
      const fence = fenceAt(cut);
      const piece = text.slice(from, cut);
      const closes =
        fence === undefined
          ? ""
          : `${piece.endsWith("\n") ? "" : "\n"}${fence.marker}`;
      return fitsSection(`${opening}${piece}${closes}`)
        ? { text: piece, opens: opening, closes }
        : undefined;
    };
    const last = pieceTo(text.length);
    if (last !== undefined) {
      pieces.push(last);
      break;
    }
    // Where each kind of cut could fall, in the stretch a section holds.
    const window = text.slice(from, from + sectionChars + 1);
    const within = (cut: number) => cut > from && cut < from + window.length;
    const cuts = [
      paragraphs.filter(within),
      ...segmenters.map((segmenter) =>
        Array.from(
          segmenter.segment(window),
          ({ index }) => from + index
        ).filter(within)
      ),
    ];
    let found: { cut: number; piece: AnswerPiece } | undefined;
    for (const candidates of cuts) {
      for (const cut of candidates.toReversed()) {
        const piece = pieceTo(cut);
        if (piece !== undefined) {
          found = { cut, piece };
          break;
        }
      }
      if (found !== undefined) {
        break;
      }
    }
    if (found === undefined) {
      throw new Error("No piece of the answer fits a section");
    }
    pieces.push(found.piece);
    start = found.cut;
    opens = fenceAt(start)?.opening ?? "";
  }
  return pieces;
};

/**
 * An answer, labelled as made by AI where the platform has a label for it
 * (Teams), whole: as many cards as it takes, each within what the platform
 * takes in one message, its text cut only where a paragraph or a sentence
 * ends (`piecesOf`), in order, and the thumbs under the last.
 */
export const answerCards = ({
  locale,
  text,
  rate,
}: AnswerCard): PostableCard[] => {
  const cards: string[][] = [];
  let room = 0;
  for (const { opens, text: piece, closes } of piecesOf(text, locale)) {
    const shown = `${opens}${piece}${closes}`;
    const cost = sizeOf(shown);
    const last = cards.at(-1);
    if (last === undefined || cost > room) {
      cards.push([shown]);
      room = outsideBytes - cost;
      continue;
    }
    last.push(shown);
    room -= cost;
  }
  return cards.map((pieces, at) => {
    const thumbs = at === cards.length - 1 && rate !== undefined;
    const card = (
      <Card>
        {pieces.map((piece, index) => (
          <CardText key={index}>{piece}</CardText>
        ))}
        {thumbs ? <Actions>{RateButtons({ locale, rate })}</Actions> : null}
      </Card>
    );
    return { card: cardOf(card), aiGenerated: true };
  });
};

/**
 * The thumbs for an answer the person saw streamed as text, sent right
 * after it, labelled as made by AI like the answer.
 */
export const ratingCard = ({
  locale,
  rate,
}: Pick<AnswerCard, "locale" | "rate">): PostableCard => {
  const card = (
    <Card>
      <Actions>{RateButtons({ locale, rate })}</Actions>
    </Card>
  );
  return { card: cardOf(card), aiGenerated: true };
};

/** Where a held write is: waiting for the press, or as the press ran it. */
export type WriteState =
  | "held"
  | "running"
  | "done"
  | "failed"
  | "unknown"
  | "skipped";

/** A held write, as the person sees it before it runs. */
export interface HeldWriteView {
  /** Its id in connect's held writes. */
  id: string;
  /** The hash of its exact input, which a press confirms. */
  inputHash: string;
  /** What it does, in the person's words. */
  title: string;
  /** Its exact values, as its connector describes them. */
  values: readonly { label: string; value: string }[];
  state: WriteState;
}

/**
 * What the turn read that other people wrote, which the card warns about:
 * mail, or a company record named by where it is.
 */
export type ReadCheck = { read: "mail" } | { read: "record"; where: string };

/** How a press ended, said once at the foot of the card. */
export type PressOutcome = Extract<
  LineName,
  | "allDone"
  | "cancelled"
  | "stopped"
  | "unknownOutcome"
  | "expired"
  | "changedSince"
>;

/** A turn's held writes on one card. */
export interface HeldWritesCard {
  locale: ChannelLocale;
  /** In the order they run. */
  writes: readonly HeldWriteView[];
  check?: ReadCheck;
  /** Set once the press has ended; the card is edited in place. */
  outcome?: PressOutcome;
}

/** The buttons' action ids, for the channel layer's `onAction`. */
export const confirmAction = "held-writes.confirm";
export const cancelAction = "held-writes.cancel";

/** What a press on the card's buttons carries: exactly the writes it showed. */
const pressSchema = z
  .array(
    z.object({ id: z.string().min(1), inputHash: z.string().min(1) }).strict()
  )
  .min(1)
  .max(maxWritesOnCard);
export type Press = z.infer<typeof pressSchema>;

/**
 * The writes a press names, from its button's value, or null when the
 * value isn't one a card of held writes carries.
 */
export const pressOf = (value?: string): Press | null => {
  if (value === undefined) {
    return null;
  }
  try {
    const parsed = pressSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

const stateLines = {
  running: "stepRunning",
  done: "stepDone",
  failed: "stepFailed",
  unknown: "stepUnknown",
  skipped: "stepSkipped",
} as const satisfies Record<Exclude<WriteState, "held">, LineName>;

/** The card's warning about what the turn read, in the person's language. */
const checkLine = (check: ReadCheck, locale: ChannelLocale, room: Room) =>
  check.read === "mail"
    ? say("checkMail", locale)
    : say("checkRecord", locale, {
        where: fit(check.where, maxTitleChars, room).text,
      });

/**
 * A turn's held writes on one card, in the order they run, each with its
 * exact values; nothing runs until the person presses Confirm. Confirm and
 * Cancel carry the writes' ids and input hashes, so a press confirms
 * exactly what the card showed. They are on the card only while every
 * write is held and every value is on it whole: otherwise the card says
 * it can't be confirmed, and to ask for fewer changes at a time.
 */
export const heldWritesCard = ({
  locale,
  writes,
  check,
  outcome,
}: HeldWritesCard): PostableCard => {
  if (writes.length === 0) {
    throw new Error("A card of held writes needs at least one write");
  }
  const room: Room = { left: outsideBytes };
  const shown = writes.slice(0, maxWritesOnCard);
  const press = JSON.stringify(
    shown.map(({ id, inputHash }) => ({ id, inputHash }))
  );
  room.left -= sizeOf(press);
  const warning = check === undefined ? null : checkLine(check, locale, room);
  let whole = shown.length === writes.length;
  const steps = shown.map((write, index) => {
    const title = fit(write.title, maxTitleChars, room);
    const values = write.values.slice(0, maxValuesPerWrite).map((each) => {
      const label = fit(each.label, maxLabelChars, room);
      const value = fit(each.value, Number.POSITIVE_INFINITY, room);
      whole &&= label.whole && value.whole;
      return { label: label.text, value: value.text };
    });
    whole &&= title.whole && values.length === write.values.length;
    return { write, number: index + 1, title: title.text, values };
  });
  const pressable =
    whole &&
    outcome === undefined &&
    writes.every((write) => write.state === "held");
  const card = (
    <Card>
      <CardText>
        {writes.length === 1
          ? say("heldOne", locale)
          : say("heldMany", locale, { count: writes.length })}
      </CardText>
      {warning === null ? null : <CardText style="bold">{warning}</CardText>}
      {steps.map(({ write, number, title, values }) => (
        <Section key={write.id}>
          <CardText style="bold">{`${number}. ${title}`}</CardText>
          {values.length === 0 ? null : (
            <Fields>
              {values.map(({ label, value }, at) => (
                <Field key={`${write.id}.${at}`} label={label} value={value} />
              ))}
            </Fields>
          )}
          {write.state === "held" ? null : (
            <CardText style="muted">
              {say(stateLines[write.state], locale)}
            </CardText>
          )}
        </Section>
      ))}
      {whole ? null : <CardText>{say("cardTooLong", locale)}</CardText>}
      {outcome === undefined ? null : (
        <CardText style="bold">{say(outcome, locale)}</CardText>
      )}
      {pressable ? (
        <Actions>
          <Button id={confirmAction} style="primary" value={press}>
            {say("confirm", locale)}
          </Button>
          <Button id={cancelAction} value={press}>
            {say("cancel", locale)}
          </Button>
        </Actions>
      ) : null}
    </Card>
  );
  return { card: cardOf(card) };
};

/**
 * For someone Grasp hasn't seen yet: one sign-in to Grasp, after which
 * their next message is answered.
 */
export const signInCard = ({
  locale,
  url,
  line = "signIn",
}: {
  locale: ChannelLocale;
  url: string;
  /** What it says above the button: `signInAskAgain` where nothing was kept. */
  line?: "signIn" | "signInAskAgain";
}): PostableCard => ({
  card: cardOf(
    <Card>
      <CardText>{say(line, locale)}</CardText>
      <Actions>
        <LinkButton style="primary" url={ownLink(url)}>
          {say("signInButton", locale)}
        </LinkButton>
      </Actions>
    </Card>
  ),
});

/**
 * A member's own Microsoft 365, to connect or sign in to again
 * (connect-own.ts): a button to the deployment's own page that starts
 * connect's sign-in for whoever is signed in there. The link carries
 * nothing of theirs: the flow finishes only for the person who started it.
 */
export const connectOwnCard = ({
  locale,
  url,
  reconnect,
}: {
  locale: ChannelLocale;
  url: string;
  reconnect: boolean;
}): PostableCard => ({
  card: cardOf(
    <Card>
      <CardText>
        {say(reconnect ? "reconnectOwn" : "connectOwn", locale)}
      </CardText>
      <Actions>
        <LinkButton style="primary" url={ownLink(url)}>
          {say("connectOwnButton", locale)}
        </LinkButton>
      </Actions>
    </Card>
  ),
});

/** The Start button's action id, for the channel layer's `onAction`. */
export const startAction = "workflow.start";

/** A workflow Stephen offers to start, as the person sees it first. */
export interface StartOfferCard {
  locale: ChannelLocale;
  /** Its id in `chat_workflow_offers`, which the press names. */
  offerId: string;
  workflow: string;
  /** The values it starts with, each whole (workflow-offers.ts). */
  values: readonly { label: string; value: string }[];
}

/**
 * A workflow offered on a card: its name, each value it would start with,
 * and Start, whose press names only the offer, so it starts exactly what
 * the card showed, and only for the person it was offered to.
 */
export const startOfferCard = ({
  locale,
  offerId,
  workflow,
  values,
}: StartOfferCard): PostableCard => {
  const room: Room = { left: outsideBytes };
  const name = fit(workflow, maxTitleChars, room).text;
  const shown = values.map((each) => ({
    label: fit(each.label, maxLabelChars, room).text,
    value: fit(each.value, Number.POSITIVE_INFINITY, room).text,
  }));
  const card = (
    <Card>
      <CardText>{say("startOffer", locale, { workflow: name })}</CardText>
      {shown.length === 0 ? null : (
        <Fields>
          {shown.map(({ label, value }, at) => (
            <Field key={`${offerId}.${at}`} label={label} value={value} />
          ))}
        </Fields>
      )}
      <Actions>
        <Button id={startAction} style="primary" value={offerId}>
          {say("startButton", locale)}
        </Button>
      </Actions>
    </Card>
  );
  return { card: cardOf(card), aiGenerated: true };
};
