import type { BusinessProcess } from "@grasp-os/shared/business-processes";
import type { WorkflowStage } from "@grasp-os/shared/workflow-lifecycle";
import type { WorkflowSummary } from "@grasp-os/shared/workflows";
import { i18n } from "@lingui/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import type { ReactNode } from "react";

import { formatNumber } from "../format.ts";
import { RouterLink } from "../frame/router-link.tsx";
import { Avatar, AvatarFallback } from "../grasp/avatar/index.ts";
import { Badge } from "../grasp/badge/index.ts";
import type { BadgeTone } from "../grasp/badge/index.ts";
import { BrandIcon } from "../grasp/brand-icon/index.ts";
import type { Brand } from "../grasp/brand-icon/index.ts";
import { Card } from "../grasp/card/index.ts";
import { Heading } from "../grasp/heading/index.ts";
import { IconTile } from "../grasp/icon-tile/index.ts";
import {
  AppRecord,
  AppWindow,
  CalendarIcon,
  Chart,
  Clock,
  Conversation,
  Mail,
  Money,
  People,
  Person,
  Scale,
  Web,
  Workflow,
} from "../grasp/icons/index.ts";
import type { IconData } from "../grasp/icons/index.ts";
import { Section, SectionHeader } from "../grasp/section-header/index.ts";
import { Text } from "../grasp/text/index.ts";
import { Toggle, ToggleGroup } from "../grasp/toggle/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";

// Concepts for the Workflows overview, for Ruben to choose (never merged).
// Every workflow stands in one of five phases, with its icon, name, owner,
// phase, and quietly the tools it uses, its runs and its team. The seed's
// workflows are real; the rest are sample rows (`sample: true`), marked as
// such in the report: core has no sketched or to-build workflow, no tools
// list per workflow in the overview's read, and no team on a workflow.

/** The five phases, in the order a workflow moves through them. */
export const phases = [
  "sketched",
  "toBuild",
  "building",
  "running",
  "needsYou",
] as const;
export type Phase = (typeof phases)[number];

const phaseNames: Readonly<Record<Phase, MessageDescriptor>> = {
  sketched: msg({ message: "Sketched", context: "workflow phase" }),
  toBuild: msg({ message: "To build", context: "workflow phase" }),
  building: msg({ message: "Building", context: "workflow phase" }),
  running: msg({ message: "Running", context: "workflow phase" }),
  needsYou: msg({ message: "Needs you", context: "workflow phase" }),
};

const phaseTones: Readonly<Record<Phase, BadgeTone>> = {
  sketched: "neutral",
  toBuild: "neutral",
  building: "info",
  running: "success",
  needsYou: "attention",
};

/** How a workflow is started: its type's mark. */
type Kind = "schedule" | "person" | "app" | "email" | "webhook";

const kindIcons: Readonly<Record<Kind, IconData>> = {
  schedule: Clock,
  person: Person,
  app: AppWindow,
  email: Mail,
  webhook: Web,
};

const kindNames: Readonly<Record<Kind, MessageDescriptor>> = {
  schedule: msg`On a schedule`,
  person: msg`Started by a person`,
  app: msg`Part of an App`,
  email: msg`When an email comes in`,
  webhook: msg`When another system calls`,
};

/** Each business process's icon from the library, for its tile. */
const processIcons: Readonly<Record<BusinessProcess, IconData>> = {
  o2c: Money,
  i2r: Conversation,
  p2p: AppRecord,
  r2c: Scale,
  r2r: Chart,
  h2r: People,
};

/** A workflow's own icon, as an App picks one: chosen once, kept. */
const ownIcons: readonly IconData[] = [
  Money,
  Conversation,
  AppRecord,
  Scale,
  Chart,
  People,
  CalendarIcon,
  Mail,
];

/** One workflow on the overview. */
export interface ConceptRow {
  id: string;
  name: string;
  phase: Phase;
  owner: string;
  team: string;
  /** None set: the generic workflow mark stands in. */
  process: BusinessProcess | null;
  kind: Kind;
  tools: readonly Brand[];
  runs: number;
  /** Not from core: made up to show the page whole. */
  sample: boolean;
}

/** The phase a real workflow is in, from core's stage and its runs. */
export const phaseOf = (
  stage: WorkflowStage,
  summary: WorkflowSummary | undefined,
  paused: boolean
): Phase => {
  if (stage === "live" || stage === "scaling") {
    const stuck =
      paused ||
      (summary !== undefined && (summary.waiting > 0 || summary.failed > 0));
    return stuck ? "needsYou" : "running";
  }
  if (stage === "mapped") {
    return "toBuild";
  }
  return "building";
};

/** Sample rows for the phases the seed has nothing in. */
export const sampleRows: readonly ConceptRow[] = [
  {
    id: "s-mortgage-check",
    name: "Mortgage file check",
    phase: "needsYou",
    owner: "Mark Jansen",
    team: "Mortgage advice",
    process: "o2c",
    kind: "email",
    tools: ["microsoft", "teams"],
    runs: 212,
    sample: true,
  },
  {
    id: "s-invoice-matching",
    name: "Supplier invoice matching",
    phase: "needsYou",
    owner: "Eva Bakker",
    team: "Finance",
    process: "p2p",
    kind: "schedule",
    tools: ["microsoft", "stripe"],
    runs: 87,
    sample: true,
  },
  {
    id: "s-kyc-refresh",
    name: "KYC refresh",
    phase: "running",
    owner: "Joost Smit",
    team: "Compliance",
    process: "r2c",
    kind: "schedule",
    tools: ["microsoft"],
    runs: 640,
    sample: true,
  },
  {
    id: "s-complaint-routing",
    name: "Complaint routing",
    phase: "running",
    owner: "Lisa de Vries",
    team: "Customer service",
    process: "i2r",
    kind: "email",
    tools: ["teams", "whatsapp"],
    runs: 1204,
    sample: true,
  },
  {
    id: "s-month-end",
    name: "Month-end accruals",
    phase: "running",
    owner: "Jeroen Mulder",
    team: "Finance",
    process: "r2r",
    kind: "person",
    tools: ["microsoft"],
    runs: 12,
    sample: true,
  },
  {
    id: "s-payslips",
    name: "Payslip collection",
    phase: "toBuild",
    owner: "Nina Visser",
    team: "Client onboarding",
    process: "o2c",
    kind: "webhook",
    tools: ["google", "microsoft"],
    runs: 0,
    sample: true,
  },
  {
    id: "s-expenses",
    name: "Expense approvals",
    phase: "toBuild",
    owner: "Jeroen Mulder",
    team: "Finance",
    process: "p2p",
    kind: "person",
    tools: ["teams"],
    runs: 0,
    sample: true,
  },
  {
    id: "s-new-hire",
    name: "New hire laptop",
    phase: "sketched",
    owner: "Sanne de Wit",
    team: "Operations",
    process: "h2r",
    kind: "person",
    tools: ["microsoft", "slack"],
    runs: 0,
    sample: true,
  },
  {
    id: "s-offer-follow-up",
    name: "Mortgage offer follow-up",
    phase: "sketched",
    owner: "Mark Jansen",
    team: "Mortgage advice",
    process: "o2c",
    kind: "schedule",
    tools: ["microsoft", "whatsapp"],
    runs: 0,
    sample: true,
  },
  {
    id: "s-aml-review",
    name: "AML alert review",
    phase: "sketched",
    owner: "Joost Smit",
    team: "Compliance",
    process: "r2c",
    kind: "webhook",
    tools: ["microsoft"],
    runs: 0,
    sample: true,
  },
];

/** Which icon treatment a concept uses. */
type IconTreatment = "process" | "own" | "kind";

const styles = stylex.create({
  stack: { display: "grid", gap: grasp.space6 },
  row: {
    display: "grid",
    gridTemplateColumns: {
      default: "minmax(0, 2fr) minmax(0, 1.4fr) minmax(0, 1fr) auto",
      "@container overview (width < 44rem)": "minmax(0, 1fr) auto",
    },
    alignItems: "center",
    columnGap: grasp.space6,
    rowGap: grasp.space1,
    paddingBlock: grasp.space3,
    paddingInline: grasp.space4,
    borderBlockStartWidth: grasp.hairline,
    borderBlockStartStyle: "solid",
    borderBlockStartColor: {
      default: grasp.line,
      ":first-child": "transparent",
    },
  },
  measured: { containerName: "overview", containerType: "inline-size" },
  lead: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space3,
    minWidth: 0,
  },
  named: { display: "grid", minWidth: 0, gap: grasp.space1 },
  owner: {
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space2,
    minWidth: 0,
  },
  quiet: {
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space3,
    justifySelf: "end",
  },
  hideNarrow: {
    display: {
      default: "inline-flex",
      "@container overview (width < 44rem)": "none",
    },
  },
  tools: { display: "inline-flex", alignItems: "center", gap: grasp.space1 },
  board: {
    display: "grid",
    gridAutoFlow: "column",
    gridAutoColumns: "minmax(13rem, 1fr)",
    gap: grasp.space4,
    overflowX: "auto",
    paddingBlockEnd: grasp.space2,
  },
  column: { display: "grid", alignContent: "start", gap: grasp.space3 },
  columnHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    paddingInline: grasp.space1,
  },
  card: { display: "grid", gap: grasp.space3 },
  cardFoot: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: grasp.space2,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(16rem, 1fr))",
    gap: grasp.space4,
  },
  bigCard: { display: "grid", gap: grasp.space4 },
  cardHead: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: grasp.space3,
  },
  map: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(20rem, 1fr))",
    alignItems: "start",
    gap: grasp.space6,
  },
  mapRow: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto auto",
    alignItems: "center",
    columnGap: grasp.space4,
    paddingBlock: grasp.space3,
    paddingInline: grasp.space4,
    borderBlockStartWidth: grasp.hairline,
    borderBlockStartStyle: "solid",
    borderBlockStartColor: {
      default: grasp.line,
      ":first-child": "transparent",
    },
  },
  phaseCount: { display: "flex", flexWrap: "wrap", gap: grasp.space2 },
});

/** A workflow's icon, in the concept's treatment. */
const WorkflowIcon = ({
  row,
  treatment,
  look = "raised",
}: {
  row: ConceptRow;
  treatment: IconTreatment;
  look?: "raised" | "tint";
}) => {
  if (treatment === "process") {
    return (
      <IconTile
        icon={row.process === null ? Workflow : processIcons[row.process]}
        variant={look}
      />
    );
  }
  if (treatment === "kind") {
    return (
      <IconTile
        icon={kindIcons[row.kind]}
        aria-label={i18n._(kindNames[row.kind])}
        variant={look}
      />
    );
  }
  const index =
    Array.from(
      { length: row.name.length },
      (_, at) => row.name.codePointAt(at) ?? 0
    ).reduce((sum, code) => sum + code, 0) % ownIcons.length;
  return <IconTile icon={ownIcons[index] ?? Workflow} variant="tint" />;
};

/** Its name: a link for a real workflow, words for a sample. */
const RowName = ({ row }: { row: ConceptRow }) =>
  row.sample ? (
    <Text element="span" weight="medium">
      {row.name}
    </Text>
  ) : (
    <RouterLink params={{ workflow: row.id }} to="/workflows/$workflow">
      {row.name}
    </RouterLink>
  );

/** Its owner: a face and a name. */
const Owner = ({ name }: { name: string }) => (
  <span {...stylex.props(styles.owner)}>
    <Avatar decorative name={name} size="xs">
      <AvatarFallback />
    </Avatar>
    <Text element="span" size="sm" wrap="truncate">
      {name}
    </Text>
  </span>
);

/** The tools it uses, as small marks. */
const Tools = ({ tools }: { tools: readonly Brand[] }) => (
  <span {...stylex.props(styles.tools)}>
    {tools.map((tool) => (
      <BrandIcon brand={tool} key={tool} size="xs" tile={false} />
    ))}
  </span>
);

/** Its runs, one number, quietly. */
const Runs = ({ runs }: { runs: number }) => {
  const { t } = useLingui();
  return (
    <Text element="span" size="sm" tone="muted">
      {t`${plural(runs, { one: "# run", other: "# runs" })}`}
    </Text>
  );
};

const PhaseBadge = ({ phase }: { phase: Phase }) => (
  <Badge size="sm" tone={phaseTones[phase]}>
    {i18n._(phaseNames[phase])}
  </Badge>
);

/** A: one row, in its phase's list. */
const SectionRow = ({ row }: { row: ConceptRow }) => (
  <div {...stylex.props(styles.row)}>
    <span {...stylex.props(styles.lead)}>
      <WorkflowIcon row={row} treatment="process" />
      <span {...stylex.props(styles.named)}>
        <RowName row={row} />
        <Text element="span" size="xs" tone="muted">
          {row.team}
        </Text>
      </span>
    </span>
    <span {...stylex.props(styles.hideNarrow)}>
      <Owner name={row.owner} />
    </span>
    <span {...stylex.props(styles.hideNarrow)}>
      <Tools tools={row.tools} />
    </span>
    <span {...stylex.props(styles.quiet)}>
      {row.runs > 0 ? <Runs runs={row.runs} /> : null}
    </span>
  </div>
);

/** The phases in the order a list reads them: what needs you first. */
const readingOrder: readonly Phase[] = [
  "needsYou",
  "running",
  "building",
  "toBuild",
  "sketched",
];

/** A: sections down the page, one list per phase. */
export const SectionsConcept = ({ rows }: { rows: readonly ConceptRow[] }) => (
  <div {...stylex.props(styles.stack, styles.measured)}>
    {readingOrder.map((phase) => {
      const shown = rows.filter((row) => row.phase === phase);
      return shown.length === 0 ? null : (
        <Section key={phase}>
          <SectionHeader
            aside={
              <Text element="span" size="sm" tone="muted">
                {formatNumber(shown.length)}
              </Text>
            }
            title={i18n._(phaseNames[phase])}
          />
          <Card padding="none">
            {shown.map((row) => (
              <SectionRow key={row.id} row={row} />
            ))}
          </Card>
        </Section>
      );
    })}
  </div>
);

/** B: a card on the board. */
const BoardCard = ({ row }: { row: ConceptRow }) => (
  <Card padding="md">
    <div {...stylex.props(styles.card)}>
      <span {...stylex.props(styles.lead)}>
        <WorkflowIcon row={row} treatment="own" />
        <span {...stylex.props(styles.named)}>
          <RowName row={row} />
          <Text element="span" size="xs" tone="muted">
            {row.team}
          </Text>
        </span>
      </span>
      <Owner name={row.owner} />
      <span {...stylex.props(styles.cardFoot)}>
        <Tools tools={row.tools} />
        {row.runs > 0 ? <Runs runs={row.runs} /> : null}
      </span>
    </div>
  </Card>
);

/** B: a board, one column per phase, from Sketched to Running. */
export const BoardConcept = ({ rows }: { rows: readonly ConceptRow[] }) => (
  <div {...stylex.props(styles.board)}>
    {phases.map((phase) => {
      const shown = rows.filter((row) => row.phase === phase);
      return (
        <section key={phase} {...stylex.props(styles.column)}>
          <span {...stylex.props(styles.columnHead)}>
            <Heading level={2} size="ui">
              {i18n._(phaseNames[phase])}
            </Heading>
            <Text element="span" size="sm" tone="muted">
              {formatNumber(shown.length)}
            </Text>
          </span>
          {shown.map((row) => (
            <BoardCard key={row.id} row={row} />
          ))}
        </section>
      );
    })}
  </div>
);

/** C: a card in the grid, its icon large, its phase on it. */
const GridCard = ({ row }: { row: ConceptRow }) => (
  <Card padding="lg">
    <div {...stylex.props(styles.bigCard)}>
      <span {...stylex.props(styles.cardHead)}>
        <WorkflowIcon look="tint" row={row} treatment="kind" />
        <PhaseBadge phase={row.phase} />
      </span>
      <span {...stylex.props(styles.named)}>
        <RowName row={row} />
        <Text element="span" size="xs" tone="muted">
          {`${i18n._(kindNames[row.kind])} · ${row.team}`}
        </Text>
      </span>
      <span {...stylex.props(styles.cardFoot)}>
        <Owner name={row.owner} />
        <Tools tools={row.tools} />
      </span>
      {row.runs > 0 ? <Runs runs={row.runs} /> : null}
    </div>
  </Card>
);

/** C: cards in a grid, filtered by phase at the top. */
export const GridConcept = ({ rows }: { rows: readonly ConceptRow[] }) => {
  const { t } = useLingui();
  const [phase, setPhase] = useState<Phase | undefined>();
  const shown =
    phase === undefined ? rows : rows.filter((row) => row.phase === phase);
  return (
    <div {...stylex.props(styles.stack)}>
      <ToggleGroup
        aria-label={t`Phase`}
        onValueChange={(value: unknown[]) => {
          const [chosen] = value;
          setPhase(phases.find((each) => each === chosen));
        }}
        size="sm"
        value={phase === undefined ? [] : [phase]}
      >
        {readingOrder.map((each) => (
          <Toggle key={each} value={each}>
            {`${i18n._(phaseNames[each])} ${formatNumber(rows.filter((row) => row.phase === each).length)}`}
          </Toggle>
        ))}
      </ToggleGroup>
      <div {...stylex.props(styles.grid)}>
        {shown.map((row) => (
          <GridCard key={row.id} row={row} />
        ))}
      </div>
    </div>
  );
};

/** D: one team's workflows, each with its phase. */
const TeamCard = ({
  team,
  rows,
}: {
  team: string;
  rows: readonly ConceptRow[];
}) => (
  <Section>
    <SectionHeader title={team} />
    <Card padding="none">
      {rows.map((row) => (
        <div key={row.id} {...stylex.props(styles.mapRow)}>
          <span {...stylex.props(styles.lead)}>
            <WorkflowIcon row={row} treatment="process" />
            <span {...stylex.props(styles.named)}>
              <RowName row={row} />
              <Owner name={row.owner} />
            </span>
          </span>
          <Tools tools={row.tools} />
          <span {...stylex.props(styles.quiet)}>
            <PhaseBadge phase={row.phase} />
          </span>
        </div>
      ))}
    </Card>
  </Section>
);

/** D: the company as it runs, team by team. */
export const MapConcept = ({ rows }: { rows: readonly ConceptRow[] }) => {
  const teams = [...new Set(rows.map((row) => row.team))].toSorted();
  return (
    <div {...stylex.props(styles.map, styles.measured)}>
      {teams.map((team) => (
        <TeamCard
          key={team}
          rows={rows
            .filter((row) => row.team === team)
            .toSorted(
              (a, b) =>
                readingOrder.indexOf(a.phase) - readingOrder.indexOf(b.phase)
            )}
          team={team}
        />
      ))}
    </div>
  );
};

/** The concept's own content under the page's heading. */
export const OverviewConcept = ({
  concept,
  rows,
}: {
  concept: "a" | "b" | "c" | "d";
  rows: readonly ConceptRow[];
}): ReactNode => {
  if (concept === "a") {
    return <SectionsConcept rows={rows} />;
  }
  if (concept === "b") {
    return <BoardConcept rows={rows} />;
  }
  if (concept === "c") {
    return <GridConcept rows={rows} />;
  }
  return <MapConcept rows={rows} />;
};
