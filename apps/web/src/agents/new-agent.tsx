import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useNavigate } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import type { ReactNode } from "react";

import { Page, PageHeading } from "../frame/page.tsx";
import { Button } from "../grasp/button/index.ts";
import {
  Card,
  CardDescription,
  CardMedia,
  CardTitle,
} from "../grasp/card/index.ts";
import { ChatMessage } from "../grasp/chat-message/index.ts";
import {
  Drawer,
  DrawerAction,
  DrawerBody,
  DrawerDescription,
  DrawerFooter,
  DrawerContent,
  DrawerTitle,
} from "../grasp/drawer/index.ts";
import { Field, FieldLabel } from "../grasp/field/index.ts";
import { Heading } from "../grasp/heading/index.ts";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "../grasp/item/index.ts";
import { KeyValueList } from "../grasp/key-value/index.ts";
import { QuestionTool } from "../grasp/question-tool/index.ts";
import type {
  QuestionAnswer,
  QuestionKind,
  QuestionOption,
} from "../grasp/question-tool/index.ts";
import { Text } from "../grasp/text/index.ts";
import { Textarea } from "../grasp/textarea/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { useCoreAction } from "../use-core-action.ts";
import { AgentFailure } from "./agent-facts.tsx";
import { agentTemplates } from "./agent-templates.ts";
import { cronOf } from "./agent-wakes.tsx";
import { AgentAura, AgentFigure } from "./figure/agent-figure.tsx";
import { figureShapes } from "./figure/body.ts";
import type { FigureShape } from "./figure/body.ts";
import { faceOf, figurePalettes, lookFromName } from "./figure/look.ts";
import type { FigureLook, FigurePalette } from "./figure/look.ts";

// A new agent, for the company's admins: Grasp asks what it should be, one question at a time,
// on Damsko's Question tool, the way a chat asks: what it should do (a starting point or the
// person's own words), what to call it, its shape and its colours, who may ask it, whether it
// works on its own and what it should always know. Above the questions the agent itself takes
// form as they are answered: its figure on its own night (figure/), changing shape and colour as
// a choice is pointed at, and its name and job under it. The answers so far stand under it, each
// a line. Once the last is answered, the whole agent waits in a Drawer, each answer with Change,
// and Make agent makes it. Core makes it on, reaching nobody and with nothing it may do
// (agent-builder.ts); the answers then set who may ask it and its schedule, and its page opens.

/** CONCEPT: which way the questions are asked, from `?concept=` in the address. */
const conceptOf = (): "a" | "b" | "c" | "now" => {
  const asked =
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("concept");
  return asked === "a" || asked === "b" || asked === "c" ? asked : "now";
};

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
  look: FigureLook;
  audience: "everyone" | "nobody";
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

/** What a question asks, as Damsko's Question tool takes it. */
interface Asked {
  question: string;
  kind: QuestionKind;
  options?: QuestionOption[];
  other?: boolean;
  otherLabel?: string;
  columns?: 1 | 2;
  placeholder?: string;
}

const styles = stylex.create({
  column: {
    display: "grid",
    gap: grasp.space5,
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
  words: { display: "grid", gap: grasp.space1, marginBlockStart: grasp.space3 },
  // CONCEPT A: the questions as a conversation, the agent forming in its head.
  chatHead: { display: "flex", alignItems: "center", gap: grasp.space4 },
  chatWords: { display: "grid", gap: grasp.space1, minWidth: 0 },
  chat: { display: "grid", gap: grasp.space4 },
  // CONCEPT B: the question beside the agent taking form.
  beside: {
    display: "grid",
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      "@media (width >= 64rem)": "minmax(0, 1fr) 22rem",
    },
    alignItems: "start",
    gap: grasp.space6,
    width: "100%",
    maxWidth: "64rem",
    marginInline: "auto",
  },
  besideMain: {
    display: "grid",
    minWidth: 0,
    order: { default: 2, "@media (width >= 64rem)": 1 },
  },
  besideCard: {
    display: "grid",
    gap: grasp.space4,
    order: { default: 1, "@media (width >= 64rem)": 2 },
    position: { default: "static", "@media (width >= 64rem)": "sticky" },
    insetBlockStart: grasp.space6,
  },
  // CONCEPT C: the starting points, as words to begin from.
  starts: { display: "flex", flexWrap: "wrap", gap: grasp.space2 },
  // The question as wide as the agent's card above it.
  whole: { width: "100%", maxWidth: "none" },
});

/** The words each question, choice and answer is said in. */
const useWording = () => {
  const { t } = useLingui();
  const shapeNames: Record<FigureShape, string> = {
    orb: t`Orb`,
    trio: t`Three circling`,
    pair: t`Pair in orbit`,
    swarm: t`Swarm`,
    prism: t`Triangle`,
    crystal: t`Crystal`,
    planet: t`Planet`,
  };
  const paletteNames: Record<FigurePalette, string> = {
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
      shape: () => shapeNames[draft.look.shape],
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
          <AgentAura look={draft.look} />
          <AgentFigure
            follow
            label={draft.name === "" ? t`The new agent` : draft.name}
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

/** CONCEPT: the page's body, as concept `concept` asks. */
const Concepted = ({
  concept,
  draft,
  tool,
  chat,
  first,
  describe,
}: {
  concept: "a" | "b" | "c" | "now";
  draft: Draft;
  tool: ReactNode;
  chat: readonly {
    step: Step;
    short: string;
    question: string;
    answer: string;
  }[];
  /** Before the first answer, with the Drawer closed. */
  first: boolean;
  describe: {
    described: string;
    onDescribe: (value: string) => void;
    onDraft: () => void;
  };
}) => {
  const { t, i18n } = useLingui();
  const sofar =
    chat.length === 0 ? null : (
      <KeyValueList
        variant="inline"
        items={chat.map(({ short, answer }) => ({ key: short, value: answer }))}
      />
    );
  let inside = (
    <div {...stylex.props(styles.column)}>
      <Forming draft={draft} />
      {sofar}
      {tool}
    </div>
  );
  if (concept === "a") {
    inside = (
      <div {...stylex.props(styles.column)}>
        <span {...stylex.props(styles.chatHead)}>
          <AgentFigure look={draft.look} size="md" state="listening" />
          <span {...stylex.props(styles.chatWords)}>
            <Heading level={2} size="ui">
              {draft.name === "" ? t`The new agent` : draft.name}
            </Heading>
            {draft.job === "" ? null : (
              <Text size="sm" tone="muted">
                {draft.job}
              </Text>
            )}
          </span>
        </span>
        <div {...stylex.props(styles.chat)}>
          {chat.map((each) => (
            <Fragment key={each.step}>
              <ChatMessage from="agent" name="Grasp">
                {each.question}
              </ChatMessage>
              <ChatMessage from="person">{each.answer}</ChatMessage>
            </Fragment>
          ))}
        </div>
        {tool}
      </div>
    );
  }
  if (concept === "b") {
    inside = (
      <div {...stylex.props(styles.beside)}>
        <div {...stylex.props(styles.besideMain)}>{tool}</div>
        <aside {...stylex.props(styles.besideCard)}>
          <Forming draft={draft} />
          {sofar}
        </aside>
      </div>
    );
  }
  if (concept === "c" && first && draft.job === "") {
    inside = (
      <div {...stylex.props(styles.column)}>
        <Forming draft={draft} />
        <Field>
          <FieldLabel>{t`What should it do?`}</FieldLabel>
          <Textarea
            onValueChange={(value) => {
              describe.onDescribe(value);
            }}
            placeholder={t`Every Monday, look for invoices more than two weeks overdue and draft a friendly reminder to each client.`}
            rows={4}
            value={describe.described}
          />
        </Field>
        <span {...stylex.props(styles.starts)}>
          {agentTemplates.map((each) => (
            <Button
              key={each.key}
              onClick={() => {
                describe.onDescribe(i18n._(each.description));
              }}
              size="sm"
              variant="quiet"
            >
              {i18n._(each.label)}
            </Button>
          ))}
        </span>
        <span>
          <Button
            disabled={describe.described.trim() === ""}
            onClick={() => {
              describe.onDraft();
            }}
            variant="ink"
          >
            {t`Draft it`}
          </Button>
        </span>
      </div>
    );
  }
  return inside;
};

/** The new agent's page: the questions, the agent taking form, and the summary in a Drawer. */
export const NewAgent = ({
  personId,
  taken,
}: {
  /** The person making it: a schedule chosen here works for them. */
  personId: string;
  /** The names other agents have: core keeps each name to one agent, in any case or accent. */
  taken: readonly string[];
}) => {
  const { t, i18n } = useLingui();
  const words = useWording();
  const navigate = useNavigate();
  const { failure, run } = useCoreAction();
  const [draft, setDraft] = useState<Draft>(blank);
  const [at, setAt] = useState(0);
  const [answers, setAnswers] = useState<Partial<Record<Step, QuestionAnswer>>>(
    {}
  );
  const [reviewing, setReviewing] = useState(false);
  const [described, setDescribed] = useState("");
  const step: Step = steps[at] ?? "instructions";
  const answer = answers[step];
  const template = agentTemplates.find(({ key }) => key === draft.template);
  const last = at === steps.length - 1;
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

  const keep = (next: QuestionAnswer) => {
    setAnswers({ ...answers, [step]: next });
    // The figure answers a choice as it is pointed at, before Next.
    const [value] = next.values;
    const shape = figureShapes.find((each) => each === value);
    const palette = figurePalettes.find((each) => each === value);
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
  const take = (given: QuestionAnswer): Draft => {
    const [value] = given.values;
    const own = given.words.trim();
    const byStep: Record<Step, () => Draft> = {
      job: () => {
        const chosen = agentTemplates.find(({ key }) => key === value);
        if (chosen === undefined || given.other) {
          return { ...draft, template: undefined, job: own };
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
          instructions: i18n._(chosen.instructions),
        };
      },
      name: () => ({
        ...draft,
        name: given.other || value === undefined ? own : value,
      }),
      audience: () => ({
        ...draft,
        audience: value === "everyone" ? "everyone" : "nobody",
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

  // Each question as Damsko's Question tool asks it.
  const askedOf = (asked: Step): Asked => {
    const byStep: Record<Step, () => Asked> = {
      job: () => ({
        question: t`What should the agent do? Pick a starting point or say it in your own words.`,
        kind: "single" as const,
        options: agentTemplates.map(
          ({ key, label, description }): QuestionOption => ({
            value: key,
            label: i18n._(label),
            description: i18n._(description),
          })
        ),
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
          options: free.map((name, index): QuestionOption => ({
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
        options: figureShapes.map((shape): QuestionOption => ({
          value: shape,
          label: words.shapeNames[shape],
        })),
        other: false,
        columns: 2 as const,
      }),
      palette: () => ({
        question: t`Which colours should it have?`,
        kind: "single" as const,
        options: figurePalettes.map((palette): QuestionOption => ({
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
            value: "nobody",
            label: words.audienceNames.nobody,
            description: t`You choose people and teams on its page`,
            recommended: true,
          },
          {
            value: "everyone",
            label: words.audienceNames.everyone,
            description: t`It does nothing yet until you allow it`,
          },
        ],
        other: false,
      }),
      schedule: () => ({
        question: t`Should it work on its own?`,
        kind: "single" as const,
        options: schedules.map((each): QuestionOption => ({
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
    return byStep[asked]();
  };
  const question = askedOf(step);

  // Where the answer was never touched, the card starts from what the draft already holds.
  const startingAnswer = (): QuestionAnswer => {
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
    const made = await run(async (session) => {
      const agent = await session.connections.makeAgent({
        name: draft.name,
        job: draft.job,
        instructions: draft.instructions,
        face: faceOf(draft.look),
        model: null,
        modelRole: null,
      });
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
      return agent;
    });
    if (made === undefined) {
      // The button says it failed; why stands in the Drawer, from core.
      throw new Error("The agent wasn't made.");
    }
    await navigate({
      to: "/agents/$agent",
      params: { agent: made.id },
      // Nobody may ask it yet: its page opens where that is chosen.
      search: draft.audience === "nobody" ? { tab: "access" } : {},
    });
  };

  const answered = steps.slice(0, reviewing ? steps.length : at);
  // CONCEPT: which way the questions are asked, from `?concept=` in the address.
  const concept = conceptOf();
  const tool = reviewing ? null : (
    <QuestionTool
      {...question}
      failedLabel={t`Couldn't take that answer`}
      key={step}
      layout={styles.whole}
      onBack={
        at === 0
          ? undefined
          : () => {
              setAt(at - 1);
            }
      }
      onSubmit={submit}
      onValueChange={keep}
      {...(step === "instructions"
        ? {
            onSkip: () => {
              setDraft({ ...draft, instructions: "" });
              setReviewing(true);
            },
          }
        : {})}
      step={{ index: at, count: steps.length }}
      submitDisabled={!ready}
      submitDisabledReason={
        nameTaken
          ? t`Another agent has this name`
          : t`Choose or write an answer first`
      }
      submitLabel={last ? t`Review` : t`Next`}
      value={shown}
    />
  );
  // CONCEPT C: describe it once, and Grasp drafts the whole agent from it.
  const drafted = (): void => {
    const said = described.trim();
    const lower = said.toLowerCase();
    const near =
      agentTemplates.find((each) =>
        i18n
          ._(each.label)
          .toLowerCase()
          .split(" ")
          .some((word) => word.length > 4 && lower.includes(word.slice(0, 5)))
      ) ?? agentTemplates[0];
    const name = freeNames(near)[0] ?? t`New agent`;
    setDraft({
      ...draft,
      template: near?.key,
      job: said,
      name,
      look: lookFromName(name),
      instructions: near === undefined ? "" : i18n._(near.instructions),
    });
    setReviewing(true);
  };
  const inside = (
    <Concepted
      chat={answered.map((each) => ({
        step: each,
        question: askedOf(each).question,
        short: words.short[each],
        answer: words.answerOf(each, draft),
      }))}
      concept={concept}
      describe={{ described, onDescribe: setDescribed, onDraft: drafted }}
      draft={draft}
      first={at === 0 && !reviewing}
      tool={tool}
    />
  );
  return (
    <Page>
      <PageHeading title={t`New agent`} />
      {inside}
      <Drawer
        onOpenChange={(open) => {
          setReviewing(open);
        }}
        open={reviewing}
      >
        <DrawerContent>
          <DrawerTitle>{draft.name}</DrawerTitle>
          <DrawerDescription>{draft.job}</DrawerDescription>
          <DrawerBody>
            {/* Why it wasn't made, from core, above what to change. */}
            <AgentFailure>{failure}</AgentFailure>
            <ItemGroup aria-label={t`The new agent`} separated>
              {steps.map((each, index) => (
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
              ))}
            </ItemGroup>
          </DrawerBody>
          <DrawerFooter>
            <DrawerAction>{t`Keep editing`}</DrawerAction>
            <DrawerAction
              action={make}
              failedLabel={t`Couldn't make it`}
              variant="ink"
              workingLabel={t`Making`}
            >
              {t`Make agent`}
            </DrawerAction>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    </Page>
  );
};
