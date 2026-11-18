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
import { DataTable } from "../grasp/data-table/index.ts";
import type { DataTableColumn } from "../grasp/data-table/index.ts";
import { Heading } from "../grasp/heading/index.ts";
import { IconTile } from "../grasp/icon-tile/index.ts";
import {
  AppRecord,
  Chart,
  Conversation,
  Money,
  People,
  Scale,
  Workflow,
} from "../grasp/icons/index.ts";
import type { IconData } from "../grasp/icons/index.ts";
import { Tabs, TabsList, TabsTrigger } from "../grasp/tabs/index.ts";
import { Text } from "../grasp/text/index.ts";
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

/** Each business process's icon from the library, for its tile. */
const processIcons: Readonly<Record<BusinessProcess, IconData>> = {
  o2c: Money,
  i2r: Conversation,
  p2p: AppRecord,
  r2c: Scale,
  r2r: Chart,
  h2r: People,
};

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
/** The width under which the board shows one phase at a time. */
const narrowBoard = "@container board (width < 52rem)";

const styles = stylex.create({
  measured: { containerName: "board", containerType: "inline-size" },
  wide: { display: { default: "block", [narrowBoard]: "none" } },
  narrow: {
    display: { default: "none", [narrowBoard]: "grid" },
    gap: grasp.space4,
  },
  // Five lanes across, each as wide as the page lets it be.
  board: {
    display: "grid",
    gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
    gap: grasp.space3,
    alignItems: "start",
  },
  // A lane: its head on the canvas, its cards on a soft ground.
  lane: {
    display: "grid",
    alignContent: "start",
    gap: grasp.space2,
    minWidth: 0,
  },
  laneHead: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    minHeight: grasp.space8,
    paddingInline: grasp.space1,
    borderBlockEndWidth: grasp.hairline,
    borderBlockEndStyle: "solid",
    borderBlockEndColor: grasp.line,
  },
  laneHeadNeeds: { borderBlockEndColor: grasp.attention },
  laneBody: {
    display: "grid",
    alignContent: "start",
    gap: grasp.space2,
    padding: grasp.space2,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.soft,
    minHeight: grasp.space20,
  },
  laneBodyNeeds: { backgroundColor: grasp.attentionSoft },
  // A card's own room: smaller than a Card's own padding.
  card: {
    display: "grid",
    gridTemplateRows: "auto 1fr",
    gap: grasp.space2,
    padding: grasp.space3,
  },
  cardMinimal: { height: "6rem" },
  cardRich: { height: "9rem" },
  top: {
    display: "flex",
    alignItems: "flex-start",
    gap: grasp.space2,
    minWidth: 0,
  },
  // A name on one or two lines, never three.
  name: {
    display: "-webkit-box",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: 2,
    overflow: "hidden",
    minWidth: 0,
    flexGrow: 1,
  },
  foot: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: grasp.space2,
    alignSelf: "end",
    minWidth: 0,
  },
  meta: {
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space2,
    minWidth: 0,
  },
  owner: {
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space2,
    minWidth: 0,
  },
  tools: { display: "inline-flex", alignItems: "center", gap: grasp.space1 },
  rich: { display: "grid", gap: grasp.space1, minWidth: 0 },
  // B3: a lane of rows.
  laneRow: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    minWidth: 0,
    paddingBlock: grasp.space2,
    paddingInline: grasp.space3,
    borderBlockStartWidth: grasp.hairline,
    borderBlockStartStyle: "solid",
    borderBlockStartColor: {
      default: grasp.line,
      ":first-child": "transparent",
    },
  },
  rowName: { flexGrow: 1, minWidth: 0 },
  // The table's workflow cell.
  lead: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space3,
    minWidth: 0,
  },
  stack: { display: "grid", gap: grasp.space4 },
});

/** The tools it uses, as small marks. */
const Tools = ({ tools }: { tools: readonly Brand[] }) => (
  <span {...stylex.props(styles.tools)}>
    {tools.map((tool) => (
      <BrandIcon brand={tool} key={tool} size="xs" tile={false} />
    ))}
  </span>
);

const PhaseBadge = ({ phase }: { phase: Phase }) => (
  <Badge size="sm" tone={phaseTones[phase]}>
    {i18n._(phaseNames[phase])}
  </Badge>
);

/** Its name, on one or two lines: a link for a real workflow. */
const CardName = ({ row }: { row: ConceptRow }) => (
  <span {...stylex.props(styles.name)}>
    {row.sample ? (
      <Text element="span" size="sm" weight="medium">
        {row.name}
      </Text>
    ) : (
      <RouterLink params={{ workflow: row.id }} to="/workflows/$workflow">
        {row.name}
      </RouterLink>
    )}
  </span>
);

/** Its runs, one quiet number. */
const RunCount = ({ runs }: { runs: number }) => {
  const { t } = useLingui();
  return runs === 0 ? null : (
    <Text element="span" size="xs" tone="muted">
      {t`${plural(runs, { one: "# run", other: "# runs" })}`}
    </Text>
  );
};

/** The business process's icon, in the library's tile; the workflow mark where none is set. */
const ProcessMark = ({ row }: { row: ConceptRow }) => (
  <IconTile
    icon={row.process === null ? Workflow : processIcons[row.process]}
    variant="tint"
  />
);

/** B1: the least a card can be: icon, name, the owner's face; tools and runs on one quiet line. */
const MinimalCard = ({ row }: { row: ConceptRow }) => (
  <Card padding="none">
    <div {...stylex.props(styles.card, styles.cardMinimal)}>
      <span {...stylex.props(styles.top)}>
        <ProcessMark row={row} />
        <CardName row={row} />
      </span>
      <span {...stylex.props(styles.foot)}>
        <span {...stylex.props(styles.meta)}>
          <Tools tools={row.tools} />
          <RunCount runs={row.runs} />
        </span>
        <Avatar name={row.owner} size="xs">
          <AvatarFallback />
        </Avatar>
      </span>
    </div>
  </Card>
);

/** B2: a little richer: the owner by name, the team, tools and runs, still compact. */
const RichCard = ({ row }: { row: ConceptRow }) => (
  <Card padding="none">
    <div {...stylex.props(styles.card, styles.cardRich)}>
      <span {...stylex.props(styles.top)}>
        <ProcessMark row={row} />
        <span {...stylex.props(styles.rich)}>
          <CardName row={row} />
          <Text element="span" size="xs" tone="muted" wrap="truncate">
            {row.team}
          </Text>
        </span>
      </span>
      <span {...stylex.props(styles.rich)}>
        <span {...stylex.props(styles.owner)}>
          <Avatar decorative name={row.owner} size="xs">
            <AvatarFallback />
          </Avatar>
          <Text element="span" size="xs" wrap="truncate">
            {row.owner}
          </Text>
        </span>
        <span {...stylex.props(styles.foot)}>
          <Tools tools={row.tools} />
          <RunCount runs={row.runs} />
        </span>
      </span>
    </div>
  </Card>
);

/** B3: a workflow as one row in its lane. */
const LaneRow = ({ row }: { row: ConceptRow }) => (
  <div {...stylex.props(styles.laneRow)}>
    <ProcessMark row={row} />
    <span {...stylex.props(styles.rowName)}>
      <CardName row={row} />
    </span>
    <Avatar name={row.owner} size="xs">
      <AvatarFallback />
    </Avatar>
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

/** A lane's head: the phase, strong, and how many; Needs you in the attention colour. */
const LaneHead = ({ phase, count }: { phase: Phase; count: number }) => (
  <span
    {...stylex.props(
      styles.laneHead,
      phase === "needsYou" && styles.laneHeadNeeds
    )}
  >
    <Heading level={2} size="ui">
      {i18n._(phaseNames[phase])}
    </Heading>
    <Badge size="sm" tone={phase === "needsYou" ? "attention" : "neutral"}>
      {formatNumber(count)}
    </Badge>
  </span>
);

type CardLook = "minimal" | "rich" | "rows";

/** A lane's workflows, as the concept draws them. */
const LaneBody = ({
  phase,
  rows,
  look,
}: {
  phase: Phase;
  rows: readonly ConceptRow[];
  look: CardLook;
}) => {
  if (look === "rows") {
    return rows.length === 0 ? null : (
      <Card padding="none">
        {rows.map((row) => (
          <LaneRow key={row.id} row={row} />
        ))}
      </Card>
    );
  }
  return (
    <div
      {...stylex.props(
        styles.laneBody,
        phase === "needsYou" && styles.laneBodyNeeds
      )}
    >
      {rows.map((row) =>
        look === "minimal" ? (
          <MinimalCard key={row.id} row={row} />
        ) : (
          <RichCard key={row.id} row={row} />
        )
      )}
    </div>
  );
};

/** The board: five lanes at a wide width; on a phone, one phase at a time behind a switch. */
const Board = ({
  rows,
  look,
}: {
  rows: readonly ConceptRow[];
  look: CardLook;
}) => {
  const { t } = useLingui();
  const [shown, setShown] = useState<Phase>("needsYou");
  const inPhase = (phase: Phase) => rows.filter((row) => row.phase === phase);
  return (
    <div {...stylex.props(styles.measured)}>
      <div {...stylex.props(styles.wide)}>
        <div {...stylex.props(styles.board)}>
          {phases.map((phase) => (
            <section key={phase} {...stylex.props(styles.lane)}>
              <LaneHead count={inPhase(phase).length} phase={phase} />
              <LaneBody look={look} phase={phase} rows={inPhase(phase)} />
            </section>
          ))}
        </div>
      </div>
      <div {...stylex.props(styles.narrow)}>
        <Tabs
          onValueChange={(value) => {
            const next = phases.find((phase) => phase === value);
            if (next !== undefined) {
              setShown(next);
            }
          }}
          value={shown}
          variant="segmented"
        >
          <TabsList aria-label={t`Phase`}>
            {readingOrder.map((phase) => (
              <TabsTrigger key={phase} value={phase}>
                {`${i18n._(phaseNames[phase])} ${formatNumber(inPhase(phase).length)}`}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <LaneBody look={look} phase={shown} rows={inPhase(shown)} />
      </div>
    </div>
  );
};

/** T: the workflow cell, its process's tile and its name. */
const WorkflowCell = ({ row }: { row: ConceptRow }) => (
  <span {...stylex.props(styles.lead)}>
    <ProcessMark row={row} />
    <CardName row={row} />
  </span>
);

/** T: the owner, a face and a name. */
const OwnerCell = ({ name }: { name: string }) => (
  <span {...stylex.props(styles.owner)}>
    <Avatar decorative name={name} size="xs">
      <AvatarFallback />
    </Avatar>
    <Text element="span" size="sm">
      {name}
    </Text>
  </span>
);

/** T: the table's columns, under their headers' words. */
const tableColumns = (words: {
  workflow: string;
  phase: string;
  owner: string;
  team: string;
  tools: string;
  runs: string;
}): DataTableColumn<ConceptRow>[] => [
  {
    key: "workflow",
    header: words.workflow,
    value: (row) => row.name,
    cell: (row) => <WorkflowCell row={row} />,
  },
  {
    key: "phase",
    header: words.phase,
    value: (row) => readingOrder.indexOf(row.phase),
    cell: (row) => <PhaseBadge phase={row.phase} />,
    sortable: true,
  },
  {
    key: "owner",
    header: words.owner,
    value: (row) => row.owner,
    cell: (row) => <OwnerCell name={row.owner} />,
  },
  { key: "team", header: words.team, value: (row) => row.team },
  {
    key: "tools",
    header: words.tools,
    value: (row) => row.tools.join(" "),
    cell: (row) => <Tools tools={row.tools} />,
  },
  {
    key: "runs",
    header: words.runs,
    value: (row) => row.runs,
    cell: (row) => (row.runs === 0 ? "" : formatNumber(row.runs)),
    align: "end",
  },
];

/** T: one aligned table of every workflow, Needs you first. */
const TableConcept = ({ rows }: { rows: readonly ConceptRow[] }) => {
  const { t } = useLingui();
  return (
    <DataTable
      columns={tableColumns({
        workflow: t`Workflow`,
        phase: t`Phase`,
        owner: t({ message: "Owner", context: "column: who owns a workflow" }),
        team: t`Team`,
        tools: t`Tools`,
        runs: t`Runs`,
      })}
      defaultSort={{ key: "phase", order: "ascending" }}
      density="compact"
      label={t`Workflows`}
      rowKey={(row) => row.id}
      rows={rows}
      unit={{ one: t`workflow`, other: t`workflows` }}
    />
  );
};

/** The concept's own content under the page's heading. */
export const OverviewConcept = ({
  concept,
  rows,
}: {
  concept: "b1" | "b2" | "b3" | "t";
  rows: readonly ConceptRow[];
}): ReactNode => {
  if (concept === "t") {
    return <TableConcept rows={rows} />;
  }
  const looks = { b1: "minimal", b2: "rich", b3: "rows" } as const;
  return <Board look={looks[concept]} rows={rows} />;
};
