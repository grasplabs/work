import { onlyForAsking } from "@grasp-os/shared/interview-links";
import type { InterviewFact } from "@grasp-os/shared/interview-links";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "@grasp-os/ui/components/field";
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
import { useLocation } from "@tanstack/react-router";
import { useId, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import type { Pose } from "../onboarding/field/engine.ts";
import { voice } from "./interview.stylex.ts";
import { update, useKind, useProgress } from "./kept.ts";
import { looks } from "./looks.ts";
import { agreeToPart, changeLine, useLoop } from "./loop.ts";
import type { LoopState } from "./loop.ts";
import {
  partAt,
  withFactsBack,
  withFactToggled,
  withShares,
} from "./progress.ts";
import { markedTerms, storyPieces } from "./read-back-terms.ts";
import type { Term } from "./read-back-terms.ts";
import { useSaidIn } from "./speech.ts";
import { SpokenText } from "./spoken.tsx";
import { usePromise } from "./words.ts";

// Concepts only, until one is picked (`?readback=a|b`): the read-back told
// as a short story, one paragraph for the part they are at, each line a
// sentence in it. The things a line names stand in it as pills
// (read-back-terms.ts). Where the lines go is said once, under the story;
// a sentence that goes somewhere else carries a pill that says so. A press
// on a sentence opens what can be done with it, beside it: put its words
// right, choose where it goes, or take it out. What they leave in is what
// counts, as in the list (read-back.tsx).
//
// A, the story: the sentence is what is pressed; its tools are pills; a
//    line taken out leaves the story, and one button puts them back.
// B, the story with marked facts: every thing the line names is a pill
//    (tools, and what Stephen marked in their words: tasks, wishes, what
//    goes wrong); a line taken out stays, struck through, with a way back.

export type ReadBackConcept = "a" | "b";

/** The concept asked for in the address, if any: none is the list as it is. */
export const useReadBackConcept = (): ReadBackConcept | null => {
  const written = useLocation({ select: (location) => location.searchStr });
  const concept = new URLSearchParams(written).get("readback");
  return concept === "a" || concept === "b" ? concept : null;
};

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
  // B's prose stands back, so the things it names come forward.
  storyQuiet: { color: colors.mutedForeground },
  // A sentence: pressed to open what can be done with it. Its ground
  // follows its lines when it wraps.
  // His line under the sentence he says draws in from its start and
  // draws back as he goes on, on the library's curve; its colour comes and
  // goes the same way, so nothing jumps.
  sentence: {
    borderRadius: radius.sm,
    paddingBlockEnd: "0.2em",
    boxDecorationBreak: "clone",
    WebkitBoxDecorationBreak: "clone",
    cursor: "pointer",
    backgroundColor: {
      default: "transparent",
      [media.hover]: { default: "transparent", ":hover": colors.secondary },
    },
    backgroundImage: `linear-gradient(${voice.heat}, ${voice.heat})`,
    backgroundRepeat: "no-repeat",
    backgroundPosition: "0 100%",
    backgroundSize: "0% 2px",
    transitionProperty: {
      default: "background-color, background-size, color",
      [media.reducedMotion]: "none",
    },
    transitionDuration: duration.ui,
    transitionTimingFunction: duration.easeInOut,
  },
  open: { backgroundColor: colors.secondary },
  // Where he is in his telling: the sentence he says now carries his warmth
  // as a line under it; those still to come wait in grey.
  saying: { backgroundSize: "100% 2px" },
  waiting: { color: colors.subtleForeground },
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
  logoFile: {
    display: "block",
    width: "100%",
    height: "100%",
    objectFit: "contain",
  },
  // B: a line taken out stays where it was, struck through and faded.
  out: {
    color: colors.subtleForeground,
    textDecorationLine: "line-through",
    textDecorationColor: colors.subtleForeground,
  },
  actions: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space["2"],
  },
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

/** The pill on a sentence that goes somewhere else than the rest. */
const GoingPill = ({ going }: { going: Going }) => {
  const { t } = useLingui();
  if (going === "asking") {
    return (
      <Badge size="sm" variant="outline">
        {t`Only used to know whom to ask`}
      </Badge>
    );
  }
  return going === "team" ? (
    <Badge icon={UsersIcon} size="sm" variant="outline">
      {t`Shared with your team`}
    </Badge>
  ) : (
    <Badge icon={EyeOffIcon} size="sm" variant="outline">
      {t`Anonymous`}
    </Badge>
  );
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
  let mark: ReactNode = null;
  if (term.src !== null) {
    mark = (
      <span {...stylex.props(styles.logo)}>
        <img alt="" src={term.src} {...stylex.props(styles.logoFile)} />
      </span>
    );
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

/**
 * One line as a sentence of the story: its words, the things it names as
 * pills, and where it goes when that differs from the rest. Pressed, what
 * can be done with it opens beside it.
 */
const Sentence = ({
  fact,
  marked,
  told,
  going,
  differs,
}: {
  fact: InterviewFact;
  marked: readonly string[];
  told: Told | null;
  going: Going;
  differs: boolean;
}) => {
  const [open, setOpen] = useState(false);
  const pieces = storyPieces(fact.text, marked);
  return (
    <Popover
      onOpenChange={(next) => {
        setOpen(next);
      }}
      open={open}
    >
      <PopoverAnchor asChild>
        <span
          aria-expanded={open}
          aria-haspopup="dialog"
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
            open && styles.open,
            told === "saying" && styles.saying,
            told === "waiting" && styles.waiting
          )}
        >
          {pieces.map((piece) =>
            piece.term === null ? (
              piece.text
            ) : (
              <TermPill key={piece.at} term={piece.term} text={piece.text} />
            )
          )}
          {differs ? (
            <>
              {" "}
              <GoingPill going={going} />
            </>
          ) : null}
        </span>
      </PopoverAnchor>
      <PopoverContent align="start">
        <LineEditor
          asking={going === "asking"}
          fact={fact}
          onDone={() => {
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
};

/** B: a line taken out, where it stood, struck through, with the way to put it back. */
const TakenOut = ({ fact }: { fact: InterviewFact }) => {
  const { t } = useLingui();
  const words = fact.text;
  return (
    <span {...stylex.props(fadeIn)}>
      <span {...stylex.props(styles.out)}>{fact.text}</span>{" "}
      <Button
        aria-label={t`Put back: ${words}`}
        onClick={() => {
          update((progress) => withFactToggled(progress, fact.id));
        }}
        size="xs"
        variant="ghost"
      >
        {t`Put back`}
      </Button>
    </span>
  );
};

/** The read-back told as a story, in concept `concept`. */
export const StoryReadBack = ({ concept }: { concept: ReadBackConcept }) => {
  const { t } = useLingui();
  const promise = usePromise();
  const kind = useKind();
  const loop = useLoop();
  const progress = useProgress();
  const { parts, at, part } = partAt(progress);
  const saidIn = useSaidIn(loop.line, loop.from);
  const said =
    loop.doing === "speaking" && loop.telling === null
      ? Math.max(loop.from, saidIn)
      : -1;
  const left = part?.facts.filter(({ out }) => out !== true) ?? [];
  const out = part?.facts.filter(({ out: taken }) => taken === true) ?? [];
  const agree = useAgree(left.length, out.length);
  if (part === undefined) {
    return null;
  }
  const marked = markedTerms(progress.lines, concept === "b");
  const most = mostOf(left.map((fact) => goingOf(fact, kind)));
  // Said once for the part; a sentence that goes elsewhere says so itself.
  let once = t`Only counted anonymously`;
  if (most === "team") {
    once = t`Shared as how your team works`;
  } else if (most === "asking") {
    once = t`Only used to know whom to ask`;
  }
  const n = at + 1;
  const count = parts.length;
  const taken = out.length;
  // A: the lines left; B: every line, those taken out where they stood.
  const shown = concept === "a" ? left : part.facts;
  return (
    <div {...stylex.props(looks.screen)}>
      <div {...stylex.props(looks.body)}>
        <div {...stylex.props(styles.head)}>
          {/* How much there is still to check: nobody agrees with care to pages without an end in sight. */}
          {count > 1 ? (
            <Badge
              size="sm"
              variant="outline"
            >{t`Part ${n} of ${count}`}</Badge>
          ) : null}
          <div aria-live="polite">
            <h1 {...stylex.props(looks.said)}>
              <SpokenText said={said} text={loop.line} />
            </h1>
          </div>
        </div>
        <p
          key={at}
          {...stylex.props(
            styles.story,
            fadeIn,
            concept === "b" && styles.storyQuiet
          )}
        >
          {shown.map((fact, place) => {
            const going = goingOf(fact, kind);
            return (
              <span key={fact.id}>
                {place > 0 ? " " : null}
                {fact.out === true ? (
                  <TakenOut fact={fact} />
                ) : (
                  <Sentence
                    differs={going !== most}
                    fact={fact}
                    going={going}
                    marked={marked}
                    told={toldOf(loop.telling, fact.id)}
                  />
                )}
              </span>
            );
          })}
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
        <div {...stylex.props(styles.actions)}>
          <Button
            disabled={loop.doing === "idle"}
            onClick={() => {
              agreeToPart(out.length > 0 ? `${agree}.` : undefined);
            }}
            size="lg"
          >
            {agree}
          </Button>
          {concept === "a" && out.length > 0 ? (
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
          ) : null}
        </div>
      </div>
    </div>
  );
};
