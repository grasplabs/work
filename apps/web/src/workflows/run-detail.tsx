import { failureText } from "@grasp-os/shared/errors";
import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@grasp-os/ui/components/sheet";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { isTransient } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import { useCore } from "../use-core.ts";
import type { Names } from "./activity-bar.tsx";
import { runDotOf, runStatusLabels } from "./run-status.ts";

// One run of an independent workflow, opened beside the page (prototype
// `workflow-inside/inside-traces.tsx` `Detail`): when it ran, how it
// ended, who started it, and what it returned or why it failed; then, for
// the workflow's builders, its steps (traces.tsx). The run is read on its
// own (`workflowResources.run`) and again until it ends: the list carries
// no result, as only the person it acted for and the organization's admins
// see what it returned or why it failed (it can hold what the run read for
// them). Everyone else is told so, rather than shown nothing.

/** How often a run still going is read again. */
const followMs = 1500;

/** Whether `run` has ended: nothing about it changes after. */
const ended = (run: WorkflowResourceRun): boolean => run.endedAt !== null;

/** A label over what it names, in a run's facts. */
const Fact = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex flex-col gap-0.5">
    <dt className="text-muted-foreground">{label}</dt>
    <dd>{children}</dd>
  </div>
);

/** What an ended run returned, or why it failed, as far as the reader may see. */
export const RunResultView = ({
  run,
  seesResult,
}: {
  run: WorkflowResourceRun;
  seesResult: boolean;
}) => {
  if (!ended(run)) {
    return null;
  }
  if (run.error !== undefined) {
    return (
      <section className="flex flex-col gap-2">
        <h3 className="text-muted-foreground">
          <Trans>Why it failed</Trans>
        </h3>
        <p>{run.error.message}</p>
        {run.error.code === null ? null : (
          <code className="text-muted-foreground text-xs">
            {run.error.code}
          </code>
        )}
      </section>
    );
  }
  if (run.output !== undefined) {
    return (
      <section className="flex flex-col gap-2">
        <h3 className="text-muted-foreground">
          <Trans>What it returned</Trans>
        </h3>
        <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs">
          {JSON.stringify(run.output, null, 2)}
        </pre>
      </section>
    );
  }
  // Core keeps the result from whoever may not see it, and says nothing
  // of one that is gone (a run cancelled, or kept past its retention).
  return seesResult ? null : (
    <p className="text-muted-foreground">
      <Trans>
        Only the person it ran for and the organization&apos;s admins see what
        it returned or why it failed.
      </Trans>
    </p>
  );
};

/** Run `opened`, read again until it ends: its facts, then its result. */
const RunFacts = ({
  workflow,
  opened,
  names,
  admin,
}: {
  workflow: string;
  opened: WorkflowResourceRun;
  names: Names;
  admin: boolean;
}) => {
  const core = useCore();
  const { t } = useLingui();
  const [run, setRun] = useState(opened);
  const [failure, setFailure] = useState<string>();

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const follow = async (): Promise<void> => {
      try {
        const read = await core.withSession(
          async (session) =>
            await session.workflowResources.run(workflow, opened.id)
        );
        if (stopped) {
          return;
        }
        setRun(read);
        setFailure(undefined);
        if (!ended(read)) {
          timer = setTimeout(() => {
            void follow();
          }, followMs);
        }
      } catch (error) {
        if (!stopped) {
          setFailure(failureText(error));
          if (isTransient(error)) {
            timer = setTimeout(() => {
              void follow();
            }, followMs);
          }
        }
      }
    };
    void follow();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [core, opened.id, workflow]);

  const seesResult = run.principal === names.me || admin;
  return (
    <div className="flex flex-col gap-6">
      <ErrorText>{failure}</ErrorText>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3">
        <Fact label={t`Status`}>
          <output className="inline-flex items-center gap-2">
            <span
              aria-hidden="true"
              className={`${runDotOf(run.status)} size-1.75 flex-none rounded-full`}
            />
            {t(runStatusLabels[run.status])}
          </output>
        </Fact>
        <Fact label={t`Started by`}>
          {run.principal === names.me
            ? t`You`
            : (names.people.get(run.principal) ?? t`Someone else`)}
        </Fact>
        <Fact label={t`Started`}>{formatDateTime(run.createdAt)}</Fact>
        <Fact label={t`Ended`}>
          {run.endedAt === null ? (
            <span className="text-muted-foreground">
              <Trans context="a run that hasn't ended">Not yet</Trans>
            </span>
          ) : (
            formatDateTime(run.endedAt)
          )}
        </Fact>
        <Fact label={t`Version`}>{run.version}</Fact>
      </dl>
      <RunResultView run={run} seesResult={seesResult} />
    </div>
  );
};

/**
 * A run opened beside the page, `steps` under its facts and result: what
 * its builders see of what it did.
 */
export const RunSheet = ({
  workflow,
  opened,
  names,
  admin,
  onClose,
  steps,
}: {
  workflow: string;
  opened: WorkflowResourceRun | null;
  names: Names;
  /** Whether the reader is one of the organization's admins. */
  admin: boolean;
  onClose: () => void;
  steps?: ReactNode;
}) => {
  const openedAt = opened === null ? "" : formatDateTime(opened.createdAt);
  return (
    <Sheet
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open={opened !== null}
    >
      <SheetContent>
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex flex-col gap-1 border-b px-6 py-5 pr-14">
            <SheetTitle>
              <Trans>The run started {openedAt}</Trans>
            </SheetTitle>
            <SheetDescription>
              <Trans context="what a side panel shows: one run of a workflow">
                A run of this workflow
              </Trans>
            </SheetDescription>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-8 overflow-y-auto px-6 py-5">
            {opened === null ? null : (
              <RunFacts
                // Another run starts from what the list says of it.
                key={opened.id}
                admin={admin}
                names={names}
                opened={opened}
                workflow={workflow}
              />
            )}
            {steps}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
};
