import type { AdminView } from "@grasp-os/shared/admin/admin-view";
import {
  STANDINGS,
  workflowListOf,
} from "@grasp-os/shared/admin/admin-workflows";
import type {
  Standing,
  WorkflowRow,
} from "@grasp-os/shared/admin/admin-workflows";
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
import {
  Dialog,
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
import { Input } from "@grasp-os/ui/components/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import { Progress } from "@grasp-os/ui/components/progress";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { Stat } from "@grasp-os/ui/components/stat";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import { cn } from "@grasp-os/ui/lib/utils";
import { SlidersHorizontalIcon, WorkflowIcon } from "lucide-react";
import { useId, useState } from "react";

import { CommandButton, CommandFailure, useCommand } from "./commands.tsx";
import { EmptySection } from "./section.tsx";

const all = "all";

/** Each standing in words, as the list and its filter say it. */
const standingWords: Record<Standing, string> = {
  known: "Known",
  nearly: "Nearly there",
  mapping: "Being mapped",
  blocked: "Waits on a difference",
};

const standingDot: Record<Standing, string> = {
  known: "bg-status-agreed",
  nearly: "bg-foreground",
  mapping: "bg-border",
  blocked: "bg-status-attention",
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

/** A large number over the words that say what it is, as on the platform's own list of workflows. */
const Big = ({
  value,
  label,
  tone,
}: {
  value: string;
  label: string;
  tone?: "done" | "attention";
}) => (
  <div className="flex min-w-0 flex-col-reverse justify-end gap-0.5">
    <dt className="text-muted-foreground">{label}</dt>
    <Stat render={<dd />} variant={tone ?? "default"}>
      {value}
    </Stat>
  </div>
);

/** Where a workflow stands, as a dot and a word. */
const StageLine = ({
  standing,
  label,
}: {
  standing: Standing;
  label: string;
}) => (
  <span
    className={cn(
      "flex items-center gap-2",
      standing === "blocked" && "text-status-attention"
    )}
  >
    <span
      aria-hidden
      className={cn("size-2 flex-none rounded-full", standingDot[standing])}
    />
    {label}
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
    return <span className="text-muted-foreground">–</span>;
  }
  return (
    <Progress
      aria-label={label}
      className="flex-nowrap items-center"
      getAriaValueText={() => of(value, total)}
      max={total}
      value={Math.min(value, total)}
    >
      <span className="w-14 flex-none tabular-nums">{of(value, total)}</span>
    </Progress>
  );
};

/** One rule as a number field: what it is and why, with its bounds. */
const RuleField = ({
  label,
  description,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  description: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) => {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        className="w-28"
        id={id}
        max={max}
        min={min}
        onChange={(event) => {
          onChange(event.target.valueAsNumber);
        }}
        type="number"
        value={Number.isNaN(value) ? "" : value}
      />
      <FieldDescription>{description}</FieldDescription>
    </Field>
  );
};

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
  const settlesId = useId();
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
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>When a workflow is known</DialogTitle>
          <DialogDescription>
            For this organization only. Every organization starts with the same
            values.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (parsed.success) {
              void save(parsed.data);
            }
          }}
        >
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
            <FieldLabel htmlFor={settlesId}>
              When people say different things
            </FieldLabel>
            <NativeSelect
              className="w-72"
              id={settlesId}
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
              Most differences are findings: it depends on the case, the office
              or the date. Only one nobody can explain needs someone to settle
              it.
            </FieldDescription>
          </Field>
          {parsed.success ? null : (
            <p className="text-status-attention">
              One of these is out of its bounds.
            </p>
          )}
          <CommandFailure failure={failure} />
          <DialogFooter>
            {starting ? null : (
              <Button
                disabled={busy}
                onClick={() => {
                  void save(null);
                }}
                type="button"
                variant="ghost"
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

/** What Grasp can do for one workflow: count it as known by hand, or stop; draw it again. */
const WorkActions = ({
  clientId,
  row,
}: {
  clientId: string;
  row: WorkflowRow;
}) => {
  const { id, byHand, work } = row.work;
  return (
    <span className="flex flex-wrap items-start justify-end gap-2">
      <CommandButton
        clientId={clientId}
        command={{
          type: "onboarding.count_as_known",
          payload: { work: id, counted: !byHand },
        }}
        label={
          byHand
            ? `Stop counting ${work.name} as known`
            : `Count ${work.name} as known`
        }
        variant="ghost"
      >
        {byHand ? "Stop counting" : "Count as known"}
      </CommandButton>
      <CommandButton
        clientId={clientId}
        command={{ type: "onboarding.draw_again", payload: { work: id } }}
        label={`Draw ${work.name} again`}
        variant="ghost"
      >
        Draw again
      </CommandButton>
    </span>
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
      <TableCell variant="roomy">
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden
            className="bg-muted text-muted-foreground flex size-8 flex-none items-center justify-center rounded-lg"
          >
            <WorkflowIcon className="size-4" />
          </span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate" title={work.work.name}>
              {work.work.name}
            </span>
            <span className="text-muted-foreground truncate">{team}</span>
            <span className="mt-1 @xl:hidden">
              <StageLine label={stage} standing={standing} />
            </span>
          </div>
        </div>
      </TableCell>
      <TableCell className="hidden @2xl:table-cell" variant="roomy">
        <Meter
          label={`${work.work.name}: who talked`}
          total={work.doers}
          value={work.approved}
        />
      </TableCell>
      <TableCell className="hidden @3xl:table-cell" variant="roomy">
        <Meter
          label={`${work.work.name}: steps described`}
          total={work.steps}
          value={work.evidenced}
        />
      </TableCell>
      <TableCell
        className="hidden whitespace-normal @4xl:table-cell"
        variant="roomy"
      >
        <span className={row.missing > 0 ? undefined : "text-muted-foreground"}>
          {lacking}
        </span>
      </TableCell>
      <TableCell className="hidden @xl:table-cell" variant="roomy">
        <StageLine label={stage} standing={standing} />
      </TableCell>
      <TableCell className="whitespace-normal" variant="roomy">
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
    return <EmptySection>{none}</EmptySection>;
  }

  const list = workflowListOf(view);
  const total = list.rows.length;
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
    <div className="@container flex flex-col gap-8">
      {/* As the platform's own list of workflows: a few large numbers, then one table. */}
      <dl className="grid grid-cols-3 gap-4 @xl:gap-x-8">
        <Big
          label="workflows known"
          tone={list.known === total ? "done" : undefined}
          value={of(list.known, total)}
        />
        <Big label="still being mapped" value={String(list.mapping)} />
        <Big
          label={plural(
            list.missing,
            "thing still missing",
            "things still missing"
          )}
          tone={list.missing > 0 ? "attention" : undefined}
          value={String(list.missing)}
        />
      </dl>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <ToggleGroup
              aria-label="How far it is"
              onValueChange={(value: string[]) => {
                const [next] = value;
                setStanding(STANDINGS.find((each) => each === next) ?? all);
              }}
              size="sm"
              spacing={0}
              value={[standing]}
              variant="outline"
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
                onValueChange={(value: string | null) => {
                  setTeam(value ?? all);
                }}
                value={team}
              >
                <SelectTrigger aria-label="Team" className="w-48" size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {teams.map((each) => (
                      <SelectItem key={each.value} value={each.value}>
                        {each.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            ) : null}
          </div>
          <Button
            onClick={() => {
              setRulesOpen(true);
            }}
            size="sm"
            variant="ghost"
          >
            <SlidersHorizontalIcon data-icon="inline-start" />
            When one counts as known
          </Button>
        </div>

        {shown.length === 0 ? (
          <EmptySection>No workflow matches.</EmptySection>
        ) : (
          <div className="bg-card @container overflow-hidden rounded-xl border">
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead variant="card">Workflow</TableHead>
                  <TableHead
                    className="hidden w-48 @2xl:table-cell"
                    variant="card"
                  >
                    Talked
                  </TableHead>
                  <TableHead
                    className="hidden w-48 @3xl:table-cell"
                    variant="card"
                  >
                    Steps described
                  </TableHead>
                  <TableHead
                    className="hidden w-32 @4xl:table-cell"
                    variant="card"
                  >
                    Missing
                  </TableHead>
                  <TableHead
                    className="hidden w-48 @xl:table-cell"
                    variant="card"
                  >
                    Stage
                  </TableHead>
                  <TableHead className="w-60" variant="card">
                    <span className="sr-only">What Grasp can do</span>
                  </TableHead>
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
          </div>
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
