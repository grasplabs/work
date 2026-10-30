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
import { DefinitionEditor } from "../workflows/definition-editor.tsx";
import { FilesAndApps } from "../workflows/files-and-apps.tsx";
import { ResourceParams } from "../workflows/resource-params.tsx";
import { ResourceRuns } from "../workflows/resource-runs.tsx";
import { TestRun } from "../workflows/test-run.tsx";
import { Traces } from "../workflows/traces.tsx";
import type { TracesPart } from "../workflows/traces.tsx";
import { WorkflowStatus } from "../workflows/workflow-status.tsx";

// One independent workflow (platform specification 13): for its builders,
// its definition as a draft they edit, check and publish; for everyone
// with a role, its published versions. Core decides who sees what: the
// draft is read only for builders, as it can hold a sensitive default.
// Each version shows what its own actions may call, as sealed with it
// (GRA-709): each binding they use, and a connector's exact operations;
// and, for one that asks a model, the writes its answers may steer
// (GRA-718), which no reviewer should have to piece together. Its
// parameters, which its builders set, and its runs, as core lists them for
// the reader (GRA-674). Beside its name, whether it runs, with Pause and
// Resume (`workflow-status.tsx`); for its builders, Traces: each run's
// steps over its diagram, and a test of the draft on recent real items;
// for everyone, the files its runs wrote, the Knowledge it reads and the
// apps it works in; and under the page, what happened to it lately.

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
    <Badge variant="destructive">
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
 * Its name with whether it runs beside it, its version, and what its
 * builders and owner reach from here.
 */
const WorkflowHeader = ({
  resource,
  lifecycle,
  askable,
  me,
}: {
  resource: WorkflowResource;
  lifecycle: Loaded<WorkflowLifecycle>;
  askable: Loaded<boolean>;
  me: string;
}) => {
  const router = useRouter();
  const { currentVersion } = resource;
  // As core answered the last change made here, until a later read of
  // it is loaded: whichever is at the later revision.
  const [changed, setChanged] = useState<WorkflowLifecycle>();
  const loaded = lifecycle.state === "ready" ? lifecycle.data : undefined;
  const status =
    changed === undefined ||
    (loaded !== undefined && loaded.revision >= changed.revision)
      ? loaded
      : changed;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h1 className="text-2xl font-medium tracking-tight">{resource.name}</h1>
        {status === undefined ? null : (
          <WorkflowStatus
            lifecycle={status}
            name={resource.name}
            onChange={(next) => {
              setChanged(next);
              void router.invalidate();
            }}
            workflow={resource.id}
          />
        )}
      </div>
      <div className="text-muted-foreground flex flex-wrap items-center gap-2">
        <Badge variant="outline">
          {currentVersion === null ? (
            <Trans>Not published</Trans>
          ) : (
            <Trans>Version {currentVersion}</Trans>
          )}
        </Badge>
        {status === undefined ? null : <SelfApprovedBadge lifecycle={status} />}
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
      {resource.owner === me && askable.state === "ready" ? (
        <AskStephen askable={askable.data} workflow={resource.id} />
      ) : null}
    </div>
  );
};

/** The tabs of a workflow's page. */
type WorkflowTab =
  | "definition"
  | "traces"
  | "runs"
  | "files"
  | "parameters"
  | "versions";

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
}) => {
  const router = useRouter();
  const { currentVersion } = resource;
  const builder = resource.role === "builder";
  const [tab, setTab] = useState<WorkflowTab>(
    draft === undefined ? "versions" : "definition"
  );
  const [part, setPart] = useState<TracesPart>("runs");
  // Files and apps reads what no other tab needs: only once it is opened,
  // then kept while another tab shows.
  const [filesOpened, setFilesOpened] = useState(false);
  // A test on recent items runs a saved checkpoint: none before the
  // draft's first edit (revision 0 is the current version's definition).
  const saved =
    draft?.state === "ready" ? (draft.data.checkpoint?.revision ?? 0) : 0;
  const checkpoint = saved > 0 ? saved : null;
  return (
    <>
      <Tabs
        onValueChange={(value: WorkflowTab) => {
          setTab(value);
          if (value === "files") {
            setFilesOpened(true);
          }
        }}
        spacing="none"
        value={tab}
      >
        <div className="flex flex-col gap-3 border-b px-6 pt-5">
          <WorkflowHeader
            askable={askable}
            lifecycle={lifecycle}
            me={names.me}
            resource={resource}
          />
          <TabsList variant="line">
            {draft === undefined ? null : (
              <TabsTrigger value="definition">
                <Trans context="tab of a workflow">Definition</Trans>
              </TabsTrigger>
            )}
            {builder ? (
              <TabsTrigger value="traces">
                <Trans context="tab of a workflow">Traces</Trans>
              </TabsTrigger>
            ) : (
              <TabsTrigger value="runs">
                <Trans context="tab listing the runs of workflows">Runs</Trans>
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
        </div>
        {draft === undefined ? null : (
          // Kept while another tab shows: what was typed stays.
          <TabsContent keepMounted value="definition">
            <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 pt-6 pb-8">
              {draft.state === "ready" ? (
                <DefinitionEditor
                  currentVersion={currentVersion}
                  loaded={draft.data}
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
            <div className="mx-auto w-full max-w-5xl px-6 pt-6 pb-8">
              <Traces
                activity={activity}
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
            <div className="mx-auto w-full max-w-5xl px-6 pt-6 pb-8">
              {runs.state === "ready" ? (
                <ResourceRuns me={names.me} runs={runs.data} />
              ) : (
                <NotLoadedState page={runs} />
              )}
            </div>
          </TabsContent>
        )}
        <TabsContent keepMounted value="files">
          <div className="mx-auto w-full max-w-5xl px-6 pt-6 pb-8">
            {filesOpened ? (
              <FilesAndApps
                currentVersion={currentVersion}
                versions={versions}
                workflow={resource.id}
              />
            ) : null}
          </div>
        </TabsContent>
        {/* Kept while another tab shows: what was typed stays. */}
        <TabsContent keepMounted value="parameters">
          <div className="mx-auto w-full max-w-5xl px-6 pt-6 pb-8">
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
          <div className="mx-auto w-full max-w-5xl px-6 pt-6 pb-8">
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
