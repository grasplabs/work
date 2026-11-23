import { failureText } from "@grasp-os/shared/errors";
import type {
  WorkflowResourceRun,
  WorkflowRunStatus,
} from "@grasp-os/shared/workflow-resources";
import { Badge } from "@grasp-os/ui/components/badge";
import type { BadgeVariant } from "@grasp-os/ui/components/badge";
import { IconTile } from "@grasp-os/ui/components/icon-tile";
import {
  Item,
  ItemContent,
  ItemDetail,
  ItemGroup,
  ItemSeparator,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Sheet, SheetContent, SheetTitle } from "@grasp-os/ui/components/sheet";
import {
  SidePanel,
  SidePanelContent,
  SidePanelHeader,
  SidePanelSection,
} from "@grasp-os/ui/components/side-panel";
import { Text } from "@grasp-os/ui/components/text";
import { PlayIcon } from "@grasp-os/ui/lib/icons";
import { visuallyHidden } from "@grasp-os/ui/lib/styles";
import { size, space } from "@grasp-os/ui/lib/tokens.stylex";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState, Fragment } from "react";
import type { ReactNode } from "react";

import { isTransient } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import { useCore } from "../use-core.ts";
import type { Names } from "./activity-bar.tsx";
import { Code } from "./code.tsx";
import { RunFilesReader, useRunFilesSection } from "./run-files.tsx";
import type { RunFilesRead, RunPanelSection } from "./run-files.tsx";
import { runStatusLabels } from "./run-status.ts";
import { WaitingForAiProvider } from "./runs.tsx";
import { StopRun } from "./stop-run.tsx";

// One run of an independent workflow, opened beside its list on a side
// panel (in a Sheet where the page is narrow): when it
// ran, how it ended, who started it, and what it returned or why it
// failed; then, for the workflow's builders, its steps (traces.tsx). The
// run is read on its own (`workflowResources.run`) and again until it
// ends: the list carries no result, as only the person it acted for and
// the organization's admins see what it returned or why it failed (it can
// hold what the run read for them). Everyone else is told so, rather than
// shown nothing. Where its steps show under it, they follow the run
// (`status`): the run is read again only when where it is moves (its
// status, or a wait for its AI provider begun or ended, traces.tsx
// `followedState`), never on a second timer of its own. The workflow's
// builders may stop a run that hasn't ended (asked again first); the files
// it finished writing are there to download for those who may see what it
// returned (run-files.tsx).

/** How often a run still going is read again. */
const followMs = 1500;

/** How wide the page must be for a run to open beside its list. */
const besideFrom = 60 * 16;

const styles = stylex.create({
  // The list and the run opened beside it.
  split: {
    display: "grid",
    gridTemplateColumns: `minmax(0, 1fr) ${size.sidePanelWidth}`,
    columnGap: space["6"],
    alignItems: "start",
  },
  // What stands in a section's card, in its rows' inset.
  card: {
    display: "grid",
    rowGap: space["2"],
    paddingBlock: space["3"],
    paddingInline: space.sidePanelPadding,
    minWidth: 0,
  },
  // Its status, and what it waits for, under its name.
  status: {
    display: "inline-flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: space["1"],
  },
});

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

/**
 * How a run's status stands as a Badge: done is success, failed is
 * danger, anything else a plain fact (nobody need act on it).
 */
const runVariantOf = (status: WorkflowRunStatus): BadgeVariant => {
  if (status === "completed") {
    return "success";
  }
  return status === "failed" ? "destructive" : "default";
};

/** A run's status, in words, as a Badge. */
export const RunStatusBadge = ({ status }: { status: WorkflowRunStatus }) => {
  const { t } = useLingui();
  return (
    <Badge size="sm" variant={runVariantOf(status)}>
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
 * An opened run's status, and, while a step of it waits for its AI
 * provider, what for: as the runs table says it (`WaitingForAiProvider`).
 */
const RunStatusFact = ({ run }: { run: WorkflowResourceRun }) => (
  <output {...stylex.props(styles.status)}>
    <RunStatusBadge status={run.status} />
    {run.aiProvider === undefined ? null : (
      <Text as="span" color="muted" size="xs">
        <WaitingForAiProvider wait={run.aiProvider} />
      </Text>
    )}
  </output>
);

/**
 * What an ended run's result is titled in its panel: why it failed, or
 * what it returned; none when there is nothing of either to show.
 */
const resultLabelOf = (
  run: WorkflowResourceRun
): "failed" | "returned" | null => {
  if (!ended(run)) {
    return null;
  }
  if (run.error !== undefined) {
    return "failed";
  }
  return run.result === undefined ? null : "returned";
};

/**
 * What an ended run returned, or why it failed, as far as the reader may
 * see: its section's card in the panel, or, where core kept it from them,
 * who sees it.
 */
export const RunResultView = ({
  run,
  seesResult,
}: {
  run: WorkflowResourceRun;
  seesResult: boolean;
}) => {
  const { t } = useLingui();
  if (!ended(run)) {
    return null;
  }
  if (run.error !== undefined) {
    return (
      <div {...stylex.props(styles.card)}>
        <Text size="sm">{run.error.message}</Text>
        {run.error.code === null ? null : (
          <Text color="muted" size="xs">
            <code>{run.error.code}</code>
          </Text>
        )}
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
 * Run `opened`, read again until it ends, or, given `status` (what its
 * followed steps last said of it; null before they said anything), once
 * each time that moves; whether the reader builds the workflow, and so
 * may stop it; and the stop.
 */
const useFollowedRun = (
  workflow: string,
  opened: WorkflowResourceRun,
  status: string | null | undefined
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

  return { run, failure, builder, stop };
};

/** Who started a run, in words, by its person's ID. */
export const useStartedBy = (names: Names) => {
  const { t } = useLingui();
  return (principal: string): string =>
    principal === names.me
      ? t`You`
      : (names.people.get(principal) ?? t`Someone else`);
};

/** Where a panel or a list holding it says what went wrong reading it. */
const Failure = ({ children }: { children: string | undefined }) =>
  children === undefined ? null : (
    <div {...stylex.props(styles.card)}>
      <ErrorText>{children}</ErrorText>
    </div>
  );

/**
 * Run `opened` on the Inspector panel: its status under its name; its
 * facts; what it returned or why it failed; the files it wrote; then
 * `steps`, for its builders. Beside the list (`framed`), or in a Sheet.
 */
const RunPanel = ({
  workflow,
  opened,
  names,
  admin,
  framed,
  onClose,
  steps,
  status,
}: {
  workflow: string;
  opened: WorkflowResourceRun;
  names: Names;
  admin: boolean;
  framed: boolean;
  onClose: () => void;
  steps: ReactNode;
  status: string | null | undefined;
}) => {
  const { t } = useLingui();
  const { run, failure, builder, stop } = useFollowedRun(
    workflow,
    opened,
    status
  );
  const startedBy = useStartedBy(names);
  const [files, setFiles] = useState<RunFilesRead>();
  const filesSection = useRunFilesSection(workflow, run.id, files);
  const openedAt = formatDateTime(opened.createdAt);
  const seesResult = run.principal === names.me || admin;
  const facts = [
    { id: "started-by", name: t`Started by`, detail: startedBy(run.principal) },
    { id: "started", name: t`Started`, detail: formatDateTime(run.createdAt) },
    {
      id: "ended",
      name: t`Ended`,
      detail:
        run.endedAt === null
          ? t({ message: "Not yet", context: "a run that hasn't ended" })
          : formatDateTime(run.endedAt),
    },
    { id: "version", name: t`Version`, detail: String(run.version) },
  ];
  const sections: RunPanelSection[] = [];
  const result = resultLabelOf(run);
  if (result !== null) {
    sections.push({
      id: "result",
      label: result === "failed" ? t`Why it failed` : t`What it returned`,
      content: <RunResultView run={run} seesResult={seesResult} />,
    });
  }
  if (filesSection !== undefined) {
    sections.push(filesSection);
  }
  if (steps !== null && steps !== undefined) {
    sections.push({ id: "steps", label: t`What it did`, content: steps });
  }
  const label = t`The run started ${openedAt}`;
  return (
    <SidePanel aria-label={label} framed={framed}>
      <SidePanelHeader
        actions={builder && !ended(run) ? <StopRun stop={stop} /> : undefined}
        description={<RunStatusFact run={run} />}
        icon={<IconTile icon={PlayIcon} variant="tinted" />}
        onClose={onClose}
        title={label}
      />
      <SidePanelContent>
        <SidePanelSection title={t`Details`}>
          <ItemGroup aria-label={t`Details`}>
            {facts.map((fact, at) => (
              <Fragment key={fact.id}>
                {at === 0 ? null : <ItemSeparator />}
                <Item size="xs">
                  <ItemContent>
                    <ItemTitle>
                      {fact.name}
                      <ItemDetail>{fact.detail}</ItemDetail>
                    </ItemTitle>
                  </ItemContent>
                </Item>
              </Fragment>
            ))}
          </ItemGroup>
          {/* The kept values it started without, if any, under its facts. */}
          <StartedWithout run={run} />
        </SidePanelSection>
        {sections.map((section) => (
          <SidePanelSection key={section.id} title={section.label}>
            {section.content}
          </SidePanelSection>
        ))}
        <Failure>{failure}</Failure>
        <Failure>{files === undefined ? undefined : files.failure}</Failure>
        <RunFilesReader
          // Read again once the run ends, with what it finished last.
          key={ended(run) ? "ended" : "going"}
          onRead={setFiles}
          run={run.id}
          workflow={workflow}
        />
        {result === null ? (
          <RunResultView run={run} seesResult={seesResult} />
        ) : null}
      </SidePanelContent>
    </SidePanel>
  );
};

/** Whether the element `holder` holds is wide enough for a run beside its list. */
const useWide = (holder: { current: HTMLDivElement | null }): boolean => {
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const element = holder.current;
    const watch =
      element === null || typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(([entry]) => {
            setWide((entry?.contentRect.width ?? 0) >= besideFrom);
          });
    if (element !== null) {
      watch?.observe(element);
    }
    return () => {
      watch?.disconnect();
    };
  }, [holder]);
  return wide;
};

/**
 * A list of runs (`children`) with run `opened` beside it, `steps` under
 * its facts and result: what its builders see of what it did. In a Sheet
 * over the list where the page is narrow.
 */
export const RunBeside = ({
  workflow,
  opened,
  names,
  admin,
  onClose,
  steps,
  status,
  children,
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
  /** The list the run was opened from. */
  children?: ReactNode;
}) => {
  const { t } = useLingui();
  const holder = useRef<HTMLDivElement>(null);
  const wide = useWide(holder);
  const panel = (framed: boolean) =>
    opened === null ? null : (
      <RunPanel
        // Another run starts from what the list says of it.
        key={opened.id}
        admin={admin}
        framed={framed}
        names={names}
        onClose={onClose}
        opened={opened}
        status={status}
        steps={steps}
        workflow={workflow}
      />
    );
  const openedAt = opened === null ? "" : formatDateTime(opened.createdAt);
  return (
    <div ref={holder}>
      {wide && opened !== null ? (
        <div {...stylex.props(styles.split)}>
          <div>{children}</div>
          {panel(true)}
        </div>
      ) : (
        children
      )}
      <Sheet
        onOpenChange={(open) => {
          if (!open) {
            onClose();
          }
        }}
        open={!wide && opened !== null}
      >
        {/* The panel draws the title and the close: the sheet names it only. */}
        <SheetContent showCloseButton={false}>
          <span {...stylex.props(visuallyHidden)}>
            <SheetTitle>{t`The run started ${openedAt}`}</SheetTitle>
          </span>
          {wide ? null : panel(false)}
        </SheetContent>
      </Sheet>
    </div>
  );
};
