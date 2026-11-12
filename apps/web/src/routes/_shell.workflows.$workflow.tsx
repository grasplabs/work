import { isAdmin, isMemberAdmin } from "@grasp-os/shared/roles";
import type { WorkflowLifecycle } from "@grasp-os/shared/workflow-lifecycle";
import type {
  WorkflowActivity,
  WorkflowDraft,
  WorkflowParams,
  WorkflowResource,
  WorkflowResourceRun,
  WorkflowResourceVersion,
  WorkflowState,
} from "@grasp-os/shared/workflow-resources";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@grasp-os/ui/components/alert";
import { Badge } from "@grasp-os/ui/components/badge";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  createFileRoute,
  Link,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { HistoryIcon, SettingsIcon, WorkflowIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { answeredAfterBuild } from "../chat/build-answered.ts";
import { chatPresence } from "../chat/chat-presence.ts";
import { slotOf } from "../chat/chat-subject.ts";
import { useGlobalChat } from "../chat/global-chat.tsx";
import { readPeople } from "../directory.ts";
import {
  backCrumb,
  ItemBar,
  ItemShell,
  ItemSwitch,
  ItemSwitchLink,
  projectSearchOf,
  readItemProject,
} from "../frame/item-shell.tsx";
import {
  NotLoadedState,
  PageLoading,
  PageNotLoaded,
} from "../frame/page-states.tsx";
import { SettingUp, SettingUpBar } from "../frame/setting-up.tsx";
import type { SetUp } from "../frame/setting-up.tsx";
import type { Crumb } from "../frame/site-header.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { ActivityBar } from "../workflows/activity-bar.tsx";
import type { Names } from "../workflows/activity-bar.tsx";
import { useWorkflowChat } from "../workflows/draw-in-chat.ts";
import { ListedCount } from "../workflows/listed-count.tsx";
import { ResourceRuns } from "../workflows/resource-runs.tsx";
import {
  ShareWorkflow,
  useWorkflowUsers,
} from "../workflows/share-workflow.tsx";
import { StartIndependentRun } from "../workflows/start-run.tsx";
import { Traces } from "../workflows/traces.tsx";
import type { TracesPart } from "../workflows/traces.tsx";
import { WorkflowFlow } from "../workflows/workflow-flow.tsx";
import {
  workflowSettingsSectionOf,
  WorkflowSettings,
} from "../workflows/workflow-settings.tsx";
import type { WorkflowSettingsSection } from "../workflows/workflow-settings.tsx";
import {
  GoLiveDecision,
  goLiveChoiceOf,
  WorkflowStatus,
} from "../workflows/workflow-status.tsx";

// One independent workflow (platform specification 13), in the same shell
// as an App (frame/item-shell.tsx): one bar, with the way back to the
// Workflows (or the project it was started from), its name and its
// version; then its views (Flow, Runs, Settings), Run, Share and, where an
// App has Share with your team, whether it runs (`workflow-status.tsx`). Core decides
// who sees what: the draft is read only for builders, as it can hold a
// sensitive default.
//
// - Flow, for its builders, who read its draft: the definition drawn
//   (`workflow-flow.tsx`), filling the page, with Grasp's chat about it
//   docked beside (chat/chat-subject.ts), which draws it: the Flow follows
//   the draft as the chat edits it (`workflows/draw-in-chat.ts`).
// - Runs: its runs as core lists them for the reader (GRA-674), each
//   opened beside the page with what it did, returned or why it failed;
//   for its builders with a test of the draft on recent real items and
//   what happened to it lately.
// - Settings (`workflow-settings.tsx`): everything else, a section at a
//   time, as an App's are.
//
// Run, in the bar, starts its current version by hand, in a dialog; for
// whoever may decide it, the version waiting to go live is approved or
// sent back over the page.

/** What the main area shows. */
type WorkflowView = "flow" | "runs" | "settings";

/** A view named in an address, or none for anything else. */
const viewOf = (value: unknown): WorkflowView | undefined =>
  value === "flow" || value === "runs" || value === "settings"
    ? value
    : undefined;

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
 * The revision of the draft's checkpoint a test on recent items runs:
 * none before the draft's first edit (revision 0 is the current version's
 * definition).
 */
const checkpointOf = (draft: WorkflowDraft | undefined): number | null => {
  const revision = draft?.checkpoint?.revision ?? 0;
  return revision > 0 ? revision : null;
};

/** The later of two ISO times, either of which may be missing. */
const laterOf = (a: string | null, b: string | null): string | null => {
  if (a === null || (b !== null && b > a)) {
    return b;
  }
  return a;
};

/**
 * Where a new workflow Build it made stands, for its builders: being set
 * up while Grasp's agent draws its first draft in the chat beside it,
 * until a draft passes (its checkpoint); not set up once the agent's turn
 * ended without one: seen ending here, or answered after the Build it
 * that made it, so a turn over before the page came, or a reload, lands
 * there too. Any other workflow, one with a version or a draft that
 * passed, is ready.
 */
const useSetUp = (
  resource: WorkflowResource,
  latest: WorkflowDraft | undefined
): { setUp: SetUp; called: string } => {
  const chat = useGlobalChat();
  const ours = chat.slot === slotOf({ kind: "workflow", id: resource.id });
  const busy = ours && (chat.view.running || chat.view.checking);
  // What the person calls it: its chat's title, which the plan named, as
  // its own name is one for good, in core's letters.
  const called = (ours ? chat.summary?.title : undefined) ?? resource.name;
  // The workflow whose agent was seen at work on this page.
  const [worked, setWorked] = useState<string>();
  if (busy && worked !== resource.id) {
    setWorked(resource.id);
  }
  if (
    resource.role !== "builder" ||
    resource.currentVersion !== null ||
    checkpointOf(latest) !== null
  ) {
    return { setUp: "ready", called };
  }
  if (busy) {
    return { setUp: "setting-up", called };
  }
  const answered =
    ours &&
    answeredAfterBuild(chat.view.messages, {
      kind: "workflow",
      id: resource.id,
    });
  return {
    setUp: answered || worked === resource.id ? "failed" : "ready",
    called,
  };
};

/** Its builders' chat about it, docked beside the page, which draws its Flow. */
const DrawnInChat = ({
  resource,
  onDraft,
}: {
  resource: WorkflowResource;
  onDraft: (draft: WorkflowDraft) => void;
}) => {
  useWorkflowChat(resource, onDraft);
  return null;
};

/** Flow | Runs | Settings: links, so each is an address of its own. */
const ViewSwitch = ({
  workflow,
  view,
  flow,
  runs,
}: {
  workflow: string;
  view: WorkflowView;
  /** Whether the reader has its Flow: its draft. */
  flow: boolean;
  /** How many runs it has, beside their view once read. */
  runs: number | undefined;
}) => {
  const { t } = useLingui();
  const views = [
    ...(flow
      ? [
          {
            view: "flow",
            icon: WorkflowIcon,
            label: t({ message: "Flow", context: "a workflow's view" }),
          } as const,
        ]
      : []),
    {
      view: "runs",
      icon: HistoryIcon,
      label: t({ message: "Runs", context: "a workflow's view" }),
    },
    {
      view: "settings",
      icon: SettingsIcon,
      label: t({ message: "Settings", context: "a workflow's view" }),
    },
  ] as const;
  return (
    <ItemSwitch label={t`Workflow views`}>
      {views.map(({ view: each, icon: Icon, label }) => (
        <ItemSwitchLink
          current={each === view}
          icon={<Icon data-icon="inline-start" />}
          key={each}
          label={label}
          renderLink={(look) => (
            <Link
              {...look}
              params={{ workflow }}
              replace
              search={(held) => ({ project: held.project, view: each })}
              to="/workflows/$workflow"
            />
          )}
        >
          {each === "runs" ? <ListedCount count={runs} of="runs" /> : null}
        </ItemSwitchLink>
      ))}
    </ItemSwitch>
  );
};

/** Its version, as the bar has it beside its name. */
/** Its version, once one was published; nothing before. */
const VersionBadge = ({ version }: { version: number | null }) =>
  version === null ? null : (
    <Badge variant="outline">
      <Trans>Version {version}</Trans>
    </Badge>
  );

/** The version waiting to go live, over the page, for whoever decides it. */
const GoLiveWaiting = ({
  status,
  resource,
  me,
  onChange,
}: {
  status: WorkflowLifecycle;
  resource: WorkflowResource;
  me: string;
  onChange: (next: WorkflowLifecycle) => void;
}) => {
  const choice = goLiveChoiceOf(status, me);
  if (choice === null) {
    return null;
  }
  const { version: waiting } = choice;
  return (
    <div className="flex-none border-b p-3">
      <Alert variant="attention">
        <AlertTitle>
          <Trans>
            Version {waiting} waits for approval to run for the team
          </Trans>
        </AlertTitle>
        <AlertDescription>
          <GoLiveDecision
            lifecycle={status}
            me={me}
            name={resource.name}
            onChange={onChange}
            workflow={resource.id}
          />
        </AlertDescription>
      </Alert>
    </div>
  );
};

/**
 * Its runs: for its builders, with a test of the draft on recent items
 * and what happened to it lately (`Traces`); for anyone else, the runs
 * core lists them, and what happened lately under them.
 */
const RunsView = ({
  workflow,
  builder,
  runs,
  activity,
  names,
  admin,
  checkpoint,
}: {
  workflow: string;
  builder: boolean;
  runs: Loaded<WorkflowResourceRun[]>;
  activity: Loaded<WorkflowActivity[]>;
  names: Names;
  admin: boolean;
  /** The draft's checkpoint revision, if it has one: what a test runs. */
  checkpoint: number | null;
}) => {
  const [part, setPart] = useState<TracesPart>("runs");
  if (builder) {
    return (
      <div className="mx-auto w-full max-w-7xl px-6 pt-6 pb-8">
        <Traces
          activity={activity}
          admin={admin}
          checkpoint={checkpoint}
          names={names}
          onPartChange={setPart}
          part={part}
          runs={runs}
          workflow={workflow}
        />
      </div>
    );
  }
  return (
    <>
      <div className="mx-auto w-full max-w-7xl px-6 pt-6 pb-8">
        {runs.state === "ready" ? (
          <ResourceRuns
            admin={admin}
            names={names}
            runs={runs.data}
            workflow={workflow}
          />
        ) : (
          <NotLoadedState page={runs} />
        )}
      </div>
      <div className="mt-auto">
        <ActivityBar activity={activity} names={names} onAll={undefined} />
      </div>
    </>
  );
};

/**
 * The view the page shows: the one asked for, but Flow only for who reads
 * its draft (`flow`), its builders; anyone else opens on Runs.
 */
const shownView = (
  asked: WorkflowView | undefined,
  flow: boolean
): WorkflowView => {
  if (asked === undefined || (asked === "flow" && !flow)) {
    return flow ? "flow" : "runs";
  }
  return asked;
};

/** What the workflow's page read. */
interface WorkflowPageRead {
  resource: WorkflowResource;
  draft: Loaded<WorkflowDraft> | undefined;
  versions: Loaded<WorkflowResourceVersion[]>;
  params: Loaded<WorkflowParams>;
  /** What it keeps between runs, for its builders and admins only. */
  state: Loaded<WorkflowState> | undefined;
  runs: Loaded<WorkflowResourceRun[]>;
  askable: Loaded<boolean>;
  lifecycle: Loaded<WorkflowLifecycle>;
  activity: Loaded<WorkflowActivity[]>;
  names: Names;
  /** Whether the reader is one of the organization's admins. */
  admin: boolean;
  /** Whether they approve its bindings: an admin of its own, not Grasp staff. */
  approves: boolean;
}

const WorkflowResourceView = ({
  back,
  view: asked,
  section,
  ...read
}: WorkflowPageRead & {
  back: Crumb;
  /** The view the address asks for, if any. */
  view: WorkflowView | undefined;
  section: WorkflowSettingsSection | undefined;
}) => {
  const { resource, draft, runs, activity, names, admin } = read;
  const navigate = useNavigate();
  const builder = resource.role === "builder";
  const view = shownView(asked, draft !== undefined);
  // When its draft was saved: as loaded, or as a save here answered,
  // whichever is later.
  const [savedHere, setSavedHere] = useState<string | null>(null);
  const savedAt = laterOf(
    draft?.state === "ready" ? draft.data.editedAt : null,
    savedHere
  );
  // The draft as its editor last saved or read it, beside the page's read:
  // whichever is at the later revision is the draft the page goes by.
  const [edited, setEdited] = useState<WorkflowDraft>();
  const latest = latestDraftOf(draft, edited);
  const took = (next: WorkflowDraft): void => {
    setEdited(next);
    setSavedHere(next.editedAt);
  };
  const { status, onChange } = useStatus(read.lifecycle);
  const settingsAt = (at: WorkflowSettingsSection): void => {
    void navigate({
      to: "/workflows/$workflow",
      params: { workflow: resource.id },
      search: (held) => ({
        project: held.project,
        view: "settings",
        section: at,
      }),
    });
  };
  const deciding =
    status !== undefined && goLiveChoiceOf(status, names.me) !== null;
  const users = useWorkflowUsers(resource.id, builder);
  const { setUp, called } = useSetUp(resource, latest);
  if (setUp !== "ready") {
    return (
      <ItemShell bar={<SettingUpBar back={back} name={resource.name} />}>
        <DrawnInChat onDraft={took} resource={resource} />
        <SettingUp failed={setUp === "failed"} name={called} />
      </ItemShell>
    );
  }
  return (
    <ItemShell
      bar={
        <ItemBar
          actions={
            <>
              <ViewSwitch
                flow={draft !== undefined}
                runs={runs.state === "ready" ? runs.data.length : undefined}
                view={view}
                workflow={resource.id}
              />
              <StartIndependentRun
                // Read again for each version that goes live: what Run
                // starts, and that there is one to start at all.
                key={resource.currentVersion ?? "none"}
                onFiles={() => {
                  settingsAt("files");
                }}
                workflow={resource.id}
              />
              {builder ? <ShareWorkflow resource={resource} /> : null}
              {status === undefined ? null : (
                <WorkflowStatus
                  // Approving the version waiting is the page's one lime
                  // action while there is one.
                  highlight={!deciding}
                  lifecycle={status}
                  name={resource.name}
                  onChange={onChange}
                  who={users}
                  workflow={resource.id}
                />
              )}
            </>
          }
          back={back}
          name={resource.name}
          state={<VersionBadge version={resource.currentVersion} />}
        />
      }
    >
      {builder ? <DrawnInChat onDraft={took} resource={resource} /> : null}
      {status === undefined ? null : (
        <GoLiveWaiting
          me={names.me}
          onChange={onChange}
          resource={resource}
          status={status}
        />
      )}
      {/* Kept while another view shows: its zoom and layout stay. */}
      {draft === undefined ? null : (
        <div
          className={
            view === "flow"
              ? "animate-in fade-in-0 flex min-h-0 flex-1 flex-col duration-300 motion-reduce:animate-none"
              : "hidden"
          }
        >
          {draft.state === "ready" ? (
            <WorkflowFlow
              draft={latest ?? draft.data}
              onDefinition={() => {
                settingsAt("definition");
              }}
              onDraft={took}
              onTriggers={() => {
                settingsAt("triggers");
              }}
              workflow={resource.id}
            />
          ) : (
            <NotLoadedState page={draft} />
          )}
        </div>
      )}
      {/* Kept while another view shows: a test going on stays followed. */}
      <div
        className={
          view === "runs"
            ? "flex min-h-0 flex-1 flex-col overflow-y-auto"
            : "hidden"
        }
      >
        <RunsView
          activity={activity}
          admin={admin}
          builder={builder}
          checkpoint={checkpointOf(latest)}
          names={names}
          runs={runs}
          workflow={resource.id}
        />
      </div>
      {view === "settings" ? (
        <WorkflowSettings
          read={{
            ...read,
            latest,
            onDraft: took,
            savedAt,
            // As the bar has it: a change made there before the page
            // reads it again.
            lifecycle:
              status === undefined
                ? read.lifecycle
                : { state: "ready", data: status },
          }}
          section={section}
        />
      ) : null}
    </ItemShell>
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
    people: peopleRead,
    project,
    ...read
  } = Route.useLoaderData();
  const people = usePeople(peopleRead);
  const { identity } = Route.useRouteContext();
  const { view, section } = Route.useSearch();
  const { t } = useLingui();
  const back = backCrumb({ label: t`Workflows`, to: "/workflows" }, project);
  if (resource.state !== "ready") {
    return (
      <PageNotLoaded
        crumbs={[back, { label: t`Workflow` }]}
        icon={WorkflowIcon}
        notFound={t`Workflow not found`}
        page={resource}
      />
    );
  }
  return (
    <WorkflowResourceView
      // Another workflow starts afresh; a new current version of this
      // one keeps what is typed in its editor.
      key={resource.data.id}
      {...read}
      admin={isAdmin(identity.role)}
      approves={isMemberAdmin(identity)}
      back={back}
      names={{ people, me: identity.userId }}
      resource={resource.data}
      section={section}
      view={view}
    />
  );
};

/** What a link to a workflow's page may ask of it. */
interface WorkflowSearch {
  /** The view it opens on: Flow for its builders, Runs for anyone else, by default. */
  view?: WorkflowView;
  /** In Settings, the section open: General by default. */
  section?: WorkflowSettingsSection;
  /** The project it was started or opened from: the way back. */
  project?: string;
}

export const Route = createFileRoute("/_shell/workflows/$workflow")({
  // Grasp's chat has no place here but its builders', about the workflow,
  // docked beside it (chat/chat-subject.ts).
  staticData: { chat: chatPresence.hidden },
  validateSearch: (search: Record<string, unknown>): WorkflowSearch => {
    const view = viewOf(search.view);
    const section = workflowSettingsSectionOf(search.section);
    const project = projectSearchOf(search);
    return {
      ...(view === undefined ? {} : { view }),
      ...(section === undefined ? {} : { section }),
      ...(project === undefined ? {} : { project }),
    };
  },
  pendingComponent: PageLoading,
  loaderDeps: ({ search: { project } }) => ({ project }),
  loader: async ({
    context: { core, identity },
    params: { workflow },
    deps: { project },
  }) => {
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
    // What it keeps between runs: its builders' and the organization's
    // admins' to read, as its runs' results are.
    const stateRead = async (): Promise<Loaded<WorkflowState> | undefined> => {
      const read = await resourceRead;
      return read.state === "ready" &&
        (read.data.role === "builder" || isAdmin(identity.role))
        ? await loadFromCore(
            core,
            async (session) => await session.workflowResources.state(workflow)
          )
        : undefined;
    };
    const [
      resource,
      draft,
      versions,
      params,
      state,
      runs,
      askable,
      lifecycle,
      activity,
      inProject,
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
      stateRead(),
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
      // The project it was started or opened from, for the way back.
      loadFromCore(
        core,
        async (session) => await readItemProject(session, project)
      ),
    ]);
    return {
      resource,
      draft,
      versions,
      params,
      state,
      runs,
      askable,
      lifecycle,
      activity,
      people,
      project: inProject.state === "ready" ? inProject.data : undefined,
    };
  },
  component: WorkflowResourcePage,
});
