import { isAdmin, isMemberAdmin } from "@grasp-os/shared/roles";
import type { WorkflowLifecycle } from "@grasp-os/shared/workflow-lifecycle";
import type {
  SteeredWrite,
  WorkflowActivity,
  WorkflowDraft,
  WorkflowParams,
  WorkflowResource,
  WorkflowActionReview,
  WorkflowResourceRun,
  WorkflowResourceVersion,
} from "@grasp-os/shared/workflow-resources";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { PageHeaderTitle } from "@grasp-os/ui/components/page-header";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@grasp-os/ui/components/popover";
import { Separator } from "@grasp-os/ui/components/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@grasp-os/ui/components/tabs";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { EllipsisIcon, WorkflowIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { dockDrawerRoom, useDockMode } from "../chat/dock-mode.ts";
import { readPeople } from "../directory.ts";
import { formatDateTime, formatList } from "../format.ts";
import {
  NotLoadedState,
  PageLoading,
  PageNotLoaded,
} from "../frame/page-states.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { ActivityBar } from "../workflows/activity-bar.tsx";
import type { Names } from "../workflows/activity-bar.tsx";
import { AskStephen } from "../workflows/ask-stephen.tsx";
import { ProcessBadge, ProcessPicker } from "../workflows/business-process.tsx";
import { DefinitionEditor } from "../workflows/definition-editor.tsx";
import { DeleteWorkflow } from "../workflows/delete-workflow.tsx";
import { DiagramOverview } from "../workflows/diagram-overview.tsx";
import { partsOf } from "../workflows/diagram-parts.ts";
import type { DiagramPart } from "../workflows/diagram-parts.ts";
import { useDraftFromChat } from "../workflows/draw-in-chat.ts";
import { FilesAndApps } from "../workflows/files-and-apps.tsx";
import { ListedCount } from "../workflows/listed-count.tsx";
import { ResourceParams } from "../workflows/resource-params.tsx";
import { ResourceRuns } from "../workflows/resource-runs.tsx";
import { SavedAgo } from "../workflows/saved-ago.tsx";
import { ShareWorkflow } from "../workflows/share-workflow.tsx";
import { StartIndependentRun } from "../workflows/start-run.tsx";
import { definitionTitle } from "../workflows/step-body.ts";
import { TracedRun } from "../workflows/traced-run.tsx";
import { Traces } from "../workflows/traces.tsx";
import type { TracesPart } from "../workflows/traces.tsx";
import { VersionSource } from "../workflows/version-source.tsx";
import { WorkflowFlow } from "../workflows/workflow-flow.tsx";
import {
  GoLiveDecision,
  WorkflowStatus,
} from "../workflows/workflow-status.tsx";
import {
  TriggersTabContent,
  TriggersTabTrigger,
} from "../workflows/workflow-triggers-tab.tsx";

// One independent workflow (platform specification 13): for its builders,
// its definition as a draft they edit, check and publish; for everyone
// with a role, its published versions. Core decides who sees what: the
// draft is read only for builders, as it can hold a sensitive default.
// Each version shows what its own actions may call, as sealed with it
// (GRA-709): each binding they use, and a connector's exact operations;
// and, for one that asks a model, the writes its answers may steer
// (GRA-718), which no reviewer should have to piece together. Its
// parameters, which its builders set, and its runs, as core lists them for
// the reader (GRA-674), each opened beside the page with what it returned
// or why it failed. Beside its name, whether it runs, with Pause and
// Resume (`workflow-status.tsx`); under it, the business process it
// serves (its builders set it), who owns it and, for its builders, when
// its draft was saved; beside them, for whoever may decide it, the
// version waiting to go live, approved or sent back. For its builders,
// it opens on its Flow, the definition drawn (`workflow-flow.tsx`), with
// the JSON behind it on Definition; and Traces: each run's steps over its
// diagram, and a test of the draft on recent real items; for everyone,
// the files its runs wrote, the Knowledge it reads and the apps it works
// in; and under the page, what happened to it lately. As the prototype's
// workflow page (GRA-1402), the title stands alone with where it stands
// at its right; what is set about it sits in its "…" menu, and what it is
// (its version, its owner, its process) in one quiet line beside the tabs.
// Its builders draw it with Grasp in its own chat, docked beside it
// (`workflows/draw-in-chat.ts`): the Flow follows the draft as the chat
// edits it.

/**
 * One use whose writes a model's answers may steer (GRA-718), as its
 * neighbouring use badge names it: a connector's alias and the operations
 * that may write; an App export's alias alone, as any of it may write.
 */
const SteeredWriteBadge = ({ write }: { write: SteeredWrite }) => {
  const target =
    write.kind === "connector"
      ? `${write.alias}: ${formatList(write.operations)}`
      : write.alias;
  return (
    <Badge variant="attention">
      <Trans>Writes a model may steer: {target}</Trans>
    </Badge>
  );
};

/** What a version's own actions may call: each action, then its uses. */
const ActionEffects = ({ actions }: { actions: WorkflowActionReview[] }) => {
  if (actions.length === 0) {
    return (
      <span className="text-muted-foreground">
        <Trans>None</Trans>
      </span>
    );
  }
  return (
    <ul className="flex flex-col gap-1">
      {actions.map((action) => (
        <li className="flex flex-wrap items-center gap-1" key={action.binding}>
          <code>{action.binding}</code>
          {action.uses.map((use) => (
            <Badge key={use.alias} variant="outline">
              {use.kind === "connector"
                ? `${use.alias}: ${formatList(use.operations)}`
                : use.alias}
            </Badge>
          ))}
          {action.modelSteeredWrites.map((write) => (
            <SteeredWriteBadge key={write.alias} write={write} />
          ))}
        </li>
      ))}
    </ul>
  );
};

/**
 * Whether whoever asked for the live version approved it themselves, as
 * nobody else could (GRA-1227). Which version is live, and since when, is
 * the status beside the name.
 */
const SelfApprovedBadge = ({ lifecycle }: { lifecycle: WorkflowLifecycle }) =>
  lifecycle.live?.selfApproved === true ? (
    <Badge variant="outline">
      <Trans>Self-approved: nobody else could approve it</Trans>
    </Badge>
  ) : null;

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
              <TableHead variant="card">{t`Actions`}</TableHead>
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
                  <div className="flex flex-col gap-1">
                    {version.modelSteeredWrites.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1">
                        <span className="text-muted-foreground">
                          <Trans>Its model tasks</Trans>
                        </span>
                        {version.modelSteeredWrites.map((write) => (
                          <SteeredWriteBadge key={write.alias} write={write} />
                        ))}
                      </div>
                    )}
                    <ActionEffects actions={version.actions} />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="text-muted-foreground" id={captionId}>
        <Trans>
          Writes a model may steer cover each action&apos;s own model uses and
          the workflow&apos;s own model tasks. An action&apos;s model uses reach
          only that action; each of the workflow&apos;s model tasks is taken to
          reach every call the workflow makes.
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

/**
 * What its builders and owner set about it, behind "…" at the end of the
 * title's line: the process it serves, its packages, whom it is shared
 * with, and whether people may ask Stephen to start it.
 */
const WorkflowSettings = ({
  resource,
  askable,
  me,
}: {
  resource: WorkflowResource;
  askable: Loaded<boolean>;
  me: string;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const builder = resource.role === "builder";
  const owner = resource.owner === me && askable.state === "ready";
  const { name } = resource;
  if (!builder && !owner) {
    return null;
  }
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            aria-label={t`Settings of ${name}`}
            size="icon-sm"
            variant="ghost"
          />
        }
      >
        <EllipsisIcon aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96">
        {builder ? (
          <div className="flex flex-wrap items-center gap-2">
            <ProcessPicker
              name={resource.name}
              onChange={() => {
                void router.invalidate();
              }}
              process={resource.process}
              workflow={resource.id}
            />
            <ShareWorkflow resource={resource} />
            {/* Its approved packages: read, retired or revoked there by
                its builders. */}
            <Button
              nativeButton={false}
              render={
                <Link
                  params={{ workflow: resource.id }}
                  to="/settings/packages/workflows/$workflow"
                />
              }
              size="sm"
              variant="ghost"
            >
              <Trans>Packages</Trans>
            </Button>
          </div>
        ) : null}
        {builder && owner ? <Separator /> : null}
        {owner ? (
          <AskStephen askable={askable.data} workflow={resource.id} />
        ) : null}
      </PopoverContent>
    </Popover>
  );
};

/**
 * What it is, in one quiet line beside the tabs: the process it serves
 * (set in its settings by its builders), its version, its owner, and, for
 * its builders, when its draft was saved.
 */
const WorkflowFacts = ({
  resource,
  status,
  names,
  savedAt,
}: {
  resource: WorkflowResource;
  status: WorkflowLifecycle | undefined;
  names: Names;
  savedAt: string | null;
}) => {
  const { currentVersion } = resource;
  return (
    <div className="text-muted-foreground flex flex-wrap items-center gap-2 pb-2 text-xs">
      {resource.process === null ? null : (
        <ProcessBadge process={resource.process} />
      )}
      <Badge variant="outline">
        {currentVersion === null ? (
          <Trans>Not published</Trans>
        ) : (
          <Trans>Version {currentVersion}</Trans>
        )}
      </Badge>
      {status === undefined ? null : <SelfApprovedBadge lifecycle={status} />}
      <span>
        <OwnedBy names={names} owner={resource.owner} />
      </span>
      {savedAt === null ? null : (
        <span>
          <SavedAgo at={savedAt} />
        </span>
      )}
    </div>
  );
};

/**
 * Where it stands as core answered the last change made on the page, or
 * as read, whichever is at the later revision; `onChange` takes a change.
 */
const useStatus = (lifecycle: Loaded<WorkflowLifecycle>) => {
  const router = useRouter();
  // As core answered the last change made here, until a later read of
  // it is loaded: whichever is at the later revision.
  const [changed, setChanged] = useState<WorkflowLifecycle>();
  const onChange = (next: WorkflowLifecycle): void => {
    setChanged(next);
    void router.invalidate();
  };
  const loaded = lifecycle.state === "ready" ? lifecycle.data : undefined;
  const status =
    changed === undefined ||
    (loaded !== undefined && loaded.revision >= changed.revision)
      ? loaded
      : changed;
  return { status, onChange };
};

/**
 * Its title alone on its line, with where it stands, a run to start and
 * its settings at the line's end; and, for whoever may decide it, the
 * version waiting to go live.
 */
const WorkflowHeader = ({
  resource,
  title,
  status,
  onChange,
  onFiles,
  askable,
  me,
}: {
  resource: WorkflowResource;
  /** What it is headed with: its definition's title, or its name. */
  title: string;
  status: WorkflowLifecycle | undefined;
  onChange: (next: WorkflowLifecycle) => void;
  /** Shows its Files and apps, where its bindings are approved. */
  onFiles: () => void;
  askable: Loaded<boolean>;
  me: string;
}) => (
  <div className="flex flex-col gap-3">
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <PageHeaderTitle className="min-w-0 grow">{title}</PageHeaderTitle>
      <div className="flex flex-wrap items-center gap-2">
        {status === undefined ? null : (
          <WorkflowStatus
            lifecycle={status}
            name={resource.name}
            onChange={onChange}
            workflow={resource.id}
          />
        )}
        <StartIndependentRun onFiles={onFiles} workflow={resource.id} />
        <WorkflowSettings askable={askable} me={me} resource={resource} />
      </div>
    </div>
    {status === undefined ? null : (
      <GoLiveDecision
        lifecycle={status}
        me={me}
        name={resource.name}
        onChange={onChange}
        workflow={resource.id}
      />
    )}
  </div>
);

/** The tabs of a workflow's page. */
type WorkflowTab =
  | "flow"
  | "overview"
  | "definition"
  | "traces"
  | "runs"
  | "files"
  | "parameters"
  | "versions"
  | "triggers";

/** The tabs of a workflow's page, as the reader has them. */
const WorkflowTabs = ({
  overview,
  definition,
  builder,
  runs,
}: {
  overview: boolean;
  /** Whether the reader has its draft: its Flow, and the JSON behind it. */
  definition: boolean;
  builder: boolean;
  /** How many runs it has, beside their tab once read. */
  runs: number | undefined;
}) => (
  <TabsList variant="line">
    {definition ? (
      <TabsTrigger value="flow">
        <Trans context="tab of a workflow">Flow</Trans>
      </TabsTrigger>
    ) : null}
    {overview ? (
      <TabsTrigger value="overview">
        <Trans context="tab of a workflow">Overview</Trans>
      </TabsTrigger>
    ) : null}
    {builder ? (
      <TabsTrigger value="traces">
        <Trans context="tab of a workflow">Traces</Trans>
        <ListedCount count={runs} of="runs" />
      </TabsTrigger>
    ) : (
      <TabsTrigger value="runs">
        <Trans context="tab listing the runs of workflows">Runs</Trans>
        <ListedCount count={runs} of="runs" />
      </TabsTrigger>
    )}
    <TriggersTabTrigger />
    <TabsTrigger value="files">
      <Trans context="tab of a workflow">Files and apps</Trans>
    </TabsTrigger>
    {definition ? (
      <TabsTrigger value="definition">
        <Trans context="tab of a workflow">Definition</Trans>
      </TabsTrigger>
    ) : null}
    <TabsTrigger value="parameters">
      <Trans context="tab of a workflow">Parameters</Trans>
    </TabsTrigger>
    <TabsTrigger value="versions">
      <Trans context="tab of a workflow">Versions</Trans>
    </TabsTrigger>
  </TabsList>
);

/**
 * The draft the page goes by: its editor's last save or read (`edited`),
 * or the page's own read when that is at a later revision (read again
 * after a publication).
 */
const latestDraftOf = (
  loaded: Loaded<WorkflowDraft> | undefined,
  edited: WorkflowDraft | undefined
): WorkflowDraft | undefined => {
  const read = loaded?.state === "ready" ? loaded.data : undefined;
  if (edited === undefined) {
    return read;
  }
  return read !== undefined && read.revision > edited.revision ? read : edited;
};

/**
 * What the page takes from the draft's checkpoint: the revision a test on
 * recent items runs, none before the draft's first edit (revision 0 is
 * the current version's definition); and its named parts, as its
 * builders' drawing has them, for an Overview of a workflow drawn in parts.
 */
const checkpointOf = (
  draft: WorkflowDraft | undefined
): { checkpoint: number | null; parts: DiagramPart[] } => {
  const saved = draft?.checkpoint ?? null;
  if (saved === null) {
    return { checkpoint: null, parts: [] };
  }
  return {
    checkpoint: saved.revision > 0 ? saved.revision : null,
    parts: partsOf(saved.diagram),
  };
};

/**
 * For its builders, who read its draft: its Flow, the draft drawn, with a
 * real run of its current version to start and follow under it; and Definition, the JSON
 * behind it. `onDraft` takes what a save on either left; `onTab` shows
 * another tab.
 */
const DraftTabs = ({
  workflow,
  draft,
  latest,
  currentVersion,
  onDraft,
  onTab,
}: {
  workflow: string;
  draft: Loaded<WorkflowDraft>;
  /** The draft the page goes by (`latestDraftOf`). */
  latest: WorkflowDraft | undefined;
  currentVersion: number | null;
  onDraft: (next: WorkflowDraft) => void;
  onTab: (tab: WorkflowTab) => void;
}) => {
  const router = useRouter();
  return (
    <>
      {/* Kept while another tab shows: its zoom and layout stay. */}
      <TabsContent keepMounted value="flow">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-6 pt-6 pb-8">
          {draft.state === "ready" ? (
            <WorkflowFlow
              draft={latest ?? draft.data}
              onDefinition={() => {
                onTab("definition");
              }}
              onDraft={onDraft}
              onTriggers={() => {
                onTab("triggers");
              }}
              workflow={workflow}
            />
          ) : (
            <NotLoadedState page={draft} />
          )}
          {currentVersion === null ? null : (
            <TracedRun
              onFiles={() => {
                onTab("files");
              }}
              version={currentVersion}
              workflow={workflow}
            />
          )}
        </div>
      </TabsContent>
      {/* Kept while another tab shows: what was typed stays. */}
      <TabsContent keepMounted value="definition">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-6 pt-6 pb-8">
          {draft.state === "ready" ? (
            <DefinitionEditor
              currentVersion={currentVersion}
              loaded={latest ?? draft.data}
              onDraft={onDraft}
              onVersionMoved={() => {
                void router.invalidate();
              }}
              onPublished={() => {
                // The new current version, and its place among the
                // versions, as core has them now.
                void router.invalidate();
              }}
              workflow={workflow}
            />
          ) : (
            <NotLoadedState page={draft} />
          )}
        </div>
      </TabsContent>
    </>
  );
};

/**
 * What a workflow named `name` is headed with: its definition's title, as
 * its draft has it (or the latest that passed, while the draft's text
 * isn't JSON); its name without one, as for whoever doesn't read its draft.
 */
const headingOf = (draft: WorkflowDraft | undefined, name: string): string => {
  if (draft === undefined) {
    return name;
  }
  return (
    definitionTitle(draft.source) ??
    definitionTitle(draft.checkpoint?.source) ??
    name
  );
};

/** The later of two ISO times, either of which may be missing. */
const laterOf = (a: string | null, b: string | null): string | null => {
  if (a === null || (b !== null && b > a)) {
    return b;
  }
  return a;
};

const WorkflowResourceView = ({
  resource,
  draft,
  versions,
  params,
  runs,
  askable,
  lifecycle,
  activity,
  names,
  admin,
  approves,
  opens,
}: {
  resource: WorkflowResource;
  draft: Loaded<WorkflowDraft> | undefined;
  versions: Loaded<WorkflowResourceVersion[]>;
  params: Loaded<WorkflowParams>;
  runs: Loaded<WorkflowResourceRun[]>;
  askable: Loaded<boolean>;
  lifecycle: Loaded<WorkflowLifecycle>;
  activity: Loaded<WorkflowActivity[]>;
  names: Names;
  /** Whether the reader is one of the organization's admins. */
  admin: boolean;
  /** Whether they approve its bindings: an admin of its own, not Grasp staff. */
  approves: boolean;
  /**
   * The tab it opens on, if a link asked for one (a run count's: `runs`;
   * an inbox item's: `triggers`; a start refused for its bindings: `files`).
   */
  opens: WorkflowSearch["tab"];
}) => {
  const { currentVersion } = resource;
  const builder = resource.role === "builder";
  // When its draft was saved: as loaded, or as a save here answered,
  // whichever is later.
  const [savedHere, setSavedHere] = useState<string | null>(null);
  const savedAt = laterOf(
    draft?.state === "ready" ? draft.data.editedAt : null,
    savedHere
  );
  const start: WorkflowTab = draft === undefined ? "versions" : "flow";
  // A builder reads runs on Traces (its runs part), so a link asking for
  // runs opens there.
  const opened = opens === "runs" && builder ? "traces" : opens;
  const [tab, setTab] = useState<WorkflowTab>(opened ?? start);
  const [part, setPart] = useState<TracesPart>("runs");
  // The draft as its editor last saved or read it, beside the page's read:
  // whichever is at the later revision is the draft the page goes by.
  const [edited, setEdited] = useState<WorkflowDraft>();
  const latest = latestDraftOf(draft, edited);
  const { checkpoint, parts } = checkpointOf(latest);
  const took = (next: WorkflowDraft): void => {
    setEdited(next);
    setSavedHere(next.editedAt);
  };
  // As Grasp draws it in its chat, beside the page.
  useDraftFromChat(resource.id, took);
  const { status, onChange } = useStatus(lifecycle);
  // Its parts gone (a new checkpoint drawn in none), Overview goes too:
  // the tab it was on shows where the page starts instead.
  const shown = tab === "overview" && parts.length === 0 ? start : tab;
  return (
    <>
      <Tabs
        onValueChange={(value: WorkflowTab) => {
          setTab(value);
        }}
        spacing="none"
        value={shown}
      >
        <div className="flex flex-col gap-3 border-b px-6 pt-5">
          <WorkflowHeader
            askable={askable}
            me={names.me}
            onChange={onChange}
            onFiles={() => {
              setTab("files");
            }}
            resource={resource}
            status={status}
            title={headingOf(latest, resource.name)}
          />
          <div className="flex flex-wrap items-end justify-between gap-x-4">
            <WorkflowTabs
              builder={builder}
              definition={draft !== undefined}
              overview={parts.length > 0}
              runs={runs.state === "ready" ? runs.data.length : undefined}
            />
            <WorkflowFacts
              names={names}
              resource={resource}
              savedAt={savedAt}
              status={status}
            />
          </div>
        </div>
        {draft === undefined ? null : (
          <DraftTabs
            currentVersion={currentVersion}
            draft={draft}
            latest={latest}
            onDraft={took}
            onTab={setTab}
            workflow={resource.id}
          />
        )}
        {parts.length === 0 ? null : (
          <TabsContent value="overview">
            <div className="mx-auto w-full max-w-7xl px-6 pt-6 pb-8">
              <DiagramOverview
                onShow={({ n }) => {
                  setTab("flow");
                  // Once the drawing shows again: its frame, in view.
                  requestAnimationFrame(() => {
                    document
                      .querySelector(`[data-ground] #workflow-part-${n}`)
                      ?.scrollIntoView({ behavior: "smooth", block: "start" });
                  });
                }}
                parts={parts}
              />
            </div>
          </TabsContent>
        )}
        {builder ? (
          // Kept while another tab shows: a test going on stays followed.
          <TabsContent keepMounted value="traces">
            <div className="mx-auto w-full max-w-7xl px-6 pt-6 pb-8">
              <Traces
                activity={activity}
                admin={admin}
                checkpoint={checkpoint}
                names={names}
                onPartChange={setPart}
                part={part}
                runs={runs}
                workflow={resource.id}
              />
            </div>
          </TabsContent>
        ) : (
          <TabsContent value="runs">
            <div className="mx-auto w-full max-w-7xl px-6 pt-6 pb-8">
              {runs.state === "ready" ? (
                <ResourceRuns
                  admin={admin}
                  names={names}
                  runs={runs.data}
                  workflow={resource.id}
                />
              ) : (
                <NotLoadedState page={runs} />
              )}
            </div>
          </TabsContent>
        )}
        <TriggersTabContent
          builder={builder}
          me={names.me}
          workflow={resource.id}
        />
        {/* Files and apps reads what no other tab needs: only while it
            shows, afresh each time it is opened. */}
        <TabsContent value="files">
          <div className="mx-auto w-full max-w-7xl px-6 pt-6 pb-8">
            <FilesAndApps
              approves={approves}
              currentVersion={currentVersion}
              // As the header has it: a change made here before the page
              // reads it again.
              lifecycle={
                status === undefined
                  ? lifecycle
                  : { state: "ready", data: status }
              }
              names={names}
              versions={versions}
              workflow={resource.id}
            />
          </div>
        </TabsContent>
        {/* Kept while another tab shows: what was typed stays. */}
        <TabsContent keepMounted value="parameters">
          <div className="mx-auto w-full max-w-7xl px-6 pt-6 pb-8">
            {params.state === "ready" ? (
              <ResourceParams
                editable={builder}
                loaded={params.data}
                workflow={resource.id}
              />
            ) : (
              <NotLoadedState page={params} />
            )}
          </div>
        </TabsContent>
        <TabsContent value="versions">
          <div className="mx-auto w-full max-w-7xl px-6 pt-6 pb-8">
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
            <DeleteWorkflow admin={admin} resource={resource} />
          </div>
        </TabsContent>
      </Tabs>
      <div className="pb-chat mt-auto">
        <ActivityBar
          activity={activity}
          names={names}
          onAll={
            builder
              ? () => {
                  setPart("activity");
                  setTab("traces");
                }
              : undefined
          }
        />
      </div>
    </>
  );
};

/**
 * People's names by ID, for the names on activity lines: read beside the
 * page rather than before it, with IDs standing in until they come.
 */
const usePeople = (
  read: Promise<Loaded<ReadonlyMap<string, string>>>
): ReadonlyMap<string, string> => {
  const [people, setPeople] = useState<ReadonlyMap<string, string>>(
    () => new Map()
  );
  useEffect(() => {
    let left = false;
    const settle = async (): Promise<void> => {
      const loaded = await read;
      if (!left && loaded.state === "ready") {
        setPeople(loaded.data);
      }
    };
    void settle();
    return () => {
      left = true;
    };
  }, [read]);
  return people;
};

const WorkflowResourcePage = () => {
  const {
    resource,
    draft,
    versions,
    params,
    runs,
    askable,
    lifecycle,
    activity,
    people: peopleRead,
  } = Route.useLoaderData();
  const people = usePeople(peopleRead);
  const { identity } = Route.useRouteContext();
  const { tab } = Route.useSearch();
  const { t } = useLingui();
  // Its builders' chat as a drawer down the right takes its room from the page.
  const drawer = useDockMode() === "drawer";
  const name = resource.state === "ready" ? resource.data.name : undefined;
  const crumbs = [
    { label: t`Workflows`, to: "/workflows" },
    { label: name ?? t`Workflow` },
  ] as const;
  if (resource.state !== "ready") {
    return (
      <PageNotLoaded
        crumbs={crumbs}
        icon={WorkflowIcon}
        notFound={t`Workflow not found`}
        page={resource}
      />
    );
  }
  return (
    <>
      <SiteHeader crumbs={crumbs} />
      <div
        className={
          drawer && resource.data.role === "builder"
            ? `flex min-h-full flex-col text-sm ${dockDrawerRoom}`
            : "flex min-h-full flex-col text-sm"
        }
      >
        <WorkflowResourceView
          // Another workflow starts afresh; a new current version of this
          // one keeps what is typed in its editor.
          key={resource.data.id}
          activity={activity}
          admin={isAdmin(identity.role)}
          approves={isMemberAdmin(identity)}
          askable={askable}
          draft={draft}
          lifecycle={lifecycle}
          names={{ people, me: identity.userId }}
          params={params}
          resource={resource.data}
          opens={tab}
          runs={runs}
          versions={versions}
        />
      </div>
    </>
  );
};

/** What a link to a workflow's page may ask of it: the tab it opens on. */
interface WorkflowSearch {
  tab?: "runs" | "triggers" | "files";
}

export const Route = createFileRoute("/_shell/workflows/$workflow")({
  validateSearch: (search: Record<string, unknown>): WorkflowSearch =>
    search.tab === "runs" || search.tab === "triggers" || search.tab === "files"
      ? { tab: search.tab }
      : {},
  pendingComponent: PageLoading,
  loader: async ({ context: { core }, params: { workflow } }) => {
    // Names only, and not waited for: IDs stand in until they come.
    const people = loadFromCore(core, readPeople);
    const resourceRead = loadFromCore(
      core,
      async (session) => await session.workflowResources.get(workflow)
    );
    // Only its builders read its draft, as soon as core says who reads:
    // beside the page's other reads, not after them.
    const draftRead = async (): Promise<Loaded<WorkflowDraft> | undefined> => {
      const read = await resourceRead;
      return read.state === "ready" && read.data.role === "builder"
        ? await loadFromCore(
            core,
            async (session) => await session.workflowResources.draft(workflow)
          )
        : undefined;
    };
    const [
      resource,
      draft,
      versions,
      params,
      runs,
      askable,
      lifecycle,
      activity,
    ] = await Promise.all([
      resourceRead,
      draftRead(),
      loadFromCore(
        core,
        async (session) => await session.workflowResources.versions(workflow)
      ),
      loadFromCore(
        core,
        async (session) => await session.workflowResources.params(workflow)
      ),
      loadFromCore(
        core,
        async (session) => await session.workflowResources.runs(workflow)
      ),
      loadFromCore(
        core,
        async (session) => await session.workflowResources.askable(workflow)
      ),
      loadFromCore(
        core,
        async (session) =>
          await session.workflowResources.lifecycle.get(workflow)
      ),
      loadFromCore(
        core,
        async (session) => await session.workflowResources.activity(workflow)
      ),
    ]);
    return {
      resource,
      draft,
      versions,
      params,
      runs,
      askable,
      lifecycle,
      activity,
      people,
    };
  },
  component: WorkflowResourcePage,
});
