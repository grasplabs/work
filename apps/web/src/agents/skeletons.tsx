import { Card, CardMedia } from "@grasp-os/ui/components/card";
import { Field, FieldContent, FieldGroup } from "@grasp-os/ui/components/field";
import { Heading } from "@grasp-os/ui/components/heading";
import { PageHeader } from "@grasp-os/ui/components/page-header";
import { SectionHeader } from "@grasp-os/ui/components/section-header";
import { Skeleton } from "@grasp-os/ui/components/skeleton";
import { StepperNav } from "@grasp-os/ui/components/stepper";
import { Text } from "@grasp-os/ui/components/text";
import {
  colors,
  font,
  radius,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { useRef } from "react";
import type { ReactNode } from "react";

import { Backdrop } from "../chat/backdrop/backdrop.tsx";
import { agentCardStyles } from "./agent-card.tsx";
import { AgentFigureAura } from "./figure/agent-figure.tsx";

// The Agents pages before what they read arrives, as #2503's library drew
// them (its page skeletons, which the rename map moves to the product):
// the page's header waiting, then its content's own boxes, quiet, so
// nothing moves when it comes.

const styles = stylex.create({
  // The name's line at a medium heading's own height.
  name: { width: "8rem", height: font.headingMdLine },
  job: { width: "12rem", maxWidth: "100%" },
  // The audience pill's box, at a small badge's own height.
  fact: { width: "5rem", height: size.badgeHeightSm },
  page: { display: "grid", gap: space.sectionHeaderGap, minWidth: 0 },
  group: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    rowGap: space[2],
  },
  head: { paddingInline: space.tableCellInline },
  rowName: { width: "9rem", maxWidth: "100%" },
  rowHelp: { width: "14rem", maxWidth: "100%" },
  control: {
    boxSizing: "border-box",
    width: "100%",
    height: size.controlSm,
    borderRadius: `min(${radius.base}, calc(${size.controlSm} / 2))`,
    cornerShape: radius.shape,
    boxShadow: `inset 0 0 0 1px ${colors.input}`,
  },
});

/** The Agents overview waiting: the header, its toolbar, then still portrait cards. */
export const AgentsSkeleton = ({
  cards = 8,
  actions,
  toolbar,
}: {
  cards?: number;
  /** The page's actions, as the loaded page has them. */
  actions?: ReactNode;
  /** The tab row, in its place over the cards. */
  toolbar?: ReactNode;
}) => (
  <div {...stylex.props(agentCardStyles.page)}>
    <PageHeader actions={actions} loading title="" />
    {toolbar}
    <ul aria-hidden="true" {...stylex.props(agentCardStyles.grid)}>
      {Array.from({ length: cards }, (_, index) => (
        <li key={index}>
          <Card padding="none">
            <span {...stylex.props(agentCardStyles.portrait)}>
              <span {...stylex.props(agentCardStyles.words)}>
                <Skeleton style={styles.name} />
                <Skeleton style={styles.job} />
              </span>
              <span {...stylex.props(agentCardStyles.foot)}>
                <Skeleton style={styles.fact} />
              </span>
            </span>
          </Card>
        </li>
      ))}
    </ul>
  </div>
);

/** A settings card's rows waiting: each its name and help lines, a small control's box. */
const Rows = ({ rows }: { rows: number }) => (
  <FieldGroup>
    {Array.from({ length: rows }, (_, row) => (
      <Field key={row} orientation="responsive">
        <FieldContent>
          <Skeleton style={styles.rowName} />
          <Skeleton style={styles.rowHelp} />
        </FieldContent>
        <span {...stylex.props(styles.control)} />
      </Field>
    ))}
  </FieldGroup>
);

/** A settings page waiting: the header, then each group's title and quiet rows. */
export const SettingsSkeleton = ({
  sections,
}: {
  /** How many rows each group holds, top to bottom. */
  sections: readonly number[];
}) => (
  <div {...stylex.props(styles.page)}>
    <PageHeader loading size="sm" title="" />
    {sections.map((rows, index) => (
      <div aria-hidden="true" key={index} {...stylex.props(styles.group)}>
        <div {...stylex.props(styles.head)}>
          <SectionHeader loading title="" variant="group" />
        </div>
        <Card padding="none">
          <Rows rows={rows} />
        </Card>
      </div>
    ))}
  </div>
);

const choice = stylex.create({
  // As New agent's first question stands (new-agent-start.tsx).
  middle: {
    display: "grid",
    flexGrow: 1,
    placeContent: "center",
    justifyItems: "center",
    gap: space[4],
    textAlign: "center",
  },
  heading: { display: "grid", justifyItems: "center", gap: space[2] },
  ways: {
    display: "grid",
    gridTemplateColumns: {
      default: "repeat(2, minmax(0, 18rem))",
      "@media (width < 40rem)": "minmax(0, 18rem)",
    },
    gap: space[4],
    marginBlockStart: space[4],
    textAlign: "start",
  },
  stage: {
    display: "block",
    aspectRatio: "4 / 3",
    backgroundColor: colors.background,
  },
  words: { display: "grid", gap: space[1], marginBlockStart: space[3] },
  title: { width: "8rem", height: font.headingXsLine },
  description: { width: "100%" },
  last: { width: "70%" },
});

/** New agent's first question waiting: its heading and line, then its two ways' quiet cards. */
export const ChoiceSkeleton = ({
  heading,
  line,
}: {
  heading: string;
  line: string;
}) => (
  <div aria-busy="true" {...stylex.props(choice.middle)}>
    <span {...stylex.props(choice.heading)}>
      <Heading level={1} size="lg">
        {heading}
      </Heading>
      <Text color="muted">{line}</Text>
    </span>
    <div aria-hidden="true" {...stylex.props(choice.ways)}>
      {[0, 1].map((way) => (
        <Card key={way}>
          <CardMedia>
            <span {...stylex.props(choice.stage)} />
          </CardMedia>
          <span {...stylex.props(choice.words)}>
            <Skeleton style={choice.title} />
            <Skeleton size="default" style={choice.description} />
            <Skeleton size="default" style={choice.last} />
          </span>
        </Card>
      ))}
    </div>
  </div>
);

const setup = stylex.create({
  underBar: { minHeight: 0 },
  // As the setup by hand stands (manual-agent.tsx).
  ground: {
    display: "grid",
    flexGrow: 1,
    boxSizing: "border-box",
    width: "100%",
    minHeight: 0,
    paddingInline: space[6],
    paddingBlock: space[6],
  },
  stage: {
    display: "grid",
    gridTemplateRows:
      "minmax(min-content, 1fr) minmax(0, auto) minmax(min-content, 1fr)",
    justifyItems: "center",
    gap: space[6],
    width: "100%",
    minHeight: 0,
    overflow: "hidden",
  },
  top: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space[6],
    width: "100%",
  },
  bar: { width: "100%", maxWidth: size.containerSm },
  middle: { width: "100%", maxWidth: size.containerSm, minHeight: 0 },
  column: { display: "grid", gap: space[6] },
  asked: {
    display: "grid",
    justifyItems: "center",
    gap: space[3],
    textAlign: "center",
  },
  figure: {
    position: "relative",
    display: "block",
    width: "128px",
    height: "128px",
    overflow: "hidden",
    borderRadius: radius.circle,
    isolation: "isolate",
  },
  answer: {
    boxSizing: "border-box",
    width: "100%",
    height: size.controlLg,
    borderRadius: `min(${radius.base}, calc(${size.controlLg} / 2))`,
    cornerShape: radius.shape,
    boxShadow: `inset 0 0 0 1px ${colors.input}`,
  },
});

/** The figure before it has a name: Grasp's own orb. */
const unnamed = { shape: "orb", palette: "evergreen" } as const;

/** The setup by hand waiting: its bar at the first step, the figure's light, its first question. */
export const SetupSkeleton = ({
  question,
  steps,
}: {
  question: string;
  steps: number;
}) => {
  const column = useRef<HTMLDivElement>(null);
  return (
    <Backdrop
      clear={column}
      style={setup.underBar}
      variant={{ backdrop: "dots", pattern: "bayer", tone: "mint" }}
    >
      <div {...stylex.props(setup.ground)}>
        <div aria-busy="true" {...stylex.props(setup.stage)}>
          <div {...stylex.props(setup.top)}>
            <StepperNav
              disabled
              step={0}
              style={setup.bar}
              total={steps}
              variant="bar"
            />
            <span aria-hidden="true" {...stylex.props(setup.figure)}>
              <AgentFigureAura ground="page" look={unnamed} />
            </span>
          </div>
          <div ref={column} {...stylex.props(setup.middle)}>
            <div {...stylex.props(setup.column)}>
              <span {...stylex.props(setup.asked)}>
                <Heading level={1}>{question}</Heading>
              </span>
              <span aria-hidden="true" {...stylex.props(setup.answer)} />
            </div>
          </div>
        </div>
      </div>
    </Backdrop>
  );
};

const asking = stylex.create({
  // A page's room with no chat box under it, as New agent has it.
  page: {
    display: "flex",
    flexDirection: "column",
    gap: space[6],
    paddingTop: space[7],
    paddingBottom: space[8],
    paddingInline: space[6],
  },
  // As the questions of a chat stand (new-agent.tsx).
  column: {
    display: "grid",
    gap: space[5],
    width: "100%",
    maxWidth: "44rem",
    marginInline: "auto",
  },
  stage: {
    display: "block",
    aspectRatio: { default: "16 / 7", "@media (width < 40rem)": "4 / 3" },
    backgroundColor: colors.background,
  },
  question: { display: "grid", gap: space[3] },
  title: { width: "70%", height: font.textBaseLine },
  choice: { width: "100%", height: size.controlLg },
});

/** The questions of a chat waiting: the header, the agent's card, its first question's quiet choices. */
export const QuestionSkeleton = ({ choices }: { choices: number }) => (
  <div {...stylex.props(asking.page)}>
    <PageHeader loading title="" />
    <div aria-busy="true" {...stylex.props(asking.column)}>
      <Card>
        <CardMedia>
          <span {...stylex.props(asking.stage)} />
        </CardMedia>
      </Card>
      <div aria-hidden="true" {...stylex.props(asking.question)}>
        <Skeleton style={asking.title} />
        {Array.from({ length: choices }, (_, index) => (
          <Skeleton key={index} style={asking.choice} variant="rectangular" />
        ))}
      </div>
    </div>
  </div>
);
