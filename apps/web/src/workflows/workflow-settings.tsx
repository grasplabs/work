import type { WorkflowLifecycle } from "@grasp-os/shared/workflow-lifecycle";
import type {
  SteeredWrite,
  WorkflowDraft,
  WorkflowParams,
  WorkflowResource,
  WorkflowResourceVersion,
  WorkflowState,
} from "@grasp-os/shared/workflow-resources";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link, useRouter } from "@tanstack/react-router";
import { useId } from "react";

import { formatDateTime, formatList } from "../format.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import { Badge } from "../grasp/badge/index.ts";
import { Empty } from "../grasp/empty/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import {
  FactRow,
  SettingRow,
  SettingsRows,
} from "../grasp/setting-row/index.ts";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../grasp/table/index.ts";
import { TabsLink, TabsNav } from "../grasp/tabs/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import type { Loaded } from "../load-from-core.tsx";
import type { Names } from "./activity-bar.tsx";
import { AskStephen } from "./ask-stephen.tsx";
import {
  ProcessBadge,
  ProcessPicker,
  processCovers,
} from "./business-process.tsx";
import { DefinitionEditor } from "./definition-editor.tsx";
import { DeleteWorkflow } from "./delete-workflow.tsx";
import { FilesAndApps } from "./files-and-apps.tsx";
import { KeptState } from "./kept-state.tsx";
import { ResourceParams } from "./resource-params.tsx";
import { SavedAgo } from "./saved-ago.tsx";
import { VersionSource } from "./version-source.tsx";
import { LiveFacts } from "./workflow-status.tsx";
import { WorkflowTriggers } from "./workflow-triggers.tsx";

// Everything about a workflow besides its Flow and its runs, in one place,
// a section at a time, as an App's settings are (apps/app-settings.tsx):
// what it serves, whose it is and where it stands (General), what starts
// it on its own (Triggers), the files its runs wrote and the apps and
// Brain it works in (Files and apps), its parameters and what it keeps
// between runs (Parameters), the JSON behind its Flow, for its builders,
// who save and publish it there (Definition), and its published versions
// (Versions). Each section is an address of its own (`?section=`).

/** The sections, in the order the list shows them. */
const workflowSettingsSections = [
  "general",
  "triggers",
  "files",
  "parameters",
  "definition",
  "versions",
] as const;

export type WorkflowSettingsSection = (typeof workflowSettingsSections)[number];

/** A section named in an address, or none for anything else. */
export const workflowSettingsSectionOf = (
  value: unknown
): WorkflowSettingsSection | undefined =>
  workflowSettingsSections.find((section) => section === value);

const sectionLabels: Record<WorkflowSettingsSection, MessageDescriptor> = {
  general: msg({
    message: "General",
    context: "a workflow's settings section",
  }),
  triggers: msg({
    message: "Triggers",
    context: "a workflow's settings section",
  }),
  files: msg({
    message: "Files and apps",
    context: "a workflow's settings section",
  }),
  parameters: msg({
    message: "Parameters",
    context: "a workflow's settings section",
  }),
  definition: msg({
    message: "Definition",
    context: "a workflow's settings section",
  }),
  versions: msg({
    message: "Versions",
    context: "a workflow's settings section",
  }),
};

// How wide a section's column grows, as an App's settings have it
// (apps/app-settings.tsx): Grasp UI has no token for a settings page's
// measure.
const SETTINGS_MEASURE = "56rem";

const styles = stylex.create({
  settings: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
    gap: grasp.space2,
    paddingTop: grasp.space2,
  },
  scroll: { flexGrow: 1, minHeight: 0, minWidth: 0, overflowY: "auto" },
  column: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space4,
    width: "100%",
    maxWidth: SETTINGS_MEASURE,
    marginInline: "auto",
    paddingBlock: grasp.space6,
    paddingInline: grasp.space4,
    boxSizing: "border-box",
  },
  writes: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: grasp.space1,
  },
  live: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: grasp.space1,
  },
});

/**
 * What a version's model tasks may steer (GRA-718, GRA-727), which no
 * reviewer should have to piece together: each connector's alias and the
 * operations that may write.
 */
const SteeredWrites = ({ writes }: { writes: readonly SteeredWrite[] }) => {
  const { t } = useLingui();
  if (writes.length === 0) {
    return t`None`;
  }
  return (
    <div {...stylex.props(styles.writes)}>
      {writes.map((write) => (
        <Badge key={write.alias} size="sm" tone="attention">
          {`${write.alias}: ${formatList(write.operations)}`}
        </Badge>
      ))}
    </div>
  );
};

/**
 * The published versions, each with the writes its model tasks may steer.
 * A version an earlier platform release published, in a format this one
 * doesn't read (`refused`), never runs: it says so, and to publish it
 * again, in place of a review of a build it doesn't have.
 */
const Versions = ({ versions }: { versions: WorkflowResourceVersion[] }) => {
  const { t } = useLingui();
  const captionId = useId();
  if (versions.length === 0) {
    return (
      <SectionCard aria-label={t`Versions`} density="compact" flush>
        <Empty size="inline">{t`Nothing is published yet.`}</Empty>
      </SectionCard>
    );
  }
  return (
    <SectionCard
      aria-label={t`Versions`}
      density="compact"
      flush
      footer={
        <span id={captionId}>
          {t`Each of the workflow's model tasks is taken to reach every call the workflow makes.`}
        </span>
      }
    >
      <Table aria-describedby={captionId} aria-label={t`Versions`}>
        <TableHeader>
          <TableRow>
            <TableHead>{t`Version`}</TableHead>
            <TableHead>{t`Definition version`}</TableHead>
            <TableHead>{t`Published`}</TableHead>
            <TableHead>{t`Writes a model may steer`}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {versions.map((version) => (
            <TableRow key={version.version}>
              <TableCell>{version.version}</TableCell>
              <TableCell>{version.definitionVersion}</TableCell>
              <TableCell>{formatDateTime(version.createdAt)}</TableCell>
              <TableCell>
                {version.refused === undefined ? (
                  <SteeredWrites writes={version.modelSteeredWrites} />
                ) : (
                  <Badge size="sm" tone="attention">
                    {t`Made by an earlier platform release: publish it again`}
                  </Badge>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </SectionCard>
  );
};

/**
 * Whom the workflow belongs to: you, or its owner by name; someone else
 * while their name isn't known (not listed, or not read yet), never an ID.
 */
const OwnedBy = ({ owner, names }: { owner: string; names: Names }) => {
  const { t } = useLingui();
  if (owner === names.me) {
    return t`Owned by you`;
  }
  const name = names.people.get(owner);
  return name === undefined ? t`Owned by someone else` : t`Owned by ${name}`;
};

/** What the workflow's page read, and what changes it, as its sections need. */
export interface WorkflowRead {
  resource: WorkflowResource;
  /** Its draft, for its builders alone. */
  draft: Loaded<WorkflowDraft> | undefined;
  /** The draft the page goes by: its editor's last save, or the page's read. */
  latest: WorkflowDraft | undefined;
  /** Takes what a save of the draft left. */
  onDraft: (next: WorkflowDraft) => void;
  /** When its draft was last saved, for its builders. */
  savedAt: string | null;
  versions: Loaded<WorkflowResourceVersion[]>;
  params: Loaded<WorkflowParams>;
  /** What it keeps between runs, for its builders and admins only. */
  state: Loaded<WorkflowState> | undefined;
  askable: Loaded<boolean>;
  /** Where it stands, as the bar has it: a change made there before a read. */
  lifecycle: Loaded<WorkflowLifecycle>;
  names: Names;
  /** Whether the reader is one of the organization's admins. */
  admin: boolean;
  /** Whether they approve its bindings: an admin of its own, not Grasp staff. */
  approves: boolean;
}

/** The business process it serves: its builders pick it, anyone else reads it. */
const ProcessRow = ({
  resource,
  builder,
}: {
  resource: WorkflowResource;
  builder: boolean;
}) => {
  const { t, i18n } = useLingui();
  const router = useRouter();
  const { process } = resource;
  const covers = process === null ? undefined : i18n._(processCovers[process]);
  if (builder) {
    return (
      <SettingRow
        label={t`Business process`}
        {...(covers === undefined ? {} : { info: covers })}
      >
        <ProcessPicker
          name={resource.name}
          onChange={() => {
            void router.invalidate();
          }}
          process={process}
          workflow={resource.id}
        />
      </SettingRow>
    );
  }
  return (
    <FactRow
      label={t`Business process`}
      {...(covers === undefined ? {} : { info: covers })}
    >
      {process === null ? t`None` : <ProcessBadge process={process} />}
    </FactRow>
  );
};

/** General: what it serves, whose it is, where it stands, and deleting it. */
const General = ({
  resource,
  savedAt,
  askable,
  lifecycle,
  names,
  admin,
}: WorkflowRead) => {
  const { t } = useLingui();
  const builder = resource.role === "builder";
  const owner = resource.owner === names.me;
  const status = lifecycle.state === "ready" ? lifecycle.data : undefined;
  return (
    <>
      <SectionCard density="compact" flush title={t`About`}>
        <SettingsRows>
          <ProcessRow builder={builder} resource={resource} />
          <FactRow label={t`Owner`}>
            <OwnedBy names={names} owner={resource.owner} />
          </FactRow>
          {status === undefined ? null : (
            <FactRow label={t`Live`}>
              <span {...stylex.props(styles.live)}>
                <LiveFacts lifecycle={status} />
                {status.live?.selfApproved === true ? (
                  <Badge size="sm">
                    {t`Self-approved: nobody else could approve it`}
                  </Badge>
                ) : null}
              </span>
            </FactRow>
          )}
          {savedAt === null ? null : (
            <FactRow label={t`Draft`}>
              <SavedAgo at={savedAt} />
            </FactRow>
          )}
        </SettingsRows>
      </SectionCard>
      {owner && askable.state === "ready" ? (
        <SectionCard density="compact" flush title={t`Stephen`}>
          <AskStephen askable={askable.data} workflow={resource.id} />
        </SectionCard>
      ) : null}
      <DeleteWorkflow admin={admin} resource={resource} />
    </>
  );
};

/** The section open: what it shows of the workflow. */
const SectionBody = ({
  section,
  read,
}: {
  section: WorkflowSettingsSection;
  read: WorkflowRead;
}) => {
  const router = useRouter();
  const { resource, names, approves, versions } = read;
  const builder = resource.role === "builder";
  const { currentVersion } = resource;
  if (section === "triggers") {
    return (
      <WorkflowTriggers
        builder={builder}
        me={names.me}
        workflow={resource.id}
      />
    );
  }
  if (section === "files") {
    return (
      <FilesAndApps
        approves={approves}
        currentVersion={currentVersion}
        lifecycle={read.lifecycle}
        names={names}
        versions={versions}
        workflow={resource.id}
      />
    );
  }
  if (section === "parameters") {
    return (
      <>
        {read.params.state === "ready" ? (
          <ResourceParams
            editable={builder}
            loaded={read.params.data}
            workflow={resource.id}
          />
        ) : (
          <NotLoadedState page={read.params} />
        )}
        <KeptState
          editable={builder || approves}
          read={read.state}
          workflow={resource.id}
        />
      </>
    );
  }
  if (section === "definition" && read.draft !== undefined) {
    return read.draft.state === "ready" ? (
      <DefinitionEditor
        currentVersion={currentVersion}
        loaded={read.latest ?? read.draft.data}
        onDraft={(next) => {
          read.onDraft(next);
        }}
        onPublished={() => {
          // The new current version, and its place among the versions,
          // as core has them now.
          void router.invalidate();
        }}
        onVersionMoved={() => {
          void router.invalidate();
        }}
        workflow={resource.id}
      />
    ) : (
      <NotLoadedState page={read.draft} />
    );
  }
  if (section === "versions") {
    return (
      <>
        {versions.state === "ready" ? (
          <Versions versions={versions.data} />
        ) : (
          <NotLoadedState page={versions} />
        )}
        <VersionSource
          builder={builder}
          versions={versions}
          workflow={resource.id}
        />
      </>
    );
  }
  return <General {...read} />;
};

/** A section's link in the list, an address of its own. */
const SectionLink = ({
  workflow,
  section,
  current,
  children,
}: {
  workflow: string;
  section: WorkflowSettingsSection;
  current: boolean;
  children: string;
}) => (
  <TabsLink
    current={current}
    render={
      <Link
        params={{ workflow }}
        replace
        search={(held) => ({
          project: held.project,
          view: "settings",
          section,
        })}
        to="/workflows/$workflow"
      />
    }
  >
    {children}
  </TabsLink>
);

/**
 * A workflow's settings: the sections the reader sees as a list, and the
 * one open (`section`, or General) beside it. Definition is its builders'
 * alone, who read its draft.
 */
export const WorkflowSettings = ({
  section: asked,
  read,
}: {
  section: WorkflowSettingsSection | undefined;
  read: WorkflowRead;
}) => {
  const { t, i18n } = useLingui();
  const sections = workflowSettingsSections.filter(
    (each) => each !== "definition" || read.draft !== undefined
  );
  const section =
    asked === undefined || !sections.includes(asked) ? "general" : asked;
  return (
    <div {...stylex.props(styles.settings)}>
      <TabsNav aria-label={t`Settings sections`}>
        {sections.map((each) => (
          <SectionLink
            current={each === section}
            key={each}
            section={each}
            workflow={read.resource.id}
          >
            {i18n._(sectionLabels[each])}
          </SectionLink>
        ))}
      </TabsNav>
      <div {...stylex.props(styles.scroll)}>
        <div {...stylex.props(styles.column)}>
          <SectionBody read={read} section={section} />
        </div>
      </div>
    </div>
  );
};
