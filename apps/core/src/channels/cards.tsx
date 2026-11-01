import {
  Actions,
  Button,
  Card,
  CardLink,
  CardText,
  Field,
  Fields,
  LinkButton,
  Section,
  toCardElement,
} from "chat";
import type { CardElement, PostableCard } from "chat";
import { z } from "zod";

import { say } from "./words.ts";
import type { ChannelLocale, LineName } from "./words.ts";

// What Stephen sends in a chat app, written once as Chat SDK cards: each
// adapter renders a card natively (an Adaptive Card in Teams, Block Kit in
// Slack, buttons in WhatsApp and Telegram, an embed in Discord), with a
// text fallback where there is none. The words are his lines (words.ts),
// in the person's language. A press on a button reaches the channel layer
// as `onAction` with the button's id and value.
//
// A card holds what other people wrote: an answer, a document's title, the
// values of a change. Each platform caps what one message may carry, and a
// card over the cap is refused whole, so the cards measure that text as
// they put it on and stop before the cap. A card of held writes never asks
// for a press on values it couldn't show in full: it sends the person to
// Grasp to see and confirm them there instead.

/**
 * How much text from outside Grasp one card carries, in bytes as JSON
 * (UTF-8, escapes included): the rest of Teams' 28 KB for a card is left
 * for Stephen's own lines and the card's structure. Slack's limits are
 * checked with its adapter (GRA-751).
 */
const outsideBytes = 16 * 1024;

/** The most held writes one card shows; more are confirmed in Grasp. */
export const maxWritesOnCard = 10;

/** The most values one held write shows; more are confirmed in Grasp. */
export const maxValuesPerWrite = 10;

/** The most sources under an answer. */
export const maxSources = 10;

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

/**
 * Characters that end a link's label early on some platform (`]` in
 * Markdown, `|` and `>` in Slack's links), taken out of a label.
 */
const linkBreakers = /[[\]<>|]/gu;

/** The card as each adapter takes it. */
const cardOf = (element: unknown): CardElement => {
  const card = toCardElement(element);
  if (card === null) {
    throw new Error("Not a card");
  }
  return card;
};

/** A source an answer was given from: a document the person can open. */
export interface AnswerSource {
  title: string;
  url: string;
}

/** An answer, as a chat app shows it. */
export interface AnswerCard {
  locale: ChannelLocale;
  /** The answer, in Markdown. */
  text: string;
  /** What it was answered from, numbered in this order. */
  sources: readonly AnswerSource[];
  /** The chat in Grasp, where the whole answer is. */
  chatUrl: string;
  /**
   * The request the answer is for (stephen-requests.ts), where the person
   * can rate it with a thumb: Helpful or Not helpful.
   */
  rate?: string | undefined;
}

/** `sources` as numbered links, within half a card's room for outside text. */
const listedSources = (sources: readonly AnswerSource[], room: Room) =>
  sources.slice(0, maxSources).map((source, index) => {
    const title = fit(
      source.title.replaceAll(linkBreakers, ""),
      maxTitleChars,
      room
    );
    const address = linkable(source.url);
    const url =
      address !== null && sizeOf(address) <= room.left ? address : null;
    if (url !== null) {
      room.left -= sizeOf(url);
    }
    return { label: `${index + 1}. ${title.text}`, url, key: `${index}` };
  });

/** The numbered sources under an answer, if it has any. */
const SourcesSection = ({
  locale,
  listed,
}: {
  locale: ChannelLocale;
  listed: ReturnType<typeof listedSources>;
}) =>
  listed.length === 0 ? null : (
    <Section>
      <CardText style="bold">{say("sources", locale)}</CardText>
      {listed.map(({ label, url, key }) =>
        url === null ? (
          <CardText key={key}>{label}</CardText>
        ) : (
          <CardLink key={key} label={label} url={url} />
        )
      )}
    </Section>
  );

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
 * An answer with its numbered sources, labelled as made by AI where the
 * platform has a label for it (Teams). Text past what the platform takes
 * is cut, and the card links to the chat in Grasp.
 */
export const answerCard = ({
  locale,
  text,
  sources,
  chatUrl,
  rate,
}: AnswerCard): PostableCard => {
  // The sources take at most half the room, so a long answer keeps the
  // rest; a source whose address no longer fits is named without a link.
  const sourcesRoom: Room = { left: outsideBytes / 2 };
  const listed = listedSources(sources, sourcesRoom);
  const room: Room = {
    left: outsideBytes - (outsideBytes / 2 - sourcesRoom.left),
  };
  const answer = fit(text, Number.POSITIVE_INFINITY, room);
  // Grasp has what the card leaves out: the rest of the answer, or the
  // sources past the first few.
  const whole = answer.whole && sources.length <= maxSources;
  const card = (
    <Card>
      <CardText>{answer.text}</CardText>
      {answer.whole ? null : (
        <CardText style="muted">{say("answerTooLong", locale)}</CardText>
      )}
      {SourcesSection({ locale, listed })}
      {whole && rate === undefined ? null : (
        <Actions>
          {RateButtons({ locale, rate })}
          {whole ? null : (
            <LinkButton url={ownLink(chatUrl)}>
              {say("openInGrasp", locale)}
            </LinkButton>
          )}
        </Actions>
      )}
    </Card>
  );
  return { card: cardOf(card), aiGenerated: true };
};

/**
 * The numbered sources of an answer the person saw streamed as text, sent
 * right after it, labelled as made by AI like the answer; with the link to
 * the chat in Grasp when there are more sources than a card lists.
 */
export const sourcesCard = ({
  locale,
  sources,
  chatUrl,
  rate,
}: Omit<AnswerCard, "text">): PostableCard => {
  const listed = listedSources(sources, { left: outsideBytes });
  const more = sources.length > maxSources;
  const card = (
    <Card>
      {SourcesSection({ locale, listed })}
      {!more && rate === undefined ? null : (
        <Actions>
          {RateButtons({ locale, rate })}
          {more ? (
            <LinkButton url={ownLink(chatUrl)}>
              {say("openInGrasp", locale)}
            </LinkButton>
          ) : null}
        </Actions>
      )}
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
  /** The held writes in Grasp, where each can be seen and confirmed too. */
  openUrl: string;
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
 * so and links to Grasp, where the person sees all of it.
 */
export const heldWritesCard = ({
  locale,
  writes,
  check,
  openUrl,
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
      <Actions>
        {pressable ? (
          <Button id={confirmAction} style="primary" value={press}>
            {say("confirm", locale)}
          </Button>
        ) : null}
        {pressable ? (
          <Button id={cancelAction} value={press}>
            {say("cancel", locale)}
          </Button>
        ) : null}
        <LinkButton url={ownLink(openUrl)}>
          {say("openInGrasp", locale)}
        </LinkButton>
      </Actions>
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
}: {
  locale: ChannelLocale;
  url: string;
}): PostableCard => ({
  card: cardOf(
    <Card>
      <CardText>{say("signIn", locale)}</CardText>
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
