import { failureText } from "@grasp-os/shared/errors";
import { maxItemTestItems } from "@grasp-os/shared/workflow-resources";
import type {
  WorkflowItemTest,
  WorkflowItemTestItem,
} from "@grasp-os/shared/workflow-resources";
import { Button } from "@grasp-os/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
} from "@grasp-os/ui/components/empty";
import { Field, FieldLabel } from "@grasp-os/ui/components/field";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { Text } from "@grasp-os/ui/components/text";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";

import { isTransient } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import { useCore } from "../use-core.ts";
import { RunStatusBadge } from "./run-detail.tsx";
import { runStatusLabels } from "./run-status.ts";
import { SectionCard } from "./section-card.tsx";

// "Test on recent items" (GRA-513, prototype `builder-runs.tsx`): the
// draft runs once, at its revision, on the input of each of the builder's most
// recent real runs, each a test run whose calls are answered from what the
// builder gives here, never made. Each item's result is read again until
// every item's test run ended, newest item first, as core keeps them; an
// item that never started says why, in core's words.

/** How often a test still going is read again. */
const followMs = 1500;

const endedStatuses = new Set(["completed", "failed", "cancelled"]);

/** Whether every item of `test` is done: ended, refused, or removed. */
const itemTestSettled = (test: WorkflowItemTest): boolean =>
  test.items.every(({ run }) => run === null || endedStatuses.has(run.status));

const styles = stylex.create({
  // The answers, the button and how it went, in the card.
  form: {
    display: "grid",
    rowGap: space["3"],
    justifyItems: "start",
    padding: space["4"],
  },
  answers: { justifySelf: "stretch" },
  result: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: space["1"],
  },
});

/** How one item went, in words. */
const ItemResult = ({ item }: { item: WorkflowItemTestItem }) => {
  const { t } = useLingui();
  const { refusal } = item;
  if (refusal !== null) {
    return (
      <Text as="span" color="muted" size="sm">
        {t`Never started: ${refusal}`}
      </Text>
    );
  }
  const { run } = item;
  if (run === null) {
    return (
      <Text as="span" color="muted" size="sm">
        {t`Removed after a week`}
      </Text>
    );
  }
  return (
    <span {...stylex.props(styles.result)}>
      <RunStatusBadge status={run.status} />
      {run.error === undefined ? null : (
        <Text as="span" color="muted" size="sm">
          {run.error.message}
        </Text>
      )}
    </span>
  );
};

const ItemTestTable = ({ test }: { test: WorkflowItemTest }) => {
  const { t } = useLingui();
  const { draftRevision } = test;
  const revision = draftRevision;
  if (test.items.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyDescription>
            {t`You have no recent runs whose input is still kept, so there was nothing to test on.`}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <Table aria-label={t`Test revision ${revision} on recent items`}>
      <TableHeader>
        <TableRow>
          <TableHead>{t`Real run`}</TableHead>
          <TableHead>{t`Its version`}</TableHead>
          <TableHead>{t`How it went then`}</TableHead>
          <TableHead>{t`Revision ${draftRevision} on it`}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {test.items.map((item) => (
          <TableRow key={item.sourceRunId}>
            <TableCell rowHeader>
              {formatDateTime(item.sourceCreatedAt)}
            </TableCell>
            <TableCell>{item.sourceVersion}</TableCell>
            <TableCell>{t(runStatusLabels[item.sourceStatus])}</TableCell>
            <TableCell wrap>
              <ItemResult item={item} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};

export const ItemTest = ({
  workflow,
  revision,
}: {
  workflow: string;
  /** The draft's revision, which the test runs. */
  revision: number;
}) => {
  const core = useCore();
  const { t } = useLingui();
  const [answers, setAnswers] = useState("{}");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [test, setTest] = useState<WorkflowItemTest>();
  const testId = test?.id;
  const settled = test === undefined || itemTestSettled(test);

  // The test is read again while any item goes, and no longer once each
  // ended or the panel is gone.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const follow = async (): Promise<void> => {
      if (testId === undefined) {
        return;
      }
      try {
        const read = await core.withSession(
          async (session) =>
            await session.workflowResources.itemTest(workflow, testId)
        );
        if (stopped) {
          return;
        }
        setTest(read);
        setFailure(undefined);
        if (!itemTestSettled(read)) {
          timer = setTimeout(() => {
            void follow();
          }, followMs);
        }
      } catch (error) {
        if (!stopped) {
          setFailure(failureText(error));
          // Out for a moment: the runs go on, and so does following them.
          if (isTransient(error)) {
            timer = setTimeout(() => {
              void follow();
            }, followMs);
          }
        }
      }
    };
    if (testId !== undefined) {
      timer = setTimeout(() => {
        void follow();
      }, followMs);
    }
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [core, testId, workflow]);

  const start = async (): Promise<void> => {
    setFailure(undefined);
    let fixtures: unknown;
    try {
      fixtures = JSON.parse(answers);
    } catch {
      setFailure(t`What the calls answer isn't JSON.`);
      return;
    }
    setBusy(true);
    try {
      setTest(
        await core.withSession(
          async (session) =>
            await session.workflowResources.startItemTest(workflow, {
              revision,
              fixtures,
            })
        )
      );
    } catch (error) {
      setFailure(failureText(error));
    }
    setBusy(false);
  };

  const most = maxItemTestItems;
  return (
    <SectionCard
      flush
      info={t`Runs the draft on the input of your ${most} most recent runs. Nothing is sent or changed: each call it makes is answered from what you give here, by the name of its binding.`}
      title={t`Test revision ${revision} on recent items`}
    >
      <div {...stylex.props(styles.form)}>
        <Field style={styles.answers}>
          <FieldLabel>{t`What its calls answer`}</FieldLabel>
          <Textarea
            onValueChange={setAnswers}
            spellCheck={false}
            value={answers}
          />
        </Field>
        <Button
          disabled={busy || !settled}
          variant="outline"
          onClick={() => {
            void start();
          }}
        >
          {busy ? t`Starting…` : t`Test on recent items`}
        </Button>
        <ErrorText>{failure}</ErrorText>
      </div>
      {test === undefined ? null : <ItemTestTable test={test} />}
    </SectionCard>
  );
};
