/**
 * An organization's Workflows, ported from the prototype
 * (grasplabs/prototype `components/admin/org-workflows.tsx`) and composed
 * as Grasp Work composes a page: how many pieces of work stand where, as
 * figures; then every piece of work in one table (a row each on a phone),
 * with how far it is known, how many of the people who do it talked, how
 * many of its steps enough of them described, and how much is still
 * missing, all as the model counts them (`workflowListOf`). The rules
 * that say when one counts as known are behind their own button, and
 * staff change them there; each row counts its work as known by hand, or
 * draws it again from what its people agreed to. Each change is a command
 * to the company's Grasp (commands.tsx).
 *
 * Not here yet, as the prototype has it: a row opening the work's own
 * record (its steps on the canvas, and who described which).
 */
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
import { Alert, AlertDescription } from "@grasp-os/ui/components/alert";
import { Badge } from "@grasp-os/ui/components/badge";
import type { BadgeVariant } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
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
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import { NumberField } from "@grasp-os/ui/components/number-field";
import { Progress } from "@grasp-os/ui/components/progress";
import {
  Section as Part,
  SectionHeader,
} from "@grasp-os/ui/components/section-header";
import { Stat, StatGroup } from "@grasp-os/ui/components/stat";
import { Text } from "@grasp-os/ui/components/text";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import { Icon, SlidersHorizontalIcon } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { ActionRows } from "./action-rows.tsx";
import type { ActionColumn } from "./action-rows.tsx";
import { CommandMenu } from "./command-menu.tsx";
import { CommandFailure, useCommand } from "./commands.tsx";

const styles = stylex.create({
  // The page's parts, a step further apart than the lines within each.
  parts: { display: "flex", flexDirection: "column", gap: space["10"] },
  part: { display: "flex", flexDirection: "column", gap: space["4"] },
  // The filters, on one line that wraps on a phone.
  filters: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space["2"],
  },
  team: { width: "12rem" },
  // So many of so many: the figure, then a thin bar.
  meter: {
    display: "flex",
    alignItems: "center",
    gap: space["3"],
    minWidth: "9rem",
  },
  meterFigure: { flexShrink: 0, width: "3.5rem" },
  meterBar: { flexGrow: 1 },
  numberField: { width: "7rem" },
  form: { display: "flex", flexDirection: "column", gap: space["5"] },
  // The dialog's form holds its body and footer: it shrinks with the
  // dialog so its body scrolls and its buttons stay in sight.
  dialogForm: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
  },
  settles: { width: "18rem" },
});

const all = "all";

/** With more workflows than this, the list can be narrowed by standing and team. */
const FILTER_FROM = 8;

/** Each standing in words, as the figures, the list and its filter say it. */
const standingWords: Record<Standing, string> = {
  known: "Known",
  nearly: "Nearly there",
  mapping: "Being mapped",
  blocked: "Waits on a difference",
};

/** Each standing as a Badge: green once known, amber while it waits on a difference. */
const standingTones: Record<Standing, BadgeVariant> = {
  known: "success",
  nearly: "info",
  mapping: "default",
  blocked: "warning",
};

/** What each standing's figure says under it. */
const standingLines: Record<Standing, string> = {
  known: "Enough people described every step",
  nearly: "Close to known",
  mapping: "Still being described",
  blocked: "People describe it differently",
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

/** So many of so many, as a number and a thin bar; nothing to count says so. */
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
      <Text color="muted" size="sm">
        None yet
      </Text>
    );
  }
  return (
    <span {...stylex.props(styles.meter)}>
      <span {...stylex.props(styles.meterFigure)}>{of(value, total)}</span>
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>When a workflow is known</DialogTitle>
          <DialogDescription>
            For this organization only. Every organization starts with the same
            values.
          </DialogDescription>
        </DialogHeader>
        <form
          {...stylex.props(styles.dialogForm)}
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
                <Alert live="polite" variant="warning">
                  <AlertDescription>
                    One of these is out of its bounds.
                  </AlertDescription>
                </Alert>
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

/** One piece of work as the list says it: its row, its team's name, and the company it is for. */
interface WorkLine {
  row: WorkflowRow;
  team: string;
  clientId: string;
}

/** Where a piece of work stands, as a Badge: counted by hand says so. */
const StageBadge = ({ line }: { line: WorkLine }) => {
  const { work, standing } = line.row;
  return (
    <Badge variant={work.byHand ? "success" : standingTones[standing]}>
      {work.byHand ? "Counted as known by Grasp" : standingWords[standing]}
    </Badge>
  );
};

const workColumns: readonly ActionColumn<WorkLine>[] = [
  { id: "team", head: "Team", cell: ({ team }) => team },
  {
    id: "stage",
    head: "Stage",
    cell: (line) => <StageBadge line={line} />,
  },
  {
    id: "talked",
    head: "Talked",
    cell: ({ row }) => (
      <Meter
        label={`${row.work.work.name}: who talked`}
        total={row.work.doers}
        value={row.work.approved}
      />
    ),
    fact: ({ row }) =>
      row.work.doers === 0 ? null : of(row.work.approved, row.work.doers),
  },
  {
    id: "steps",
    head: "Steps described",
    cell: ({ row }) => (
      <Meter
        label={`${row.work.work.name}: steps described`}
        total={row.work.steps}
        value={row.work.evidenced}
      />
    ),
    fact: ({ row }) =>
      row.work.steps === 0 ? null : of(row.work.evidenced, row.work.steps),
  },
  {
    id: "missing",
    head: "Missing",
    cell: ({ row }) => lackingWords(row),
  },
];

/** What Grasp can do for one workflow, in its row's menu: count it as known by hand, or stop; draw it again. */
const workActions = ({ row, clientId }: WorkLine) => {
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

/** How many pieces of work stand where: one figure a standing, of all of them. */
const Figures = ({
  counts,
  total,
}: {
  counts: Record<Standing, number>;
  total: number;
}) => (
  <StatGroup aria-label="How far the work is known" columns={4}>
    {STANDINGS.toReversed().map((standing) => (
      <Stat
        change={standingLines[standing]}
        key={standing}
        label={standingWords[standing]}
        value={of(counts[standing], total)}
        variant={
          standing === "blocked" && counts.blocked > 0 ? "warning" : "default"
        }
      />
    ))}
  </StatGroup>
);

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
    return (
      <Empty align="start" size="sm">
        <EmptyHeader>
          <EmptyTitle>No workflows yet</EmptyTitle>
          <EmptyDescription>{none}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
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
    <div {...stylex.props(styles.parts)}>
      <Figures counts={list.counts} total={list.rows.length} />
      <Part aria-labelledby="work">
        <SectionHeader
          actions={
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
          }
          description="Each piece of work as its team's lead named it, and how far its people described it."
          id="work"
          title="The work"
          variant="group"
        />
        <div {...stylex.props(styles.part)}>
          {filtered ? (
            <div {...stylex.props(styles.filters)}>
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
                <NativeSelect
                  aria-label="Team"
                  onChange={(event) => {
                    setTeam(event.target.value);
                  }}
                  size="sm"
                  style={styles.team}
                  value={team}
                >
                  {teams.map((each) => (
                    <NativeSelectOption key={each.value} value={each.value}>
                      {each.label}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              ) : null}
            </div>
          ) : null}
          {shown.length === 0 ? (
            <Empty align="start" size="sm">
              <EmptyHeader>
                <EmptyDescription>No workflow matches.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            // A piece of work opens nothing of its own yet: each row holds what Grasp can do for it.
            <ActionRows
              actions={workActions}
              actionsHead="What Grasp can do"
              columns={workColumns}
              label="Workflows"
              name={({ row }) => row.work.work.name}
              nameHead="Workflow"
              rowKey={({ row }) => row.work.id}
              rows={shown.map((row) => ({
                row,
                team: teamNames.get(row.work.team) ?? "",
                clientId,
              }))}
            />
          )}
        </div>
      </Part>
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
