import type { Identity } from "@grasp-os/shared/rpc";
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
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { DraftHistory } from "../drafts/draft-history.tsx";
import { formatList } from "../format.ts";
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
import { ShareWorkflow } from "./share-workflow.tsx";
import { VersionSource } from "./version-source.tsx";
import { WorkflowTriggers } from "./workflow-triggers.tsx";

// Everything about a workflow besides its Flow and its runs, in one place,
// a section at a time, as an App's settings are (apps/app-settings.tsx):
// what it serves and whose it is (General), whom it is shared with and as
// what (Sharing), what starts it on its own (Triggers), the files its runs
// wrote and the apps and Brain it works in (Files and apps), its
// parameters and what it keeps between runs (Parameters), the JSON behind
// its Flow, for its builders (Definition), and its changes and published
// versions, as an App's History has them (drafts/draft-history.tsx). Each
// section is an address of its own (`?section=`).

/** The sections, in the order the list shows them. */
const workflowSettingsSections = [
  "general",
  "sharing",
  "triggers",
  "files",
  "parameters",
  "definition",
  "history",
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
  sharing: msg({
    message: "Sharing",
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
  history: msg({
    message: "History",
    context: "a workflow's settings section",
  }),
};

/**
 * What a version's model tasks may steer (GRA-718, GRA-727), which no
 * reviewer should have to piece together: each connector's alias and the
 * operations that may write.
 */
const SteeredWrites = ({ writes }: { writes: readonly SteeredWrite[] }) => (
  <span className="flex flex-wrap items-center gap-1">
    {writes.map((write) => (
      <Badge key={write.alias} variant="attention">
        {`${write.alias}: ${formatList(write.operations)}`}
      </Badge>
    ))}
  </span>
);

/**
 * What a version's model tasks may steer, under it in History (GRA-718,
 * GRA-727). A version an earlier platform release published, in a format
 * this one doesn't read (`refused`), never runs: it says so, and to
 * publish it again, in place of a review of a build it doesn't have.
 */
const VersionDetails = ({ version }: { version: WorkflowResourceVersion }) => {
  if (version.refused !== undefined) {
    return (
      <span>
        <Badge variant="attention">
          <Trans>Made by an earlier platform release: publish it again</Trans>
        </Badge>
      </span>
    );
  }
  return version.modelSteeredWrites.length === 0 ? null : (
    <span className="text-muted-foreground flex flex-wrap items-center gap-1 text-xs">
      <Trans>Writes a model may steer:</Trans>
      <SteeredWrites writes={version.modelSteeredWrites} />
    </span>
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
  names: Names;
  /** Who reads it: what History offers them. */
  identity: Pick<Identity, "userId" | "role" | "staff">;
  /** Whether the reader is one of the organization's admins. */
  admin: boolean;
  /** Whether they approve its bindings: an admin of its own, not Grasp staff. */
  approves: boolean;
}

/** General: what it serves, whose it is, and deleting it. */
const General = ({
  resource,
  savedAt,
  askable,
  names,
  admin,
}: WorkflowRead) => {
  const { t } = useLingui();
  const router = useRouter();
  const builder = resource.role === "builder";
  const owner = resource.owner === names.me;
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
  const { resource, names, approves, versions, identity } = read;
  const builder = resource.role === "builder";
  const { currentVersion } = resource;
  if (section === "sharing") {
    return <ShareWorkflow resource={resource} />;
  }
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
        loaded={read.latest ?? read.draft.data}
        onDraft={(next) => {
          read.onDraft(next);
        }}
        workflow={resource.id}
      />
    ) : (
      <NotLoadedState page={read.draft} />
    );
  }
  if (section === "history") {
    return (
      <>
        <DraftHistory
          builds={builder && !identity.staff}
          renderDetails={(version) =>
            "resourceId" in version ? (
              <VersionDetails version={version} />
            ) : null
          }
          identity={identity}
          live={currentVersion}
          subject={{ kind: "workflow", id: resource.id }}
        />
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
 * one open (`section`, or General) beside it. Sharing and Definition are
 * its builders' alone, who read its draft.
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
    (each) =>
      (each !== "definition" && each !== "sharing") || read.draft !== undefined
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
