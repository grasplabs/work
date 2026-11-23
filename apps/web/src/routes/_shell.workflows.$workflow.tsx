import type { Draft } from "@grasp-os/shared/drafts";
import { isAdmin, isMemberAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import type { SubjectMember } from "@grasp-os/shared/subject-members";
import { workflowLabel } from "@grasp-os/shared/workflow-resources";
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
import * as stylex from "@stylexjs/stylex";
import {
  createFileRoute,
  Link,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { setActiveChat } from "../chat/active-chat.ts";
import { chatPresence } from "../chat/chat-presence.ts";
import { slotOf } from "../chat/chat-subject.ts";
import { useChatAbout } from "../chat/global-chat.tsx";
import {
  ShareWithTeam,
  showsUnpublishedChanges,
  UnpublishedChanges,
} from "../drafts/share-with-team.tsx";
import { memberNames, useMembers } from "../drafts/sharing.tsx";
import { useDraft } from "../drafts/use-draft.ts";
import {
  backCrumb,
  ItemBar,
  ItemShell,
  projectSearchOf,
  readItemProject,
} from "../frame/item-shell.tsx";
import {
  WORKFLOW_GENERAL,
  Fill,
  LoadingBar,
  SettingsPending,
} from "../frame/page-skeletons-b.tsx";
import { NotLoadedState, PageNotLoaded } from "../frame/page-states.tsx";
import { SettingUp, SettingUpBar } from "../frame/setting-up.tsx";
import type { SetUp } from "../frame/setting-up.tsx";
import type { Crumb } from "../frame/site-header.tsx";
import { Workflow as WorkflowMark } from "../grasp/icons/index.ts";
import { TabsLink, TabsNav } from "../grasp/tabs/nav.tsx";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { ActivityBar } from "../workflows/activity-bar.tsx";
import type { Names } from "../workflows/activity-bar.tsx";
import { ListedCount } from "../workflows/listed-count.tsx";
import { workflowBlock } from "../workflows/overview.ts";
import type { TriggerBlock } from "../workflows/overview.ts";
import { readWorkflowNames, workflowVersions } from "../workflows/reads.ts";
import { ResourceRuns } from "../workflows/resource-runs.tsx";
import { workflowSettingsSectionOf } from "../workflows/settings-sections.ts";
import type { WorkflowSettingsSection } from "../workflows/settings-sections.ts";
import { StartIndependentRun } from "../workflows/start-run.tsx";
import { Traces } from "../workflows/traces.tsx";
import type { TracesPart } from "../workflows/traces.tsx";
import { useWorkflowDraft } from "../workflows/use-workflow-draft.ts";
import { WorkflowFlow } from "../workflows/workflow-flow.tsx";
import { WorkflowSettings } from "../workflows/workflow-settings.tsx";
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
//   the draft as anyone writes it (`workflows/use-workflow-draft.ts`). Once it
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

// The Flow comes in softly as it is shown again.
const fadeIn = stylex.keyframes({
  from: { opacity: 0 },
  to: { opacity: 1 },
});

const styles = stylex.create({
  // A view kept while another shows: its state stays.
  away: { display: "none" },
  flow: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
    animationName: { default: fadeIn, [media.reduced]: "none" },
    animationDuration: grasp.durationOpen,
    animationTimingFunction: grasp.ease,
  },
  runs: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
    overflowY: "auto",
  },
  // As wide as the card, as every page is: the shell gives the side room.
  column: {
    width: "100%",
    paddingBlockStart: grasp.space6,
  },
  bar: { marginBlockStart: "auto" },
});

/** A view named in an address, or none for anything else. */
const viewOf = (value: unknown): WorkflowView | undefined =>
  value === "flow" || value === "runs" || value === "settings"
    ? value
    : undefined;

/**
 * Whether it is paused, as core answered the last change made on the
 * page until the page reads it again, and whether `identity` may pause
 * and resume it (a builder of it, never Grasp staff); `onChange` takes a
 * change.
 */
const usePaused = (
  resource: WorkflowResource,
  identity: Pick<Identity, "staff">
) => {
  const router = useRouter();
  // As core answered the last change made here, until the next read.
  const [changed, setChanged] = useState<WorkflowResource>();
  const [seen, setSeen] = useState(resource);
  if (resource !== seen) {
    setSeen(resource);
    setChanged(undefined);
  }
  const onChange = (next: WorkflowResource): void => {
    setChanged(next);
    void router.invalidate();
  };
  return {
    paused: (changed ?? resource).paused,
    pauses: resource.role === "builder" && !identity.staff,
    onChange,
  };
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
            label: t({ message: "Flow", context: "a workflow's view" }),
          } as const,
        ]
      : []),
    {
      view: "runs",
      label: t({ message: "Runs", context: "a workflow's view" }),
    },
    {
      view: "settings",
      label: t({ message: "Settings", context: "a workflow's view" }),
    },
  ] as const;
  const label = t`Workflow views`;
  const links = views.map(({ view: each, label: words }) => (
    <TabsLink
      current={each === view}
      key={each}
      render={
        <Link
          params={{ workflow }}
          replace
          search={(held) => ({ project: held.project, view: each })}
          to="/workflows/$workflow"
        />
      }
    >
      {words}
      {each === "runs" ? <ListedCount count={runs} of="runs" /> : null}
    </TabsLink>
  ));
  // TabsNav folds to one menu by itself where its links don't fit.
  return (
    <TabsNav aria-label={label} variant="segmented">
      {links}
    </TabsNav>
  );
};

/**
 * Its runs: for its builders, with a test of the draft on recent items
 * and what happened to it lately (`Traces`); for anyone else, the runs
 * core lists them, and what happened lately under them.
 */
const RunsView = ({
  workflow,
  name,
  builder,
  runs,
  activity,
  names,
  admin,
  testable,
  openRun,
  onCloseRun,
}: {
  workflow: string;
  /** Its name, as people see it. */
  name: string;
  /** The run the address asks to open, by its ID. */
  openRun: string | undefined;
  /** Clears the run from the address once it is closed. */
  onCloseRun: () => void;
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
      <div {...stylex.props(styles.column)}>
        <Traces
          activity={activity}
          admin={admin}
          name={name}
          names={names}
          onCloseRun={onCloseRun}
          onPartChange={setPart}
          openRun={openRun}
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
      <div {...stylex.props(styles.column)}>
        {runs.state === "ready" ? (
          <ResourceRuns
            admin={admin}
            name={name}
            names={names}
            onCloseRun={onCloseRun}
            openRun={openRun}
            runs={runs.data}
            workflow={workflow}
          />
        ) : (
          <NotLoadedState page={runs} />
        )}
      </div>
      <div {...stylex.props(styles.bar)}>
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
  activity: Loaded<WorkflowActivity[]>;
  /** Why its triggers start nothing, if they can't; null where they can or core didn't list them. */
  blocked: TriggerBlock | null;
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
  blocked,
  admin,
  back,
  view,
  flow,
  runs,
  paused,
  pauses,
  builder,
  draft,
  members,
  running,
  pending,
  onChange,
  onFiles,
  onOpenRun,
  onShared,
}: {
  resource: WorkflowResource;
  blocked: TriggerBlock | null;
  /** Whether the reader is an admin who allows triggers: an admin of its own, not Grasp staff. */
  admin: boolean;
  back: Crumb;
  view: WorkflowView;
  /** Whether the reader has its Flow: its draft. */
  flow: boolean;
  /** How many runs it has, once read. */
  runs: number | undefined;
  paused: boolean;
  /** Whether the reader may pause and resume it: a builder, not Grasp staff. */
  pauses: boolean;
  builder: boolean;
  /** Its draft, for its builders, as read last. */
  draft: Draft | undefined;
  /** Whom it is shared with, for its builders, once read. */
  members: readonly SubjectMember[] | undefined;
  /** Whether Grasp works on it, or checks it. */
  running: boolean;
  /** Whether it is shared and has changes only its builders see. */
  pending: boolean;
  onChange: (changed: WorkflowResource) => void;
  /** Shows what it may reach, in its Settings' Files and apps. */
  onFiles: () => void;
  /** Opens a run Run started, beside its runs. */
  onOpenRun: (id: string) => void;
  onShared: () => void;
}) => {
  const live = resource.currentVersion;
  const label = workflowLabel(resource);
  return (
    <ItemBar
      actions={
        <>
          <StartIndependentRun
            live={live}
            onFiles={onFiles}
            onOpenRun={onOpenRun}
            workflow={resource.id}
          />
          {pauses ? (
            <PauseControl
              live={live}
              name={label}
              onChange={onChange}
              paused={paused}
              workflow={resource.id}
            />
          ) : null}
          {builder ? (
            <ShareWithTeam
              draft={draft}
              members={members ?? []}
              onShared={onShared}
              pending={pending}
              running={running}
              shared={{
                subject: { kind: "workflow", id: resource.id },
                name: label,
                owner: resource.owner,
                live,
              }}
            />
          ) : null}
        </>
      }
      back={back}
      name={label}
      state={
        <WorkflowStatus
          admin={admin}
          blocked={blocked}
          builder={builder}
          live={live}
          paused={paused}
          who={members === undefined ? undefined : memberNames(members)}
        />
      }
      views={
        <ViewSwitch
          flow={flow}
          runs={runs}
          view={view}
          workflow={resource.id}
        />
      }
    />
  );
};

const WorkflowResourceView = ({
  back,
  view: asked,
  section,
  run,
  handedOver,
  ...read
}: WorkflowPageRead & {
  back: Crumb;
  /** The view the address asks for, if any. */
  view: WorkflowView | undefined;
  section: WorkflowSettingsSection | undefined;
  /** On Runs, the run the address asks to open. */
  run: string | undefined;
  /** The chat the person came from, building it in Chat. */
  handedOver: string | undefined;
}) => {
  const { resource, draft, runs, activity, names, admin } = read;
  const navigate = useNavigate();
  const builder = resource.role === "builder";
  // What its builders build: none for anyone else.
  const built = builder
    ? ({ kind: "workflow", id: resource.id } as const)
    : undefined;
  const view = shownView(asked, draft !== undefined);
  const label = workflowLabel(resource);
  // Grasp's chat about it, docked beside it for its builders, draws it.
  const chat = useChatAbout(built, label);
  const { draft: shared, reread } = useDraft(built, chat.worked);
  const { draft: latest, onDraft } = useWorkflowDraft(
    resource.id,
    draft,
    shared?.revision
  );
  const [shares, setShares] = useState(0);
  // Whom it is shared with, for one who builds it; none for anyone else.
  const members = useMembers(built, shares);
  const { paused, pauses, onChange } = usePaused(resource, read.identity);
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
  /** Runs, with `id` open beside the list; none closes it. */
  const runAt = (id?: string): void => {
    void navigate({
      to: "/workflows/$workflow",
      params: { workflow: resource.id },
      search: (held) => ({
        project: held.project,
        view: "runs",
        ...(id === undefined ? {} : { run: id }),
      }),
    });
  };
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
      <ItemShell bar={<SettingUpBar back={back} name={label} />}>
        {/* What the person calls it: its chat's title, which the plan
          named, as its own name is one for good, in core's letters. */}
        <SettingUp failed={setUp === "failed"} name={chat.title ?? label} />
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
          admin={read.approves}
          back={back}
          blocked={read.blocked}
          builder={builder}
          draft={shared}
          flow={draft !== undefined}
          members={members}
          onChange={onChange}
          onFiles={() => {
            settingsAt("files");
          }}
          onOpenRun={runAt}
          onShared={() => {
            reread();
            setShares((before) => before + 1);
          }}
          pending={unpublished}
          resource={resource}
          running={chat.busy}
          paused={paused}
          pauses={pauses}
          runs={runs.state === "ready" ? runs.data.length : undefined}
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
        <div {...stylex.props(view === "flow" ? styles.flow : styles.away)}>
          {draft.state === "ready" ? (
            <WorkflowFlow
              draft={latest ?? draft.data}
              onDefinition={() => {
                settingsAt("definition");
              }}
              onDraft={onDraft}
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
      <div {...stylex.props(view === "runs" ? styles.runs : styles.away)}>
        <RunsView
          activity={activity}
          admin={admin}
          builder={builder}
          name={label}
          names={names}
          onCloseRun={() => {
            runAt();
          }}
          openRun={run}
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
            onDraft,
            savedAt: shared?.updatedAt ?? null,
          }}
          section={section}
        />
      ) : null}
    </ItemShell>
  );
};

/** People's names by ID, and whether they name every member. */
interface People {
  people: ReadonlyMap<string, string>;
  everyone: boolean;
}

const noPeople: People = { people: new Map(), everyone: false };

/**
 * People's names by ID, for the names on runs and activity lines: read
 * beside the page rather than before it, "Someone else" standing in until
 * they come.
 */
const usePeople = (read: Promise<Loaded<People>>): People => {
  const [people, setPeople] = useState<People>(noPeople);
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
  const { view, section, run, chat } = Route.useSearch();
  const { t } = useLingui();
  const back = backCrumb({ label: t`Workflows`, to: "/workflows" }, project);
  if (resource.state !== "ready") {
    return (
      <PageNotLoaded
        crumbs={[back, { label: t`Workflow` }]}
        icon={WorkflowMark}
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
      names={{ ...people, me: identity.userId }}
      resource={resource.data}
      run={run}
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
  /** On Runs, the run open beside the list, by its ID. */
  run?: string;
  /**
   * The chat the person came from, building it in Grasp's chat: the page
   * makes it the workflow's. Core checks it is theirs on each read.
   */
  chat?: string;
}

/**
 * The workflow before it is read: the bar, its name to come, and the view
 * the address names. Its settings wait as cards; its flow and its runs
 * draw themselves in, as no skeleton has a canvas's shape, and who sees
 * which by default waits on the read.
 */
const WorkflowPending = () => {
  const { view } = Route.useSearch();
  return (
    <>
      <LoadingBar />
      <Fill>
        {view === "settings" ? (
          <SettingsPending sections={WORKFLOW_GENERAL} />
        ) : null}
      </Fill>
    </>
  );
};

export const Route = createFileRoute("/_shell/workflows/$workflow")({
  // Grasp's chat has no place here but its builders', about the workflow,
  // docked beside it (chat/chat-subject.ts).
  staticData: { chat: chatPresence.hidden, page: "fill" },
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
      ...(typeof search.run === "string" && search.run !== ""
        ? { run: search.run }
        : {}),
    };
  },
  pendingComponent: WorkflowPending,
  loaderDeps: ({ search: { project } }) => ({ project }),
  loader: async ({
    context: { core, identity },
    params: { workflow },
    deps: { project },
  }) => {
    // Names only, and not waited for: IDs stand in until they come.
    const people = loadFromCore(
      core,
      async (session): Promise<People> => await readWorkflowNames(session)
    );
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
      activity,
      inProject,
      triggers,
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
        async (session) => await session.workflowResources.activity(workflow)
      ),
      // The project it was started or opened from, for the way back.
      loadFromCore(
        core,
        async (session) => await readItemProject(session, project)
      ),
      // What starts it, for whether anything can: none where core doesn't
      // list them to the reader.
      loadFromCore(
        core,
        async (session) =>
          await session.workflowResources.triggers.list(workflow)
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
      activity,
      blocked: triggers.state === "ready" ? workflowBlock(triggers.data) : null,
      people,
      project: inProject.state === "ready" ? inProject.data : undefined,
    };
  },
  component: WorkflowResourcePage,
});
