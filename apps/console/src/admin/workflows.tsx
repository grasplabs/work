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
 * counts as known are behind their own button.
 *
 * Not here yet, as the prototype has it: a row opening the work's own
 * record (its steps on the canvas, who described which, and Grasp's
 * actions on it), and changing the rules, which core doesn't hold.
 */
import type {
  OrgRules,
  Settler,
} from "@grasp-os/shared/admin/onboarding-admin";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import { Progress } from "@grasp-os/ui/components/progress";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
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
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import { cn } from "@grasp-os/ui/lib/utils";
import { SlidersHorizontalIcon, WorkflowIcon } from "lucide-react";
import { useState } from "react";

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
    <dd
      className={cn(
        "text-2xl tabular-nums",
        tone === "done" && "text-status-agreed",
        tone === "attention" && "text-status-attention"
      )}
    >
      {value}
    </dd>
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

/** One rule: what it is and why, and what it is set to. */
const Rule = ({
  label,
  description,
  value,
}: {
  label: string;
  description: string;
  value: string;
}) => (
  <div className="flex flex-col gap-1 border-t py-3 first:border-t-0 first:pt-0">
    <dt className="flex flex-col gap-0.5">
      <span>{label}</span>
      <span className="text-muted-foreground">{description}</span>
    </dt>
    <dd className="font-medium">{value}</dd>
  </div>
);

/**
 * The rules that say when a workflow counts as known at this
 * organization, as they stand. Every organization starts with the same
 * values; changing them isn't in the console yet.
 */
const Rules = ({
  rules,
  open,
  onOpenChange,
}: {
  rules: OrgRules;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const fewer = rules.people - 1;
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>When a workflow is known</DialogTitle>
          <DialogDescription>
            For this organization only. Every organization starts with the same
            values; changing them isn’t in the console yet.
          </DialogDescription>
        </DialogHeader>
        <dl className="flex flex-col text-sm">
          <Rule
            description="People who do the work themselves. The lead’s own account is a guess, never one of them."
            label="People per step"
            value={`${rules.people}, or ${fewer} and a document, a log or an example`}
          />
          <Rule
            description="Fewer than this, and the workflow is still being mapped."
            label="Before it is checked"
            value={`${rules.minInterviews} approved ${plural(rules.minInterviews, "interview", "interviews")}`}
          />
          <Rule
            description="Then more interviews would only repeat what is known."
            label="When it stops"
            value={`The last ${rules.run} added less than ${percent.format(rules.stopShare)} new facts`}
          />
          <Rule
            description="Probably two workflows in one, or teams that work differently."
            label="When it does not settle"
            value={`After ${rules.maxInterviews} interviews, Stephen asks the lead to split it`}
          />
          <Rule
            description="Most differences are findings: it depends on the case, the office or the date. Only one nobody can explain needs someone to settle it."
            label="When people say different things"
            value={`${settlerWords[rules.settles]} settles one nobody can explain`}
          />
        </dl>
      </DialogContent>
    </Dialog>
  );
};

/** One piece of work in the table. */
const WorkRow = ({ row, team }: { row: WorkflowRow; team: string }) => {
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
    </TableRow>
  );
};

/**
 * The section for `view`. Until the company's core draws the work from
 * its interviews at all (`view.unknown.works`), there is no work to list,
 * and the section says it isn't known yet rather than that none was found.
 */
export const OrgWorkflows = ({ view }: { view: AdminView }) => {
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
      <section className="bg-card text-muted-foreground rounded-xl border px-5 py-4">
        {none}
      </section>
    );
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
          <p className="bg-card text-muted-foreground rounded-xl border px-4 py-6 text-center">
            No workflow matches.
          </p>
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
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((row) => (
                  <WorkRow
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

      <Rules
        onOpenChange={setRulesOpen}
        open={rulesOpen}
        rules={view.state.rules}
      />
    </div>
  );
};
