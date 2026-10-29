import { failureText } from "@grasp-os/shared/errors";
import { maxItemTestItems } from "@grasp-os/shared/workflow-resources";
import type {
  WorkflowItemTest,
  WorkflowItemTestItem,
} from "@grasp-os/shared/workflow-resources";
import { Button } from "@grasp-os/ui/components/button";
import { Label } from "@grasp-os/ui/components/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useId, useState } from "react";

import { isTransient } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import { useCore } from "../use-core.ts";
import { runDotOf, runStatusLabels } from "./run-status.ts";

// "Test on recent items" (GRA-513, prototype `builder-runs.tsx`): the
// draft's checkpoint runs once on the input of each of the builder's most
// recent real runs, each a test run whose calls are answered from what the
// builder gives here, never made. Each item's result is read again until
// every item's test run ended, newest item first, as core keeps them; an
// item that never started says why, in core's words.

/** How often a test still going is read again. */
const followMs = 1500;

const endedStatuses = new Set(["completed", "failed", "cancelled"]);

/** Whether every item of `test` is done: ended, refused, or removed. */
export const itemTestSettled = (test: WorkflowItemTest): boolean =>
  test.items.every(({ run }) => run === null || endedStatuses.has(run.status));

/** How one item went, in words. */
const ItemResult = ({ item }: { item: WorkflowItemTestItem }) => {
  const { t } = useLingui();
  const { refusal } = item;
  if (refusal !== null) {
    return (
      <span className="text-muted-foreground">
        <Trans>Never started: {refusal}</Trans>
      </span>
    );
  }
  const { run } = item;
  if (run === null) {
    return (
      <span className="text-muted-foreground">
        <Trans>Removed after a week</Trans>
      </span>
    );
  }
  return (
    <span className="flex flex-col gap-1">
      <span className="inline-flex items-center gap-2">
        <span
          aria-hidden="true"
          className={`${runDotOf(run.status)} size-1.75 flex-none rounded-full`}
        />
        {t(runStatusLabels[run.status])}
      </span>
      {run.error === undefined ? null : (
        <span className="text-muted-foreground">{run.error.message}</span>
      )}
    </span>
  );
};

const ItemTestTable = ({ test }: { test: WorkflowItemTest }) => {
  const { t } = useLingui();
  const captionId = useId();
  const { draftRevision } = test;
  if (test.items.length === 0) {
    return (
      <p className="bg-card text-muted-foreground rounded-xl border px-4 py-6 text-center">
        <Trans>
          You have no recent runs whose input is still kept, so there was
          nothing to test on.
        </Trans>
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="bg-card overflow-hidden rounded-xl border">
        <Table aria-describedby={captionId}>
          <TableHeader>
            <TableRow>
              <TableHead variant="card">{t`Real run`}</TableHead>
              <TableHead variant="card">{t`Its version`}</TableHead>
              <TableHead variant="card">{t`How it went then`}</TableHead>
              <TableHead variant="card">
                {t`Revision ${draftRevision} on it`}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {test.items.map((item) => (
              <TableRow key={item.sourceRunId}>
                <TableCell variant="roomy">
                  {formatDateTime(item.sourceCreatedAt)}
                </TableCell>
                <TableCell variant="roomy">{item.sourceVersion}</TableCell>
                <TableCell variant="roomy">
                  {t(runStatusLabels[item.sourceStatus])}
                </TableCell>
                <TableCell variant="roomy">
                  <ItemResult item={item} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="text-muted-foreground" id={captionId}>
        <Trans>
          Newest item first. Nothing was sent or changed: every call was
          answered from what you gave.
        </Trans>
      </p>
    </div>
  );
};

export const ItemTest = ({
  workflow,
  revision,
}: {
  workflow: string;
  /** The draft's checkpoint revision, which the test runs. */
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
    <section aria-labelledby="item-test" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="font-medium" id="item-test">
          <Trans>Test revision {revision} on recent items</Trans>
        </h2>
        <p className="text-muted-foreground">
          <Trans>
            Runs the draft on the input of your {most} most recent runs. Nothing
            is sent or changed: each call it makes is answered from what you
            give here, by the name of its binding.
          </Trans>
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="item-test-answers">
          <Trans>What its calls answer</Trans>
        </Label>
        <Textarea
          id="item-test-answers"
          onChange={(event) => {
            setAnswers(event.target.value);
          }}
          spellCheck={false}
          value={answers}
          variant="code"
        />
      </div>
      <div>
        <Button
          disabled={busy || !settled}
          onClick={() => {
            void start();
          }}
          variant="outline"
        >
          {busy ? t`Starting…` : t`Test on recent items`}
        </Button>
      </div>
      <ErrorText>{failure}</ErrorText>
      {test === undefined ? null : <ItemTestTable test={test} />}
    </section>
  );
};
