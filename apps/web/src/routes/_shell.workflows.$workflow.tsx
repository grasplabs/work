import type { Draft } from "@grasp-os/shared/drafts";
import { isAdmin, isMemberAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
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
import { useLingui } from "@lingui/react/macro";
import {
  createFileRoute,
  Link,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { HistoryIcon, SettingsIcon, WorkflowIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useCoreRead } from "../apps/use-core-read.ts";
import { setActiveChat } from "../chat/active-chat.ts";
import { chatPresence } from "../chat/chat-presence.ts";
import { slotOf } from "../chat/chat-subject.ts";
import { readPeople } from "../directory.ts";
import { memberNames, readMembers } from "../drafts/members.ts";
import type { Member } from "../drafts/members.ts";
import {
  ShareWithTeam,
  showsUnpublishedChanges,
  UnpublishedChanges,
} from "../drafts/share-with-team.tsx";
import { useDraft } from "../drafts/use-draft.ts";
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
import {
  useFollowedDraft,
  useWorkflowChat,
} from "../workflows/draw-in-chat.ts";
import { ListedCount } from "../workflows/listed-count.tsx";
import { workflowVersions } from "../workflows/reads.ts";
import { ResourceRuns } from "../workflows/resource-runs.tsx";
import { StartIndependentRun } from "../workflows/start-run.tsx";
import { Traces } from "../workflows/traces.tsx";
import type { TracesPart } from "../workflows/traces.tsx";
import { WorkflowFlow } from "../workflows/workflow-flow.tsx";
import {
  workflowSettingsSectionOf,
  WorkflowSettings,
} from "../workflows/workflow-settings.tsx";
import type { WorkflowSettingsSection } from "../workflows/workflow-settings.tsx";
import { PauseControl, WorkflowStatus } from "../workflows/workflow-status.tsx";

// One independent workflow (platform specification 13), in the same shell
// as an App (frame/item-shell.tsx), with the same bar: the way back to
// the Workflows (or the project it was started from), its name and where
// it stands in plain words (`workflow-status.tsx`); then its views (Flow,
// Runs, Settings), Run, Pause, and Share with your team, the page's one
// lime action, as an App's workspace has it (drafts/share-with-team.tsx).
// Core decides who sees what: the draft is read only for builders, as it
// can hold a sensitive default.
//
// - Flow, for its builders, who read its draft: the definition drawn
//   (`workflow-flow.tsx`), filling the page, with Grasp's chat about it
//   docked beside (chat/chat-subject.ts), which draws it: the Flow follows
//   the draft as anyone writes it (`workflows/draw-in-chat.ts`). Once it
//   is shared, a line under the bar says it has changes only its builders
//   see, with Undo, as an App's does.
// - Runs: its runs as core lists them for the reader (GRA-674), each
//   opened beside the page with what it did, returned or why it failed;
//   for its builders with a test of the draft on recent real items and
//   what happened to it lately.
// - Settings (`workflow-settings.tsx`): everything else, a section at a
//   time, as an App's are, History among them.
//
// Run, in the bar, starts its live version by hand, in a dialog.

/** What the main area shows. */
type WorkflowView = "flow" | "runs" | "settings";

/** A view named in an address, or none for anything else. */
const viewOf = (value: unknown): WorkflowView | undefined =>
  value === "flow" || value === "runs" || value === "settings"
    ? value
    : undefined;

/**
 * Whether it is paused, as core answered the last change made on the
 * page until the page reads it again; `onChange` takes a change.
 */
const usePaused = (lifecycle: Loaded<WorkflowLifecycle>) => {
  const router = useRouter();
  const loaded = lifecycle.state === "ready" ? lifecycle.data : undefined;
  // As core answered the last change made here, until the next read.
  const [changed, setChanged] = useState<WorkflowLifecycle>();
  const [seen, setSeen] = useState(loaded);
  if (loaded !== seen) {
    setSeen(loaded);
    setChanged(undefined);
  }
  const onChange = (next: WorkflowLifecycle): void => {
    setChanged(next);
    void router.invalidate();
  };
  return { status: changed ?? loaded, onChange };
};

/**
 * The draft the page goes by: its editor's last save or read (`edited`),
 * or the page's own read when that is at a later revision.
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
 * The revision a test on recent items runs: the draft's, while it passes
 * and has been written (revision 0 is the live version's definition).
 */
const testableOf = (draft: WorkflowDraft | undefined): number | null =>
  draft !== undefined && draft.revision > 0 && draft.diagram !== null
    ? draft.revision
    : null;

/**
 * Where a new workflow Build it made stands, for its builders: being set
 * up while Grasp's agent draws its first draft in the chat beside it,
 * until a draft passes; not set up once the agent's turn ended without
 * one: seen ending here, or answered after the Build it that made it, so
 * a turn over before the page came, or a reload, lands there too. Any
 * other workflow, one with a version or a draft that passed, is ready,
 * and stays so while the page is open.
 */
const useSetUp = (
  resource: WorkflowResource,
  latest: WorkflowDraft | undefined,
  chat: { busy: boolean; built: boolean }
): SetUp => {
  // The workflow whose agent was seen at work on this page.
  const [worked, setWorked] = useState<string>();
  // The workflow whose draft was seen passing on this page.
  const [passed, setPassed] = useState<string>();
  if (chat.busy && worked !== resource.id) {
    setWorked(resource.id);
  }
  if (testableOf(latest) !== null && passed !== resource.id) {
    setPassed(resource.id);
  }
  if (
    resource.role !== "builder" ||
    resource.currentVersion !== null ||
    passed === resource.id ||
    testableOf(latest) !== null
  ) {
    return "ready";
  }
  if (chat.busy) {
    return "setting-up";
  }
  return chat.built || worked === resource.id ? "failed" : "ready";
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
  testable,
}: {
  workflow: string;
  builder: boolean;
  runs: Loaded<WorkflowResourceRun[]>;
  activity: Loaded<WorkflowActivity[]>;
  names: Names;
  admin: boolean;
  /** The draft's revision while it passes: what a test runs. */
  testable: number | null;
}) => {
  const [part, setPart] = useState<TracesPart>("runs");
  if (builder) {
    return (
      <div className="mx-auto w-full max-w-7xl px-6 pt-6 pb-8">
        <Traces
          activity={activity}
          admin={admin}
          names={names}
          onPartChange={setPart}
          testable={testable}
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
  /** Who reads it: what its History offers them. */
  identity: Pick<Identity, "userId" | "role" | "staff">;
  /** Whether the reader is one of the organization's admins. */
  admin: boolean;
  /** Whether they approve its bindings: an admin of its own, not Grasp staff. */
  approves: boolean;
}

/**
 * Its bar, as an App's: its name and where it stands, its views, Run,
 * Pause, and, for its builders, Share with your team, the one lime action.
 */
const WorkflowBar = ({
  resource,
  back,
  view,
  flow,
  runs,
  status,
  builder,
  draft,
  members,
  running,
  pending,
  onChange,
  onFiles,
  onShared,
}: {
  resource: WorkflowResource;
  back: Crumb;
  view: WorkflowView;
  /** Whether the reader has its Flow: its draft. */
  flow: boolean;
  /** How many runs it has, once read. */
  runs: number | undefined;
  /** Whether it is paused, once read. */
  status: WorkflowLifecycle | undefined;
  builder: boolean;
  /** Its draft, for its builders, as read last. */
  draft: Draft | undefined;
  /** Whom it is shared with, for its builders, once read. */
  members: readonly Member[] | undefined;
  /** Whether Grasp works on it, or checks it. */
  running: boolean;
  /** Whether it is shared and has changes only its builders see. */
  pending: boolean;
  onChange: (lifecycle: WorkflowLifecycle) => void;
  /** Shows what it may reach, in its Settings' Files and apps. */
  onFiles: () => void;
  onShared: () => void;
}) => {
  const live = resource.currentVersion;
  return (
    <ItemBar
      actions={
        <>
          <ViewSwitch
            flow={flow}
            runs={runs}
            view={view}
            workflow={resource.id}
          />
          <StartIndependentRun
            // Read again for each version that goes live: what Run starts,
            // and that there is one to start at all.
            key={live ?? "none"}
            onFiles={onFiles}
            workflow={resource.id}
          />
          {status === undefined ? null : (
            <PauseControl
              lifecycle={status}
              live={live}
              name={resource.name}
              onChange={onChange}
              workflow={resource.id}
            />
          )}
          {builder ? (
            <ShareWithTeam
              draft={draft}
              members={members ?? []}
              onShared={onShared}
              pending={pending}
              running={running}
              shared={{
                subject: { kind: "workflow", id: resource.id },
                name: resource.name,
                owner: resource.owner,
                live,
              }}
            />
          ) : null}
        </>
      }
      back={back}
      name={resource.name}
      state={
        builder && members === undefined ? undefined : (
          <WorkflowStatus
            lifecycle={status}
            live={live}
            who={members === undefined ? undefined : memberNames(members)}
          />
        )
      }
    />
  );
};

/**
 * Whom it is shared with, for one who builds it (`builds`), read again
 * each time it is shared from here (`shares`); none for anyone else.
 */
const useMembers = (workflow: string, builds: boolean, shares: number) => {
  const read = useCoreRead(
    builds ? `${workflow}/${shares}` : "none",
    async (session) =>
      builds
        ? await readMembers(session, { kind: "workflow", id: workflow })
        : [],
    workflow
  );
  return read?.state === "ready" ? read.data : undefined;
};

const WorkflowResourceView = ({
  back,
  view: asked,
  section,
  handedOver,
  ...read
}: WorkflowPageRead & {
  back: Crumb;
  /** The view the address asks for, if any. */
  view: WorkflowView | undefined;
  section: WorkflowSettingsSection | undefined;
  /** The chat the person came from, building it in Chat. */
  handedOver: string | undefined;
}) => {
  const { resource, draft, runs, activity, names, admin } = read;
  const navigate = useNavigate();
  const builder = resource.role === "builder";
  const subject = { kind: "workflow", id: resource.id } as const;
  const view = shownView(asked, draft !== undefined);
  const chat = useWorkflowChat(resource, builder);
  const { draft: shared, reread } = useDraft(
    builder ? subject : undefined,
    chat.worked
  );
  // The draft as its editor last saved or read it, beside the page's read:
  // whichever is at the later revision is the draft the page goes by.
  const [edited, setEdited] = useState<WorkflowDraft>();
  const latest = latestDraftOf(draft, edited);
  useFollowedDraft(resource.id, shared?.revision, latest?.revision, setEdited);
  const [shares, setShares] = useState(0);
  const members = useMembers(resource.id, builder, shares);
  const { status, onChange } = usePaused(read.lifecycle);
  useEffect(() => {
    if (handedOver === undefined) {
      return;
    }
    setActiveChat(handedOver, slotOf({ kind: "workflow", id: resource.id }));
    // Carried on: the address no longer needs it.
    void navigate({
      to: ".",
      search: (held: Record<string, unknown>) => ({ ...held, chat: undefined }),
      replace: true,
    });
  }, [navigate, resource.id, handedOver]);
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
  const setUp = useSetUp(resource, latest, chat);
  if (setUp !== "ready") {
    return (
      <ItemShell bar={<SettingUpBar back={back} name={resource.name} />}>
        {/* What the person calls it: its chat's title, which the plan
          named, as its own name is one for good, in core's letters. */}
        <SettingUp
          failed={setUp === "failed"}
          name={chat.title ?? resource.name}
        />
      </ItemShell>
    );
  }
  const live = resource.currentVersion;
  const unpublished =
    builder && showsUnpublishedChanges(live, shared, members ?? []);
  return (
    <ItemShell
      bar={
        <WorkflowBar
          back={back}
          builder={builder}
          draft={shared}
          flow={draft !== undefined}
          members={members}
          onChange={onChange}
          onFiles={() => {
            settingsAt("files");
          }}
          onShared={() => {
            reread();
            setShares((before) => before + 1);
          }}
          pending={unpublished}
          resource={resource}
          running={chat.busy}
          runs={runs.state === "ready" ? runs.data.length : undefined}
          status={status}
          view={view}
        />
      }
    >
      {unpublished && shared !== undefined ? (
        <UnpublishedChanges
          draft={shared}
          onChanged={reread}
          running={chat.busy}
        />
      ) : null}
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
              onDraft={setEdited}
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
          names={names}
          runs={runs}
          testable={testableOf(latest)}
          workflow={resource.id}
        />
      </div>
      {view === "settings" ? (
        <WorkflowSettings
          read={{
            ...read,
            latest,
            onDraft: setEdited,
            savedAt: shared?.updatedAt ?? null,
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
  const { view, section, chat } = Route.useSearch();
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
      handedOver={chat}
      identity={identity}
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
  /**
   * The chat the person came from, building it in Grasp's chat: the page
   * makes it the workflow's. Core checks it is theirs on each read.
   */
  chat?: string;
}

export const Route = createFileRoute("/_shell/workflows/$workflow")({
  // Grasp's chat has no place here but its builders', about the workflow,
  // docked beside it (chat/chat-subject.ts).
  staticData: { chat: chatPresence.hidden },
  validateSearch: (search: Record<string, unknown>): WorkflowSearch => {
    const view = viewOf(search.view);
    const section = workflowSettingsSectionOf(search.section);
    const project = projectSearchOf(search);
    const chat = typeof search.chat === "string" ? search.chat : undefined;
    return {
      ...(view === undefined ? {} : { view }),
      ...(section === undefined ? {} : { section }),
      ...(chat === undefined ? {} : { chat }),
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
        async (session) => await workflowVersions(session, workflow)
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
