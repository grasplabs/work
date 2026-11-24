import { failureText } from "@grasp-os/shared/errors";
import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { Badge } from "@grasp-os/ui/components/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";

import { isTransient } from "../core.ts";
import { useCore } from "../use-core.ts";
import { personOf } from "./activity-words.ts";
import type { Names } from "./activity-words.ts";
import { Code } from "./code.tsx";
import { runStatusLabels, runToneOf } from "./run-status.ts";
import type { AnyRunStatus } from "./run-status.ts";

// What a run of an independent workflow shows wherever it is shown (its
// page, run-page.tsx; a test's rows): its status as a Badge, the kept
// values it started without, what it returned or why it failed as far as
// the reader may see it (only the person it acted for and the
// organization's admins see that: it can hold what the run read for
// them), who started it, and the run read again until it ends, with the
// stop its builders may give it.

/** How often a run still going is read again. */
const followMs = 1500;

const styles = stylex.create({
  // What stands in a section's card, in its rows' inset.
  card: {
    display: "grid",
    rowGap: space["2"],
    paddingBlock: space["3"],
    paddingInline: space.sidePanelPadding,
    minWidth: 0,
  },
});

/** Whether `run` has ended: nothing about it changes after. */
const ended = (run: WorkflowResourceRun): boolean => run.endedAt !== null;

/** A run's status, in words, as a Badge. */
export const RunStatusBadge = ({ status }: { status: AnyRunStatus }) => {
  const { t } = useLingui();
  return (
    <Badge size="sm" variant={runToneOf(status)}>
      {t(runStatusLabels[status])}
    </Badge>
  );
};

/**
 * How many kept values a run started without, if any: core withheld them
 * as the runs that kept them read something no longer there to read, and
 * the run read them as unset (core's workflow-state.ts).
 */
export const StartedWithout = ({ run }: { run: WorkflowResourceRun }) => {
  const { t } = useLingui();
  const count = run.stateWithheld;
  if (count === undefined) {
    return null;
  }
  return (
    <div {...stylex.props(styles.card)}>
      <Text color="muted" size="sm">
        {t`${plural(count, {
          one: "It started without # kept value: the run that kept it read something that is no longer there to read.",
          other:
            "It started without # kept values: the runs that kept them read something that is no longer there to read.",
        })}`}
      </Text>
    </div>
  );
};

/**
 * What an ended run returned, or why it failed, as far as the reader may
 * see: its section's card in the panel, or, where core kept it from them,
 * who sees it.
 */
export const RunResultView = ({
  run,
  seesResult,
  builder = false,
}: {
  run: WorkflowResourceRun;
  seesResult: boolean;
  /** Whether the reader builds the workflow: they may see a failure's code, folded away. */
  builder?: boolean;
}) => {
  const { t } = useLingui();
  if (!ended(run)) {
    return null;
  }
  if (run.error !== undefined) {
    return (
      <div {...stylex.props(styles.card)}>
        <Text size="sm">{run.error.message}</Text>
        {builder && run.error.code !== null ? (
          <Collapsible>
            <CollapsibleTrigger>
              {t({
                message: "Details",
                context: "a failed run's error code, folded away",
              })}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <Text color="muted" size="xs">
                <code>{run.error.code}</code>
              </Text>
            </CollapsibleContent>
          </Collapsible>
        ) : null}
      </div>
    );
  }
  if (run.result !== undefined) {
    return <Code code={JSON.stringify(run.result, null, 2)} language="json" />;
  }
  // Core keeps the result from whoever may not see it, and says nothing
  // of one that is gone (a run cancelled, or kept past its retention).
  return seesResult ? null : (
    <Text color="muted" size="sm">
      {t`Only the person it ran for and the organization's admins see what it returned or why it failed.`}
    </Text>
  );
};

/**
 * Run `opened`, read again until it ends; whether the reader builds the
 * workflow, and so may stop it; and the stop.
 */
export const useFollowedRun = (
  workflow: string,
  opened: WorkflowResourceRun
) => {
  const core = useCore();
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

  return { run, failure, builder, stop };
};

/** Who started a run, in words, by its person's ID. */
export const useStartedBy = (names: Names) => {
  const { t } = useLingui();
  return (principal: string): string =>
    principal === names.me ? t`You` : personOf(names, principal);
};
