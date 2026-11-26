/**
 * An organization's Workflows, ported from the prototype
 * (grasplabs/prototype `components/admin/org-workflows.tsx`): every piece
 * of work in one table, as the platform lists its workflows, with how far
 * it is known, how many of the people who do it talked, how many of its
 * steps enough of them described, and how much is still missing, all as
 * the model counts them (`workflowListOf`). The rules that say when one
 * counts as known are behind their own button, and staff change them
 * there; each row counts its work as known by hand, or draws it again
 * from what its people agreed to. Each change is a command to the
 * company's Grasp (commands.tsx).
 *
 * Not here yet, as the prototype has it: a row opening the work's own
 * record (its steps on the canvas, and who described which).
 */
import type {
  AdminIntegrations,
  AdminNeeded,
} from "@grasp-os/shared/admin-snapshot";
import type { AdminView } from "@grasp-os/shared/admin/admin-view";
import {
  STANDINGS,
  workflowListOf,
} from "@grasp-os/shared/admin/admin-workflows";
import type {
  Standing,
  WorkflowRow,
} from "@grasp-os/shared/admin/admin-workflows";
import {
  SETTLERS,
  STARTING_ORG_RULES,
} from "@grasp-os/shared/admin/onboarding-admin";
import type {
  OrgRules,
  Settler,
} from "@grasp-os/shared/admin/onboarding-admin";
import { orgRulesSchema } from "@grasp-os/shared/onboarding-staff";
import { Button } from "@grasp-os/ui/components/button";
import { Card, CardContent } from "@grasp-os/ui/components/card";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import { IconTile } from "@grasp-os/ui/components/icon-tile";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import { NumberField } from "@grasp-os/ui/components/number-field";
import { Progress } from "@grasp-os/ui/components/progress";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { Text } from "@grasp-os/ui/components/text";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import {
  Icon,
  SlidersHorizontalIcon,
  WorkflowIcon,
} from "@grasp-os/ui/lib/icons";
import {
  colors,
  font,
  media,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { CommandMenu } from "./command-menu.tsx";
import { CommandFailure, useCommand } from "./commands.tsx";
import { appName, needWords } from "./connections.tsx";
import { Attention } from "./marks.tsx";
import { EmptyPanel, PanelNote } from "./panel.tsx";

const all = "all";

/** With more workflows than this, the list can be narrowed by standing and team. */
const FILTER_FROM = 8;

/** Each standing in words, as the list and its filter say it. */
const standingWords: Record<Standing, string> = {
  known: "Known",
  nearly: "Nearly there",
  mapping: "Being mapped",
  blocked: "Waits on a difference",
};

/** Narrower than `width`, measured on the table's own box (its container): a column goes. */
const narrowerThan = (width: string) => `@container (width < ${width})`;

const styles = stylex.create({
  stage: { display: "flex", alignItems: "center", gap: space["2"] },
  blocked: { color: colors.warning },
  dot: {
    width: "0.5rem",
    height: "0.5rem",
    flexShrink: 0,
    borderRadius: "50%",
  },
  known: { backgroundColor: colors.success },
  nearly: { backgroundColor: colors.foreground },
  mapping: { backgroundColor: colors.border },
  blockedDot: { backgroundColor: colors.warning },
  // The figure, then its bar taking the rest of the column, as wide as it is.
  meter: {
    display: "flex",
    alignItems: "center",
    gap: space["2"],
    width: "100%",
  },
  meterFigure: {
    width: "3.5rem",
    flexShrink: 0,
    fontVariantNumeric: "tabular-nums",
  },
  meterBar: { flexGrow: 1, minWidth: "3rem" },
  numberField: { width: "7rem" },
  settles: { width: "18rem", maxWidth: "100%" },
  form: { display: "flex", flexDirection: "column", gap: space["5"] },
  dialog: { width: "42rem" },
  page: { display: "flex", flexDirection: "column", gap: space["8"] },
  list: { display: "flex", flexDirection: "column", gap: space["3"] },
  bar: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space["3"],
  },
  filters: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space["2"],
  },
  team: { width: "12rem" },
  work: { display: "flex", minWidth: 0, alignItems: "center", gap: space["3"] },
  workWords: {
    display: "flex",
    minWidth: 0,
    flexDirection: "column",
    gap: "0.125rem",
  },
  name: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.foreground,
  },
  teamLine: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    color: colors.mutedForeground,
  },
  // The stage under the name while its own column has no room.
  stageBelow: {
    display: { default: "none", [narrowerThan("36rem")]: "block" },
    marginBlockStart: space["1"],
  },
  // The name takes what the other columns leave, its words cut with an ellipsis.
  nameColumn: { width: "100%", maxWidth: 0 },
  talkedColumn: {
    width: "10rem",
    display: { default: null, [narrowerThan("42rem")]: "none" },
  },
  stepsColumn: {
    width: "10rem",
    display: { default: null, [narrowerThan("48rem")]: "none" },
  },
  missingColumn: {
    width: "9.5rem",
    display: { default: null, [narrowerThan("56rem")]: "none" },
  },
  stageColumn: {
    width: "11rem",
    display: { default: null, [narrowerThan("36rem")]: "none" },
  },
  actionsColumn: { width: "3.5rem" },
  waiting: {
    display: "flex",
    flexDirection: "column",
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  waitingRow: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "flex-start",
    justifyContent: "space-between",
    columnGap: space["6"],
    rowGap: space["1"],
    paddingBlock: space["3"],
    paddingInline: space["5"],
    borderBlockStartWidth: { default: size.hairline, ":first-child": 0 },
    borderBlockStartStyle: "solid",
    borderBlockStartColor: colors.border,
  },
  needs: {
    display: "flex",
    flexDirection: "column",
    alignItems: { default: "flex-start", [media.lg]: "flex-end" },
  },
});

/** How a standing is marked; its word always stands beside the mark. */
const standingDot: Record<Standing, stylex.StyleXStyles> = {
  known: styles.known,
  nearly: styles.nearly,
  mapping: styles.mapping,
  blocked: styles.blockedDot,
};

const percent = new Intl.NumberFormat("en", {
  style: "percent",
  maximumFractionDigits: 1,
});

const settlerWords: Record<Settler, string> = {
  owner: "The owner of the workflow",
  lead: "The team lead",
  sponsor: "The sponsor",
};

/** So many of so many. */
const of = (count: number, total: number): string => `${count} of ${total}`;

/** One for one, many for the rest. */
const plural = (count: number, one: string, other: string): string =>
  count === 1 ? one : other;

/**
 * What a piece of work still lacks, in words. Known or not, the count is
 * everything `missingOf` names (people still to talk, steps, numbers and
 * questions), so it is never called questions alone.
 */
const lackingWords = ({ missing }: WorkflowRow): string =>
  missing === 0
    ? "Nothing missing"
    : `${missing} ${plural(missing, "thing", "things")} missing`;

/** Where a workflow stands, as a dot and a word. */
const StageLine = ({
  standing,
  label,
}: {
  standing: Standing;
  label: string;
}) => (
  <span {...stylex.props(styles.stage)}>
    <span aria-hidden {...stylex.props(styles.dot, standingDot[standing])} />
    {standing === "blocked" ? (
      <span {...stylex.props(styles.name, styles.blocked)}>{label}</span>
    ) : (
      <Text as="span" color="default" size="sm">
        {label}
      </Text>
    )}
  </span>
);

/** So many of so many, as a number and a thin bar; a dash when there is nothing to count. */
const Meter = ({
  value,
  total,
  label,
}: {
  value: number;
  total: number;
  label: string;
}) => {
  if (total === 0) {
    return (
      <Text as="span" color="muted" size="sm">
        –
      </Text>
    );
  }
  return (
    <span {...stylex.props(styles.meter)}>
      <span {...stylex.props(styles.meterFigure)}>
        <Text as="span" color="default" size="sm">
          {of(value, total)}
        </Text>
      </span>
      <Progress
        aria-label={label}
        getAriaValueText={() => of(value, total)}
        max={total}
        style={styles.meterBar}
        value={Math.min(value, total)}
      />
    </span>
  );
};

/** One rule as a number field: what it is and why, with its bounds. */
const RuleField = ({
  label,
  description,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  description: string;
  value: number;
  min: number;
  max: number;
  /** A share in percent takes one decimal; counts stay whole. */
  step?: number;
  onChange: (value: number) => void;
}) => (
  <Field>
    <FieldLabel>{label}</FieldLabel>
    <NumberField
      max={max}
      min={min}
      // An emptied field is no number, which the rules' check refuses.
      onValueChange={(next) => {
        onChange(next ?? Number.NaN);
      }}
      step={step}
      style={styles.numberField}
      value={Number.isNaN(value) ? null : value}
    />
    <FieldDescription>{description}</FieldDescription>
  </Field>
);

/**
 * The rules that say when a workflow counts as known at this
 * organization, as they stand, for staff to change. Every organization
 * starts with the same values, and can go back to them.
 */
const Rules = ({
  clientId,
  rules,
  open,
  onOpenChange,
}: {
  clientId: string;
  rules: OrgRules;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const { busy, failure, give } = useCommand(clientId);
  const [draft, setDraft] = useState<OrgRules>(rules);
  const set = (change: Partial<OrgRules>) => {
    setDraft({ ...draft, ...change });
  };
  const parsed = orgRulesSchema.safeParse(draft);
  const starting = JSON.stringify(rules) === JSON.stringify(STARTING_ORG_RULES);
  const save = async (next: OrgRules | null): Promise<void> => {
    if (await give({ type: "onboarding.rules", payload: { rules: next } })) {
      onOpenChange(false);
    }
  };
  const fewer = draft.people - 1;
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent style={styles.dialog}>
        <DialogHeader>
          <DialogTitle>When a workflow is known</DialogTitle>
          <DialogDescription>
            For this organization only. Every organization starts with the same
            values.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (parsed.success) {
              void save(parsed.data);
            }
          }}
        >
          <DialogBody>
            <div {...stylex.props(styles.form)}>
              <RuleField
                description={`People who do the work themselves, or ${fewer} and a document, a log or an example. The lead’s own account is a guess, never one of them.`}
                label="People per step"
                max={10}
                min={1}
                onChange={(people) => {
                  set({ people });
                }}
                value={draft.people}
              />
              <RuleField
                description="Approved interviews before it is checked. Fewer, and the workflow is still being mapped."
                label="Before it is checked"
                max={30}
                min={1}
                onChange={(minInterviews) => {
                  set({ minInterviews });
                }}
                value={draft.minInterviews}
              />
              <RuleField
                description="How many of the last interviews are looked at for new facts."
                label="Interviews looked at"
                max={10}
                min={1}
                onChange={(run) => {
                  set({ run });
                }}
                value={draft.run}
              />
              <RuleField
                description={`It stops once those added less than this share of new facts, in percent: then more interviews would only repeat what is known. Now ${percent.format(draft.stopShare)}.`}
                label="When it stops"
                max={100}
                min={0}
                onChange={(share) => {
                  set({ stopShare: share / 100 });
                }}
                step={0.1}
                value={Math.round(draft.stopShare * 1000) / 10}
              />
              <RuleField
                description="After this many interviews, Stephen asks the lead to split it: probably two workflows in one, or teams that work differently."
                label="When it does not settle"
                max={50}
                min={1}
                onChange={(maxInterviews) => {
                  set({ maxInterviews });
                }}
                value={draft.maxInterviews}
              />
              <Field>
                <FieldLabel>When people say different things</FieldLabel>
                <NativeSelect
                  style={styles.settles}
                  onChange={(event) => {
                    const settles = SETTLERS.find(
                      (each) => each === event.target.value
                    );
                    if (settles !== undefined) {
                      set({ settles });
                    }
                  }}
                  value={draft.settles}
                >
                  {SETTLERS.map((each) => (
                    <NativeSelectOption key={each} value={each}>
                      {settlerWords[each]}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <FieldDescription>
                  Most differences are findings: it depends on the case, the
                  office or the date. Only one nobody can explain needs someone
                  to settle it.
                </FieldDescription>
              </Field>
              {parsed.success ? null : (
                <Text color="default" size="sm">
                  <Attention>One of these is out of its bounds.</Attention>
                </Text>
              )}
              <CommandFailure failure={failure} />
            </div>
          </DialogBody>
          <DialogFooter>
            {starting ? null : (
              <Button
                disabled={busy}
                onClick={() => {
                  void save(null);
                }}
                type="button"
                variant="outline"
              >
                Back to where every organization starts
              </Button>
            )}
            <Button disabled={busy || !parsed.success} type="submit">
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

/** What Grasp can do for one workflow, in its row's menu: count it as known by hand, or stop; draw it again. */
const WorkActions = ({
  clientId,
  row,
}: {
  clientId: string;
  row: WorkflowRow;
}) => {
  const { id, byHand, work } = row.work;
  return (
    <CommandMenu
      clientId={clientId}
      items={[
        {
          words: byHand ? "Stop counting as known" : "Count as known",
          command: {
            type: "onboarding.count_as_known",
            payload: { work: id, counted: !byHand },
          },
        },
        {
          words: "Draw again",
          command: { type: "onboarding.draw_again", payload: { work: id } },
        },
      ]}
      label={`What Grasp can do for ${work.name}`}
    />
  );
};

/** One piece of work in the table. */
const WorkRow = ({
  row,
  team,
  clientId,
}: {
  row: WorkflowRow;
  team: string;
  clientId: string;
}) => {
  const { work, standing } = row;
  const stage = work.byHand
    ? "Counted as known by Grasp"
    : standingWords[standing];
  const lacking = lackingWords(row);
  return (
    <TableRow>
      <TableCell rowHeader style={styles.nameColumn}>
        <div {...stylex.props(styles.work)}>
          <span aria-hidden>
            <IconTile icon={WorkflowIcon} />
          </span>
          <div {...stylex.props(styles.workWords)}>
            <span title={work.work.name} {...stylex.props(styles.name)}>
              {work.work.name}
            </span>
            <span {...stylex.props(styles.teamLine)}>{team}</span>
            <span {...stylex.props(styles.stageBelow)}>
              <StageLine label={stage} standing={standing} />
            </span>
          </div>
        </div>
      </TableCell>
      <TableCell style={styles.talkedColumn}>
        <Meter
          label={`${work.work.name}: who talked`}
          total={work.doers}
          value={work.approved}
        />
      </TableCell>
      <TableCell style={styles.stepsColumn}>
        <Meter
          label={`${work.work.name}: steps described`}
          total={work.steps}
          value={work.evidenced}
        />
      </TableCell>
      <TableCell style={styles.missingColumn} wrap>
        <Text as="span" color={row.missing > 0 ? "default" : "muted"} size="sm">
          {lacking}
        </Text>
      </TableCell>
      <TableCell style={styles.stageColumn}>
        <StageLine label={stage} standing={standing} />
      </TableCell>
      <TableCell align="end" style={styles.actionsColumn}>
        <WorkActions clientId={clientId} row={row} />
      </TableCell>
    </TableRow>
  );
};

/**
 * The section for `view`. Until the company's core draws the work from
 * its interviews at all (`view.unknown.works`), there is no work to list,
 * and the section says it isn't known yet rather than that none was found.
 */
export const OrgWorkflows = ({
  view,
  clientId,
}: {
  view: AdminView;
  clientId: string;
}) => {
  const [team, setTeam] = useState<string>(all);
  const [standing, setStanding] = useState<Standing | typeof all>(all);
  const [rulesOpen, setRulesOpen] = useState(false);

  if (view.works.length === 0) {
    let none =
      "None yet. A team’s work shows up here once its lead has named it.";
    if (view.unknown.works) {
      none =
        "Not known yet: the company’s own Grasp doesn’t draw the work from its interviews yet.";
    } else if (view.told) {
      none = "None found yet. They show up here as the interviews come in.";
    }
    return <EmptyPanel>{none}</EmptyPanel>;
  }

  const list = workflowListOf(view);
  // A short list is read whole: its filters come once it is long.
  const filtered = list.rows.length > FILTER_FROM;
  const teamNames = new Map(
    view.teams.map((each) => [each.team.id, each.team.name])
  );
  const teams = [
    { value: all, label: "All teams" },
    ...view.teams
      .filter((each) => list.rows.some((row) => row.work.team === each.team.id))
      .map((each) => ({ value: each.team.id, label: each.team.name })),
  ];
  const shown = list.rows.filter(
    (row) =>
      (team === all || row.work.team === team) &&
      (standing === all || row.standing === standing)
  );
  const filters = [
    { value: all, label: "All" },
    ...STANDINGS.toReversed()
      .filter((each) => list.counts[each] > 0)
      .map((each) => ({ value: each, label: standingWords[each] })),
  ];

  return (
    <div {...stylex.props(styles.page)}>
      <div {...stylex.props(styles.list)}>
        <div {...stylex.props(styles.bar)}>
          <div {...stylex.props(styles.filters)}>
            {filtered ? (
              <>
                <ToggleGroup
                  aria-label="How far it is"
                  onValueChange={(value) => {
                    const [next] = value;
                    setStanding(STANDINGS.find((each) => each === next) ?? all);
                  }}
                  size="sm"
                  value={[standing]}
                >
                  {filters.map((each) => (
                    <ToggleGroupItem key={each.value} value={each.value}>
                      {each.label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
                {teams.length > 2 ? (
                  <Select
                    items={teams}
                    onValueChange={(value) => {
                      setTeam(value ?? all);
                    }}
                    value={team}
                  >
                    <SelectTrigger
                      aria-label="Team"
                      size="sm"
                      style={styles.team}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent />
                  </Select>
                ) : null}
              </>
            ) : null}
          </div>
          <Button
            onClick={() => {
              setRulesOpen(true);
            }}
            size="sm"
            variant="outline"
          >
            <Icon icon={SlidersHorizontalIcon} />
            When one counts as known
          </Button>
        </div>

        {shown.length === 0 ? (
          <EmptyPanel>No workflow matches.</EmptyPanel>
        ) : (
          <Card size="sm">
            <CardContent flush>
              {/* The name takes what the other columns leave at every width they show
                  at, or the workflow's name has none. */}
              <Table aria-label="Workflows">
                <TableHeader>
                  <TableRow>
                    <TableHead style={styles.nameColumn}>Workflow</TableHead>
                    <TableHead style={styles.talkedColumn}>Talked</TableHead>
                    <TableHead style={styles.stepsColumn}>
                      Steps described
                    </TableHead>
                    <TableHead style={styles.missingColumn}>Missing</TableHead>
                    <TableHead style={styles.stageColumn}>Stage</TableHead>
                    <TableHead
                      aria-label="What Grasp can do"
                      style={styles.actionsColumn}
                    />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.map((row) => (
                    <WorkRow
                      clientId={clientId}
                      key={row.work.id}
                      row={row}
                      team={teamNames.get(row.work.team) ?? ""}
                    />
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </div>

      {rulesOpen ? (
        <Rules
          clientId={clientId}
          onOpenChange={setRulesOpen}
          open={rulesOpen}
          rules={view.state.rules}
        />
      ) : null}
    </div>
  );
};

/** One workflow, and each of its bindings no working connection serves. */
interface WaitingWorkflow {
  id: string;
  name: string;
  needs: AdminNeeded[];
}

const waitingWorkflows = (
  needed: readonly AdminNeeded[]
): WaitingWorkflow[] => {
  const workflows = new Map<string, WaitingWorkflow>();
  for (const need of needed) {
    const workflow = workflows.get(need.workflow.id) ?? {
      id: need.workflow.id,
      name: need.workflow.name,
      needs: [],
    };
    workflow.needs.push(need);
    workflows.set(need.workflow.id, workflow);
  }
  return [...workflows.values()];
};

/** What one binding waits on: its app and why, or that no app was approved for it. */
const needLine = (need: AdminNeeded): string =>
  need.app === null
    ? `${need.alias}: ${needWords.unbound}`
    : `${need.alias}: ${appName(need.app)}, ${needWords[need.state].toLowerCase()}`;

/**
 * The company's workflows that can't run as they are, for a connection:
 * each with every binding of its current version that no working
 * connection serves.
 */
export const WaitingOnConnectionsRows = ({
  integrations,
}: {
  integrations: AdminIntegrations;
}) => {
  const workflows = waitingWorkflows(integrations.needed);
  if (workflows.length === 0) {
    return <PanelNote>No workflow waits on a connection.</PanelNote>;
  }
  return (
    <CardContent flush>
      <ul {...stylex.props(styles.waiting)}>
        {workflows.map((workflow) => (
          <li key={workflow.id} {...stylex.props(styles.waitingRow)}>
            <Text as="span" color="default" size="sm">
              {workflow.name}
            </Text>
            <span {...stylex.props(styles.needs)}>
              {workflow.needs.map((need) => (
                <Text as="span" color="default" key={need.alias} size="xs">
                  <Attention>{needLine(need)}</Attention>
                </Text>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </CardContent>
  );
};
