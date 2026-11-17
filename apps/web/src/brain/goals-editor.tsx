import type { Goal } from "@grasp-os/shared/brain";
import { brainGoalNoticeMaxLength } from "@grasp-os/shared/brain-records";
import type { WorkflowSummary } from "@grasp-os/shared/workflows";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useId, useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { Button } from "../grasp/button/index.ts";
import { Checkbox } from "../grasp/checkbox/index.ts";
import {
  Dialog,
  DialogAction,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "../grasp/dialog/index.ts";
import { Field, FieldDescription, FieldLabel } from "../grasp/field/index.ts";
import { Edit, Plus, Workflow } from "../grasp/icons/index.ts";
import { Input } from "../grasp/input/index.ts";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemDetail,
  ItemGroup,
  ItemTitle,
} from "../grasp/item/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { Text } from "../grasp/text/index.ts";
import { Textarea } from "../grasp/textarea/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
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

const styles = stylex.create({
  form: { display: "flex", flexDirection: "column", gap: grasp.space5 },
  list: { display: "flex", flexDirection: "column", gap: grasp.space1 },
  actions: { display: "flex", gap: grasp.space2 },
});

/** Today in UTC, as the brain's records date a change: `YYYY-MM-DD`. */
const todayUtc = (): string => new Date().toISOString().slice(0, 10);

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

/** Whether `wording` says what `goal` already says. */
const sameWording = (goal: Goal | undefined, wording: GoalWording): boolean =>
  goal !== undefined &&
  wording.title.trim() === wordingOf(goal).title &&
  wording.howWeNotice.trim() === wordingOf(goal).howWeNotice;

/** The records that set `wording`: a new goal, or `goal` worded again. */
const wordingRecords = (goal: Goal | undefined, wording: GoalWording) => {
  const day = todayUtc();
  return goal === undefined
    ? newGoalRecords(wording, day)
    : rewordedRecords(goal.id, wording, day);
};

/** The records that link `chosen` of the `workflows` shown to `goal`. */
const linkRecords = (
  goal: Goal,
  workflows: readonly WorkflowSummary[],
  chosen: ReadonlySet<string>
) => {
  const picked = workflows
    .map(({ workflowId }) => workflowId)
    .filter((each) => chosen.has(each));
  // A linked workflow the list doesn't show (deleted since) stays linked.
  const shown = new Set<string>(workflows.map(({ workflowId }) => workflowId));
  const kept = goal.workflows.filter((each) => !shown.has(each));
  return relinkedRecords(goal, [...kept, ...picked], todayUtc());
};

/** `chosen` with `key` in or out. */
const toggled = (
  chosen: ReadonlySet<string>,
  key: string,
  checked: boolean
): ReadonlySet<string> => {
  const next = new Set(chosen);
  if (checked) {
    next.add(key);
  } else {
    next.delete(key);
  }
  return next;
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
  const formId = useId();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const [wording, setWording] = useState<GoalWording>(() =>
    goal === undefined ? { title: "", howWeNotice: "" } : wordingOf(goal)
  );
  const canSave =
    wording.title.trim() !== "" && !sameWording(goal, wording) && !busy;
  /** Saves the wording; whether it was saved. */
  const saved = async (): Promise<boolean> => {
    const records = wordingRecords(goal, wording);
    const done = await run(
      async (session) => await session.brain.addRecords(records)
    );
    if (done === undefined) {
      return false;
    }
    await router.invalidate();
    return true;
  };
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent closeLabel={t`Close`}>
        <DialogTitle>
          {goal === undefined ? t`New board goal` : t`Reword the goal`}
        </DialogTitle>
        <DialogBody>
          <form
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              if (canSave) {
                void (async () => {
                  if (await saved()) {
                    onOpenChange(false);
                  }
                })();
              }
            }}
            {...stylex.props(styles.form)}
          >
            <Field>
              <FieldLabel>{t`Goal`}</FieldLabel>
              <Input
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                disabled={busy}
                maxLength={titleMaxLength}
                onValueChange={(title) => {
                  setWording({ ...wording, title });
                }}
                placeholder={t`What does the board want to reach?`}
                value={wording.title}
              />
            </Field>
            <Field>
              <FieldLabel>{t`How we notice it`}</FieldLabel>
              <Textarea
                disabled={busy}
                maxLength={brainGoalNoticeMaxLength}
                onValueChange={(howWeNotice) => {
                  setWording({ ...wording, howWeNotice });
                }}
                placeholder={t`How will the company see that it is met?`}
                rows={3}
                value={wording.howWeNotice}
              />
              {goal === undefined ? null : (
                <FieldDescription>
                  {t`The earlier wording stays in the goal's history.`}
                </FieldDescription>
              )}
            </Field>
            <ErrorText>{failure}</ErrorText>
          </form>
        </DialogBody>
        <DialogFooter>
          <DialogAction>{t`Cancel`}</DialogAction>
          <DialogAction
            action={async () => {
              if (!(await saved())) {
                // The dialog stays open, with core's reason above the buttons.
                throw new Error("The goal wasn't saved.");
              }
            }}
            disabled={!canSave}
            failedLabel={t`Not saved`}
            variant="ink"
            workingLabel={t`Saving`}
          >
            {t`Save`}
          </DialogAction>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

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
  const { t } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const [chosen, setChosen] = useState<ReadonlySet<string>>(
    () => new Set(goal.workflows)
  );
  const { title } = wordingOf(goal);
  const save = async (): Promise<void> => {
    const records = linkRecords(goal, workflows, chosen);
    if (records.length === 0) {
      return;
    }
    const done = await run(
      async (session) => await session.brain.addRecords(records)
    );
    if (done === undefined) {
      // The dialog stays open, with core's reason above the buttons.
      throw new Error("The workflows weren't linked.");
    }
    await router.invalidate();
  };
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent closeLabel={t`Close`}>
        <DialogTitle>{t`Workflows that serve ${title}`}</DialogTitle>
        <DialogBody>
          {workflows.length === 0 ? (
            <Text tone="muted">{t`There are no workflows to link yet.`}</Text>
          ) : (
            <div {...stylex.props(styles.list)}>
              {workflows.map((each) => {
                const key = each.workflowId;
                return (
                  <Field key={key} orientation="horizontal">
                    <Checkbox
                      checked={chosen.has(key)}
                      disabled={busy}
                      onCheckedChange={(checked) => {
                        setChosen(toggled(chosen, key, checked === true));
                      }}
                    />
                    <FieldLabel>{each.name}</FieldLabel>
                  </Field>
                );
              })}
            </div>
          )}
          <ErrorText>{failure}</ErrorText>
        </DialogBody>
        <DialogFooter>
          <DialogAction>{t`Cancel`}</DialogAction>
          <DialogAction
            action={save}
            disabled={busy}
            failedLabel={t`Not saved`}
            variant="ink"
            workingLabel={t`Saving`}
          >
            {t`Save`}
          </DialogAction>
        </DialogFooter>
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
    <Item>
      <ItemContent>
        <ItemTitle>
          {title}
          <ItemDetail>
            {plural(count, {
              one: "# workflow serves it",
              other: "# workflows serve it",
            })}
          </ItemDetail>
        </ItemTitle>
        {howWeNotice === "" ? null : (
          <ItemDescription>{howWeNotice}</ItemDescription>
        )}
      </ItemContent>
      <ItemActions>
        <div {...stylex.props(styles.actions)}>
          <Button
            aria-label={t`Reword ${title}`}
            icon={Edit}
            onClick={() => {
              onChange({ goal, what: "wording" });
            }}
            size="sm"
            variant="quiet"
          >
            {t`Reword`}
          </Button>
          <Button
            aria-label={t`Workflows of ${title}`}
            disabled={busy}
            icon={Workflow}
            onClick={() => {
              onChange({ goal, what: "workflows" });
            }}
            size="sm"
            variant="quiet"
          >
            {t`Workflows`}
          </Button>
        </div>
      </ItemActions>
    </Item>
  );
};

/** Whether `change` is the given goal's change of `what`. */
const changeOf = (
  change: Change | undefined,
  what: "wording" | "workflows"
): Goal | undefined =>
  change !== undefined && change !== "new" && change.what === what
    ? change.goal
    : undefined;

/**
 * The board's goals as an admin changes them: each goal's row, and a new
 * goal. For admins only: core refuses anyone else's change.
 */
export const GoalsEditor = ({ goals }: { goals: readonly Goal[] }) => {
  const { t } = useLingui();
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
      // Read again next time: a workflow may have changed meanwhile.
      setWorkflows(undefined);
    }
  };
  const rewording = changeOf(change, "wording");
  const linking = changeOf(change, "workflows");
  return (
    <SectionCard
      actions={
        <Button
          icon={Plus}
          onClick={() => {
            void open("new");
          }}
          size="sm"
          variant="ink"
        >
          {t`Add a goal`}
        </Button>
      }
      density="compact"
      flush={goals.length > 0}
      title={t`Board goals`}
    >
      {goals.length === 0 ? (
        <Text tone="muted">{t`No goals yet.`}</Text>
      ) : (
        <ItemGroup aria-label={t`Board goals`} separated>
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
        </ItemGroup>
      )}
      <ErrorText>{failure}</ErrorText>
      {change === "new" ? <WordingDialog onOpenChange={close} open /> : null}
      {rewording === undefined ? null : (
        <WordingDialog
          goal={rewording}
          key={rewording.id}
          onOpenChange={close}
          open
        />
      )}
      {linking === undefined || workflows === undefined ? null : (
        <WorkflowsDialog
          goal={linking}
          key={linking.id}
          onOpenChange={close}
          open
          workflows={workflows}
        />
      )}
    </SectionCard>
  );
};
