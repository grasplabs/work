import type { Goal, GoalWorkflow } from "@grasp-os/shared/brain";
import { brainGoalNoticeMaxLength } from "@grasp-os/shared/brain-records";
import type { WorkflowSummary } from "@grasp-os/shared/workflows";
import { Button } from "@grasp-os/ui/components/button";
import { Checkbox } from "@grasp-os/ui/components/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
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
import { Spinner } from "@grasp-os/ui/components/spinner";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { PencilIcon, PlusIcon, WorkflowIcon } from "lucide-react";
import { useId, useState } from "react";

import { todayUtc } from "../dashboard/programme.ts";
import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { listWorkflows } from "../workflows/reads.ts";
import {
  newGoalRecords,
  relinkedRecords,
  rewordedRecords,
} from "./goal-records.ts";
import type { GoalWording } from "./goal-records.ts";

// The board's goals as an admin changes them, on the Vision page: a new
// goal, a goal worded again (a new version: the old one stays in its
// history), and the company's workflows that serve each, linked and taken
// off. Each change is the brain's records (goal-records.ts), which core
// takes from admins alone and audits; the brain is read again after it.
// Members see the goals as notes, and nothing here.

/** Longest a goal's title is, as the brain keeps it. */
const titleMaxLength = 200;

/** A goal's newest wording. */
const wordingOf = (goal: Goal): GoalWording => {
  const newest = goal.versions.at(-1);
  return {
    title: newest?.title ?? "",
    howWeNotice: newest?.howWeNotice ?? "",
  };
};

/** Sets a new goal, or words `goal` again. */
const WordingDialog = ({
  goal,
  open,
  onOpenChange,
}: {
  /** The goal to word again; none to set a new one. */
  goal?: Goal;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const { t } = useLingui();
  const ids = useId();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const [wording, setWording] = useState<GoalWording>(() =>
    goal === undefined ? { title: "", howWeNotice: "" } : wordingOf(goal)
  );
  const unchanged =
    goal !== undefined &&
    wording.title.trim() === wordingOf(goal).title &&
    wording.howWeNotice.trim() === wordingOf(goal).howWeNotice;
  const canSave = wording.title.trim() !== "" && !unchanged && !busy;
  const save = async (): Promise<void> => {
    const day = todayUtc();
    const records =
      goal === undefined
        ? newGoalRecords(wording, day)
        : rewordedRecords(goal.id, wording, day);
    const saved = await run(
      async (session) => await session.brain.addRecords(records)
    );
    if (saved !== undefined) {
      onOpenChange(false);
      await router.invalidate();
    }
  };
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSave) {
              void save();
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {goal === undefined ? (
                <Trans>New board goal</Trans>
              ) : (
                <Trans>Reword the goal</Trans>
              )}
            </DialogTitle>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor={`${ids}-title`}>
              <Trans>Goal</Trans>
            </FieldLabel>
            <Input
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
              disabled={busy}
              id={`${ids}-title`}
              maxLength={titleMaxLength}
              onChange={(event) => {
                setWording({ ...wording, title: event.target.value });
              }}
              placeholder={t`What does the board want to reach?`}
              value={wording.title}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${ids}-notice`}>
              <Trans>How we notice it</Trans>
            </FieldLabel>
            <Textarea
              disabled={busy}
              id={`${ids}-notice`}
              maxLength={brainGoalNoticeMaxLength}
              onChange={(event) => {
                setWording({ ...wording, howWeNotice: event.target.value });
              }}
              placeholder={t`How will the company see that it is met?`}
              rows={3}
              value={wording.howWeNotice}
            />
            {goal === undefined ? null : (
              <FieldDescription>
                <Trans>
                  The earlier wording stays in the goal&apos;s history.
                </Trans>
              </FieldDescription>
            )}
          </Field>
          <ErrorText>{failure}</ErrorText>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              <Trans>Cancel</Trans>
            </DialogClose>
            <Button disabled={!canSave} type="submit">
              {busy ? <Spinner data-icon="inline-start" /> : null}
              <Trans>Save</Trans>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

const keyOf = ({ app, workflow }: GoalWorkflow): string => `${app}/${workflow}`;

/** Links the company's workflows that serve `goal`, and takes others off. */
const WorkflowsDialog = ({
  goal,
  workflows,
  open,
  onOpenChange,
}: {
  goal: Goal;
  /** The workflows the admin may see. */
  workflows: readonly WorkflowSummary[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const ids = useId();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const [chosen, setChosen] = useState<ReadonlySet<string>>(
    () => new Set(goal.workflows.map(keyOf))
  );
  const { title } = wordingOf(goal);
  const save = async (): Promise<void> => {
    const picked = workflows
      .map(({ app, workflow }) => ({ app, workflow }))
      .filter((each) => chosen.has(keyOf(each)));
    // A linked workflow the list doesn't show (its App went) stays linked.
    const shown = new Set(workflows.map(keyOf));
    const kept = goal.workflows.filter((each) => !shown.has(keyOf(each)));
    const records = relinkedRecords(goal, [...kept, ...picked], todayUtc());
    if (records.length === 0) {
      onOpenChange(false);
      return;
    }
    const saved = await run(
      async (session) => await session.brain.addRecords(records)
    );
    if (saved !== undefined) {
      onOpenChange(false);
      await router.invalidate();
    }
  };
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy) {
              void save();
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>
              <Trans>Workflows that serve {title}</Trans>
            </DialogTitle>
          </DialogHeader>
          {workflows.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              <Trans>There are no workflows to link yet.</Trans>
            </p>
          ) : (
            <ul className="flex max-h-80 flex-col gap-1 overflow-y-auto">
              {workflows.map((each) => {
                const key = keyOf(each);
                const id = `${ids}-${key}`;
                return (
                  <li className="flex items-center gap-2.5 py-1" key={key}>
                    <Checkbox
                      checked={chosen.has(key)}
                      disabled={busy}
                      id={id}
                      onCheckedChange={(checked) => {
                        const next = new Set(chosen);
                        if (checked) {
                          next.add(key);
                        } else {
                          next.delete(key);
                        }
                        setChosen(next);
                      }}
                    />
                    <label
                      className="flex min-w-0 flex-col text-sm"
                      htmlFor={id}
                    >
                      <span className="truncate">{each.workflow}</span>
                      <span className="text-muted-foreground truncate">
                        {each.appName}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          <ErrorText>{failure}</ErrorText>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              <Trans>Cancel</Trans>
            </DialogClose>
            <Button disabled={busy} type="submit">
              {busy ? <Spinner data-icon="inline-start" /> : null}
              <Trans>Save</Trans>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

/** What an admin changes of one goal, from its row. */
type Change = { goal: Goal; what: "wording" | "workflows" } | "new";

/** One goal's row: its newest wording, how many workflows serve it, and the ways to change it. */
const GoalRow = ({
  goal,
  busy,
  onChange,
}: {
  goal: Goal;
  busy: boolean;
  onChange: (change: Change) => void;
}) => {
  const { t } = useLingui();
  const { title, howWeNotice } = wordingOf(goal);
  const count = goal.workflows.length;
  return (
    <li className="flex flex-wrap items-start gap-3 py-3">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium">{title}</span>
        {howWeNotice === "" ? null : (
          <span className="text-muted-foreground text-sm">{howWeNotice}</span>
        )}
        <span className="text-muted-foreground text-xs">
          {plural(count, {
            one: "# workflow serves it",
            other: "# workflows serve it",
          })}
        </span>
      </span>
      <span className="flex flex-none gap-1.5">
        <Button
          aria-label={t`Reword ${title}`}
          onClick={() => {
            onChange({ goal, what: "wording" });
          }}
          size="sm"
          variant="outline"
        >
          <PencilIcon data-icon="inline-start" />
          <Trans>Reword</Trans>
        </Button>
        <Button
          aria-label={t`Workflows of ${title}`}
          disabled={busy}
          onClick={() => {
            onChange({ goal, what: "workflows" });
          }}
          size="sm"
          variant="outline"
        >
          <WorkflowIcon data-icon="inline-start" />
          <Trans>Workflows</Trans>
        </Button>
      </span>
    </li>
  );
};

/**
 * The board's goals as an admin changes them: each goal's row, and a new
 * goal. For admins only: core refuses anyone else's change.
 */
export const GoalsEditor = ({ goals }: { goals: readonly Goal[] }) => {
  const [change, setChange] = useState<Change>();
  const [workflows, setWorkflows] = useState<readonly WorkflowSummary[]>();
  const { busy, failure, run } = useCoreAction();
  const open = async (next: Change): Promise<void> => {
    if (
      next !== "new" &&
      next.what === "workflows" &&
      workflows === undefined
    ) {
      const listed = await run(listWorkflows);
      if (listed === undefined) {
        return;
      }
      setWorkflows(listed);
    }
    setChange(next);
  };
  const close = (isOpen: boolean): void => {
    if (!isOpen) {
      setChange(undefined);
      // Read again next time: an App may have changed meanwhile.
      setWorkflows(undefined);
    }
  };
  return (
    <section aria-labelledby="board-goals" className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-sm font-medium" id="board-goals">
          <Trans>Board goals</Trans>
        </h2>
        <Button
          onClick={() => {
            void open("new");
          }}
          size="sm"
        >
          <PlusIcon data-icon="inline-start" />
          <Trans>Add a goal</Trans>
        </Button>
      </div>
      {goals.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          <Trans>No goals yet.</Trans>
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border px-4">
          {goals.map((goal) => (
            <GoalRow
              busy={busy}
              goal={goal}
              key={goal.id}
              onChange={(next) => {
                void open(next);
              }}
            />
          ))}
        </ul>
      )}
      <ErrorText>{failure}</ErrorText>
      {change === "new" ? <WordingDialog onOpenChange={close} open /> : null}
      {change !== undefined && change !== "new" && change.what === "wording" ? (
        <WordingDialog
          goal={change.goal}
          key={change.goal.id}
          onOpenChange={close}
          open
        />
      ) : null}
      {change !== undefined &&
      change !== "new" &&
      change.what === "workflows" &&
      workflows !== undefined ? (
        <WorkflowsDialog
          goal={change.goal}
          key={change.goal.id}
          onOpenChange={close}
          open
          workflows={workflows}
        />
      ) : null}
    </section>
  );
};
