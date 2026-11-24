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
  DrawerBody,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@grasp-os/ui/components/drawer";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemSeparator,
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
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireSkip,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from "@grasp-os/ui/components/questionnaire";
import { Text } from "@grasp-os/ui/components/text";
import { media, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useNavigate } from "@tanstack/react-router";
import { Fragment, useState } from "react";

import { Page } from "../frame/page.tsx";
import { failureWords } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { briefOf, instructionsOf } from "./agent-brief.ts";
import { AgentFailure } from "./agent-facts.tsx";
import { offeredShapes, useLookWords } from "./agent-look.tsx";
import { agentTemplates } from "./agent-templates.ts";
import { AgentFigure, AgentFigureAura } from "./figure/agent-figure.tsx";
import { agentFigurePalettes, faceOf, lookFromName } from "./figure/look.ts";
import type { AgentFigureLook } from "./figure/look.ts";
import { finishSetup, keepOutcome } from "./finish-setup.ts";
import {
  cronOfSchedule,
  rhythms,
  scheduleOfRhythm,
  useScheduleWords,
} from "./schedule.ts";

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
const schedules = ["asked", ...rhythms] as const;
type Cadence = (typeof schedules)[number];

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
  schedule: Cadence;
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

/** One choice a question offers. */
interface Option {
  value: string;
  label: string;
  description?: string;
  recommended?: boolean;
}

/** What a question asks: one choice of its options, or the person's own words. */
interface Asked {
  question: string;
  kind: "single" | "text";
  options?: Option[];
  /** Whether the person may also answer in words of their own. @default true */
  other?: boolean;
  otherLabel?: string;
  columns?: 1 | 2;
  placeholder?: string;
}

/** The answer a question holds: a choice, or the person's own words. */
interface Answer {
  values: string[];
  /** Whether the words are the answer, not a choice. */
  other: boolean;
  words: string;
}

const styles = stylex.create({
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
    aspectRatio: { default: "16 / 7", [media.maxSm]: "4 / 3" },
    isolation: "isolate",
  },
  words: { display: "grid", gap: space["1"], marginBlockStart: space["3"] },
  // Back at the start of the question's actions, its way on at the end.
  actions: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space["2"],
    width: "100%",
  },
  end: { display: "flex", alignItems: "center", gap: space["2"] },
  head: {
    display: "flex",
    justifyContent: "space-between",
    gap: space["2"],
    width: "100%",
  },
});

/** The words each question, choice and answer is said in. */
const useWording = () => {
  const { t } = useLingui();
  const { shapeNameOf, paletteNames } = useLookWords();
  const schedule = useScheduleWords();
  const scheduleNameOf = (cadence: Cadence): string =>
    cadence === "asked"
      ? t`Only when asked`
      : schedule.of(scheduleOfRhythm(cadence, scheduledAt));
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
      shape: () => shapeNameOf(draft.look.shape),
      palette: () => paletteNames[draft.look.palette],
      audience: () => audienceNames[draft.audience],
      schedule: () => scheduleNameOf(draft.schedule),
      instructions: () =>
        draft.instructions === "" ? t`Nothing more` : draft.instructions,
    };
    return byStep[step]();
  };
  return {
    shapeNameOf,
    paletteNames,
    scheduleNameOf,
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

/**
 * One question, as a chat asks it: its choices as cards, with words of the
 * person's own where they may give them, Back to the question before, and
 * the way on. Mounted anew for each question, so its answer starts from
 * what the agent already holds.
 */
const Asking = ({
  question,
  answer,
  keep,
  submit,
  back,
  skip,
  ready,
  waitingWhy,
  index,
  count,
  last,
}: {
  question: Asked;
  answer: Answer;
  keep: (answer: Answer) => void;
  submit: () => void;
  back: (() => void) | undefined;
  skip: (() => void) | undefined;
  ready: boolean;
  waitingWhy: string;
  index: number;
  count: number;
  last: boolean;
}) => {
  const { t } = useLingui();
  const options = question.options ?? [];
  const typed = question.kind === "text";
  const ownWords = typed || question.other !== false;
  const position = index + 1;
  return (
    <Questionnaire
      aria-label={t`New agent`}
      onSubmit={() => {
        submit();
      }}
    >
      {/* The head of the question, where it is in the run at its end. */}
      <span {...stylex.props(styles.head)}>
        <Text as="span" color="muted" size="xs">
          {t`Question`}
        </Text>
        <Text as="span" color="muted" size="xs">
          {t`${position} of ${count}`}
        </Text>
      </span>
      <QuestionnaireItem name="answer" required={skip === undefined}>
        <QuestionnaireTitle>{question.question}</QuestionnaireTitle>
        {options.length === 0 ? null : (
          <QuestionnaireChoices columns={question.columns ?? 1}>
            {options.map((option) => (
              <QuestionnaireChoice
                checked={!answer.other && answer.values.includes(option.value)}
                key={option.value}
                onCheckedChange={(checked) => {
                  if (checked) {
                    keep({ values: [option.value], other: false, words: "" });
                  }
                }}
                recommended={option.recommended ?? false}
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
        {ownWords ? (
          <QuestionnaireInput
            aria-label={typed ? question.question : question.otherLabel}
            onValueChange={(words) => {
              keep({ values: [], other: !typed && words !== "", words });
            }}
            placeholder={typed ? question.placeholder : question.otherLabel}
            value={typed || answer.other ? answer.words : ""}
          />
        ) : null}
      </QuestionnaireItem>
      <QuestionnaireActions>
        <span {...stylex.props(styles.actions)}>
          {back === undefined ? (
            <span />
          ) : (
            <Button onClick={back} size="sm" variant="ghost">
              {t`Back`}
            </Button>
          )}
          <span {...stylex.props(styles.end)}>
            {skip === undefined ? null : (
              <QuestionnaireSkip
                onClick={(event) => {
                  event.preventDefault();
                  skip();
                }}
              />
            )}
            <QuestionnaireSubmit disabled={!ready} disabledReason={waitingWhy}>
              {last ? t`Review` : t`Next`}
            </QuestionnaireSubmit>
          </span>
        </span>
      </QuestionnaireActions>
    </Questionnaire>
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
  const [answers, setAnswers] = useState<Partial<Record<Step, Answer>>>({});
  const [reviewing, setReviewing] = useState(false);
  // Only one of the company's is asked who may ask it and when it works.
  const asked = steps.filter(
    (each) =>
      (each !== "audience" || company) &&
      (each !== "schedule" || draft.audience !== "me")
  );
  const step: Step = asked[at] ?? "instructions";
  const answer = answers[step];
  const template = agentTemplates.find(({ key }) => key === draft.template);
  const last = at === asked.length - 1;
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

  const keep = (next: Answer) => {
    setAnswers({ ...answers, [step]: next });
    // The figure answers a choice as it is pointed at, before Next.
    const [value] = next.values;
    const shape = offeredShapes.find((each) => each === value);
    const palette = agentFigurePalettes.find((each) => each === value);
    if (step === "shape" && shape !== undefined) {
      setDraft({ ...draft, look: { ...draft.look, shape } });
    }
    if (step === "palette" && palette !== undefined) {
      setDraft({ ...draft, look: { ...draft.look, palette } });
    }
  };

  const forward = () => {
    if (last) {
      setReviewing(true);
    } else {
      setAt(at + 1);
    }
  };

  /** What this step's answer makes of the agent. */
  const take = (given: Answer): Draft => {
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
    return byStep[step]();
  };

  // Each question, as the Questionnaire below asks it.
  const question = (() => {
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
          label: words.shapeNameOf(shape),
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
          label: words.scheduleNameOf(each),
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
    return byStep[step]();
  })();

  // Where the answer was never touched, the card starts from what the draft already holds.
  const startingAnswer = (): Answer => {
    const byStep: Record<Step, () => Answer> = {
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
    return byStep[step]();
  };

  // What the card shows, touched or not, is what Next takes.
  const shown = answer ?? startingAnswer();
  const submit = () => {
    setDraft(take(shown));
    forward();
  };
  const named =
    shown.other || shown.values.length === 0
      ? shown.words
      : (shown.values[0] ?? "");
  const nameTaken = step === "name" && isTaken(named);
  const given =
    question.kind === "text"
      ? shown.words.trim() !== ""
      : shown.values.length > 0 || (shown.other && shown.words.trim() !== "");
  const ready = !nameTaken && (step === "instructions" || given);

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
      const agent = mine
        ? await session.connections.makeOwnAgent(input)
        : await session.connections.makeAgent(input);
      // The rest part by part once it exists, its instructions first:
      // what fails then is said on its page, as the agent is made and its
      // name taken (finish-setup.ts). One of their own is never asked
      // whom it answers or when it works.
      const cron =
        mine || draft.schedule === "asked"
          ? undefined
          : cronOfSchedule(scheduleOfRhythm(draft.schedule, scheduledAt));
      const outcome = await finishSetup(
        session,
        agent.id,
        {
          instructions,
          apps: [],
          classes: [],
          reach:
            draft.audience === "everyone" ? { who: "everyone" } : undefined,
          wake:
            cron === undefined
              ? undefined
              : {
                  cron,
                  personId,
                  opening: draft.job === "" ? draft.name : draft.job,
                },
        },
        (error) => failureWords(error, i18n)
      );
      keepOutcome(agent.id, outcome);
      return { agent, outcome };
    });
    if (made === undefined) {
      // The button says it failed; why stands in the Drawer, from core.
      throw new Error("The agent wasn't made.");
    }
    let tab: "instructions" | "access" | undefined;
    if (made.outcome.unsaved.some(({ part }) => part === "instructions")) {
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
      // Made: Back leads to where New agent was opened from, never to
      // its questions again.
      replace: true,
    });
  };

  const answered = asked.slice(0, reviewing ? asked.length : at);
  const making = async (): Promise<void> => {
    await make();
  };
  return (
    <Page>
      <PageHeader title={t`New agent`} />
      <div {...stylex.props(styles.column)}>
        <Forming draft={draft} />
        {answered.length === 0 ? null : (
          <KeyValueList
            items={answered.map((each) => ({
              id: each,
              label: words.short[each],
              value: words.answerOf(each, draft),
            }))}
            orientation="horizontal"
          />
        )}
        {/* While the Drawer holds the whole agent, no question stands under it. */}
        {reviewing ? null : (
          <Asking
            answer={shown}
            back={
              at === 0
                ? undefined
                : () => {
                    setAt(at - 1);
                  }
            }
            count={asked.length}
            index={at}
            key={step}
            keep={keep}
            last={last}
            question={question}
            ready={ready}
            skip={
              step === "instructions"
                ? () => {
                    setDraft({ ...draft, instructions: "" });
                    setReviewing(true);
                  }
                : undefined
            }
            submit={submit}
            waitingWhy={
              nameTaken
                ? t`Another agent has this name`
                : t`Choose or write an answer first`
            }
          />
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
            <ItemGroup aria-label={t`The new agent`}>
              {asked.map((each, index) => (
                <Fragment key={each}>
                  {index === 0 ? null : <ItemSeparator />}
                  <Item size="sm">
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
                </Fragment>
              ))}
            </ItemGroup>
          </DrawerBody>
          <DrawerFooter>
            <DrawerClose>{t`Keep editing`}</DrawerClose>
            <Button
              errorText={t`Couldn't make it`}
              loadingText={t`Making`}
              onClick={making}
              size="sm"
            >
              {t`Make agent`}
            </Button>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    </Page>
  );
};
