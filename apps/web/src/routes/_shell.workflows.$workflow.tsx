import type { DecisionView } from "@grasp-os/shared/decisions";
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
import type { WorkflowTrigger } from "@grasp-os/shared/workflow-triggers";
import { Button } from "@grasp-os/ui/components/button";
import { Icon, WorkflowIcon } from "@grasp-os/ui/lib/icons";
import { duration, font, media, space } from "@grasp-os/ui/lib/tokens.stylex";
import { plural } from "@lingui/core/macro";
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
import type { Names } from "../workflows/activity-words.ts";
import { workflowBlock } from "../workflows/overview.ts";
import type { TriggerBlock } from "../workflows/overview.ts";
import { workflowSearchOf } from "../workflows/page-search.ts";
import type { WorkflowView } from "../workflows/page-search.ts";
import { readWorkflowNames, workflowVersions } from "../workflows/reads.ts";
import type { WorkflowSettingsSection } from "../workflows/settings-sections.ts";
import { StartIndependentRun } from "../workflows/start-run.tsx";
import { Traces } from "../workflows/traces.tsx";
import type { TracesPart } from "../workflows/traces.tsx";
import { useWorkflowDraft } from "../workflows/use-workflow-draft.ts";
import { WorkflowFlow } from "../workflows/workflow-flow.tsx";
import { WorkflowHome } from "../workflows/workflow-page.tsx";
import type { WorkshopRow, WorkshopView } from "../workflows/workflow-page.tsx";
import { WorkflowSettings } from "../workflows/workflow-settings.tsx";
import { PauseControl, WorkflowStatus } from "../workflows/workflow-status.tsx";

// One independent workflow (platform specification 13), as direction C
// (Track) has it. Its page (workflows/workflow-page.tsx): its name and where
// it stands, what waits on the reader, its runs, each opening its own page
// (routes/_shell.workflows.$workflow_.runs.$run.tsx), and for its builders
// their workshop: Run, Pause and Share with your team, the one lime action,
// in the bar, and a row for each tool that changes it, each opening its
// view under the workflow's crumb. Core decides who sees what: the draft is
// read only for builders, as it can hold a sensitive default.
//
// - Flow, for its builders, who read its draft: the definition drawn
//   (`workflow-flow.tsx`), filling the page, with Grasp's chat about it
//   docked beside (chat/chat-subject.ts), which draws it: the Flow follows
//   the draft as anyone writes it (`workflows/use-workflow-draft.ts`). Once it
//   is shared, a line under the bar says it has changes only its builders
//   see, with Undo, as an App's does.
// - Runs and tests, for its builders: every run, a test of the draft on
//   recent real items, and what happened to it lately (`traces.tsx`).
// - Settings (`workflow-settings.tsx`): everything else, a section at a
//   time, as an App's are, History among them; for anyone else too, a
//   button away in the bar.
//
// Run, in the bar, starts its live version by hand, in a dialog.

// The Flow comes in softly as it is shown again.
const fadeIn = stylex.keyframes({
  from: { opacity: 0 },
  to: { opacity: 1 },
});

const styles = stylex.create({
  // A view kept while another shows: its state stays.
  away: { display: "none" },
  // The canvas set in from the page's edges as the reference's shell sets
  // a page (28px above, 32px below, 24px at its sides): the frame's item
  // shell gives none of its own.
  flow: {
    // The text the reference's shell gives a page, which what isn't sized
    // itself inherits (the item shell here sets a smaller one).
    fontSize: font.textBase,
    lineHeight: font.textBaseLine,
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
    paddingBlockStart: space["7"],
    paddingBlockEnd: space["8"],
    paddingInline: space["6"],
    animationName: { default: fadeIn, [media.reducedMotion]: "none" },
    animationDuration: duration.open,
    animationTimingFunction: duration.ease,
  },
  // The room below the reference's shell gives a page stands outside what
  // scrolls, so the runs stop short of the card's foot.
  runs: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
    paddingBlockEnd: space["8"],
  },
  runsScroll: { flexGrow: 1, minHeight: 0, overflowY: "auto" },
  // As wide as the page, with the room round it the reference's shell
  // gives a page: the frame's item shell here gives none of its own.
  column: {
    // The text the reference's shell gives a page, which what isn't sized
    // itself inherits (the item shell here sets a smaller one).
    fontSize: font.textBase,
    lineHeight: font.textBaseLine,
    boxSizing: "border-box",
    width: "100%",
    paddingBlockStart: `calc(${space["7"]} + ${space["6"]})`,
    paddingInline: space["6"],
  },
  // Where it stands gives way where the bar is narrow, as on the
  // reference, whose shell sets the bar 48px narrower than this one (48rem there).
  state: {
    display: {
      default: "inline-flex",
      "@container bar (width < 51rem)": "none",
    },
    // In the bar's small words, its "Allow it" too, as #2503's bar draws them.
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
  },
});

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

/**
 * The view the page shows: the one asked for, but Flow and Runs and tests
 * only for its builders; anyone else, and anyone who asked for none, has
 * its page.
 */
const shownView = (
  asked: WorkflowView | undefined,
  builder: boolean
): WorkflowView | undefined =>
  asked === "settings" || builder ? asked : undefined;

/** What the workflow's page read. */
interface WorkflowPageRead {
  resource: WorkflowResource;
  draft: Loaded<WorkflowDraft> | undefined;
  versions: Loaded<WorkflowResourceVersion[]>;
  params: Loaded<WorkflowParams>;
  /** What it keeps between runs, for its builders and admins only. */
  state: Loaded<WorkflowState> | undefined;
  runs: Loaded<WorkflowResourceRun[]>;
  /** The answers its runs wait for that the reader may give. */
  decisions: DecisionView[];
  /** What starts it, where the reader manages its triggers. */
  triggers: Loaded<WorkflowTrigger[]> | undefined;
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

/** What each builder view is called, in the trail after the workflow's name. */
const useViewNames = () => {
  const { t } = useLingui();
  return {
    flow: t({
      message: "Steps",
      context: "a workflow's steps, drawn as a flow",
    }),
    runs: t({
      message: "Runs and tests",
      context: "a workflow's builder view",
    }),
    settings: t({ message: "Settings", context: "a workflow's view" }),
  } satisfies Record<WorkflowView, string>;
};

/**
 * Its bar: the trail to it, and past it to the view open; where it stands
 * (on a view: its page says it under its name); Run, Settings for anyone
 * who doesn't build it, Pause, and, for its builders, Share with your team,
 * the one lime action.
 */
const WorkflowBar = ({
  resource,
  blocked,
  admin,
  back,
  view,
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
  /** The view open; none on its page. */
  view: WorkflowView | undefined;
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
  /** Opens the page of a run Run started. */
  onOpenRun: (id: string) => void;
  onShared: () => void;
}) => {
  const { t } = useLingui();
  const viewNames = useViewNames();
  const live = resource.currentVersion;
  const label = workflowLabel(resource);
  const crumbs: Crumb[] =
    view === undefined
      ? [back, { label }]
      : [
          back,
          {
            label,
            to: "/workflows/$workflow",
            params: { workflow: resource.id },
          },
          { label: viewNames[view] },
        ];
  return (
    <ItemBar
      actions={
        <>
          {builder || view === "settings" ? null : (
            <Button asChild size="sm" variant="ghost">
              <Link
                params={{ workflow: resource.id }}
                search={(held) => ({
                  project: held.project,
                  view: "settings",
                })}
                to="/workflows/$workflow"
              >
                {t({ message: "Settings", context: "a workflow's view" })}
              </Link>
            </Button>
          )}
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
      crumbs={crumbs}
      headed={view === undefined}
      name={label}
      state={
        view === undefined ? undefined : (
          <span {...stylex.props(styles.state)}>
            <WorkflowStatus
              admin={admin}
              blocked={blocked}
              builder={builder}
              live={live}
              paused={paused}
              who={members === undefined ? undefined : memberNames(members)}
            />
          </span>
        )
      }
    />
  );
};

/**
 * Its builders' workshop on its page: a row for each tool that changes it,
 * in a line from what the page read.
 */
const useWorkshop = (
  read: Pick<WorkflowPageRead, "resource" | "versions" | "triggers">,
  draft: WorkflowDraft | undefined
): WorkshopRow[] => {
  const { t } = useLingui();
  const steps = draft?.diagram?.tasks.length;
  const viewNames = useViewNames();
  const live = read.resource.currentVersion;
  const triggers =
    read.triggers?.state === "ready" ? read.triggers.data.length : undefined;
  const versions =
    read.versions.state === "ready"
      ? read.versions.data.filter(({ label }) => label !== null).length
      : undefined;
  let stepsLine: string;
  if (steps === undefined) {
    stepsLine =
      live === null ? t`Not published yet.` : t`Version ${live} is live.`;
  } else if (live === null) {
    stepsLine = t`${plural(steps, { one: "# step, drawn as a flow. Not published yet.", other: "# steps, drawn as a flow. Not published yet." })}`;
  } else {
    stepsLine = t`${plural(steps, { one: `# step, drawn as a flow. Version ${live} is live.`, other: `# steps, drawn as a flow. Version ${live} is live.` })}`;
  }
  return [
    {
      id: "steps",
      title: viewNames.flow,
      description: stepsLine,
      to: { view: "flow" },
    },
    {
      id: "triggers",
      title: t({ message: "What starts it", context: "a workflow's triggers" }),
      description:
        triggers === undefined || triggers === 0
          ? t`Run by hand.`
          : t`${plural(triggers, { one: "# trigger, and Run by hand.", other: "# triggers, and Run by hand." })}`,
      to: { view: "settings", section: "triggers" },
    },
    {
      id: "files",
      title: t({
        message: "Files and apps",
        context: "what a workflow may reach",
      }),
      description: t`What it may read and change, and who allowed it.`,
      to: { view: "settings", section: "files" },
    },
    {
      id: "runs",
      title: viewNames.runs,
      description: t`Every run, a test of your draft on recent items, and what happened lately.`,
      to: { view: "runs" },
    },
    {
      id: "versions",
      title: t({
        message: "Versions",
        context: "a workflow's published versions",
      }),
      description:
        versions === undefined || versions === 0
          ? t`None published yet.`
          : t`${plural(versions, { one: "# published.", other: "# published." })}`,
      to: { view: "settings", section: "history" },
    },
    {
      id: "settings",
      title: viewNames.settings,
      description: t`Its name, who it's shared with, its parameters and its definition.`,
      to: { view: "settings", section: "general" },
    },
  ];
};

/** Its draft, once read. */
const readyOf = (
  draft: Loaded<WorkflowDraft> | undefined
): WorkflowDraft | undefined =>
  draft?.state === "ready" ? draft.data : undefined;

/**
 * Its builders' views: the Flow and Runs and tests, each kept while
 * another view shows, so the Flow's zoom and layout stay and a test going
 * on stays followed.
 */
const BuilderViews = ({
  view,
  draft,
  latest,
  onDraft,
  open,
  workflow,
  runs,
  activity,
  names,
}: {
  view: WorkflowView | undefined;
  draft: Loaded<WorkflowDraft> | undefined;
  /** Its draft as written last, on this page. */
  latest: WorkflowDraft | undefined;
  onDraft: (draft: WorkflowDraft) => void;
  open: (to: WorkshopView) => void;
  workflow: string;
  runs: Loaded<WorkflowResourceRun[]>;
  activity: Loaded<WorkflowActivity[]>;
  names: Names;
}) => {
  const [part, setPart] = useState<TracesPart>("runs");
  return (
    <>
      {/* Kept while another view shows: its zoom and layout stay. */}
      {draft === undefined ? null : (
        <div {...stylex.props(view === "flow" ? styles.flow : styles.away)}>
          {draft.state === "ready" ? (
            <WorkflowFlow
              draft={latest ?? draft.data}
              onDefinition={() => {
                open({ view: "settings", section: "definition" });
              }}
              onDraft={onDraft}
              onTriggers={() => {
                open({ view: "settings", section: "triggers" });
              }}
              workflow={workflow}
            />
          ) : (
            <NotLoadedState page={draft} />
          )}
        </div>
      )}
      {/* Kept while another view shows: a test going on stays followed. */}
      <div {...stylex.props(view === "runs" ? styles.runs : styles.away)}>
        <div {...stylex.props(styles.runsScroll)}>
          <div {...stylex.props(styles.column)}>
            <Traces
              activity={activity}
              names={names}
              onPartChange={setPart}
              part={part}
              runs={runs}
              testable={testableOf(latest)}
              workflow={workflow}
            />
          </div>
        </div>
      </div>
    </>
  );
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
  const { resource, draft, runs, activity, names } = read;
  const navigate = useNavigate();
  const builder = resource.role === "builder";
  // What its builders build: none for anyone else.
  const built = builder
    ? ({ kind: "workflow", id: resource.id } as const)
    : undefined;
  const view = shownView(asked, builder);
  const label = workflowLabel(resource);
  // Grasp's chat about it, docked beside its Flow for its builders, draws it.
  const chat = useChatAbout(view === "flow" ? built : undefined, label);
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
  const workshop = useWorkshop(read, latest ?? readyOf(draft));
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
  const openRun = (id: string): void => {
    void navigate({
      to: "/workflows/$workflow/runs/$run",
      params: { workflow: resource.id, run: id },
    });
  };
  const open = (to: WorkshopView): void => {
    void navigate({
      to: "/workflows/$workflow",
      params: { workflow: resource.id },
      search: (held) => ({ project: held.project, ...to }),
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
          members={members}
          onChange={onChange}
          onFiles={() => {
            open({ view: "settings", section: "files" });
          }}
          onOpenRun={openRun}
          onShared={() => {
            reread();
            setShares((before) => before + 1);
          }}
          pending={unpublished}
          resource={resource}
          running={chat.busy}
          paused={paused}
          pauses={pauses}
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
      {view === undefined ? (
        <WorkflowHome
          builder={builder}
          decisions={read.decisions}
          name={label}
          names={names}
          onOpen={open}
          runs={runs}
          status={
            <WorkflowStatus
              admin={read.approves}
              blocked={read.blocked}
              builder={builder}
              live={live}
              paused={paused}
              who={members === undefined ? undefined : memberNames(members)}
            />
          }
          workflow={resource.id}
          workshop={workshop}
        />
      ) : null}
      {builder ? (
        <BuilderViews
          activity={activity}
          draft={draft}
          latest={latest}
          names={names}
          onDraft={onDraft}
          open={open}
          runs={runs}
          view={view}
          workflow={resource.id}
        />
      ) : null}
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

/** People's names by ID. */
interface People {
  people: ReadonlyMap<string, string>;
}

const noPeople: People = { people: new Map() };

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
  const { view, section, chat } = Route.useSearch();
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
      names={{ people: people.people, me: identity.userId }}
      resource={resource.data}
      section={section}
      view={view}
    />
  );
};

/** A workflow's mark, where a page says it wasn't found. */
const WorkflowMark = () => <Icon icon={WorkflowIcon} />;

export const Route = createFileRoute("/_shell/workflows/$workflow")({
  // Grasp's chat has no place here but its builders', about the workflow,
  // docked beside its Flow (chat/chat-subject.ts).
  staticData: { chat: chatPresence.hidden },
  validateSearch: workflowSearchOf,
  pendingComponent: PageLoading,
  loaderDeps: ({ search: { project } }) => ({ project }),
  loader: async ({
    context: { core, identity },
    params: { workflow },
    deps: { project },
  }) => {
    // Names only, and not waited for: "Someone else" stands in until they come.
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
    // What starts it, for whether anything can: only where the reader
    // manages its triggers, its builders and the organization's admins.
    // Core lists anyone else their own alone, which says nothing of it.
    const triggersRead = async (): Promise<
      Loaded<WorkflowTrigger[]> | undefined
    > => {
      const read = await resourceRead;
      return read.state === "ready" &&
        (read.data.role === "builder" || isAdmin(identity.role))
        ? await loadFromCore(
            core,
            async (session) =>
              await session.workflowResources.triggers.list(workflow)
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
      waiting,
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
      triggersRead(),
      // The answers its runs wait for that the reader may give.
      loadFromCore(core, async (session) => await session.decisions.waiting()),
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
      decisions:
        waiting.state === "ready"
          ? waiting.data.filter(
              ({ workflowResource }) => workflowResource.id === workflow
            )
          : [],
      triggers,
      blocked:
        triggers?.state === "ready" ? workflowBlock(triggers.data) : null,
      people,
      project: inProject.state === "ready" ? inProject.data : undefined,
    };
  },
  component: WorkflowResourcePage,
});
