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
import { RunFiles } from "./run-files.tsx";
import { runDotOf, runStatusLabels } from "./run-status.ts";
import { WaitingForAiProvider } from "./runs.tsx";
import { StopRun } from "./stop-run.tsx";

// One run of an independent workflow, opened beside the page (prototype
// `workflow-inside/inside-traces.tsx` `Detail`): when it ran, how it
// ended, who started it, and what it returned or why it failed; then, for
// the workflow's builders, its steps (traces.tsx). The run is read on its
// own (`workflowResources.run`) and again until it ends: the list carries
// no result, as only the person it acted for and the organization's admins
// see what it returned or why it failed (it can hold what the run read for
// them). Everyone else is told so, rather than shown nothing. Where its
// steps show under it, they follow the run (`status`): the run is read
// again only when where it is moves (its status, or a wait for its AI
// provider begun or ended, traces.tsx `followedState`), never on a second
// timer of its own. The workflow's builders may stop a run that hasn't
// ended (asked again first); the files it finished writing are there to
// download for those who may see what it returned (run-files.tsx).

/** How often a run still going is read again. */
const followMs = 1500;

/** Whether `run` has ended: nothing about it changes after. */
const ended = (run: WorkflowResourceRun): boolean => run.endedAt !== null;

/**
 * Whether a run's facts are read again on their own timer: only while it
 * goes on, and only where no steps follow it (`status`).
 */
const readsAgain = (
  run: WorkflowResourceRun,
  status: string | null | undefined
): boolean => status === undefined && !ended(run);

/** A label over what it names, in a run's facts. */
const Fact = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex flex-col gap-0.5">
    <dt className="text-muted-foreground">{label}</dt>
    <dd>{children}</dd>
  </div>
);

/** What an ended run returned, or why it failed, as far as the reader may see. */
/**
 * An opened run's status, and, while a step of it waits for its AI
 * provider, what for: as the runs table says it (`WaitingForAiProvider`).
 */
export const RunStatusFact = ({ run }: { run: WorkflowResourceRun }) => {
  const { t } = useLingui();
  return (
    <Fact label={t`Status`}>
      <output className="inline-flex items-center gap-2">
        <span
          aria-hidden="true"
          className={`${runDotOf(run.status)} size-1.75 flex-none rounded-full`}
        />
        {t(runStatusLabels[run.status])}
      </output>
      {run.aiProvider === undefined ? null : (
        <span className="text-muted-foreground block text-xs">
          <WaitingForAiProvider wait={run.aiProvider} />
        </span>
      )}
    </Fact>
  );
};

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

/**
 * Run `opened`: its facts, then its result. Read again until it ends, or,
 * given `status` (what its followed steps last said of it; null before
 * they said anything), once each time that moves.
 */
const RunFacts = ({
  workflow,
  opened,
  names,
  admin,
  status,
}: {
  workflow: string;
  opened: WorkflowResourceRun;
  names: Names;
  admin: boolean;
  status: string | null | undefined;
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
        if (readsAgain(read, status)) {
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
  }, [core, opened.id, workflow, status]);

  // Only its builders may stop a run: the reader's role, as core says it.
  const [builder, setBuilder] = useState(false);
  useEffect(() => {
    let stopped = false;
    const readRole = async (): Promise<void> => {
      try {
        const read = await core.withSession(
          async (session) => await session.workflowResources.get(workflow)
        );
        if (!stopped) {
          setBuilder(read.role === "builder");
        }
      } catch {
        // Not offered then: core would refuse the stop anyway.
      }
    };
    void readRole();
    return () => {
      stopped = true;
    };
  }, [core, workflow]);

  const stop = async (): Promise<void> => {
    const stopped = await core.withSession(
      async (session) =>
        await session.workflowResources.terminateRun(workflow, run.id)
    );
    setRun(stopped);
  };

  const seesResult = run.principal === names.me || admin;
  return (
    <div className="flex flex-col gap-6">
      <ErrorText>{failure}</ErrorText>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3">
        <RunStatusFact run={run} />
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
      {builder && !ended(run) ? <StopRun stop={stop} /> : null}
      <RunResultView run={run} seesResult={seesResult} />
      <RunFiles
        // Read again once the run ends, with what it finished last.
        key={ended(run) ? "ended" : "going"}
        run={run.id}
        workflow={workflow}
      />
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
  status,
}: {
  workflow: string;
  opened: WorkflowResourceRun | null;
  names: Names;
  /** Whether the reader is one of the organization's admins. */
  admin: boolean;
  onClose: () => void;
  steps?: ReactNode;
  /**
   * Where `steps` follow the run: where it is as they last read it, its
   * status and any wait for its AI provider (traces.tsx `followedState`;
   * null before they did), so the run's facts are not read on a timer too.
   */
  status?: string | null;
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
                status={status}
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
