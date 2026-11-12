import type { WorkflowLifecycle } from "@grasp-os/shared/workflow-lifecycle";
import type {
  SteeredWrite,
  WorkflowDraft,
  WorkflowParams,
  WorkflowResource,
  WorkflowResourceVersion,
  WorkflowState,
} from "@grasp-os/shared/workflow-resources";
import { Badge } from "@grasp-os/ui/components/badge";
import { buttonVariants } from "@grasp-os/ui/components/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useRouter } from "@tanstack/react-router";
import { useId } from "react";
import type { ReactNode } from "react";

import { formatDateTime, formatList } from "../format.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import type { Loaded } from "../load-from-core.tsx";
import {
  SettingsBody,
  SettingsRow,
  SettingsSection,
} from "../settings/settings-parts.tsx";
import type { Names } from "./activity-bar.tsx";
import { AskStephen } from "./ask-stephen.tsx";
import { ProcessBadge, ProcessPicker } from "./business-process.tsx";
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

/**
 * What a version's model tasks may steer (GRA-718, GRA-727), which no
 * reviewer should have to piece together: each connector's alias and the
 * operations that may write.
 */
const SteeredWrites = ({ writes }: { writes: readonly SteeredWrite[] }) => {
  if (writes.length === 0) {
    return (
      <span className="text-muted-foreground">
        <Trans>None</Trans>
      </span>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1">
      {writes.map((write) => (
        <Badge key={write.alias} variant="attention">
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
      <p className="bg-card text-muted-foreground rounded-xl border px-4 py-6 text-center">
        <Trans>Nothing is published yet.</Trans>
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="bg-card overflow-hidden rounded-xl border">
        <Table aria-describedby={captionId}>
          <TableHeader>
            <TableRow>
              <TableHead variant="card">{t`Version`}</TableHead>
              <TableHead variant="card">{t`Definition version`}</TableHead>
              <TableHead variant="card">{t`Published`}</TableHead>
              <TableHead variant="card">
                {t`Writes a model may steer`}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {versions.map((version) => (
              <TableRow key={version.version}>
                <TableCell variant="roomy">{version.version}</TableCell>
                <TableCell variant="roomy">
                  {version.definitionVersion}
                </TableCell>
                <TableCell variant="roomy">
                  {formatDateTime(version.createdAt)}
                </TableCell>
                <TableCell variant="roomy">
                  {version.refused === undefined ? (
                    <SteeredWrites writes={version.modelSteeredWrites} />
                  ) : (
                    <Badge variant="attention">
                      <Trans>
                        Made by an earlier platform release: publish it again
                      </Trans>
                    </Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="text-muted-foreground" id={captionId}>
        <Trans>
          Each of the workflow&apos;s model tasks is taken to reach every call
          the workflow makes.
        </Trans>
      </p>
    </div>
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
  const router = useRouter();
  const builder = resource.role === "builder";
  const owner = resource.owner === names.me;
  const status = lifecycle.state === "ready" ? lifecycle.data : undefined;
  return (
    <>
      <SettingsSection title={t`About`}>
        <SettingsBody>
          <SettingsRow label={t`Business process`}>
            {builder ? (
              <ProcessPicker
                name={resource.name}
                onChange={() => {
                  void router.invalidate();
                }}
                process={resource.process}
                workflow={resource.id}
              />
            ) : (
              <span>
                {resource.process === null ? (
                  <Trans>None</Trans>
                ) : (
                  <ProcessBadge process={resource.process} />
                )}
              </span>
            )}
          </SettingsRow>
          <SettingsRow label={t`Owner`}>
            <span>
              <OwnedBy names={names} owner={resource.owner} />
            </span>
          </SettingsRow>
          {status === undefined ? null : (
            <SettingsRow label={t`Live`}>
              <span className="flex flex-col items-end gap-1">
                <LiveFacts lifecycle={status} />
                {status.live?.selfApproved === true ? (
                  <Badge variant="outline">
                    <Trans>Self-approved: nobody else could approve it</Trans>
                  </Badge>
                ) : null}
              </span>
            </SettingsRow>
          )}
          {savedAt === null ? null : (
            <SettingsRow label={t`Draft`}>
              <span>
                <SavedAgo at={savedAt} />
              </span>
            </SettingsRow>
          )}
        </SettingsBody>
      </SettingsSection>
      {owner && askable.state === "ready" ? (
        <SettingsSection title={t`Stephen`}>
          <SettingsBody>
            <AskStephen askable={askable.data} workflow={resource.id} />
          </SettingsBody>
        </SettingsSection>
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
  children: ReactNode;
}) => (
  <Link
    aria-current={current ? "page" : undefined}
    className={`${buttonVariants({
      size: "sm",
      variant: current ? "secondary" : "ghost",
    })} w-full md:justify-start`}
    params={{ workflow }}
    replace
    search={(held) => ({
      project: held.project,
      view: "settings",
      section,
    })}
    to="/workflows/$workflow"
  >
    {children}
  </Link>
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
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <nav
        aria-label={t`Settings sections`}
        className="flex flex-none gap-1 overflow-x-auto border-b p-2 md:w-52 md:flex-col md:overflow-x-visible md:overflow-y-auto md:border-r md:border-b-0 md:p-3"
      >
        {sections.map((each) => (
          <span className="flex-none" key={each}>
            <SectionLink
              current={each === section}
              section={each}
              workflow={read.resource.id}
            >
              {i18n._(sectionLabels[each])}
            </SectionLink>
          </span>
        ))}
      </nav>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-6 md:px-8">
          <h2 className="text-lg font-medium">
            {i18n._(sectionLabels[section])}
          </h2>
          <SectionBody read={read} section={section} />
        </div>
      </div>
    </div>
  );
};
