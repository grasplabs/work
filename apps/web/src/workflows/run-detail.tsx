import { failureText } from "@grasp-os/shared/errors";
import { runFileContentPath } from "@grasp-os/shared/run-files";
import type { RunFileListing } from "@grasp-os/shared/run-files";
import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { buttonVariants } from "@grasp-os/ui/components/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@grasp-os/ui/components/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { Trans, useLingui } from "@lingui/react/macro";
import { DownloadIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { isTransient } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { formatBytes, formatDateTime } from "../format.ts";
import { useCore } from "../use-core.ts";
import type { Names } from "./activity-bar.tsx";
import { runDotOf, runStatusLabels } from "./run-status.ts";
import { WaitingForAiProvider } from "./runs.tsx";

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
// timer of its own.

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

/** The files an ended run finished, each to download (GRA-888). */
const RunFileTable = ({
  workflow,
  run,
  files,
}: {
  workflow: string;
  run: string;
  files: RunFileListing[];
}) => {
  const { t } = useLingui();
  if (files.length === 0) {
    return (
      <p className="text-muted-foreground">
        <Trans>This run kept no files.</Trans>
      </p>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t`Name`}</TableHead>
          <TableHead>{t`Size`}</TableHead>
          <TableHead>{t`Finished`}</TableHead>
          <TableHead>
            <span className="sr-only">{t`Download`}</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {files.map(({ id, name, size, finishedAt }) => (
          <TableRow key={id}>
            <TableCell>{name}</TableCell>
            <TableCell>{formatBytes(size)}</TableCell>
            <TableCell>{formatDateTime(finishedAt)}</TableCell>
            <TableCell>
              {/* Core serves it as an attachment only, to those who may download it. */}
              <a
                aria-label={t`Download ${name}`}
                className={buttonVariants({
                  size: "icon-sm",
                  variant: "ghost",
                })}
                download
                href={runFileContentPath(workflow, run, id)}
              >
                <DownloadIcon />
              </a>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};

/**
 * The files an ended run finished, for those core lets download them (its
 * person and, unless the run is restricted, the organization's admins):
 * nothing for anyone else, whom core answers null. Core decides who sees
 * what and serves each file only as an attachment.
 */
const RunFiles = ({
  workflow,
  run,
}: {
  workflow: string;
  run: WorkflowResourceRun;
}) => {
  const core = useCore();
  const [files, setFiles] = useState<RunFileListing[] | null>(null);
  const [failure, setFailure] = useState<string>();
  const hasEnded = ended(run);

  useEffect(() => {
    let stopped = false;
    const read = async (): Promise<void> => {
      try {
        const listed = await core.withSession(
          async (session) =>
            await session.workflowResources.runFiles(workflow, run.id)
        );
        if (!stopped) {
          setFiles(listed);
          setFailure(undefined);
        }
      } catch (error) {
        if (!stopped) {
          setFailure(failureText(error));
        }
      }
    };
    // A run still going finishes no files yet: read once it ends.
    if (hasEnded) {
      void read();
    }
    return () => {
      stopped = true;
    };
  }, [core, workflow, run.id, hasEnded]);

  if (failure === undefined && files === null) {
    return null;
  }
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-muted-foreground">
        <Trans>Files</Trans>
      </h3>
      <ErrorText>{failure}</ErrorText>
      {files === null ? null : (
        <RunFileTable files={files} run={run.id} workflow={workflow} />
      )}
    </section>
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
      <RunResultView run={run} seesResult={seesResult} />
      <RunFiles run={run} workflow={workflow} />
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
