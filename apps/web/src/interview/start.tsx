import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@grasp-os/ui/components/dialog";
import { Heading } from "@grasp-os/ui/components/heading";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Link } from "@grasp-os/ui/components/link";
import { Text } from "@grasp-os/ui/components/text";
import { colors, media, radius, space } from "@grasp-os/ui/lib/tokens.stylex";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { TopError } from "../frame/top-error.tsx";
import { Actions, Page, Quiet, Words } from "./calm.tsx";
import { budgetMinutes } from "./countdown.tsx";
import { DitherOver } from "./frame.tsx";

// The start of the interview as someone meets it on their link: one
// screen, one decision, agree and start. The title on two lines, one short
// paragraph whose last words, underlined, open what becomes of their
// answers in a dialog, the one button, and "Not right now" as a link button
// at the foot. Two text styles (the serif title, the body's words at one
// size) and the buttons' label, centred on one axis. Then the way out of
// it, in as few words as honestly do: "Not now" offers a time to be
// reminded. And the pause in the conversation, which keeps the place and
// the minutes.

const styles = stylex.create({
  // The page's room: the column under the header, the quiet way out at its foot.
  page: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    flexGrow: 1,
    minHeight: 0,
    overflowY: "auto",
    boxSizing: "border-box",
    paddingInline: { default: space["4"], [media.sm]: space["10"] },
    paddingBlockStart: { default: space["8"], [media.sm]: space["10"] },
    // The links at the foot stay clear of a phone's home bar.
    paddingBlockEnd: {
      default: `max(${space["4"]}, env(safe-area-inset-bottom))`,
      [media.sm]: `max(${space["8"]}, env(safe-area-inset-bottom))`,
    },
    textAlign: "center",
  },
  // The column: in the upper middle of the page, at a fixed place from the top at every width, so
  // the promises open under the trigger and nothing above them moves.
  column: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    flexGrow: 1,
    gap: { default: space["8"], [media.lg]: space["10"] },
    width: "100%",
    paddingBlockStart: {
      default: "8vh",
      [media.sm]: "10vh",
      [media.lg]: "14vh",
    },
  },
  // The words under the title: the paragraph's measure.
  block: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space["4"],
    width: "100%",
    maxWidth: { default: "26rem", [media.lg]: "45rem" },
    // Its lines as long as each other, so the last never stands short under the first.
    textWrap: "balance",
  },
  // The title no wider than the page's room, so a line too long for it runs over, and is measured.
  title: { maxWidth: "100%" },
  // The title in two lines from a small laptop up, each line whole; on a phone one balanced run.
  titleLine: {
    display: { default: "inline", [media.sm]: "block" },
  },
  titleWhole: {
    whiteSpace: { default: null, [media.sm]: "nowrap" },
  },
  // The promises: a list in the dialog's words, its dots lined up at the start.
  list: {
    marginBlock: 0,
    paddingInlineStart: space["5"],
    listStyleType: "disc",
    display: "grid",
    gap: space["2"],
    // The dialog's own description: its size, quieter than the title, so
    // the title leads. Lines run its width; only a lone last word is kept
    // from standing alone.
    color: colors.mutedForeground,
    textWrap: "pretty",
  },
  // The one button: the whole width on a phone, its own width on a wider window.
  agree: { width: { default: "100%", [media.sm]: "auto" } },
  agreeRoom: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space["3"],
    width: "100%",
  },
  // The quiet way out, centred at the foot.
  foot: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    columnGap: space["8"],
    rowGap: space["2"],
    paddingBlockStart: space["6"],
  },
  // The suggested time: its dither clipped to the Item's own corner, above its fill.
  suggested: {
    position: "relative",
    isolation: "isolate",
    overflow: "hidden",
    borderRadius: radius.lg,
  },
});

/** The title's sizes, from the largest: a step down before a line of it would break. */
const titleSizes = ["xl", "lg", "default"] as const;
const sizeNames: readonly string[] = titleSizes;

const nothing = (): void => {
  // No title to measure.
};

/**
 * The title's size: the largest at which each of its two lines stands whole
 * in the room. A new width of the room starts again from the largest; a
 * line that runs over takes the next size down. On a phone the lines are
 * one run of words, which never runs over.
 */
const useTitleSize = () => {
  const [step, setStep] = useState(0);
  const firstLine = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const title = firstLine.current?.parentElement;
    const room = title?.parentElement;
    if (
      title === null ||
      title === undefined ||
      room === null ||
      room === undefined
    ) {
      return nothing;
    }
    // The room's width, not the title's: the title is only as wide as its words.
    let width = -1;
    const runsOver = (): boolean =>
      [...title.children].some((line) => line.scrollWidth > line.clientWidth);
    const fit = (): void => {
      const at = sizeNames.indexOf(title.dataset.size ?? "");
      if (room.clientWidth !== width && at > 0) {
        width = room.clientWidth;
        setStep(0);
        return;
      }
      width = room.clientWidth;
      if (runsOver()) {
        setStep(Math.min(at + 1, titleSizes.length - 1));
      }
    };
    const watch = new ResizeObserver(fit);
    watch.observe(room);
    watch.observe(title);
    let current = true;
    // The serif arrives after the first measure, a little wider or narrower: measured again.
    const settle = async (): Promise<void> => {
      try {
        await document.fonts.ready;
      } catch {
        // A page without the fonts' API measures once, as it is.
        return;
      }
      if (current) {
        width = -1;
        fit();
      }
    };
    void settle();
    return () => {
      current = false;
      watch.disconnect();
    };
  }, []);
  return {
    size: titleSizes[step] ?? "xl",
    // At the smallest size a line that still runs over wraps, rather than leave the window.
    whole: step < titleSizes.length - 1,
    firstLine,
  };
};

/**
 * What becomes of their answers: the paragraph's underlined words, which
 * open the promises in a dialog over the page.
 */
const Answers = ({
  promises,
  children,
}: {
  promises: string[];
  children: ReactNode;
}) => {
  const { t } = useLingui();
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Link asChild>
          <button type="button">{children}</button>
        </Link>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t`What happens to your answers`}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <ul {...stylex.props(styles.list)}>
            {promises.map((each) => (
              <li key={each}>{each}</li>
            ))}
          </ul>
        </DialogBody>
        <DialogFooter>
          <DialogClose variant="default">{t`Got it`}</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** The start: one decision, centred. */
export const Consent = ({
  name,
  company: named,
  who,
  refusal,
  onAgree,
  onNotNow,
}: {
  name: string;
  /** The company's name; "Your company" when it has none yet. */
  company: string | undefined;
  /** Who interviews them, by name. */
  who: string;
  /** Why taking part wasn't kept, when it wasn't. */
  refusal: string | null;
  onAgree: () => void;
  onNotNow: () => void;
}) => {
  const { t } = useLingui();
  const title = useTitleSize();
  const minutes = budgetMinutes;
  const company = named === undefined || named === "" ? t`Your company` : named;
  // One sentence for translators; it stands on two lines where the window has room for both.
  const lines = t`Hi ${name}, got a few minutes
to talk about your work?`.split("\n");
  const promises = [
    t`Your voice isn’t saved, only your words.`,
    t`Nothing is shared until you review and approve it.`,
    t`You can change or delete everything up to 7 days afterwards.`,
  ];
  return (
    <div {...stylex.props(styles.page)}>
      <div {...stylex.props(styles.column)}>
        <Heading level={1} size={title.size} style={styles.title}>
          {lines.map((line, at) => (
            <span
              key={line}
              ref={at === 0 ? title.firstLine : undefined}
              {...stylex.props(
                styles.titleLine,
                title.whole && styles.titleWhole
              )}
            >
              {/* On a phone the two lines are one run of words: a space between them. */}
              {at === 0 ? "" : " "}
              {line}
            </span>
          ))}
        </Heading>
        <div {...stylex.props(styles.block)}>
          {/* A box, not a paragraph: the dialog it opens stands in it. */}
          <Text as="div" size="lg">
            <Trans>
              {company} asked everyone to have a short conversation with {who},
              our AI interviewer. It takes {minutes} minutes at most, and you
              decide{" "}
              <Answers promises={promises}>
                what happens to your answers
              </Answers>
              .
            </Trans>
          </Text>
        </div>
        <div {...stylex.props(styles.agreeRoom)}>
          <Button onClick={onAgree} size="lg" style={styles.agree}>
            {t`I agree, let’s start`}
          </Button>
          {refusal === null ? null : <TopError>{refusal}</TopError>}
        </div>
      </div>
      <div {...stylex.props(styles.foot)}>
        <Button onClick={onNotNow} variant="link">
          {t`Not right now`}
        </Button>
      </div>
    </div>
  );
};

/** A time "Not now" offers to remind them at. */
export interface RemindAt {
  id: "today" | "tomorrow" | "monday";
  at: Date;
}

/** At `hour` o'clock on the day `days` after `now`. */
const dayAt = (now: Date, days: number, hour: number): Date => {
  const at = new Date(now);
  at.setDate(at.getDate() + days);
  at.setHours(hour, 0, 0, 0);
  return at;
};

/** Monday, by `getDay`. */
const monday = 1;
/** Later today is offered until this hour. */
const laterTodayUntil = 15;

/**
 * The times "Not now" offers: later today while there is still a working
 * afternoon left, tomorrow morning, and Monday morning unless tomorrow is
 * Monday.
 */
export const remindTimes = (now: Date): RemindAt[] => {
  const times: RemindAt[] = [];
  if (now.getHours() < laterTodayUntil) {
    times.push({ id: "today", at: dayAt(now, 0, 16) });
  }
  times.push({ id: "tomorrow", at: dayAt(now, 1, 9) });
  const toMonday = (monday - now.getDay() + 7) % 7 || 7;
  if (toMonday > 1) {
    times.push({ id: "monday", at: dayAt(now, toMonday, 9) });
  }
  return times;
};

/** The reminder time we would pick: tomorrow morning, a fresh start. */
const suggested: RemindAt["id"] = "tomorrow";

/** A time's clock, as the page's language writes it. */
const useClock = () => {
  const { i18n } = useLingui();
  return (at: Date): string =>
    new Intl.DateTimeFormat(i18n.locale, { timeStyle: "short" }).format(at);
};

/** "Not now": when to be reminded, one press: the time first, the day under it. */
export const NotNow = ({
  closes,
  times,
  onPick,
  onBack,
}: {
  closes: string;
  times: RemindAt[];
  onPick: (picked: RemindAt) => void;
  onBack: () => void;
}) => {
  const { t } = useLingui();
  const clock = useClock();
  const dayOf: Record<RemindAt["id"], string> = {
    today: t`Later today`,
    tomorrow: t`Tomorrow morning`,
    monday: t`Monday morning`,
  };
  return (
    <Page>
      <Words
        line={t`We’ll send a reminder with this same link. It stays open until ${closes}.`}
        title={t`When works better for you?`}
      />
      <ItemGroup aria-label={t`Remind me`}>
        {times.map((each) => {
          const item = (
            <Item
              onClick={() => {
                onPick(each);
              }}
              size="sm"
              variant="outline"
            >
              <ItemContent>
                <ItemTitle>{clock(each.at)}</ItemTitle>
                <ItemDescription>{dayOf[each.id]}</ItemDescription>
              </ItemContent>
            </Item>
          );
          // The one we would pick carries the header's calm dither.
          return each.id === suggested ? (
            <div key={each.id} {...stylex.props(styles.suggested)}>
              {item}
              <DitherOver />
            </div>
          ) : (
            <div key={each.id}>{item}</div>
          );
        })}
      </ItemGroup>
      <Quiet>
        <Button onClick={onBack} variant="link">
          {t`Back`}
        </Button>
      </Quiet>
    </Page>
  );
};

/** "Not now" taken. */
export const Reminded = ({
  picked,
  onStart,
}: {
  picked: RemindAt;
  onStart: () => void;
}) => {
  const { t } = useLingui();
  const time = useClock()(picked.at);
  const lines: Record<RemindAt["id"], string> = {
    today: t`We’ll remind you later today at ${time}. Nothing was recorded.`,
    tomorrow: t`We’ll remind you tomorrow morning at ${time}. Nothing was recorded.`,
    monday: t`We’ll remind you on Monday morning at ${time}. Nothing was recorded.`,
  };
  return (
    <Page>
      <Words line={lines[picked.id]} live title={t`Got it.`} />
      <Actions>
        <Button onClick={onStart} size="lg" variant="outline">
          {t`Actually, let’s start now`}
        </Button>
      </Actions>
    </Page>
  );
};

/** Stopped for now in the conversation: the place and the minutes are kept. */
export const Paused = ({
  minutesLeft,
  closes,
  onCarryOn,
}: {
  minutesLeft: number;
  closes: string;
  onCarryOn: () => void;
}) => {
  const { t } = useLingui();
  return (
    <Page>
      <Words
        line={plural(minutesLeft, {
          one: `Your answers are saved and the clock is paused. You have # minute left, and you can pick up where you left off anytime until ${closes}.`,
          other: `Your answers are saved and the clock is paused. You have # minutes left, and you can pick up where you left off anytime until ${closes}.`,
        })}
        live
        title={t`Paused`}
      />
      <Actions>
        <Button onClick={onCarryOn} size="lg">
          {t`Continue`}
        </Button>
      </Actions>
    </Page>
  );
};
