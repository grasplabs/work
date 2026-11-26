import { Button } from "@grasp-os/ui/components/button";
import { ArrowLeftIcon, Icon } from "@grasp-os/ui/lib/icons";
import { fadeIn, visuallyHidden } from "@grasp-os/ui/lib/styles";
import {
  colors,
  duration,
  font,
  media,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { readingTiming, saidBy, wordsOf } from "../voice/timing.ts";
import {
  hold,
  prepare,
  say,
  stopSpeaking,
  useSaid,
  useVoice,
  voiceClock,
} from "../voice/voice.ts";
import { Sound, useBackWay, useEnterGoesOn } from "./calm-frame.tsx";
import { enterPlatform } from "./entry-store.ts";
import type { EntryFact } from "./entry-store.ts";
import { poseField } from "./field/engine.ts";
import { poses } from "./field/poses.ts";
import { PlanPictures } from "./plan-pictures.tsx";
import type { Scene } from "./plan-scenes.ts";
import { dayAt, leadsOf, weekdayOf } from "./plan.ts";
import { closesOn } from "./setup.ts";
import { StartOver } from "./start-over.tsx";
import type { SetupData } from "./step-parts.ts";
import { useRememberLines } from "./step-voice.tsx";

// "Here's the plan", told as a story (as the first onboarding told it,
// `about-story.tsx` before a955fb8). Stephen tells the admin's own two
// weeks, a part at a time with the plan's own days in it, each part a line
// of its own for the voice (one request may say only so much), and the
// whole window tells it with him in footage: it turns to
// night and becomes one of the Appearance page's scenes, dithered in the
// brand's greens by the same shader, and every part of the story is a
// stock clip of its own that turns into the next as he goes on
// (plan-pictures.tsx, plan-scenes.ts). Under it, on the picture's dark
// foot, each part streams in word by word as he says it. Once told, the
// last clip stays, his last words under it, and only then Continue fades
// in, where every step keeps it: at the foot, on the right.
//
// With his voice on, the story follows it; off, the pace of speech;
// paused, it holds. Under reduced motion, and coming back to the step,
// the last clip stands at once, still; it can be told again from
// there, and skipped while it is told. A screen reader hears each part
// whole, as it comes.

const styles = stylex.create({
  // The whole window, night, over the page and its bar and track.
  stage: {
    position: "fixed",
    inset: 0,
    zIndex: 10,
    isolation: "isolate",
    display: "grid",
    gridTemplateRows: "auto 1fr auto auto",
    justifyItems: "center",
    backgroundColor: colors.brandNight,
    color: colors.bodyForeground,
  },
  // The stage's own bar and foot, where the frame keeps them: his voice at the top, back and the
  // way on at the foot.
  bar: {
    justifySelf: "end",
    display: "flex",
    alignItems: "center",
    gap: space[1],
    // A little night behind his tools, so they show on a bright picture too.
    backgroundImage:
      "radial-gradient(closest-side, color-mix(in srgb, var(--damsko-brand-night) 60%, transparent), transparent)",
    paddingBlock: space[4],
    paddingInline: { default: space[8], [media.maxSm]: space[4] },
  },
  foot: {
    width: "100%",
    display: "grid",
    gridTemplateColumns: "1fr auto",
    alignItems: "center",
    gap: space[3],
    minHeight: "5.5rem",
    paddingBlockEnd: { default: space[6], [media.maxSm]: space[4] },
    paddingInline: { default: space[8], [media.maxSm]: space[4] },
  },
  footStart: { display: "flex", alignItems: "center" },
  footEnd: {
    display: "flex",
    flexDirection: "row-reverse",
    alignItems: "center",
    justifySelf: "end",
    gap: space[3],
    whiteSpace: "nowrap",
  },
  // The words, on the picture's dark foot: room for three lines, so nothing moves.
  words: {
    display: "grid",
    alignContent: "end",
    width: "100%",
    maxWidth: "48rem",
    paddingInline: space[6],
    textAlign: "center",
    minHeight: {
      default: "calc(3 * var(--damsko-heading-lg-line))",
      [media.maxSm]: "calc(4 * var(--damsko-heading-md-line))",
    },
  },
  line: {
    margin: 0,
    color: colors.foreground,
    fontFamily: font.serif,
    fontWeight: font.weightNormal,
    fontSize: { default: font.headingLg, [media.maxSm]: font.headingMd },
    lineHeight: {
      default: font.headingLgLine,
      [media.maxSm]: font.headingMdLine,
    },
    letterSpacing: font.trackingTitle,
    textAlign: "center",
    textWrap: "balance",
    textShadow: "0 0 24px var(--damsko-brand-night)",
  },
  word: {
    display: "inline-block",
    whiteSpace: "pre",
    opacity: 0,
    filter: "blur(8px)",
    transform: "translateY(0.35em)",
    transitionProperty: "opacity, filter, transform, color",
    transitionDuration: "380ms, 380ms, 380ms, 1200ms",
    transitionTimingFunction: duration.ease,
  },
  said: { opacity: 1, filter: "blur(0)", transform: "none" },
  fresh: { color: colors.brandLime },
  quiet: { opacity: 0.7 },
  // Going into the platform: the story's words and ways make room for what was set up.
  leaving: {
    opacity: 0,
    transitionProperty: "opacity",
    transitionDuration: "420ms",
    pointerEvents: "none",
  },
  // Continue arriving once the story is told: slower than a step's, it is the story's last beat.
  arriving: { animationDuration: "900ms" },
});

/** Fetches the way into the platform ahead (platform-entry.tsx), which the root plays. */
const fetchEntry = (): void => {
  void import("./platform-entry.tsx");
};

/** Told once in this visit: coming back to the step, the story's last picture stands at once. */
let toldBefore = false;

const lessMotion = "(prefers-reduced-motion: reduce)";

const onMotionChange = (listener: () => void): (() => void) => {
  const query = window.matchMedia(lessMotion);
  query.addEventListener("change", listener);
  return () => {
    query.removeEventListener("change", listener);
  };
};

const useLessMotion = (): boolean =>
  useSyncExternalStore(
    onMotionChange,
    () => window.matchMedia(lessMotion).matches,
    () => false
  );

/** One part of the narration and the figure it is told over. */
interface Part {
  scene: Scene;
  text: string;
}

/** The narration, in the language the page is in: what the admin chose, told back as what happens next. */
const useParts = (data: SetupData): Part[] => {
  const { t, i18n } = useLingui();
  const day = new Intl.DateTimeFormat(i18n.locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
  const clock = new Intl.DateTimeFormat(i18n.locale, {
    hour: "numeric",
    minute: "2-digit",
  });
  const { plan } = data.view;
  const leads = leadsOf(data.view.roster).filter(
    ({ lead }) => lead !== null
  ).length;
  const start = plan === null ? null : day.format(dayAt(plan.start));
  const at = plan?.at === undefined ? null : clock.format(new Date(plan.at));
  const close =
    plan === null ? null : day.format(dayAt(weekdayOf(closesOn(plan))));
  let first = t`Once Grasp’s team has planned the day with you, the team leads go first. They get a link for a short chat with me about their day, the tools they use, and where their time goes.`;
  if (start !== null) {
    first =
      at === null
        ? t`On ${start}, the team leads go first. They get a link for a short chat with me about their day, the tools they use, and where their time goes.`
        : t`On ${start} at ${at}, the team leads go first. They get a link for a short chat with me about their day, the tools they use, and where their time goes.`;
  }
  const everyone =
    leads > 0
      ? t`Everyone else gets their own link as soon as their lead has talked with me, and can do the chat whenever it suits them.`
      : t`Then everyone else gets their own link, and can do the chat whenever it suits them.`;
  return [
    {
      scene: "you",
      text: t`That’s everything. Here’s a quick look at what happens next.`,
    },
    { scene: "first", text: first },
    { scene: "everyone", text: everyone },
    {
      scene: "close",
      text:
        close === null
          ? t`About two weeks later we wrap up, once I’ve heard from almost everyone.`
          : t`We wrap up on ${close}, once I’ve heard from almost everyone.`,
    },
    {
      scene: "learned",
      text: t`Then I pull it all together, and we walk through the report: where work gets stuck, and what makes the most sense to tackle first.`,
    },
    {
      scene: "rest",
      text: t`Most of the time, it’s the small things that pile up and end up making the biggest difference. Until then, Grasp is all yours.`,
    },
  ];
};

/** How many of each shown at most, so the way in stays a glance, never a list. */
const most = { teams: 5, leads: 4, documents: 3 };

/** What the admin set up, as the way into the platform gathers it: the company, its teams and leads, its people, its documents, the day. */
const useEntryFacts = (data: SetupData): EntryFact[] => {
  const { t, i18n } = useLingui();
  const { roster, plan } = data.view;
  const teams = leadsOf(roster);
  const people = roster?.people.filter((person) => !person.away).length ?? 0;
  const facts: EntryFact[] = [];
  const company = data.company?.trim() ?? "";
  facts.push({ kind: "company", text: company === "" ? "Grasp" : company });
  for (const { team } of teams.slice(0, most.teams)) {
    facts.push({ kind: "team", text: team });
  }
  for (const { lead } of teams.slice(0, most.leads)) {
    if (lead !== null) {
      facts.push({ kind: "lead", text: lead.split(/\s+/u)[0] ?? lead });
    }
  }
  if (people > 0) {
    facts.push({
      kind: "people",
      text: plural(people, { one: "# person", other: "# people" }),
    });
  }
  for (const document of data.documents.slice(0, most.documents)) {
    facts.push({ kind: "document", text: document.name });
  }
  if (plan !== null) {
    const day = new Intl.DateTimeFormat(i18n.locale, {
      weekday: "short",
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    }).format(dayAt(plan.start));
    facts.push({ kind: "start", text: t`Starts ${day}` });
  }
  return facts;
};

/** How many characters of a part are said by now: by his voice, or by the pace of speech when it is off. */
const useNarrated = (
  text: string,
  began: number | null,
  over: boolean
): number => {
  const voice = useVoice();
  const said = useSaid(text);
  const [now, setNow] = useState(voiceClock);
  const silent = !voice.on;
  const ticking = silent && began !== null && !over;
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      setNow(voiceClock());
      frame = requestAnimationFrame(tick);
    };
    if (ticking) {
      tick();
    }
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [ticking]);
  if (over) {
    return text.length;
  }
  if (began === null) {
    return 0;
  }
  if (!silent) {
    return Math.max(said, 0);
  }
  return saidBy(readingTiming(text), now - began);
};

/** A part streaming in, word by word as it is said: each word rises out of a blur, briefly in mint. */
const Streamed = ({ text, said }: { text: string; said: number }) => (
  <p aria-hidden="true" {...stylex.props(styles.line)}>
    {wordsOf(text).map(({ word, start, end }) => (
      <span
        key={start}
        {...stylex.props(
          styles.word,
          said > start && styles.said,
          said > start && said < end + 14 && styles.fresh
        )}
      >
        {word}
      </span>
    ))}
  </p>
);

/**
 * A part as it is told, its words streaming in as they are said: one for each part, so each
 * starts from none said, never from where the part before it ended.
 */
const Told = ({
  text,
  began,
  over,
  settled,
}: {
  text: string;
  began: number | null;
  over: boolean;
  /** Told before: all of it said and settled, none of it still fresh. */
  settled: boolean;
}) => {
  const said = useNarrated(text, began, over || settled);
  return <Streamed said={settled ? text.length + 20 : said} text={text} />;
};

/** The ways on, at the foot: Skip while the story is told; once it is, Continue and to be told again. */
const Ways = ({
  shown,
  reduce,
  onward,
  skip,
  again,
}: {
  shown: boolean;
  reduce: boolean;
  onward: () => Promise<void>;
  skip: () => void;
  again: () => void;
}) => {
  const { t } = useLingui();
  const ref = useEnterGoesOn();
  if (!shown) {
    return (
      <span {...stylex.props(styles.footEnd, styles.quiet)}>
        <Button onClick={skip} size="sm" variant="link">
          {t`Skip`}
        </Button>
      </span>
    );
  }
  return (
    <div ref={ref} {...stylex.props(styles.footEnd, fadeIn, styles.arriving)}>
      <Button
        onClick={() => {
          void onward();
        }}
        size="lg"
      >
        {t`Continue`}
      </Button>
      {reduce ? null : (
        <span {...stylex.props(styles.quiet)}>
          <Button onClick={again} size="sm" variant="link">
            {t`Tell me again`}
          </Button>
        </span>
      )}
    </div>
  );
};

/** Back a step, where the frame's track would have it. */
const Back = () => {
  const { t } = useLingui();
  const back = useBackWay();
  if (back === undefined) {
    return <span />;
  }
  return (
    <span {...stylex.props(styles.footStart)}>
      <Button
        aria-label={t`Back`}
        onClick={back}
        size="icon-sm"
        tooltip={t`Back`}
        variant="ghost"
      >
        <Icon icon={ArrowLeftIcon} />
      </Button>
    </span>
  );
};

/** The story as it is told: the part being told, and how much of it is said. */
const useTelling = (data: SetupData, shown: boolean) => {
  const parts = useParts(data);
  const texts = parts.map((part) => part.text);
  const [at, setAt] = useState(0);
  const [began, setBegan] = useState<number | null>(null);
  // The part being told is said to its end.
  const [over, setOver] = useState(false);
  // Every part fetched ahead, in turn, so each starts at once when its turn comes.
  const ahead = texts.join("\n");
  useEffect(() => {
    for (const text of ahead.split("\n")) {
      prepare(text);
    }
  }, [ahead]);
  // Once told, the last part.
  const told = shown ? parts.length - 1 : at;
  return {
    texts,
    part: parts[told] ?? parts[0],
    at: told,
    over,
    began,
    setAt,
    setBegan,
    setOver,
  };
};

export const PlanStory = ({
  data,
  onward,
}: {
  data: SetupData;
  /** Past the setup's last screen: into the platform. Over once it is there. */
  onward: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const facts = useEntryFacts(data);
  const reduce = useLessMotion();
  const [told, setTold] = useState(toldBefore);
  const shown = told || reduce;
  const { texts, part, at, over, began, setAt, setBegan, setOver } = useTelling(
    data,
    shown
  );
  // The way in, fetched while the story is told, so it starts at once.
  useEffect(fetchEntry, []);
  // Continue: what they set up gathers on the screen and builds the platform's first page.
  const [entering, setEntering] = useState(false);
  const enter = async (): Promise<void> => {
    if (entering) {
      return;
    }
    setEntering(true);
    stopSpeaking();
    await enterPlatform({ facts, go: onward });
  };

  const finish = () => {
    toldBefore = true;
    stopSpeaking();
    poseField(poses.about);
    setTold(true);
  };
  const remember = useRememberLines();
  const latest = useRef({ texts, finish, remember, setAt, setBegan, setOver });
  useEffect(() => {
    latest.current = { texts, finish, remember, setAt, setBegan, setOver };
  });

  // The story: a breath, then each part in turn, a short breath after each, and a longer one for
  // the last to land.
  useEffect(() => {
    let left = false;
    const tell = async (index: number): Promise<void> => {
      const { texts: lines } = latest.current;
      const text = lines[index];
      if (left || text === undefined) {
        if (!left) {
          latest.current.finish();
        }
        return;
      }
      if (index === 0) {
        // What the step says, to be fetched ahead the next time through (step-voice.tsx).
        latest.current.remember?.(lines);
      }
      latest.current.setAt(index);
      latest.current.setOver(false);
      latest.current.setBegan(voiceClock());
      await say(text);
      if (left) {
        return;
      }
      latest.current.setOver(true);
      await hold(index === lines.length - 1 ? 1200 : 300);
      await tell(index + 1);
    };
    if (!shown) {
      void (async () => {
        await hold(700);
        await tell(0);
      })();
    }
    return () => {
      left = true;
    };
  }, [shown]);
  // Leaving the step, his voice stops with the story.
  useEffect(
    () => () => {
      stopSpeaking();
    },
    []
  );

  const scene: Scene = part?.scene ?? "you";
  return createPortal(
    <section data-mode="dark" {...stylex.props(styles.stage, fadeIn)}>
      <PlanPictures scene={scene} still={reduce} />
      <div {...stylex.props(styles.bar, entering && styles.leaving)}>
        <Sound />
        {/* Over the frame's bar, so its way to start over (local only) is here too. */}
        <StartOver size="icon-sm" />
      </div>
      <span />
      <div {...stylex.props(styles.words, entering && styles.leaving)}>
        <h1 {...stylex.props(visuallyHidden)}>{t`What happens next`}</h1>
        <Told
          began={began}
          key={`part-${String(at)}`}
          over={over}
          settled={shown}
          text={part?.text ?? ""}
        />
        <span aria-live="polite" {...stylex.props(visuallyHidden)}>
          {began === null && !shown ? "" : part?.text}
        </span>
      </div>
      <footer {...stylex.props(styles.foot, entering && styles.leaving)}>
        <Back />
        <Ways
          again={() => {
            toldBefore = false;
            setAt(0);
            setBegan(null);
            setOver(false);
            setTold(false);
          }}
          onward={enter}
          reduce={reduce}
          shown={shown}
          skip={finish}
        />
      </footer>
    </section>,
    document.body
  );
};
