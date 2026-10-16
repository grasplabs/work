import { failureText } from "@grasp-os/shared/errors";
import type { WorkflowRunTrace } from "@grasp-os/shared/workflow-diagrams";
import { Button } from "@grasp-os/ui/components/button";
import { Label } from "@grasp-os/ui/components/label";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";

import { isTransient } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { useCore } from "../use-core.ts";
import { WorkflowDiagramView } from "./workflow-diagram.tsx";

// A test run of a workflow's current version, started with input the
// builder types, and laid over that version's diagram as the run's own
// journal says it went: the trace core reads from the engine, read again
// until the run ends. The version is the one published, pinned by the
// run: editing the draft meanwhile changes nothing of it.

/** How often a run still going is read again. */
const followMs = 1500;

const ended = (trace: WorkflowRunTrace): boolean =>
  trace.status === "completed" ||
  trace.status === "failed" ||
  trace.status === "cancelled";

export const TestRun = ({
  workflow,
  version,
}: {
  workflow: string;
  version: number;
}) => {
  const core = useCore();
  const { t } = useLingui();
  const [input, setInput] = useState("{}");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [runId, setRunId] = useState<string | null>(null);
  const [trace, setTrace] = useState<WorkflowRunTrace>();

  // The run is read again while it goes, and no longer once it ended or
  // the panel is gone.
  useEffect(() => {
    let stopped = runId === null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const follow = async (): Promise<void> => {
      try {
        if (runId === null) {
          return;
        }
        const read = await core.withSession(
          async (session) =>
            await session.workflowResources.runTrace(workflow, runId)
        );
        if (stopped) {
          return;
        }
        setTrace(read);
        setFailure(undefined);
        // Ended, or nothing more of it is shown: no need to read again.
        if (!(ended(read) || read.detailsRemoved)) {
          timer = setTimeout(() => {
            void follow();
          }, followMs);
        }
      } catch (error) {
        if (!stopped) {
          setFailure(failureText(error));
          // Core or the connection out for a moment: the run goes on, and
          // so does following it.
          if (isTransient(error)) {
            timer = setTimeout(() => {
              void follow();
            }, followMs);
          }
        }
      }
    };
    if (!stopped) {
      void follow();
    }
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [core, runId, workflow]);

  const start = async (): Promise<void> => {
    setFailure(undefined);
    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
    } catch {
      setFailure(t`The input isn't JSON.`);
      return;
    }
    setBusy(true);
    try {
      const started = await core.withSession(
        async (session) =>
          await session.workflowResources.start(workflow, {
            version,
            input: parsed,
            key: crypto.randomUUID(),
          })
      );
      setTrace(undefined);
      setRunId(started.runId);
    } catch (error) {
      setFailure(failureText(error));
    }
    setBusy(false);
  };

  const traceVersion = trace?.version;
  const states = new Map(
    (trace?.tasks ?? []).map(({ task, state }) => [task, state])
  );
  return (
    <section aria-labelledby="test-run" className="flex flex-col gap-3">
      <h2 className="font-medium" id="test-run">
        <Trans>Test run of version {version}</Trans>
      </h2>
      <div className="flex flex-col gap-2">
        <Label htmlFor="test-run-input">
          <Trans>Input</Trans>
        </Label>
        <Textarea
          id="test-run-input"
          onChange={(event) => {
            setInput(event.target.value);
          }}
          spellCheck={false}
          value={input}
          variant="code"
        />
      </div>
      <div>
        <Button
          disabled={busy}
          onClick={() => {
            void start();
          }}
          variant="outline"
        >
          {busy ? t`Starting…` : t`Start a test run`}
        </Button>
      </div>
      <ErrorText>{failure}</ErrorText>
      {trace === undefined ? null : (
        <div className="flex flex-col gap-2">
          <output>
            {
              {
                starting: t`The run is starting.`,
                running: t`The run is going.`,
                completed: t`The run completed.`,
                failed: t`The run failed.`,
                cancelled: t`The run was stopped.`,
              }[trace.status]
            }
          </output>
          {trace.detailsRemoved ? (
            <p className="text-muted-foreground">
              <Trans>
                The details of this run were removed when its retention ended.
              </Trans>
            </p>
          ) : null}
          <WorkflowDiagramView
            diagram={trace.diagram}
            label={t`What the run of version ${traceVersion} did`}
            states={states}
          />
        </div>
      )}
    </section>
  );
};
