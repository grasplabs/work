import { onlyForAsking } from "@grasp-os/shared/interview-links";
import type {
  InterviewFact,
  InterviewProgress,
} from "@grasp-os/shared/interview-links";
import type {
  ReadBackPart,
  StorySentence,
} from "@grasp-os/shared/interview-story";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import {
  InlineCitation,
  InlineCitationText,
} from "@grasp-os/ui/components/inline-citation";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverFooter,
  PopoverHeader,
  PopoverTitle,
} from "@grasp-os/ui/components/popover";
import { Switch } from "@grasp-os/ui/components/switch";
import { Text } from "@grasp-os/ui/components/text";
import { Textarea } from "@grasp-os/ui/components/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { EyeOffIcon, Icon, UsersIcon } from "@grasp-os/ui/lib/icons";
import { fadeIn, focusRingText } from "@grasp-os/ui/lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { iconVars } from "@grasp-os/ui/lib/vars.stylex";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useEffectEvent, useId, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { StepFoot } from "../onboarding/calm-frame.tsx";
import type { Pose } from "../onboarding/field/engine.ts";
import { update, useKind, useProgress } from "./kept.ts";
import { looks } from "./looks.ts";
import { agreeToPart, changeLine, storyFor, useLoop } from "./loop.ts";
import type { LoopState } from "./loop.ts";
import {
  partAt,
  withFactsBack,
  withFactToggled,
  withShares,
} from "./progress.ts";
import { markedTerms, sourceOf, storyPieces } from "./read-back-terms.ts";
import type { Source, Term } from "./read-back-terms.ts";
import { useSaidIn } from "./speech.ts";
import { SpokenText } from "./spoken.tsx";
import { usePromise } from "./words.ts";

// The read-back, told as a short story (prototype `interview-talk.tsx`,
// `ReadBack`): one part at a time, a few lines each, so it is read,
// checked and agreed to without scrolling. The paragraph is the story
// Stephen tells of the part (`/api/interview/story`), a sentence for the
// lines that belong together, or the lines as they stand until it is
// there. The things a line names stand in it as pills (read-back-terms.ts);
// resting on a sentence shows what they said that it comes from. Where the
// lines go is said once, under the story. A press on a sentence opens what
// can be done with its lines, beside it: put their words right, choose
// where they go, or take them out. What they leave in is what counts.

/** Stephen's light falling softly from the top while they read: over the title, never under the words. */
export const readingPose: Pose = {
  at: [0.5, 0],
  reach: [0.8, 0.34],
  seed: 9.4,
  tempo: 0.6,
  strength: 0.34,
};

/** A line of the read-back while he tells it: told, being told, or still to come. */
export type Told = "said" | "saying" | "waiting";

/** Where line `id` is in his telling; none when he isn't telling. */
export const toldOf = (
  telling: LoopState["telling"],
  id: string
): Told | null => {
  if (telling === null) {
    return null;
  }
  if (telling.now.includes(id)) {
    return "saying";
  }
  return telling.told.includes(id) ? "said" : "waiting";
};

const styles = stylex.create({
  head: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space["3"],
  },
  // The story: one paragraph at the size of reading, from its start, with
  // room between its lines for the pills. A new part fades in in its place.
  story: {
    margin: 0,
    width: "100%",
    maxWidth: "36rem",
    textAlign: "start",
    fontFamily: font.sans,
    fontSize: font.textLg,
    lineHeight: 1.85,
    fontWeight: font.weightNormal,
    color: colors.foreground,
    textWrap: "pretty",
  },
  // A sentence: pressed to open what can be done with it. Damsko's
  // highlight for words a source stands behind (InlineCitationText) lights
  // it under the pointer and on focus; the same ground stands under the
  // sentence Stephen says now, and while it is open. Its ground follows its
  // lines when it wraps.
  sentence: {
    borderRadius: radius.xs,
    boxDecorationBreak: "clone",
    WebkitBoxDecorationBreak: "clone",
    cursor: "pointer",
    backgroundColor: "transparent",
    transitionProperty: {
      default: "background-color",
      [media.reducedMotion]: "none",
    },
    transitionDuration: duration.hover,
    transitionTimingFunction: duration.ease,
  },
  lit: { backgroundColor: colors.accent },
  // When they said it, over their words: the transcript's own time.
  when: {
    display: "block",
    fontVariantNumeric: "tabular-nums",
    opacity: 0.7,
  },
  // A thing the line names: a quiet pill in the words' own size, its
  // maker's mark whole at the height of a letter, sitting on the line.
  pill: {
    whiteSpace: "nowrap",
    paddingInline: "0.4em",
    paddingBlock: "0.08em",
    borderRadius: radius.md,
    backgroundColor: colors.secondary,
    fontWeight: font.weightMedium,
    boxDecorationBreak: "clone",
    WebkitBoxDecorationBreak: "clone",
  },
  logo: {
    display: "inline-block",
    width: "0.95em",
    height: "0.95em",
    marginInlineEnd: "0.32em",
    verticalAlign: "-0.13em",
    [iconVars.size]: "0.95em",
  },
  // A logo file keeps its own shape: as high as the mark, as wide as it is.
  logoFile: {
    display: "inline-block",
    height: "0.95em",
    width: "auto",
    maxWidth: "1.8em",
    marginInlineEnd: "0.32em",
    verticalAlign: "-0.13em",
  },
  // A name its maker writes as a logo (AFAS) stands for the words, at cap height.
  wordmark: {
    display: "inline-block",
    height: "0.72em",
    width: "auto",
    verticalAlign: "0",
  },
  actions: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space["2"],
  },
  choices: { display: "flex", flexDirection: "column", gap: space["2"] },
  editor: {
    display: "flex",
    flexDirection: "column",
    gap: space["4"],
    width: "100%",
  },
});

/** The words of the button that agrees to the part: what is left of it. */
const useAgree = (left: number, out: number): string => {
  const { t } = useLingui();
  if (left === 0) {
    return t`None of this is right`;
  }
  return out > 0 ? t`The rest is correct` : t`Yes, that’s correct`;
};

/** Where a line goes, as the story names it: with the team, only counted, or only to know whom to ask. */
type Going = "team" | "anonymous" | "asking";

const goingOf = (
  fact: Pick<InterviewFact, "tag" | "share">,
  kind: ReturnType<typeof useKind>
): Going => {
  if (onlyForAsking(fact.tag, kind)) {
    return "asking";
  }
  return fact.share === "team" ? "team" : "anonymous";
};

/** Where most lines of the part go, said once; a tie is the stricter side. */
const mostOf = (goings: Going[]): Going => {
  const count = (going: Going) =>
    goings.filter((each) => each === going).length;
  if (count("asking") === goings.length && goings.length > 0) {
    return "asking";
  }
  return count("team") > count("anonymous") ? "team" : "anonymous";
};

/** What can be done with a line, beside it: its words, where it goes, or out. */
const LineEditor = ({
  fact,
  asking,
  onDone,
}: {
  fact: InterviewFact;
  asking: boolean;
  onDone: () => void;
}) => {
  const { t } = useLingui();
  const { id, text, share } = fact;
  const [draft, setDraft] = useState(text);
  const [team, setTeam] = useState(share === "team");
  const switchId = useId();
  return (
    <div {...stylex.props(styles.editor)}>
      <PopoverHeader>
        <PopoverTitle>{t`Change this line`}</PopoverTitle>
      </PopoverHeader>
      <Textarea
        aria-label={t`Change: ${text}`}
        maxLength={300}
        onValueChange={(value) => {
          setDraft(value);
        }}
        value={draft}
      />
      {asking ? (
        <Text color="muted" size="sm">
          {t`Only used to know whom to ask`}
        </Text>
      ) : (
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor={switchId}>
              {t`Share as how your team works`}
            </FieldLabel>
            <FieldDescription>{t`Off, it is only counted anonymously.`}</FieldDescription>
          </FieldContent>
          <Switch
            checked={team}
            id={switchId}
            onCheckedChange={(next) => {
              setTeam(next);
            }}
          />
        </Field>
      )}
      <PopoverFooter>
        <Button
          onClick={() => {
            update((progress) => withFactToggled(progress, id));
            onDone();
          }}
          variant="ghost"
        >
          {t`Take out`}
        </Button>
        <Button
          onClick={() => {
            const now = draft.trim();
            if (now !== "" && now !== text) {
              changeLine(id, text, now);
            }
            const chosen = team ? "team" : undefined;
            if (!asking && chosen !== share) {
              update((progress) =>
                withShares(progress, new Map([[id, chosen]]))
              );
            }
            onDone();
          }}
        >
          {t`Save`}
        </Button>
      </PopoverFooter>
    </div>
  );
};

/** A thing a line names, in the line: its maker's mark, if any, and its words. */
const TermPill = ({ term, text }: { term: Term; text: string }) => {
  if (term.src !== null && term.wordmark) {
    return (
      <span {...stylex.props(styles.pill)}>
        <img alt={text} src={term.src} {...stylex.props(styles.wordmark)} />
      </span>
    );
  }
  let mark: ReactNode = null;
  if (term.src !== null) {
    mark = <img alt="" src={term.src} {...stylex.props(styles.logoFile)} />;
  } else if (term.logo !== null) {
    mark = (
      <span {...stylex.props(styles.logo)}>
        <Icon icon={term.logo} />
      </span>
    );
  }
  return (
    <span {...stylex.props(styles.pill)}>
      {mark}
      {text}
    </span>
  );
};

/** Enter and Space press a sentence, as they press a button. */
const pressWithKeys =
  (press: () => void) =>
  (event: KeyboardEvent): void => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      press();
    }
  };

/** Where a group of lines is in his telling: being told when any is, told when all are. */
const toldOfAll = (
  telling: LoopState["telling"],
  ids: readonly string[]
): Told | null => {
  const each = ids.map((id) => toldOf(telling, id));
  if (each.includes(null)) {
    return null;
  }
  if (each.includes("saying")) {
    return "saying";
  }
  return each.every((told) => told === "said") ? "said" : "waiting";
};

/** What can be done with the lines a sentence tells: the one line itself, or first which of them. */
const LinesEditor = ({
  facts,
  goingOf: going,
  onDone,
}: {
  facts: readonly InterviewFact[];
  goingOf: (fact: InterviewFact) => Going;
  onDone: () => void;
}) => {
  const { t } = useLingui();
  const [chosen, setChosen] = useState<string | null>(
    facts.length === 1 ? (facts[0]?.id ?? null) : null
  );
  const fact = facts.find(({ id }) => id === chosen);
  if (fact !== undefined) {
    return (
      <LineEditor
        asking={going(fact) === "asking"}
        fact={fact}
        onDone={onDone}
      />
    );
  }
  return (
    <div {...stylex.props(styles.editor)}>
      <PopoverHeader>
        <PopoverTitle>{t`Which line do you want to change?`}</PopoverTitle>
      </PopoverHeader>
      <div {...stylex.props(styles.choices)}>
        {facts.map(({ id, text }) => (
          <Button
            key={id}
            onClick={() => {
              setChosen(id);
            }}
            variant="outline"
          >
            {text.length > 56 ? `${text.slice(0, 55)}…` : text}
          </Button>
        ))}
      </div>
    </div>
  );
};

/**
 * One sentence of the story and the lines it tells: its words, the things
 * it names as pills; resting on it shows what they said that it comes
 * from, and where it goes when that differs from the rest. Pressed, what
 * can be done with its lines opens beside it.
 */
/** What a sentence comes from, as the tooltip shows it: their words, and when in the conversation. */
interface Hint {
  said: string;
  /** Minutes and seconds into the conversation ("4:05"), as a transcript has it. */
  when: string | null;
}

const hintOf = (
  source: Source | null,
  startedAt: number | null
): Hint | null => {
  if (source === null) {
    return null;
  }
  if (source.at === null || startedAt === null || source.at < startedAt) {
    return { said: source.said, when: null };
  }
  const seconds = Math.floor((source.at - startedAt) / 1000);
  const minutes = Math.floor(seconds / 60);
  return {
    said: source.said,
    when: `${minutes}:${String(seconds % 60).padStart(2, "0")}`,
  };
};

const Sentence = ({
  text,
  facts,
  marked,
  told,
  source,
  elsewhere,
  goingOf: going,
}: {
  text: string;
  facts: readonly InterviewFact[];
  marked: readonly string[];
  told: Told | null;
  /** What they said that it comes from, as near as the page can tell. */
  source: Hint | null;
  /** Where its lines go, when that is not where the rest go. */
  elsewhere: string | null;
  goingOf: (fact: InterviewFact) => Going;
}) => {
  const [open, setOpen] = useState(false);
  const pieces = storyPieces(text, marked);
  const hinted = source !== null || elsewhere !== null;
  const sentence = (
    <span
      aria-expanded={open}
      aria-haspopup="dialog"
      data-field="still"
      onClick={() => {
        setOpen(true);
      }}
      onKeyDown={pressWithKeys(() => {
        setOpen(true);
      })}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a <button> is drawn inline-block and can't wrap inside a line of prose; a sentence of the story has to, so it is a span that acts as one (focusable, Enter and Space)
      role="button"
      tabIndex={0}
      {...stylex.props(
        styles.sentence,
        focusRingText,
        (open || told === "saying") && styles.lit
      )}
    >
      {pieces.map((piece) =>
        piece.term === null ? (
          piece.text
        ) : (
          <TermPill key={piece.at} term={piece.term} text={piece.text} />
        )
      )}
    </span>
  );
  // The anchor outside, the tooltip's trigger inside: the anchor passes on
  // only its place, the trigger all it needs to open.
  const anchored = (
    <InlineCitation>
      <InlineCitationText>
        <PopoverAnchor asChild>
          {hinted ? (
            <TooltipTrigger asChild>{sentence}</TooltipTrigger>
          ) : (
            sentence
          )}
        </PopoverAnchor>
      </InlineCitationText>
    </InlineCitation>
  );
  return (
    <Popover
      onOpenChange={(next) => {
        setOpen(next);
      }}
      open={open}
    >
      {hinted ? (
        <Tooltip>
          {anchored}
          {/* Under the sentence, so it never stands over the heading. */}
          <TooltipContent align="start" side="bottom">
            {source?.when === null || source === null ? null : (
              <span {...stylex.props(styles.when)}>{source.when}</span>
            )}
            {source === null ? null : <q>{source.said}</q>}
            {source !== null && elsewhere !== null ? <br /> : null}
            {elsewhere}
          </TooltipContent>
        </Tooltip>
      ) : (
        anchored
      )}
      <PopoverContent align="start">
        <LinesEditor
          facts={facts}
          goingOf={going}
          onDone={() => {
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
};

/** The story of the part as he tells it, once it is there; none before, or when there is none. */
const useStory = (part: ReadBackPart | undefined): StorySentence[] | null => {
  const [story, setStory] = useState<{
    key: string;
    sentences: StorySentence[] | null;
  } | null>(null);
  const key =
    part === undefined
      ? ""
      : part.facts
          .filter(({ out }) => out !== true)
          .map(({ id, text }) => `${id}\u0000${text}`)
          .join("\u0001");
  // The part as it is now, read when its lines change, not on every render.
  const partNow = useEffectEvent(() => part);
  useEffect(() => {
    let current = true;
    const load = async (): Promise<void> => {
      const asked = partNow();
      if (asked === undefined) {
        return;
      }
      const sentences = await storyFor(asked);
      if (current) {
        setStory({ key, sentences });
      }
    };
    void load();
    return () => {
      current = false;
    };
  }, [key]);
  return story?.key === key ? story.sentences : null;
};

/** A sentence on screen and the lines it tells. */
interface Unit {
  key: string;
  text: string;
  facts: InterviewFact[];
  source: Hint | null;
  elsewhere: string | null;
}

/** His sentences, each with the lines it tells; one that tells none of them is left out. */
const storySentences = (
  story: StorySentence[],
  facts: InterviewFact[],
  sourceFor: (told: InterviewFact[]) => Hint | null,
  elsewhereOf: (facts: InterviewFact[]) => string | null
): Unit[] =>
  story.flatMap(({ say, ids }) => {
    const told = facts.filter(({ id }) => ids.includes(id));
    return told.length === 0
      ? []
      : [
          {
            key: ids.join(" "),
            text: say,
            facts: told,
            source: sourceFor(told),
            elsewhere: elsewhereOf(told),
          },
        ];
  });

/** What the story shows: his sentences when there are, else each line as it stands. */
const storyUnits = ({
  facts,
  story,
  lines,
  startedAt,
  elsewhereOf,
}: {
  facts: InterviewFact[];
  story: StorySentence[] | null;
  lines: InterviewProgress["lines"];
  startedAt: number | null;
  elsewhereOf: (facts: InterviewFact[]) => string | null;
}): Unit[] => {
  const sourceFor = (told: InterviewFact[]): Hint | null =>
    hintOf(sourceOf(told.map(({ text }) => text).join(" "), lines), startedAt);
  if (story !== null) {
    // A line no sentence tells stands as it is, after them: nothing they
    // agree to goes unseen.
    const told = new Set(story.flatMap(({ ids }) => ids));
    const untold = facts.filter(({ id }) => !told.has(id));
    return [
      ...storySentences(story, facts, sourceFor, elsewhereOf),
      ...untold.map((fact) => ({
        key: fact.id,
        text: fact.text,
        facts: [fact],
        source: sourceFor([fact]),
        elsewhere: elsewhereOf([fact]),
      })),
    ];
  }
  return facts.map((fact) => ({
    key: fact.id,
    text: fact.text,
    facts: [fact],
    source: sourceFor([fact]),
    elsewhere: elsewhereOf([fact]),
  }));
};

/** The read-back, told as a story. */
export const ReadBack = () => {
  const { t } = useLingui();
  const promise = usePromise();
  const kind = useKind();
  const loop = useLoop();
  const progress = useProgress();
  const { at, part } = partAt(progress);
  const saidIn = useSaidIn(loop.line, loop.from);
  const said =
    loop.doing === "speaking" && loop.telling === null
      ? Math.max(loop.from, saidIn)
      : -1;
  const left = part?.facts.filter(({ out }) => out !== true) ?? [];
  const out = part?.facts.filter(({ out: taken }) => taken === true) ?? [];
  const story = useStory(part);
  const goingWords: Record<Going, string> = {
    team: t`Shared with your team`,
    anonymous: t`Anonymous`,
    asking: t`Only used to know whom to ask`,
  };
  if (part === undefined) {
    return null;
  }
  const marked = markedTerms(progress.lines, false);
  const going = (fact: InterviewFact): Going => goingOf(fact, kind);
  const most = mostOf(left.map(going));
  // Said once for the part; a sentence that goes elsewhere says so itself.
  let once = t`Only counted anonymously`;
  if (most === "team") {
    once = t`Shared as how your team works`;
  } else if (most === "asking") {
    once = t`Only used to know whom to ask`;
  }
  const taken = out.length;
  // The story he tells of the lines left, a sentence for the lines that
  // belong together, or the lines as they stand until it is there.
  const units = storyUnits({
    facts: left,
    story,
    lines: progress.lines,
    startedAt: progress.startedAt,
    elsewhereOf: (facts) => {
      const goes = facts.map(going).find((each) => each !== most);
      return goes === undefined ? null : goingWords[goes];
    },
  });
  return (
    <div {...stylex.props(looks.screen)}>
      <div {...stylex.props(looks.body)}>
        <div {...stylex.props(styles.head)}>
          <div aria-live="polite">
            <h1 {...stylex.props(looks.said)}>
              <SpokenText said={said} text={loop.line} />
            </h1>
          </div>
        </div>
        <p key={at} {...stylex.props(styles.story, fadeIn)}>
          {units.map((unit, place) => (
            <span key={unit.key}>
              {place > 0 ? " " : null}
              <Sentence
                elsewhere={unit.elsewhere}
                facts={unit.facts}
                goingOf={going}
                marked={marked}
                source={unit.source}
                text={unit.text}
                told={toldOfAll(
                  loop.telling,
                  unit.facts.map(({ id }) => id)
                )}
              />
            </span>
          ))}
        </p>
        {left.length > 0 ? (
          <Badge
            icon={most === "team" ? UsersIcon : EyeOffIcon}
            tooltip={promise}
            variant="outline"
          >
            {once}
          </Badge>
        ) : null}
        {out.length > 0 ? (
          <div {...stylex.props(styles.actions)}>
            <Button
              onClick={() => {
                const ids = out.map(({ id }) => id);
                update((now) => withFactsBack(now, ids));
              }}
              size="xs"
              variant="ghost"
            >
              {plural(taken, {
                one: "Put back the line taken out",
                other: "Put back the # lines taken out",
              })}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
};

/**
 * The read-back's foot, the setup's own (StepFoot): which part of how many
 * at its start, with the line along the edge, and at its end agreeing to
 * the part, its main way on, and changing something before it, which
 * brings the box back to say what.
 */
export const ReadBackFoot = ({ onChange }: { onChange: () => void }) => {
  const { t } = useLingui();
  const loop = useLoop();
  const progress = useProgress();
  const { parts, at, part } = partAt(progress);
  const left = part?.facts.filter(({ out }) => out !== true) ?? [];
  const out = part?.facts.filter(({ out: taken }) => taken === true) ?? [];
  const agree = useAgree(left.length, out.length);
  if (part === undefined) {
    return null;
  }
  const n = at + 1;
  const count = parts.length;
  return (
    <StepFoot
      end={
        <>
          <Button
            disabled={loop.doing === "idle"}
            onClick={() => {
              agreeToPart(out.length > 0 ? `${agree}.` : undefined);
            }}
            size="lg"
          >
            {agree}
          </Button>
          <Button onClick={onChange} size="lg" variant="outline">
            {t`Change something`}
          </Button>
        </>
      }
      label={t`Parts`}
      share={at / count}
      start={
        count > 1 ? (
          <Text as="span" color="muted" size="sm">
            {t`Part ${n} of ${count}`}
          </Text>
        ) : null
      }
    />
  );
};
