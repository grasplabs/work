import { isAdmin } from "@grasp-os/shared/roles";
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
import { PageHeaderTitle } from "@grasp-os/ui/components/page-header";
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
import { WorkflowIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";

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
import { DiagramOverview } from "../workflows/diagram-overview.tsx";
import { partsOf } from "../workflows/diagram-parts.ts";
import type { DiagramPart } from "../workflows/diagram-parts.ts";
import { FilesAndApps } from "../workflows/files-and-apps.tsx";
import { ListedCount } from "../workflows/listed-count.tsx";
import { ResourceParams } from "../workflows/resource-params.tsx";
import { ResourceRuns } from "../workflows/resource-runs.tsx";
import { SavedAgo } from "../workflows/saved-ago.tsx";
import { StartIndependentRun } from "../workflows/start-run.tsx";
import { TestRun } from "../workflows/test-run.tsx";
import { Traces } from "../workflows/traces.tsx";
import type { TracesPart } from "../workflows/traces.tsx";
import {
  GoLiveDecision,
  WorkflowStatus,
} from "../workflows/workflow-status.tsx";

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
// Traces: each run's steps over its diagram, and a test of the draft on
// recent real items; for everyone, the files its runs wrote, the
// Knowledge it reads and the apps it works in; and under the page, what
// happened to it lately.

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
 * Its name with whether it runs beside it; under them the process it
 * serves, its version, its owner, when its draft was saved, and what its
 * builders and owner reach from here; and, for whoever may decide it, the
 * version waiting to go live.
 */
const WorkflowHeader = ({
  resource,
  lifecycle,
  askable,
  names,
  savedAt,
}: {
  resource: WorkflowResource;
  lifecycle: Loaded<WorkflowLifecycle>;
  askable: Loaded<boolean>;
  names: Names;
  /** When its draft was last saved, for its builders; null otherwise. */
  savedAt: string | null;
}) => {
  const router = useRouter();
  const { currentVersion } = resource;
  const { me } = names;
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
  return (
    <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
      <div className="flex min-w-0 grow basis-96 flex-col gap-2">
        {/* Where it stands at the end of the title's line, as the
            prototype has it: the title takes the room it needs. */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
          <PageHeaderTitle className="min-w-0 grow">
            {resource.name}
          </PageHeaderTitle>
          {status === undefined ? null : (
            <WorkflowStatus
              lifecycle={status}
              name={resource.name}
              onChange={onChange}
              workflow={resource.id}
            />
          )}
        </div>
        <div className="text-muted-foreground flex flex-wrap items-center gap-2">
          {/* Its builders set the process it serves; everyone sees it. */}
          {resource.role === "builder" ? (
            <ProcessPicker
              name={resource.name}
              onChange={() => {
                void router.invalidate();
              }}
              process={resource.process}
              workflow={resource.id}
            />
          ) : null}
          {resource.role !== "builder" && resource.process !== null ? (
            <ProcessBadge process={resource.process} />
          ) : null}
          <Badge variant="outline">
            {currentVersion === null ? (
              <Trans>Not published</Trans>
            ) : (
              <Trans>Version {currentVersion}</Trans>
            )}
          </Badge>
          {status === undefined ? null : (
            <SelfApprovedBadge lifecycle={status} />
          )}
          <span className="text-xs">
            <OwnedBy names={names} owner={resource.owner} />
          </span>
          {savedAt === null ? null : (
            <span className="text-xs">
              <SavedAgo at={savedAt} />
            </span>
          )}
          {/* Its approved packages, for its builders: read there, and
            retired or revoked by whoever may approve packages. */}
          {resource.role === "builder" ? (
            <Link
              className="hover:underline focus-visible:underline"
              params={{ workflow: resource.id }}
              to="/settings/packages/workflows/$workflow"
            >
              <Trans>Packages</Trans>
            </Link>
          ) : null}
        </div>
        <StartIndependentRun workflow={resource.id} />
        {resource.owner === me && askable.state === "ready" ? (
          <AskStephen askable={askable.data} workflow={resource.id} />
        ) : null}
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
};

/** The tabs of a workflow's page. */
type WorkflowTab =
  | "overview"
  | "definition"
  | "traces"
  | "runs"
  | "files"
  | "parameters"
  | "versions";

/** The tabs of a workflow's page, as the reader has them. */
const WorkflowTabs = ({
  overview,
  definition,
  builder,
  runs,
}: {
  overview: boolean;
  definition: boolean;
  builder: boolean;
  /** How many runs it has, beside their tab once read. */
  runs: number | undefined;
}) => (
  <TabsList variant="line">
    {overview ? (
      <TabsTrigger value="overview">
        <Trans context="tab of a workflow">Overview</Trans>
      </TabsTrigger>
    ) : null}
    {definition ? (
      <TabsTrigger value="definition">
        <Trans context="tab of a workflow">Definition</Trans>
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
    <TabsTrigger value="files">
      <Trans context="tab of a workflow">Files and apps</Trans>
    </TabsTrigger>
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
}) => {
  const router = useRouter();
  const { currentVersion } = resource;
  const builder = resource.role === "builder";
  // When its draft was saved: as loaded, or as a save here answered,
  // whichever is later.
  const [savedHere, setSavedHere] = useState<string | null>(null);
  const savedAt = laterOf(
    draft?.state === "ready" ? draft.data.editedAt : null,
    savedHere
  );
  const start: WorkflowTab = draft === undefined ? "versions" : "definition";
  const [tab, setTab] = useState<WorkflowTab>(start);
  const [part, setPart] = useState<TracesPart>("runs");
  // The draft as its editor last saved or read it, beside the page's read:
  // whichever is at the later revision is the draft the page goes by.
  const [edited, setEdited] = useState<WorkflowDraft>();
  const { checkpoint, parts } = checkpointOf(latestDraftOf(draft, edited));
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
            lifecycle={lifecycle}
            names={names}
            resource={resource}
            savedAt={savedAt}
          />
          <WorkflowTabs
            builder={builder}
            definition={draft !== undefined}
            overview={parts.length > 0}
            runs={runs.state === "ready" ? runs.data.length : undefined}
          />
        </div>
        {parts.length === 0 ? null : (
          <TabsContent value="overview">
            <div className="mx-auto w-full max-w-7xl px-6 pt-6 pb-8">
              <DiagramOverview
                onShow={({ n }) => {
                  setTab("definition");
                  // Once the drawing shows again: its frame, in view.
                  requestAnimationFrame(() => {
                    document
                      .querySelector(`#workflow-part-${n}`)
                      ?.scrollIntoView({ behavior: "smooth", block: "start" });
                  });
                }}
                parts={parts}
              />
            </div>
          </TabsContent>
        )}
        {draft === undefined ? null : (
          // Kept while another tab shows: what was typed stays.
          <TabsContent keepMounted value="definition">
            <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-6 pt-6 pb-8">
              {draft.state === "ready" ? (
                <DefinitionEditor
                  currentVersion={currentVersion}
                  loaded={draft.data}
                  onDraft={(next) => {
                    setEdited(next);
                    setSavedHere(next.editedAt);
                  }}
                  onVersionMoved={() => {
                    void router.invalidate();
                  }}
                  onPublished={() => {
                    // The new current version, and its place among the
                    // versions, as core has them now.
                    void router.invalidate();
                  }}
                  workflow={resource.id}
                />
              ) : (
                <NotLoadedState page={draft} />
              )}
              {currentVersion === null ? null : (
                <TestRun version={currentVersion} workflow={resource.id} />
              )}
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
        {/* Files and apps reads what no other tab needs: only while it
            shows, afresh each time it is opened. */}
        <TabsContent value="files">
          <div className="mx-auto w-full max-w-7xl px-6 pt-6 pb-8">
            <FilesAndApps
              currentVersion={currentVersion}
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
  const { t } = useLingui();
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
      <div className="flex min-h-full flex-col text-sm">
        <WorkflowResourceView
          // Another workflow starts afresh; a new current version of this
          // one keeps what is typed in its editor.
          key={resource.data.id}
          activity={activity}
          admin={isAdmin(identity.role)}
          askable={askable}
          draft={draft}
          lifecycle={lifecycle}
          names={{ people, me: identity.userId }}
          params={params}
          resource={resource.data}
          runs={runs}
          versions={versions}
        />
      </div>
    </>
  );
};

export const Route = createFileRoute("/_shell/workflows/$workflow")({
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
