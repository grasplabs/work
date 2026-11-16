import type { ChatSavedMemory } from "@grasp-os/shared/brain-memories";
import { shownVisibly } from "@grasp-os/shared/chat";
import {
  convertEmojiPlaceholders,
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
import { z } from "zod";

import { inertOn } from "./inert.ts";
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
 * (`SECTION_TEXT_MAX_CHARS`). Measured on what Slack is sent: its adapter
 * names emoji in full (`{{emoji:chart_up}}` becomes
 * `:chart_with_upwards_trend:`), which lengthens a text; its bold only
 * shortens one.
 */
const sectionChars = 3000;

/**
 * The most blocks Slack takes in one message (Block Kit: "You can include
 * up to 50 blocks in each message"), past which it refuses the message
 * whole. An answer's card is a section per piece and, under the last, one
 * actions block of thumbs: a card holds one section fewer than this.
 */
const slackBlocksPerMessage = 50;

/**
 * The most characters of a field's label and value together on Slack, as
 * its adapter measures them before it cuts one (`FIELD_TEXT_MAX_CHARS`,
 * 2,000, less the 3 its `*label*` and line break take): Block Kit's limit
 * for a section's field.
 */
const slackFieldChars = 2000 - 3;

/**
 * The most characters a button's value carries: Block Kit's limit for a
 * button's `value`, past which Slack refuses the message. A press names
 * its card's writes in it, so a card names no more than fit (Teams has no
 * smaller limit, and a card is held to both).
 */
const buttonValueChars = 2000;

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
  /** The answer, in Markdown, as the model wrote it. */
  text: string;
  /** The platform it goes to, whose own syntax its pieces are made inert in. */
  platform: string;
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

/**
 * What a piece of an answer is on `platform`, as its card carries it: made
 * inert (inert.ts), which can make it longer (Slack's `&` is `&amp;`), and
 * that again as the adapter names its emoji in it. A piece is cut from the
 * answer as the model wrote it and measured as these, never cut from the
 * inert text, where a cut could part an escape such as `&lt;`.
 */
const sentOn =
  (platform: string) =>
  (piece: string): readonly string[] => {
    const inert = inertOn(platform)(piece);
    return [
      inert,
      convertEmojiPlaceholders(inert, platform === "slack" ? "slack" : "teams"),
    ];
  };

/** Whether every form a piece is sent in fits one section of a card. */
const fitsSection = (forms: readonly string[]): boolean =>
  forms.every(
    (form) => form.length <= sectionChars && sizeOf(form) <= outsideBytes
  );

/** What a piece costs a card, in bytes as JSON, in the largest form it is sent in. */
const costOf = (forms: readonly string[]): number =>
  Math.max(...forms.map((form) => sizeOf(form)));

/** Where UTF-16 keeps the second half of a surrogate pair. */
const lowSurrogates = { from: 0xdc_00, to: 0xdf_ff };

/** Whether a piece starting at `at` would part a surrogate pair. */
const partsPair = (text: string, at: number): boolean => {
  // At the second half of a pair, its own value: a lone low surrogate.
  const unit = text.codePointAt(at) ?? 0;
  return unit >= lowSurrogates.from && unit <= lowSurrogates.to;
};

/**
 * An emoji placeholder, as the Chat SDK writes and converts one: a copy of
 * its `EMOJI_PLACEHOLDER_REGEX`, which it doesn't export, flags and all
 * (channels-cards.test.ts holds it to the SDK's own conversion). Never cut
 * inside, or both halves show as text.
 */
// oxlint-disable-next-line require-unicode-regexp -- the SDK's own flags, exactly
export const emojiPlaceholders = /\{\{emoji:[a-z0-9_]+\}\}/gi;

/**
 * For each position of `text`, whether a cut there would part a placeholder
 * that fits a section in each form it is sent in (`sent`). One too long for
 * a section is no emoji anyone sees whole: it is cut like any text, so its
 * pieces are full-size, never a character each.
 */
const insidePlaceholders = (
  text: string,
  sent: (piece: string) => readonly string[]
): Uint8Array => {
  const inside = new Uint8Array(text.length + 1);
  for (const match of text.matchAll(emojiPlaceholders)) {
    if (fitsSection(sent(match[0]))) {
      inside.fill(1, match.index + 1, match.index + match[0].length);
    }
  }
  return inside;
};

/** A piece of nothing but white space. */
const onlyWhiteSpace = /^\s+$/u;

/** Where a paragraph ends: a blank line, and any more after it. */
const paragraphBreaks = /\n[^\S\n]*\n(?:[^\S\n]*\n)*/gu;

/** The largest of ascending `cuts` the piece from its start to fits a section. */
const largestFitting = (
  cuts: readonly number[],
  fits: (cut: number) => boolean
): number | undefined => {
  let low = 0;
  let high = cuts.length - 1;
  let found: number | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const cut = cuts[middle];
    if (cut !== undefined && fits(cut)) {
      found = cut;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
};

/**
 * `text` in pieces that each fit a section, untouched when it fits one,
 * each an exact slice of it, so the pieces joined are `text`, never one
 * empty. Cut where a reader pauses: after a paragraph's blank lines, else
 * between sentences (`Intl.Segmenter`, in the person's language), else
 * between characters (graphemes), else, inside a character cluster no
 * section holds, between code points. Each piece reads at most a section's
 * stretch of the text, so the work grows with the text alone, whatever it
 * holds. Fenced code is not repaired: Slack, which shows fences, reads them
 * its own way, and a block longer than a section is cut like any text.
 * Each piece is measured as `platform` is sent it (`sentOn`).
 */
export const piecesOf = (
  text: string,
  locale: ChannelLocale,
  platform: string
): string[] => {
  const sent = sentOn(platform);
  if (fitsSection(sent(text))) {
    return [text];
  }
  const paragraphs = Array.from(
    text.matchAll(paragraphBreaks),
    (match) => match.index + match[0].length
  );
  const segmenters = (["sentence", "grapheme"] as const).map(
    (granularity) => new Intl.Segmenter(locale, { granularity })
  );
  const parts = insidePlaceholders(text, sent);
  const whole = (cut: number) => parts[cut] !== 1;
  const pieces: string[] = [];
  let start = 0;
  let paragraph = 0;
  while (start < text.length) {
    const from = start;
    if (
      text.length - from <= sectionChars &&
      fitsSection(sent(text.slice(from)))
    ) {
      pieces.push(text.slice(from));
      break;
    }
    // The stretch a section could hold, and where each kind of cut falls.
    const window = text.slice(from, from + sectionChars);
    const fits = (cut: number) => fitsSection(sent(text.slice(from, cut)));
    while ((paragraphs[paragraph] ?? Number.POSITIVE_INFINITY) <= from) {
      paragraph += 1;
    }
    const byParagraph: number[] = [];
    for (let at = paragraph; at < paragraphs.length; at += 1) {
      const cut = paragraphs[at] ?? Number.POSITIVE_INFINITY;
      if (cut > from + window.length) {
        break;
      }
      byParagraph.push(cut);
    }
    // A stretch that ends before the text does may end inside a sentence
    // or a character cluster, which then seems to start where it was
    // parted: the last start found is the one the stretch's end can fake.
    const truncated = from + window.length < text.length;
    const bySegment = segmenters.map((segmenter) => {
      const starts = Array.from(
        segmenter.segment(window),
        ({ index }) => from + index
      );
      return (truncated ? starts.slice(0, -1) : starts).filter(
        (cut) => cut > from && whole(cut)
      );
    });
    // Never between the halves of a surrogate pair, which the stretch's
    // end may part.
    const byCodePoint: number[] = [];
    let at = from;
    for (const point of window) {
      at += point.length;
      if (!partsPair(text, at) && whole(at)) {
        byCodePoint.push(at);
      }
    }
    // A single code point always fits a section: the last resort can't fail.
    const cut =
      [byParagraph, ...bySegment, byCodePoint]
        .map((cuts) => largestFitting(cuts, fits))
        .find((found) => found !== undefined) ??
      from + (byCodePoint[0] === undefined ? 1 : byCodePoint[0] - from);
    pieces.push(text.slice(from, cut));
    start = cut;
  }
  return pieces;
};

/**
 * An answer, labelled as made by AI where the platform has a label for it
 * (Teams), whole and inert on `platform`: as many cards as it takes, each
 * within what the platform takes in one message, its text cut as the model
 * wrote it, only where a paragraph or a sentence ends (`piecesOf`), each
 * piece made inert after the cut (inert.ts), in order, and the thumbs under
 * the last.
 */
export const answerCards = ({
  locale,
  text,
  platform,
  rate,
}: AnswerCard): PostableCard[] => {
  const sent = sentOn(platform);
  const inert = inertOn(platform);
  const cards: string[][] = [];
  let room = 0;
  for (const piece of piecesOf(text, locale, platform)) {
    // Only white space where a cut fell before blank lines: nothing to show,
    // and a section of nothing else Slack may refuse.
    if (onlyWhiteSpace.test(piece)) {
      continue;
    }
    const cost = costOf(sent(piece));
    const last = cards.at(-1);
    if (
      last === undefined ||
      cost > room ||
      last.length >= slackBlocksPerMessage - 1
    ) {
      cards.push([inert(piece)]);
      room = outsideBytes - cost;
      continue;
    }
    last.push(inert(piece));
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
 * An answer still being written, as its card shows it until the answer
 * is whole (answer.ts): its words so far, labelled as made by AI, and the
 * words the card shows of them. Text past what the platform takes is cut.
 */
export const draftCard = (
  text: string
): { posted: PostableCard; shown: string } => {
  const { text: shown } = fit(text, Number.POSITIVE_INFINITY, {
    left: outsideBytes,
  });
  const card = (
    <Card>
      <CardText>{shown}</CardText>
    </Card>
  );
  return { posted: { card: cardOf(card), aiGenerated: true }, shown };
};

/** One of Stephen's lines on a card of its own. */
export const lineCard = (line: string): PostableCard => ({
  card: cardOf(
    <Card>
      <CardText>{line}</CardText>
    </Card>
  ),
});

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
  /** Its id in connect's held writes, or in the chat's held App calls. */
  id: string;
  /** The hash of its exact input, which a press confirms. */
  inputHash: string;
  /**
   * For a write to an App (held-app-calls.ts): the chat it is held in,
   * which a press decides it in. It is held because the chat used
   * something only its person can read, which its card says. None for
   * connect's.
   */
  chatId?: string;
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
  /** The platform it goes to, whose limits say what it shows whole. */
  platform: string;
  /** In the order they run. */
  writes: readonly HeldWriteView[];
  check?: ReadCheck;
  /** Set once the press has ended; the card is edited in place. */
  outcome?: PressOutcome;
  /**
   * Writes this turn's cards can't confirm (`heldWritesCards`), so Cancel
   * alone: `later`, each shown whole but asked after one the card to
   * confirm couldn't take, so none runs ahead of the order asked; `tooLong`,
   * each too long for any card to show whole.
   */
  cancelOnly?: "later" | "tooLong";
}

/** The buttons' action ids, for the channel layer's `onAction`. */
export const confirmAction = "held-writes.confirm";
export const cancelAction = "held-writes.cancel";

/**
 * What a press on the card's buttons carries: exactly the writes it
 * showed, a write to an App with the chat it is held in.
 */
const pressSchema = z
  .array(
    z
      .object({
        id: z.string().min(1),
        inputHash: z.string().min(1),
        chatId: z.string().min(1).optional(),
      })
      .strict()
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

/**
 * Whether a field of `label` and `value` shows whole on `platform`: on
 * Slack within a field's characters, measured as its adapter is sent them
 * (emoji named in full, which lengthens a text; its bold only shortens
 * one). Teams cuts no field; the card's own budget holds there.
 */
const fieldWhole = (platform: string, label: string, value: string) =>
  platform !== "slack" ||
  convertEmojiPlaceholders(label, "slack").length +
    convertEmojiPlaceholders(value, "slack").length <=
    slackFieldChars;

/** The card's warning about what the turn read, in the person's language. */
const checkLine = (check: ReadCheck, locale: ChannelLocale, room: Room) =>
  check.read === "mail"
    ? say("checkMail", locale)
    : say("checkRecord", locale, {
        where: fit(check.where, maxTitleChars, room).text,
      });

/** What a press on a card of `writes` carries: each write's id and hash, a write to an App's with its chat. */
const pressOfWrites = (writes: readonly HeldWriteView[]): string =>
  JSON.stringify(
    writes.map(({ id, inputHash, chatId }) =>
      chatId === undefined ? { id, inputHash } : { id, inputHash, chatId }
    )
  );

/**
 * `writes` as a card on `platform` lays them out, in `locale`, within the
 * card's room: what it shows of each, what a press carries (the writes it
 * shows, a write to an App's with its chat), and whether every write is on
 * it with every value whole, as `platform` shows it (`whole`).
 */
const laidOut = ({
  locale,
  platform,
  writes,
  check,
}: Pick<HeldWritesCard, "locale" | "platform" | "writes" | "check">) => {
  const room: Room = { left: outsideBytes };
  const shown = writes.slice(0, maxWritesOnCard);
  const press = pressOfWrites(shown);
  // A press that names more than a button carries can't be on the card.
  const pressFits = press.length <= buttonValueChars;
  room.left -= sizeOf(press);
  const warning = check === undefined ? null : checkLine(check, locale, room);
  let whole = shown.length === writes.length && pressFits;
  const steps = shown.map((write, index) => {
    const title = fit(write.title, maxTitleChars, room);
    const values = write.values.slice(0, maxValuesPerWrite).map((each) => {
      const label = fit(each.label, maxLabelChars, room);
      const value = fit(each.value, Number.POSITIVE_INFINITY, room);
      whole &&=
        label.whole &&
        value.whole &&
        fieldWhole(platform, label.text, value.text);
      return { label: label.text, value: value.text };
    });
    whole &&= title.whole && values.length === write.values.length;
    return { write, number: index + 1, title: title.text, values };
  });
  return { shown, press, pressFits, warning, steps, whole };
};

/**
 * The warning a card to confirm is measured with, whether or not it shows
 * one (`heldWritesCards`, `confirmableOn`): the longest it can show, so a
 * write never fits only because a turn had no warning, and a press, which
 * can't tell whether its card had one, measures it the same.
 */
const measuredCheck: ReadCheck = { read: "mail" };

/**
 * Whether `writes` lay out whole on one card to confirm on `platform`:
 * every one on it (at most `maxWritesOnCard`, named in one press) and
 * every value whole, measured with a warning line (`measuredCheck`).
 */
export const confirmableOn = (
  card: Pick<HeldWritesCard, "locale" | "platform" | "writes">
): boolean => laidOut({ ...card, check: measuredCheck }).whole;

/**
 * Whether `write` can be shown whole on a card of its own on `platform`,
 * with no warning line: one that can't is never confirmed on any card.
 */
export const wholeAlone = (
  card: Pick<HeldWritesCard, "locale" | "platform">,
  write: HeldWriteView
): boolean => laidOut({ ...card, writes: [write] }).whole;

/**
 * A turn's held writes on one card, in the order they run, each with its
 * exact values; nothing runs until the person presses Confirm. Confirm and
 * Cancel carry the writes' ids and input hashes (a write to an App's with
 * its chat), so a press decides exactly what the card showed. Cancel is on
 * the card while every write it carries is held, whether or not they fit:
 * cancelling runs nothing. Confirm only while, besides, every write is on
 * the card and every value whole, as `platform` shows it: otherwise the
 * card says it can't be confirmed, and to ask for fewer changes at a time.
 */
export const heldWritesCard = ({
  locale,
  platform,
  writes,
  check,
  outcome,
  cancelOnly,
}: HeldWritesCard): PostableCard => {
  if (writes.length === 0) {
    throw new Error("A card of held writes needs at least one write");
  }
  const { shown, press, pressFits, warning, steps, whole } = laidOut({
    locale,
    platform,
    writes,
    check,
  });
  const cancellable =
    pressFits &&
    outcome === undefined &&
    shown.every((write) => write.state === "held");
  const pressable = whole && cancellable && cancelOnly === undefined;
  // Why a card to cancel can't be confirmed, said truly: written after the
  // card to confirm (and, for a connection's write, which only the turn
  // that held it lists, that it won't come back), or too long to show.
  let why: LineName | null = whole ? null : "cardTooLong";
  if (cancelOnly === "later" && whole) {
    why = writes.some(({ chatId }) => chatId === undefined)
      ? "heldLaterConnections"
      : "heldLater";
  }
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
          {write.chatId === undefined ? null : (
            <CardText>{say("heldPrivate", locale)}</CardText>
          )}
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
      {why === null ? null : <CardText>{say(why, locale)}</CardText>}
      {outcome === undefined ? null : (
        <CardText style="bold">{say(outcome, locale)}</CardText>
      )}
      {cancellable ? (
        <Actions>
          {pressable ? (
            <Button id={confirmAction} style="primary" value={press}>
              {say("confirm", locale)}
            </Button>
          ) : null}
          <Button id={cancelAction} value={press}>
            {say("cancel", locale)}
          </Button>
        </Actions>
      ) : null}
    </Card>
  );
  return { card: cardOf(card) };
};

/** `writes` in groups, in order, each as large as `fits` takes it, one at least. */
const groupsOf = (
  writes: readonly HeldWriteView[],
  fits: (group: readonly HeldWriteView[]) => boolean
): HeldWriteView[][] => {
  const groups: HeldWriteView[][] = [];
  for (const write of writes) {
    const last = groups.at(-1);
    if (last !== undefined && fits([...last, write])) {
      last.push(write);
    } else {
      groups.push([write]);
    }
  }
  return groups;
};

/**
 * A turn's held writes on as few cards as it takes for each to be decided
 * there, in the order asked. The card to confirm carries the longest
 * prefix, in the order asked, of the writes that lay out whole together
 * (`confirmableOn`: at most `maxWritesOnCard`, measured with a warning
 * line, whether or not the turn has one). Once one write can't join it,
 * every write after it waits too, so none is confirmed ahead of one asked
 * before it: those go on cards with Cancel alone (`later`), each card shown
 * whole. The only write the prefix steps over is one no card can show
 * whole, even alone: it can never be confirmed, so it is on cards of its
 * own, with Cancel alone (`tooLong`). Every waiting write has a Cancel.
 * How many cards that is is bounded by what waits: a write held for an
 * App lapses after a day, a connection's at the company's midnight. What
 * the turn read is warned of on the card to confirm.
 */
export const heldWritesCards = ({
  locale,
  platform,
  writes,
  check,
}: Omit<HeldWritesCard, "outcome" | "cancelOnly">): PostableCard[] => {
  const confirmable: HeldWriteView[] = [];
  const later: HeldWriteView[] = [];
  const tooLong: HeldWriteView[] = [];
  for (const write of writes) {
    if (!wholeAlone({ locale, platform }, write)) {
      tooLong.push(write);
    } else if (
      later.length === 0 &&
      confirmableOn({ locale, platform, writes: [...confirmable, write] })
    ) {
      confirmable.push(write);
    } else {
      later.push(write);
    }
  }
  const first =
    confirmable.length === 0
      ? []
      : [
          heldWritesCard({
            locale,
            platform,
            writes: confirmable,
            ...(check === undefined ? {} : { check }),
          }),
        ];
  // Each card of later writes shown whole; each of those too long named in
  // one press (one always fits).
  const laterCards = groupsOf(
    later,
    (group) => laidOut({ locale, platform, writes: group }).whole
  ).map((group) =>
    heldWritesCard({ locale, platform, writes: group, cancelOnly: "later" })
  );
  const tooLongCards = groupsOf(
    tooLong,
    (group) =>
      group.length <= maxWritesOnCard &&
      pressOfWrites(group).length <= buttonValueChars
  ).map((group) =>
    heldWritesCard({ locale, platform, writes: group, cancelOnly: "tooLong" })
  );
  return [...first, ...laterCards, ...tooLongCards];
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
  /** The values it starts with, as the platform gets them (workflow-offers.ts). */
  values: readonly { label: string; value: string }[];
}

/**
 * A workflow offered on a card: its name, each value it would start with,
 * and Start, whose press names only the offer, so it starts exactly what
 * the card showed, and only for the person it was offered to. Start is on
 * the card only while its name and every value are on it whole, as shown
 * (`workflow` and `values` as the platform gets them, made inert, which
 * can make them longer): otherwise the card says so, and nothing starts
 * from it.
 */
export const startOfferCard = ({
  locale,
  offerId,
  workflow,
  values,
}: StartOfferCard): PostableCard => {
  const room: Room = { left: outsideBytes };
  const name = fit(workflow, maxTitleChars, room);
  let { whole } = name;
  const shown = values.map((each) => {
    const label = fit(each.label, maxLabelChars, room);
    const value = fit(each.value, Number.POSITIVE_INFINITY, room);
    whole &&= label.whole && value.whole;
    return { label: label.text, value: value.text };
  });
  const card = (
    <Card>
      <CardText>{say("startOffer", locale, { workflow: name.text })}</CardText>
      {shown.length === 0 ? null : (
        <Fields>
          {shown.map(({ label, value }, at) => (
            <Field key={`${offerId}.${at}`} label={label} value={value} />
          ))}
        </Fields>
      )}
      {whole ? (
        <Actions>
          <Button id={startAction} style="primary" value={offerId}>
            {say("startButton", locale)}
          </Button>
        </Actions>
      ) : (
        <CardText>{say("startTooLong", locale)}</CardText>
      )}
    </Card>
  );
  return { card: cardOf(card), aiGenerated: true };
};

/** Undo's action id, for the channel layer's `onAction`. */
export const undoAction = "memory.undo";

/**
 * What Stephen saved and how he says it: about the person, or another.
 * What the model wrote of it (the statement, whom it is about, its value)
 * shows every character nobody sees as an escape (`shownVisibly`), as a
 * held write's values do.
 */
const rememberedLine = (
  locale: ChannelLocale,
  saved: ChatSavedMemory
): string => {
  const statement = shownVisibly(saved.statement);
  const about =
    saved.about === undefined ? undefined : shownVisibly(saved.about);
  const value =
    saved.value === undefined ? undefined : shownVisibly(saved.value);
  if (about === undefined) {
    return value === undefined
      ? say("remembered", locale, { statement })
      : say("rememberedValue", locale, { statement, value });
  }
  return value === undefined
    ? say("rememberedAbout", locale, { about, statement })
    : say("rememberedAboutValue", locale, { about, statement, value });
};

/** The label above a memory that says how Stephen should act for them. */
const rememberedKind = {
  instruction: "rememberedInstruction",
  preference: "rememberedPreference",
} as const satisfies Partial<Record<ChatSavedMemory["type"], LineName>>;

/**
 * A memory the agent saved of what the person said in their direct
 * message (remembered.ts), as the notice in Grasp's own chat shows it:
 * what the Brain kept, whole, in as many sections as it takes, cut as
 * written and each piece made inert after the cut (`piecesOf`, inert.ts),
 * as the model wrote some of it; whether it says how he should act for
 * them; and Undo, whose press names only the memory. Undo is always on
 * the card: it only ever retires the presser's own memory.
 */
export const rememberedCard = ({
  locale,
  platform,
  saved,
}: {
  locale: ChannelLocale;
  platform: string;
  saved: ChatSavedMemory;
}): PostableCard => {
  const inert = inertOn(platform);
  const kind =
    saved.type === "instruction" || saved.type === "preference"
      ? rememberedKind[saved.type]
      : undefined;
  const pieces = piecesOf(rememberedLine(locale, saved), locale, platform);
  const card = (
    <Card>
      {kind === undefined ? null : (
        <CardText style="muted">{say(kind, locale)}</CardText>
      )}
      {pieces.flatMap((piece, index) =>
        onlyWhiteSpace.test(piece)
          ? []
          : [<CardText key={index}>{inert(piece)}</CardText>]
      )}
      <Actions>
        <Button id={undoAction} value={saved.memory}>
          {say("undo", locale)}
        </Button>
      </Actions>
    </Card>
  );
  return { card: cardOf(card), aiGenerated: true };
};
