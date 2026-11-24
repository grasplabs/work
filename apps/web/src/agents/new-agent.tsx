import type { Agent } from "@grasp-os/shared/agents";
import {
  instructionFileErrors,
  instructionsMaxLength,
  instructionsTooLong,
} from "@grasp-os/shared/instruction-files";
import { Button } from "@grasp-os/ui/components/button";
import {
  Card,
  CardDescription,
  CardMedia,
  CardTitle,
} from "@grasp-os/ui/components/card";
import {
  Drawer,
  DrawerClose,
  DrawerBody,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerContent,
  DrawerTitle,
} from "@grasp-os/ui/components/drawer";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { KeyValueList } from "@grasp-os/ui/components/key-value";
import { PageHeader } from "@grasp-os/ui/components/page-header";
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireError,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireProgress,
  QuestionnaireSkip,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from "@grasp-os/ui/components/questionnaire";
import { colors, font, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { pageText } from "../frame/page-text.ts";
import { useCoreAction } from "../use-core-action.ts";
import { SeparatedItems } from "../workflows/separated-items.tsx";
import { briefOf, instructionsOf } from "./agent-brief.ts";
import { AgentFailure } from "./agent-facts.tsx";
import { agentTemplates } from "./agent-templates.ts";
import { cronOf } from "./agent-wakes.tsx";
import { AgentFigure, AgentFigureAura } from "./figure/agent-figure.tsx";
import type { FigureShape as AgentFigureShape } from "./figure/body.ts";
import { faceOf, lookFromName } from "./figure/look.ts";
import { agentFigurePalettes } from "./figure/palettes.ts";
import type { AgentFigureLook, AgentFigurePalette } from "./figure/palettes.ts";
import { saveFirstInstructions } from "./unsaved-instructions.ts";

/** The shapes the shape question offers: the library's lit bodies a person can tell apart. */
const offeredShapes = [
  "orb",
  "trio",
  "pair",
  "swarm",
  "prism",
  "crystal",
  "planet",
] as const satisfies readonly AgentFigureShape[];

// A new agent: one of the company's, for its own admins, or one of the person's own, for anyone
// (core's agents.ts). Grasp asks what it should be, one question at a time,
// on Damsko's Questionnaire, the way a chat asks: what it should do (a starting point or the
// person's own words), what to call it, its shape and its colours, who may ask it, whether it
// works on its own and what it should always know. Above the questions the agent itself takes
// form as they are answered: its figure on its own night (figure/), changing shape and colour as
// a choice is pointed at, and its name and job under it. The answers so far stand under it, each
// a line. Once the last is answered, the whole agent waits in a Drawer, each answer with Change,
// and Make agent makes it. Core makes one of the company's on, reaching nobody and with nothing it
// may do (agent-builder.ts); the answers then set who may ask it and its schedule, and its page
// opens. One of the person's own ("Just for me") is theirs to ask at once, and is never asked who
// may ask it or when it works. Its instructions are saved as its instruction file once it is made;
// should that fail, its page opens on Instructions with them as an unsaved draft
// (unsaved-instructions.ts).

/** The questions, in the order they are asked. */
const steps = [
  "job",
  "name",
  "shape",
  "palette",
  "audience",
  "schedule",
  "instructions",
] as const;
type Step = (typeof steps)[number];

/** How often it may work on its own, as the first question about it offers. */
const schedules = ["asked", "weekdays", "daily", "mondays"] as const;
type Schedule = (typeof schedules)[number];

/** The hour a schedule chosen here runs at, in the company's time zone. */
const scheduledAt = "09:00";

/** The agent as the answers so far have it. */
interface Draft {
  /** The starting point chosen, by its key; undefined for the person's own words. */
  template: string | undefined;
  job: string;
  name: string;
  look: AgentFigureLook;
  /** `me`: one of the person's own. */
  audience: "everyone" | "nobody" | "me";
  schedule: Schedule;
  instructions: string;
}

const blank: Draft = {
  template: undefined,
  job: "",
  name: "",
  look: { shape: "orb", palette: "evergreen" },
  audience: "nobody",
  schedule: "asked",
  instructions: "",
};

/** One answer a question offers. */
interface Option {
  value: string;
  label: string;
  description?: string;
  recommended?: boolean;
}

/** What a question asks: a choice of options (with words of one's own unless `other` is false), or words alone. */
interface Asked {
  question: string;
  kind: "single" | "text";
  options?: Option[];
  other?: boolean;
  otherLabel?: string;
  columns?: 1 | 2;
  placeholder?: string;
}

/** A question's answer as the page holds it: what was picked, and words of one's own. */
interface QuestionAnswer {
  values: string[];
  other: boolean;
  words: string;
}

const styles = stylex.create({
  // A page's room, as #2503's frame gives it (28px above, 32px below, 24px
  // at its sides): no room for the chat's box, which this page hasn't.
  page: {
    gap: space["6"],
    paddingTop: space["7"],
    paddingBottom: space["8"],
    paddingInline: space["6"],
  },
  column: {
    display: "grid",
    gap: space["5"],
    width: "100%",
    maxWidth: "44rem",
    marginInline: "auto",
  },
  stage: {
    position: "relative",
    display: "grid",
    placeItems: "center",
    aspectRatio: { default: "16 / 7", "@media (width < 40rem)": "4 / 3" },
    isolation: "isolate",
  },
  words: { display: "grid", gap: space["1"], marginBlockStart: space["3"] },
  // The question as wide as the agent's card above it.
  whole: { width: "100%", maxWidth: "none" },
  // The old question card's height for its answers, room inside for a card's lift and ring.
  capped: {
    display: "grid",
    gap: space["2"],
    maxHeight: "18rem",
    overflowY: "auto",
    scrollbarWidth: "none",
    padding: space["1"],
    margin: `calc(-1 * ${space["1"]})`,
  },
  // Two columns stand as one on a phone: twice the rows, twice the room.
  cappedTwo: {
    maxHeight: { default: "36rem", "@media (width >= 40rem)": "18rem" },
  },
  fadeEnd: {
    maskImage: `linear-gradient(to bottom, black calc(100% - ${space["6"]}), transparent)`,
  },
  fadeStart: {
    maskImage: `linear-gradient(to top, black calc(100% - ${space["6"]}), transparent)`,
  },
  fadeBoth: {
    maskImage: `linear-gradient(to bottom, transparent, black ${space["6"]}, black calc(100% - ${space["6"]}), transparent)`,
  },
  // Why Next waits, at the start of the actions' row, as a held Send says it.
  reason: {
    order: -1,
    flexGrow: 1,
    flexBasis: 0,
    minWidth: "10rem",
    margin: 0,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    color: colors.mutedForeground,
  },
});

/** The words each question, choice and answer is said in. */
const useWording = () => {
  const { t } = useLingui();
  const shapeNames: Partial<Record<AgentFigureShape, string>> = {
    orb: t`Orb`,
    trio: t`Three circling`,
    pair: t`Pair in orbit`,
    swarm: t`Swarm`,
    prism: t`Triangle`,
    crystal: t`Crystal`,
    planet: t`Planet`,
  };
  const paletteNames: Record<AgentFigurePalette, string> = {
    evergreen: t`Evergreen`,
    meadow: t`Meadow`,
    ember: t`Ember`,
    amber: t`Amber`,
    ocean: t`Ocean`,
    moon: t`Moon`,
  };
  const scheduleNames: Record<Schedule, string> = {
    asked: t`Only when asked`,
    weekdays: t`Every weekday at 9:00`,
    daily: t`Every day at 9:00`,
    mondays: t`Every Monday at 9:00`,
  };
  const audienceNames: Record<Draft["audience"], string> = {
    everyone: t`Everyone in the company`,
    nobody: t`Nobody yet`,
    me: t`Just for me`,
  };
  const short: Record<Step, string> = {
    job: t`What it does`,
    name: t`Name`,
    shape: t`Shape`,
    palette: t`Colours`,
    audience: t`Who may ask it`,
    schedule: t`On its own`,
    instructions: t`What it always knows`,
  };
  const answerOf = (step: Step, draft: Draft): string => {
    const byStep: Record<Step, () => string> = {
      job: () => draft.job,
      name: () => draft.name,
      shape: () => shapeNames[draft.look.shape] ?? "",
      palette: () => paletteNames[draft.look.palette],
      audience: () => audienceNames[draft.audience],
      schedule: () => scheduleNames[draft.schedule],
      instructions: () =>
        draft.instructions === "" ? t`Nothing more` : draft.instructions,
    };
    return byStep[step]();
  };
  return {
    shapeNames,
    paletteNames,
    scheduleNames,
    audienceNames,
    short,
    answerOf,
  };
};

/** The agent taking form: its figure on its own night, and its name and job once said. */
const Forming = ({ draft }: { draft: Draft }) => {
  const { t } = useLingui();
  return (
    <Card>
      <CardMedia>
        <span {...stylex.props(styles.stage)}>
          <AgentFigureAura ground="page" look={draft.look} />
          <AgentFigure
            follow
            aria-label={draft.name === "" ? t`The new agent` : draft.name}
            look={draft.look}
            size="xl"
            state="idle"
          />
        </span>
      </CardMedia>
      {draft.name === "" && draft.job === "" ? null : (
        <span {...stylex.props(styles.words)}>
          {draft.name === "" ? null : <CardTitle>{draft.name}</CardTitle>}
          {draft.job === "" ? null : (
            <CardDescription>{draft.job}</CardDescription>
          )}
        </span>
      )}
    </Card>
  );
};

/** The cleanup of an effect that started nothing. */
const keepNothing = () => {
  // Nothing was watched.
};

/**
 * The answers, held to the old question card's height: a longer list
 * scrolls with no bar, the edge with more past it fading out, so a choice
 * is never cut off in silence.
 */
const Capped = ({
  twoColumns,
  children,
}: {
  twoColumns: boolean;
  children: ReactNode;
}) => {
  const box = useRef<HTMLDivElement>(null);
  const [under, setUnder] = useState({ start: false, end: false });
  useEffect(() => {
    const element = box.current;
    if (element === null) {
      return keepNothing;
    }
    const mark = () => {
      const room = element.scrollHeight - element.clientHeight;
      const start = room > 1 && element.scrollTop > 1;
      const end = room > 1 && element.scrollTop < room - 1;
      setUnder((was) =>
        was.start === start && was.end === end ? was : { start, end }
      );
    };
    const watch = new ResizeObserver(mark);
    watch.observe(element);
    element.addEventListener("scroll", mark, { passive: true });
    return () => {
      watch.disconnect();
      element.removeEventListener("scroll", mark);
    };
  }, []);
  return (
    <div
      ref={box}
      {...stylex.props(
        styles.capped,
        twoColumns && styles.cappedTwo,
        under.end && !under.start && styles.fadeEnd,
        under.start && !under.end && styles.fadeStart,
        under.start && under.end && styles.fadeBoth
      )}
    >
      {children}
    </div>
  );
};

/** One question as the Questionnaire's item: its options as choices, words of one's own, or both. */
const AskedItem = ({
  name,
  asked,
  answer,
  keep,
  taken,
}: {
  name: Step;
  asked: Asked;
  answer: QuestionAnswer;
  keep: (next: QuestionAnswer) => void;
  /** The name written is another agent's. */
  taken: boolean;
}) => {
  const { t } = useLingui();
  const words =
    asked.kind === "text" || asked.other !== false ? (
      <QuestionnaireInput
        {...(asked.kind === "text" ? {} : { "aria-label": asked.otherLabel })}
        onValueChange={(value) => {
          keep({ values: [], other: asked.kind !== "text", words: value });
        }}
        placeholder={asked.placeholder ?? asked.otherLabel}
        value={answer.other || asked.kind === "text" ? answer.words : ""}
      />
    ) : null;
  return (
    <QuestionnaireItem
      invalid={taken}
      name={name}
      required={name !== "instructions"}
    >
      <QuestionnaireTitle>{asked.question}</QuestionnaireTitle>
      <Capped twoColumns={asked.columns === 2}>
        {asked.options === undefined ? null : (
          <QuestionnaireChoices columns={asked.columns ?? 1}>
            {asked.options.map((option) => (
              <QuestionnaireChoice
                checked={!answer.other && answer.values.includes(option.value)}
                key={option.value}
                onCheckedChange={(checked) => {
                  if (checked) {
                    keep({ values: [option.value], other: false, words: "" });
                  }
                }}
                recommended={option.recommended === true}
                value={option.value}
              >
                {option.label}
                {option.description === undefined ? null : (
                  <QuestionnaireChoiceDescription>
                    {option.description}
                  </QuestionnaireChoiceDescription>
                )}
              </QuestionnaireChoice>
            ))}
          </QuestionnaireChoices>
        )}
        {words}
      </Capped>
      <QuestionnaireError>
        {taken ? t`Another agent has this name` : undefined}
      </QuestionnaireError>
    </QuestionnaireItem>
  );
};

/** The new agent's page: the questions, the agent taking form, and the summary in a Drawer. */
export const NewAgent = ({
  personId,
  taken,
  company,
  own,
}: {
  /** The person making it: a schedule chosen here works for them. */
  personId: string;
  /** The names other agents have: core keeps each name to one agent, in any case or accent. */
  taken: readonly string[];
  /** Whether they may make one for the company: its own admins. */
  company: boolean;
  /** Whether the company lets people have agents of their own. */
  own: boolean;
}) => {
  const { t, i18n } = useLingui();
  const words = useWording();
  const navigate = useNavigate();
  const { failure, run } = useCoreAction();
  const [draft, setDraft] = useState<Draft>({
    ...blank,
    // An admin's starts as the company's, as the guided setup's does.
    audience: company ? "everyone" : "me",
  });
  const [at, setAt] = useState(0);
  const [answers, setAnswers] = useState<Partial<Record<Step, QuestionAnswer>>>(
    {}
  );
  const [reviewing, setReviewing] = useState(false);
  // The agent once made, while its other saves are still to go through.
  const [created, setCreated] = useState<Agent>();
  // Only one of the company's is asked who may ask it and when it works.
  const asked = steps.filter(
    (each) =>
      (each !== "audience" || company) &&
      (each !== "schedule" || draft.audience !== "me")
  );
  const step: Step = asked[at] ?? "instructions";
  const template = agentTemplates.find(({ key }) => key === draft.template);
  const isTaken = (name: string): boolean =>
    taken.some(
      (other) =>
        other.localeCompare(name.trim(), undefined, { sensitivity: "base" }) ===
        0
    );
  /** The names the starting point suggests that no other agent has. */
  const freeNames = (from: typeof template): string[] =>
    (from?.names ?? [])
      .map((name) => i18n._(name))
      .filter((name) => !isTaken(name));

  const keep = (next: QuestionAnswer, where: Step = step) => {
    setAnswers({ ...answers, [where]: next });
    // The figure answers a choice as it is pointed at, before Next.
    const [value] = next.values;
    const shape = offeredShapes.find((each) => each === value);
    const palette = agentFigurePalettes.find((each) => each === value);
    if (where === "shape" && shape !== undefined) {
      setDraft({ ...draft, look: { ...draft.look, shape } });
    }
    if (where === "palette" && palette !== undefined) {
      setDraft({ ...draft, look: { ...draft.look, palette } });
    }
  };

  /** What a step's answer makes of the agent. */
  const take = (given: QuestionAnswer, of: Step): Draft => {
    const [value] = given.values;
    const typed = given.words.trim();
    const byStep: Record<Step, () => Draft> = {
      job: () => {
        const chosen = agentTemplates.find(({ key }) => key === value);
        if (chosen === undefined || given.other) {
          return { ...draft, template: undefined, job: typed };
        }
        // Another starting point brings its own name, unless this one's was kept.
        const name =
          chosen.key === draft.template && draft.name !== ""
            ? draft.name
            : (freeNames(chosen)[0] ?? "");
        // A look of its own from the start, so two agents made in a row differ,
        // until a shape or colours were chosen.
        const chosenLook =
          answers.shape !== undefined || answers.palette !== undefined;
        return {
          ...draft,
          template: chosen.key,
          job: i18n._(chosen.job),
          name,
          look: chosenLook ? draft.look : lookFromName(name),
          instructions: instructionsOf(briefOf(chosen, i18n), i18n),
        };
      },
      name: () => ({
        ...draft,
        name: given.other || value === undefined ? typed : value,
      }),
      audience: () => ({
        ...draft,
        audience: value === "everyone" || value === "me" ? value : "nobody",
      }),
      schedule: () => ({
        ...draft,
        schedule: schedules.find((each) => each === value) ?? "asked",
      }),
      instructions: () => ({ ...draft, instructions: given.words.trim() }),
      // The look follows the choice as it is pointed at (keep).
      shape: () => draft,
      palette: () => draft,
    };
    return byStep[of]();
  };

  // Each question as the Questionnaire asks it.
  const questionOf = (of: Step): Asked => {
    const byStep: Record<Step, () => Asked> = {
      job: () => ({
        question: t`What should the agent do? Pick a starting point or say it in your own words.`,
        kind: "single" as const,
        options: agentTemplates.map(({ key, label, description }): Option => ({
          value: key,
          label: i18n._(label),
          description: i18n._(description),
        })),
        otherLabel: t`Something else`,
      }),
      name: (): Asked => {
        const free = freeNames(template);
        if (free.length === 0) {
          return {
            question: t`What should we call it?`,
            kind: "text" as const,
            placeholder: t`Invoice chaser`,
          };
        }
        return {
          question: t`What should we call it?`,
          kind: "single" as const,
          options: free.map((name, index): Option => ({
            value: name,
            label: name,
            recommended: index === 0,
          })),
          otherLabel: t`Another name`,
        };
      },
      shape: () => ({
        question: t`What shape should it take?`,
        kind: "single" as const,
        options: offeredShapes.map((shape): Option => ({
          value: shape,
          label: words.shapeNames[shape] ?? shape,
        })),
        other: false,
        columns: 2 as const,
      }),
      palette: () => ({
        question: t`Which colours should it have?`,
        kind: "single" as const,
        options: agentFigurePalettes.map((palette): Option => ({
          value: palette,
          label: words.paletteNames[palette],
        })),
        other: false,
        columns: 2 as const,
      }),
      audience: () => ({
        question: t`Who may ask it?`,
        kind: "single" as const,
        options: [
          {
            value: "everyone",
            label: words.audienceNames.everyone,
            description: t`Everyone in the company can ask it.`,
            recommended: true,
          },
          {
            value: "nobody",
            label: words.audienceNames.nobody,
            description: t`You choose people and teams on its page`,
          },
          ...(own
            ? [
                {
                  value: "me",
                  label: words.audienceNames.me,
                  description: t`Only you see and ask it. It does at most what Grasp may do for you.`,
                },
              ]
            : []),
        ],
        other: false,
      }),
      schedule: () => ({
        question: t`Should it work on its own?`,
        kind: "single" as const,
        options: schedules.map((each): Option => ({
          value: each,
          label: words.scheduleNames[each],
          ...(each === "asked" ? { recommended: true } : {}),
          ...(each === "asked"
            ? {}
            : {
                description: t`It reads, and what it wants to change waits for you`,
              }),
        })),
        other: false,
      }),
      instructions: () => ({
        question: t`Anything it should always know?`,
        kind: "text" as const,
        placeholder: t`What it should know and how it should work.`,
      }),
    };
    return byStep[of]();
  };

  // Where the answer was never touched, the card starts from what the draft already holds.
  const startingAnswer = (of: Step): QuestionAnswer => {
    const byStep: Record<Step, () => QuestionAnswer> = {
      job: () =>
        draft.template === undefined
          ? { values: [], other: draft.job !== "", words: draft.job }
          : { values: [draft.template], other: false, words: "" },
      name: () => {
        const offered = freeNames(template);
        if (offered.length === 0) {
          return { values: [], other: false, words: draft.name };
        }
        return offered.includes(draft.name)
          ? { values: [draft.name], other: false, words: "" }
          : { values: [], other: draft.name !== "", words: draft.name };
      },
      shape: () => ({ values: [draft.look.shape], other: false, words: "" }),
      palette: () => ({
        values: [draft.look.palette],
        other: false,
        words: "",
      }),
      audience: () => ({ values: [draft.audience], other: false, words: "" }),
      schedule: () => ({ values: [draft.schedule], other: false, words: "" }),
      instructions: () => ({
        values: [],
        other: false,
        words: draft.instructions,
      }),
    };
    return byStep[of]();
  };

  // What the questions show, touched or not, is what Next takes.
  const shownAt = (each: Step): QuestionAnswer =>
    answers[each] ?? startingAnswer(each);
  const shown = shownAt(step);
  const named =
    shown.other || shown.values.length === 0
      ? shown.words
      : (shown.values[0] ?? "");
  const nameTaken = step === "name" && isTaken(named);
  const asking = questionOf(step);
  const given =
    asking.kind === "text"
      ? shown.words.trim() !== ""
      : shown.values.length > 0 || (shown.other && shown.words.trim() !== "");
  // Next waits for an answer, and says why while it does.
  const ready = !nameTaken && (step === "instructions" || given);
  /** On to `next` (a step after this one takes this one's answer), or back. */
  const moveTo = (next: string) => {
    const going = asked.find((each) => each === next);
    const index = going === undefined ? -1 : asked.indexOf(going);
    if (index === -1) {
      return;
    }
    if (index > at) {
      // Not on while the answer can't be taken (a name another agent has).
      if (!ready) {
        return;
      }
      setDraft(take(shown, step));
    }
    setAt(index);
  };

  const make = async (): Promise<void> => {
    const { instructions } = draft;
    const mine = draft.audience === "me";
    const made = await run(async (session) => {
      // Refused before anything is made, as their save would be.
      if (instructionsTooLong(instructions)) {
        throw instructionFileErrors.create("instructions.too_large", {
          maxLength: instructionsMaxLength,
        });
      }
      const input = {
        name: draft.name,
        job: draft.job,
        face: faceOf(draft.look),
        model: null,
        modelRole: null,
      };
      // Made once: a save after it that failed is tried again on the same
      // agent, not by making another of the same name.
      const agent =
        created ??
        (mine
          ? await session.connections.makeOwnAgent(input)
          : await session.connections.makeAgent(input));
      setCreated(agent);
      const told =
        instructions.trim() === "" ||
        (await saveFirstInstructions(session, agent.id, instructions));
      if (mine) {
        return { agent, told };
      }
      if (draft.audience === "everyone") {
        await session.connections.setAgentReach(agent.id, true, {
          who: "everyone",
        });
      }
      const cron =
        draft.schedule === "asked"
          ? undefined
          : cronOf(draft.schedule, scheduledAt);
      if (cron !== undefined) {
        await session.connections.makeAgentWake(agent.id, {
          cron,
          personId,
          opening: draft.job === "" ? draft.name : draft.job,
        });
      }
      return { agent, told };
    });
    if (made === undefined) {
      // The button says it failed; why stands in the Drawer, from core.
      throw new Error("The agent wasn't made.");
    }
    let tab: "instructions" | "access" | undefined;
    if (!made.told) {
      // Its instructions didn't save: its page opens where they wait.
      tab = "instructions";
    } else if (draft.audience === "nobody") {
      // Nobody may ask it yet: its page opens where that is chosen.
      tab = "access";
    }
    await navigate({
      to: "/agents/$agent",
      params: { agent: made.agent.id },
      search: tab === undefined ? {} : { tab },
    });
  };

  const answered = asked.slice(0, reviewing ? asked.length : at);
  return (
    <div {...stylex.props(pageText.text, styles.page)}>
      <PageHeader title={t`New agent`} />
      <div {...stylex.props(styles.column)}>
        <Forming draft={draft} />
        {answered.length === 0 ? null : (
          <KeyValueList
            orientation="horizontal"
            items={answered.map((each) => ({
              id: each,
              label: words.short[each],
              value: words.answerOf(each, draft),
            }))}
          />
        )}
        {/* While the Drawer holds the whole agent, no question stands under it. */}
        {reviewing ? null : (
          <Questionnaire
            item={step}
            items={asked.map((each) => ({
              name: each,
              required: each !== "instructions",
            }))}
            onItemChange={moveTo}
            onSubmit={(sent) => {
              // The last question: its words, or nothing where it was skipped.
              setDraft({
                ...take(shown, step),
                ...(sent[step] === undefined ? { instructions: "" } : {}),
              });
              setReviewing(true);
            }}
            style={styles.whole}
          >
            <QuestionnaireProgress>{t`Question`}</QuestionnaireProgress>
            {asked.map((each) => (
              <AskedItem
                answer={shownAt(each)}
                asked={questionOf(each)}
                key={each}
                keep={(next) => {
                  keep(next, each);
                }}
                name={each}
                taken={each === "name" && each === step && nameTaken}
              />
            ))}
            <QuestionnaireActions>
              <QuestionnairePrevious variant="ghost">
                {t`Back`}
              </QuestionnairePrevious>
              <QuestionnaireSkip />
              <QuestionnaireNext />
              <QuestionnaireSubmit>{t`Review`}</QuestionnaireSubmit>
            </QuestionnaireActions>
          </Questionnaire>
        )}
      </div>
      <Drawer
        onOpenChange={(open) => {
          setReviewing(open);
        }}
        open={reviewing}
      >
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>{draft.name}</DrawerTitle>
            <DrawerDescription>{draft.job}</DrawerDescription>
          </DrawerHeader>
          <DrawerBody>
            {/* Why it wasn't made, from core, above what to change. */}
            <AgentFailure>{failure}</AgentFailure>
            <SeparatedItems
              aria-label={t`The new agent`}
              rows={asked.map((each, index) => ({
                key: each,
                row: (
                  <Item key={each} size="sm">
                    <ItemContent>
                      <ItemTitle>{words.short[each]}</ItemTitle>
                      <ItemDescription>
                        {words.answerOf(each, draft)}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <Button
                        onClick={() => {
                          setReviewing(false);
                          setAt(index);
                        }}
                        size="sm"
                        variant="ghost"
                      >
                        {t`Change`}
                      </Button>
                    </ItemActions>
                  </Item>
                ),
              }))}
            />
          </DrawerBody>
          <DrawerFooter>
            <DrawerClose>{t`Keep editing`}</DrawerClose>
            <Button
              errorText={t`Couldn't make it`}
              loadingText={t`Making`}
              onClick={make}
              size="sm"
            >
              {t`Make agent`}
            </Button>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    </div>
  );
};
