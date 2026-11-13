import type { App, AppMember, ViewedApp } from "@grasp-os/shared/apps";
import type { Draft } from "@grasp-os/shared/drafts";
import type { Identity } from "@grasp-os/shared/rpc";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@grasp-os/ui/components/alert";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button, buttonVariants } from "@grasp-os/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import {
  ArchiveIcon,
  CodeIcon,
  DatabaseIcon,
  EyeIcon,
  LayoutGridIcon,
  LinkIcon,
  Maximize2Icon,
  MoreHorizontalIcon,
  PanelRightIcon,
  SettingsIcon,
  SparklesIcon,
  TriangleAlertIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { setActiveChat } from "../chat/active-chat.ts";
import { slotOf, useChatSubject } from "../chat/chat-subject.ts";
import { useChatAbout, useGlobalChat } from "../chat/global-chat.tsx";
import type { Session } from "../core.ts";
import { ConfirmChange, useDraftChange } from "../drafts/draft-history.tsx";
import type { Asked } from "../drafts/draft-history.tsx";
import {
  ShareWithTeam,
  showsUnpublishedChanges,
  UnpublishedChanges,
} from "../drafts/share-with-team.tsx";
import { memberNames, readMembers } from "../drafts/sharing.tsx";
import { hasChanges, useDraft } from "../drafts/use-draft.ts";
import { ErrorText } from "../error-text.tsx";
import {
  ItemBar,
  ItemShell,
  ItemSwitch,
  ItemSwitchLink,
} from "../frame/item-shell.tsx";
import { LoadingLines } from "../frame/page-states.tsx";
import { SettingUp, SettingUpBar, Updating } from "../frame/setting-up.tsx";
import type { SetUp } from "../frame/setting-up.tsx";
import type { Crumb } from "../frame/site-header.tsx";
import { PageFrame } from "../pages/page-frame.tsx";
import type { FrameFix } from "../pages/page-frame.tsx";
import { useVersionPushes } from "../pages/use-version-pushes.ts";
import { AppDataModel } from "./app-data-model.tsx";
import { AppData } from "./app-data.tsx";
import { AppLinkDialog } from "./app-own-link.tsx";
import { sharesApp } from "./app-role.ts";
import { AppSettings, Read } from "./app-settings.tsx";
import type { AppSettingsSection } from "./app-settings.tsx";
import { AppStart } from "./app-start.tsx";
import { StatusBadge, useStatusMove } from "./app-status.tsx";
import { DraftPreview } from "./draft-preview.tsx";
import { fixQuestion } from "./fix-with-grasp.ts";
import { dismissMadeTip, showsMadeTip } from "./made-tip.ts";
import { readTables, useAppRead } from "./use-app-read.ts";
import { useCoreRead } from "./use-core-read.ts";

// The Code view, with its renderer and highlighter, loads once it opens.
const AppCode = lazy(async () => {
  const { AppCode: code } = await import("./app-code.tsx");
  return { default: code };
});

// An App's workspace, where its builders change it, at the App's own
// address (/apps/$app): its people get the App itself there. One bar, the
// App's (frame/item-shell.tsx): back to the Apps, its name and where it
// stands in plain words ("Only you see this", or who uses it), then what
// the main area shows (Preview, Code, Data, Settings), "…" and Share with
// your team, the page's one lime action (drafts/share-with-team.tsx). The main area
// always shows the App: an App with no page yet asks what it should do
// (app-start.tsx), and one just made says what to do next, once
// (made-tip.ts).
// What the main area shows follows what only its builders see, on its
// own: while there are changes only they see (or the team has no version
// yet), their working version, the App as its draft has it, the compiled
// pages of core's draft, shared by all its builders, on example data they
// share; Data shows that example data, and Code the draft's files. With
// nothing only they see, exactly what the team sees: the App's current
// page, as the person, on its real data, as /apps/$app runs it; Data its
// real records, Code that version's files. The bar's state says which:
// "Only you see this", or the changes line under the bar while there are
// changes; otherwise who uses what is shown. With changes, "See what your
// team sees", under "…" (`?env=live`), shows the team's version instead,
// with a strip over it that leads back. The chat that builds it is Grasp's own (chat/global-chat.tsx),
// about this App (chat/chat-subject.ts): the App's chat, docked open
// beside the workspace.
//
// Sharing is what gives the team the changes: Share with your team asks
// who gets it and shares the changes with them in one step; once shared,
// a line under the bar says how many changes only its builders see, with
// Share changes and Undo (drafts/share-with-team.tsx). The chat's agent never shares.
// History, in Settings, steps the changes back and goes back to an
// earlier version (drafts/draft-history.tsx); its Preview opens a checkpoint or a
// version here, read-only (`?point=`, `?version=`).

/** What the main area shows. */
export type WorkspaceView = "preview" | "code" | "data" | "settings";

/** What Preview, Code and Data show: the builders' version, or what the team sees. */
export type WorkspaceEnv = "draft" | "live";

/** A checkpoint of the draft, or a version, the preview shows read-only. */
export type ReadOnlyShown = { point: number } | { version: number };

/** What the preview shows, as a key: another starts it afresh. */
const shownKey = (shown: ReadOnlyShown | undefined): string => {
  if (shown === undefined) {
    return "draft";
  }
  return "point" in shown ? `point:${shown.point}` : `version:${shown.version}`;
};

/** The switch's entries, in order. */
const views = [
  { view: "preview", icon: EyeIcon },
  { view: "code", icon: CodeIcon },
  { view: "data", icon: DatabaseIcon },
  { view: "settings", icon: SettingsIcon },
] as const;

/** Preview | Code | Data | Settings: links, so each is an address of its own. */
const ViewSwitch = ({ app, view }: { app: string; view: WorkspaceView }) => {
  const { t } = useLingui();
  const labels: Record<WorkspaceView, string> = {
    preview: t({ message: "App", context: "an app's workspace view" }),
    code: t({ message: "Code", context: "an app's workspace view" }),
    data: t({ message: "Data", context: "an app's workspace view" }),
    settings: t({ message: "Settings", context: "an app's workspace view" }),
  };
  return (
    <ItemSwitch label={t`Workspace views`}>
      {views.map(({ view: each, icon: Icon }) => (
        <ItemSwitchLink
          current={each === view}
          icon={<Icon data-icon="inline-start" />}
          key={each}
          label={labels[each]}
          renderLink={(look) => (
            <Link
              {...look}
              params={{ app }}
              replace
              search={(held) => ({
                env: held.env,
                project: held.project,
                ...(each === "preview" ? {} : { view: each }),
              })}
              to="/apps/$app"
            />
          )}
        />
      ))}
    </ItemSwitch>
  );
};

/**
 * The rest, under "…": the App's own link, what its team sees (here, and
 * at full size), and its chat on Chat.
 */
const MoreMenu = ({
  app,
  chatId,
  changing,
}: {
  app: App;
  chatId: string | undefined;
  /** Whether there are changes only its builders see, which the workspace shows. */
  changing: boolean;
}) => {
  const { t } = useLingui();
  const [linking, setLinking] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button aria-label={t`More`} size="icon-sm" variant="ghost" />
          }
        >
          <MoreHorizontalIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {app.archived ? null : (
            <DropdownMenuItem
              onClick={() => {
                setLinking(true);
              }}
            >
              <LinkIcon />
              <Trans>Link</Trans>
            </DropdownMenuItem>
          )}
          {app.currentVersion === null || app.archived || !changing ? null : (
            <DropdownMenuItem
              render={
                <Link
                  from="/apps/$app"
                  params={{ app: app.id }}
                  replace
                  search={(held) => ({
                    project: held.project,
                    env: "live" as const,
                  })}
                  to="/apps/$app"
                />
              }
            >
              <UsersIcon />
              <Trans>See what your team sees</Trans>
            </DropdownMenuItem>
          )}
          {app.currentVersion === null || app.archived ? null : (
            <DropdownMenuItem
              render={
                // Outside the shell: a document of its own.
                <a
                  aria-label={t`Open full page`}
                  href={`/apps/${app.id}/full`}
                />
              }
            >
              <Maximize2Icon />
              <Trans>Open full page</Trans>
            </DropdownMenuItem>
          )}
          {chatId === undefined ? null : (
            <DropdownMenuItem
              render={<Link search={{ chat: chatId }} to="/" />}
            >
              <PanelRightIcon />
              <Trans>Open the chat in Chat</Trans>
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <AppLinkDialog app={app} onOpenChange={setLinking} open={linking} />
    </>
  );
};

/** The workspace's bar: the App's one bar, with its views and Share with your team. */
const WorkspaceBar = ({
  app,
  back,
  view,
  identity,
  draft,
  members,
  running = false,
  pending = false,
  settingUp = false,
  chatId,
  onShared,
}: {
  app: ViewedApp;
  back: Crumb;
  view: WorkspaceView;
  identity: Pick<Identity, "staff">;
  /** The App's changes, as read last; none while they are read, or archived. */
  draft: Draft | undefined;
  /** Whom it is shared with; none while they are read. */
  members: readonly AppMember[] | undefined;
  /** Whether the chat's agent is at work on it, or checking it. */
  running?: boolean;
  /** Whether it is shared and has changes only its builders see. */
  pending?: boolean;
  /** Whether Grasp sets up a new App still (`SetUp`): its name alone, and Share off. */
  settingUp?: boolean;
  /** The App's chat; none while it is found, or for an archived App. */
  chatId?: string | undefined;
  /** Told once it was shared from here. */
  onShared?: () => void;
}) => {
  const { archived } = app;
  if (settingUp) {
    return <SettingUpBar back={back} name={app.name} />;
  }
  return (
    <ItemBar
      actions={
        <>
          <ViewSwitch app={app.id} view={view} />
          <MoreMenu app={app} changing={hasChanges(draft)} chatId={chatId} />
          {sharesApp(app, identity) ? (
            <ShareWithTeam
              draft={draft}
              members={members ?? []}
              pending={pending}
              running={running}
              shared={{
                subject: { kind: "app", id: app.id },
                name: app.name,
                owner: app.owner,
                live: app.currentVersion,
              }}
              {...(onShared === undefined ? {} : { onShared })}
            />
          ) : null}
        </>
      }
      back={back}
      name={app.name}
      state={
        members === undefined && !archived ? undefined : (
          <StatusBadge app={app} who={memberNames(members ?? [])} />
        )
      }
    />
  );
};

/** A state of the preview with nothing to preview: what it is, and what to do. */
const PreviewState = ({
  icon,
  title,
  children,
  action,
}: {
  icon: ReactNode;
  title: ReactNode;
  children: ReactNode;
  action?: ReactNode;
}) => (
  <div className="bg-muted flex min-h-0 flex-1 items-center justify-center p-6">
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
      {action === undefined ? null : <EmptyContent>{action}</EmptyContent>}
    </Empty>
  </div>
);

/**
 * Over the preview, once a call of it was refused as its test data
 * doesn't fit the draft's data model: core applies the change to the
 * test data only once it is reset (core's sealed-previews.ts), in Data.
 */
const StaleTestData = ({ app }: { app: string }) => (
  <div className="flex-none border-b p-3">
    <Alert variant="attention">
      <TriangleAlertIcon />
      <AlertTitle>
        <Trans>The example data doesn&apos;t fit the change</Trans>
      </AlertTitle>
      <AlertDescription>
        <Trans>
          Your change reshapes the App&apos;s data in a way the example records
          can&apos;t follow. Reset the example data in Data to try it. What your
          team entered isn&apos;t touched.
        </Trans>
      </AlertDescription>
      <AlertAction>
        <Link
          className={buttonVariants({ size: "sm", variant: "outline" })}
          params={{ app }}
          replace
          search={(held) => ({ project: held.project, view: "data" })}
          to="/apps/$app"
        >
          <Trans>Open Data</Trans>
        </Link>
      </AlertAction>
    </Alert>
  </div>
);

/** Whether the App has no page to preview yet: nothing written to it and no version. */
const hasNoPage = (app: App, draft: Draft): boolean =>
  draft.revision === 0 && app.currentVersion === null;

/**
 * An App with no page yet: Grasp building it, or, before anything was
 * asked, what it should do (app-start.tsx).
 */
const NoPageYet = ({ app, running }: { app: string; running: boolean }) => {
  const { t } = useLingui();
  return running ? (
    <PreviewState
      icon={<Spinner aria-label={t`Building…`} />}
      title={<Trans>Grasp is building</Trans>}
    >
      <Trans>It shows here as soon as there is something to see.</Trans>
    </PreviewState>
  ) : (
    <AppStart app={app} />
  );
};

/** The label of the App's version `version`, read to name it. */
const useVersionLabel = (
  app: string,
  version: number | undefined
): string | undefined => {
  const read = useCoreRead(`${app}/${version ?? ""}`, async (session) =>
    version === undefined
      ? null
      : await session.versions.get({ kind: "app", id: app }, version)
  );
  return read?.state === "ready" ? (read.data?.label ?? undefined) : undefined;
};

/** What the read-only preview shows: an earlier state, or a version by its label. */
const ShownBadge = ({
  shown,
  label,
}: {
  shown: ReadOnlyShown;
  label: string | undefined;
}) => {
  if ("point" in shown) {
    return <Trans>An earlier state, read-only</Trans>;
  }
  return label === undefined ? (
    <Trans>This version, read-only</Trans>
  ) : (
    <Trans>{label}, read-only</Trans>
  );
};

/**
 * Over the preview of a checkpoint or a version, read-only (`shown`):
 * what it is, the way back to the draft, and, for a checkpoint,
 * restoring it, once the person confirms.
 */
const ReadOnlyBar = ({
  draft,
  shown,
  onChanged,
}: {
  draft: Draft;
  shown: ReadOnlyShown;
  onChanged: () => void;
}) => {
  const navigate = useNavigate();
  const [asked, setAsked] = useState<Asked>();
  const label = useVersionLabel(
    draft.subject.id,
    "version" in shown ? shown.version : undefined
  );
  const back = (): void => {
    void navigate({
      to: ".",
      search: (held: Record<string, unknown>) => ({
        ...held,
        point: undefined,
        version: undefined,
      }),
      replace: true,
    });
  };
  const { busy, failure, change } = useDraftChange(
    draft.subject,
    draft.revision,
    () => {
      onChanged();
      back();
    }
  );
  return (
    <div className="flex flex-none flex-wrap items-center gap-2 border-b px-3 py-1.5">
      <Badge variant="attention">
        <ShownBadge label={label} shown={shown} />
      </Badge>
      <span className="flex-1" />
      <ErrorText>{failure}</ErrorText>
      <Button onClick={back} size="sm" variant="ghost">
        <Trans>Back to your version</Trans>
      </Button>
      {"point" in shown ? (
        <Button
          disabled={busy}
          onClick={() => {
            setAsked({ kind: "restore", number: shown.point });
          }}
          size="sm"
          variant="outline"
        >
          <Trans>Restore</Trans>
        </Button>
      ) : null}
      <ConfirmChange
        asked={asked}
        onCancel={() => {
          setAsked(undefined);
        }}
        onConfirm={(confirmed) => {
          setAsked(undefined);
          void change(confirmed);
        }}
      />
    </div>
  );
};

/**
 * Over the main area while it shows what the team sees (`?env=live`,
 * from "See what your team sees"): what it is, and the way back.
 */
const TeamViewBar = ({ app }: { app: string }) => (
  <div className="flex flex-none flex-wrap items-center gap-2 border-b px-3 py-1.5">
    <Badge variant="passed">
      <Trans>What your team sees</Trans>
    </Badge>
    <span className="flex-1" />
    <Link
      className={buttonVariants({ size: "sm", variant: "ghost" })}
      from="/apps/$app"
      params={{ app }}
      replace
      search={(held) => ({
        view: held.view,
        project: held.project,
        env: undefined,
      })}
      to="/apps/$app"
    >
      <Trans>Back to your version</Trans>
    </Link>
  </div>
);

/**
 * Over the preview of an App just made (made-tip.ts), until dismissed:
 * what it is, and what to do next.
 */
const MadeTip = ({ app }: { app: string }) => {
  const { t } = useLingui();
  const [shown, setShown] = useState(() => showsMadeTip(app));
  if (!shown) {
    return null;
  }
  return (
    <div className="flex-none border-b p-3">
      <Alert>
        <SparklesIcon />
        <AlertTitle>
          <Trans>This is your new App, with example data.</Trans>
        </AlertTitle>
        <AlertDescription>
          <Trans>
            Try it out: only you see it, and the example data is just for
            trying. To change anything, tell Grasp in the chat. When it&apos;s
            right, share it with your team.
          </Trans>
        </AlertDescription>
        <AlertAction>
          <Button
            aria-label={t`Dismiss the tip`}
            onClick={() => {
              dismissMadeTip(app);
              setShown(false);
            }}
            size="icon-sm"
            variant="ghost"
          >
            <XIcon />
          </Button>
        </AlertAction>
      </Alert>
    </div>
  );
};

/**
 * The main area's preview of the builders' working version: the App as
 * its draft has it, never the live App itself, while it has changes or
 * no version yet; a checkpoint or a version read-only when History
 * asked for one (`shown`). One frame throughout, so the chat's first
 * write, and each after it, comes into the App it shows in place. An App
 * with nothing written and no version asks what it should do instead.
 * What fails is said in the frame (page-frame.tsx), with Fix with Grasp,
 * which asks the App's chat.
 */
const PreviewArea = ({
  app,
  draft,
  shown,
  running,
  setUp,
  onFrame,
  onChanged,
}: {
  app: App;
  /** The App's draft; none until it is read. */
  draft: Draft | undefined;
  shown: ReadOnlyShown | undefined;
  running: boolean;
  /** Where a new App's first version stands: the preview shows once ready. */
  setUp: SetUp;
  /** Told each time its pages run, or failed to, at the draft's revision. */
  onFrame: (state: "running" | "failed", at: number) => void;
  /** Told once the draft changed here. */
  onChanged: () => void;
}) => {
  const { t } = useLingui();
  const chat = useGlobalChat();
  // The revision at which a call was refused as the test data doesn't fit.
  const [staleAt, setStaleAt] = useState<number>();
  // While Grasp builds it, a preview that failed (nothing to render yet,
  // or a write half done) starts again at the draft's next write, so it
  // shows the moment it works again: `tries` names each start.
  const [failedAt, setFailedAt] = useState<number>();
  const [tries, setTries] = useState(0);
  const { name } = app;
  // The draft is read first: the preview follows its revisions.
  if (draft === undefined) {
    return (
      <div className="bg-muted flex min-h-0 flex-1 items-center justify-center p-6">
        <Spinner aria-label={t`Loading…`} />
      </div>
    );
  }
  const { revision } = draft;
  const ready = setUp === "ready";
  const building = !ready || running;
  if (building && failedAt !== undefined && revision > failedAt) {
    setFailedAt(undefined);
    setTries(tries + 1);
  }
  // No page to preview: the App asks what it should do instead.
  if (ready && shown === undefined && hasNoPage(app, draft)) {
    return <NoPageYet app={app.id} running={running} />;
  }
  const fix: FrameFix = (failed, path) => {
    const message =
      failed.status === "failed" ? (failed.detail ?? failed.reason) : "";
    void chat.ask(
      fixQuestion(
        t`My version of the App didn't start. Find out why and fix it:`,
        [{ at: path, line: null, message }]
      )
    );
  };
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {shown === undefined ? null : (
        <ReadOnlyBar draft={draft} onChanged={onChanged} shown={shown} />
      )}
      {/* Once Grasp is done: the example data it speaks of is there then. */}
      {shown === undefined && ready && !running ? (
        <MadeTip app={app.id} />
      ) : null}
      {staleAt === revision && shown === undefined && ready ? (
        <StaleTestData app={app.id} />
      ) : null}
      {/* Running unseen while Grasp sets it up, so it is there to fade
        in once its first version runs; nothing of it reached before. */}
      <div
        className="flex min-h-0 flex-1 flex-col transition-opacity duration-300 data-[ready=false]:opacity-0 motion-reduce:transition-none"
        data-ready={ready}
        inert={!ready}
      >
        <DraftPreview
          app={app.id}
          draft={draft}
          key={tries}
          name={name}
          onEnded={(end) => {
            if (end.status === "failed") {
              setFailedAt(revision);
              onFrame("failed", revision);
            }
          }}
          onFix={fix}
          onRunning={() => {
            onFrame("running", revision);
          }}
          onTestDataStale={() => {
            setStaleAt(revision);
          }}
          shown={shown}
        />
      </div>
      {ready ? null : (
        <div className="absolute inset-0 flex flex-col">
          <SettingUp failed={setUp === "failed"} name={name} />
        </div>
      )}
      {/* Broken mid-turn: never the error while Grasp still works on it. */}
      {ready && running && failedAt === revision ? (
        <div className="absolute inset-0 flex flex-col">
          <Updating name={name} />
        </div>
      ) : null}
    </div>
  );
};

/**
 * The main area's preview of what the team sees: the App's current page,
 * as /apps/$app runs it, as the person, on its real data; nothing while
 * the team has no version. For its builders (`building`), a version with
 * no page (an App of workflows alone) asks what the App should do
 * instead, until the App's next version.
 */
const LivePreview = ({
  app,
  building,
}: {
  app: App;
  building?: { running: boolean };
}) => {
  const { t } = useLingui();
  const pushes = useVersionPushes([app.id])[app.id] ?? 0;
  // The version pushes after which core found no page to run.
  const [endedAt, setEndedAt] = useState<number>();
  const { name } = app;
  if (building !== undefined && endedAt === pushes) {
    return <NoPageYet app={app.id} running={building.running} />;
  }
  if (app.currentVersion === null) {
    return (
      <PreviewState
        icon={<LayoutGridIcon />}
        title={<Trans>Your team has nothing yet</Trans>}
      >
        <Trans>They see it once you share it with them.</Trans>
      </PreviewState>
    );
  }
  return (
    <section
      aria-label={t`${name}, as your team sees it`}
      className="bg-background flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <PageFrame
        app={app.id}
        bare
        embedded
        onEnded={(end) => {
          if (
            end.status === "failed" &&
            (end.reason === "not-running" || end.reason === "not-found")
          ) {
            setEndedAt(pushes);
          }
        }}
      />
    </section>
  );
};

/** The live App's tables, one at a time, and their records. */
const LiveData = ({ app }: { app: string }) => {
  const read = useAppRead(app, readTables);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Read read={read}>
        {({ version, tables }) => (
          <AppData
            app={app}
            key={`${app}/${version ?? ""}`}
            tables={tables}
            version={version}
          />
        )}
      </Read>
    </div>
  );
};

/** Where the App's draft stands: what the Data view changes. */
interface ModelDraft {
  /** The draft's revision: 0 before its first write. */
  revision: number;
  /** Whether the chat's agent is at work, writing the draft still. */
  running: boolean;
  /** Told once the Data view changed the draft. */
  onChanged: () => void;
  /** Told once the Data view reset the test data. */
  onTestDataReset: () => void;
}

/**
 * The App's data, for its builders: in Draft, its data model, changed in
 * the App's draft (`modelDraft`), each table with its test records; in
 * Live, or without a draft to change it in (an archived App), its live
 * tables' records.
 */
const DataArea = ({
  app,
  env,
  modelDraft,
}: {
  app: string;
  env: WorkspaceEnv;
  modelDraft: ModelDraft | undefined;
}) =>
  modelDraft === undefined || env === "live" ? (
    <LiveData app={app} />
  ) : (
    <AppDataModel app={app} key={app} {...modelDraft} />
  );

/** What the main area holds besides the preview, which stays (hidden) so it doesn't load again. */
const MainArea = ({
  app,
  view,
  env,
  section,
  identity,
  preview,
  building,
  modelDraft,
}: {
  app: ViewedApp;
  view: WorkspaceView;
  env: WorkspaceEnv;
  section: AppSettingsSection | undefined;
  identity: Identity;
  preview: ReactNode;
  /** The App's draft the preview shows, which the code shows too. */
  building?: Draft | undefined;
  /** The draft the Data view changes; none without one. */
  modelDraft?: ModelDraft;
}) => (
  <div className="flex h-full min-h-0 min-w-0 flex-col">
    <div
      className={view === "preview" ? "flex min-h-0 flex-1 flex-col" : "hidden"}
    >
      {preview}
    </div>
    {view === "code" ? (
      <div className="flex min-h-0 flex-1 flex-col">
        <Suspense
          fallback={
            <div className="p-4">
              <LoadingLines lines={6} />
            </div>
          }
        >
          <AppCode app={app} building={env === "live" ? undefined : building} />
        </Suspense>
      </div>
    ) : null}
    {view === "data" ? (
      <div className="flex min-h-0 flex-1 flex-col">
        <DataArea app={app.id} env={env} modelDraft={modelDraft} />
      </div>
    ) : null}
    {view === "settings" ? (
      <AppSettings
        app={app}
        identity={identity}
        section={section}
        within="workspace"
      />
    ) : null}
  </div>
);

/**
 * Whether the workspace shows what the team sees: unless there is
 * something only its builders see (changes, or no version of the team's
 * yet). Asked for (`?env=live`), it shows over the changes, with the way
 * back. An earlier state or version History opened shows as asked; while
 * the draft is read, nothing is decided yet.
 */
const showsTeams = ({
  app,
  draft,
  env,
  shown,
}: {
  app: App;
  draft: Draft | undefined;
  env: WorkspaceEnv;
  shown: ReadOnlyShown | undefined;
}): boolean => {
  if (shown !== undefined) {
    return false;
  }
  if (env === "live") {
    return true;
  }
  return (
    app.currentVersion !== null && draft !== undefined && !hasChanges(draft)
  );
};

/** The preview's frame, as it last said, at the draft's revision. */
interface FrameAt {
  app: string;
  state: "running" | "failed";
  at: number;
}

/**
 * Where a new App's first version stands, from what the page sees now, so
 * a reload lands where it was: while Grasp builds a new App (no version
 * yet) for the first time, it is being set up; once Grasp is done, what it
 * made shows, or, its preview failed at the draft's revision, a calm
 * "isn't ready yet" with Try again. Running once, it stays ready: a later
 * change that breaks it shows as any change does. Never waiting on what
 * may not come: nothing but Grasp's own turn holds the setting-up screen,
 * and only once Grasp's turn after its Build it ended (`built`) does it
 * say it isn't ready: a builder's own first steps (a table in Data) are
 * theirs to go on with.
 */
const useSetUp = ({
  app,
  shown,
  busy,
  built,
  revision,
}: {
  app: App;
  shown: ReadOnlyShown | undefined;
  busy: boolean;
  /** Whether Grasp answered after the Build it that made the App. */
  built: boolean;
  revision: number;
}): {
  setUp: SetUp;
  onFrame: (state: "running" | "failed", at: number) => void;
} => {
  const [frame, setFrame] = useState<FrameAt>();
  const [readyApp, setReadyApp] = useState<string>();
  const ours = frame?.app === app.id ? frame : undefined;
  const ready = readyApp === app.id;
  if (ours?.state === "running" && !ready) {
    setReadyApp(app.id);
  }
  const onFrame = (state: "running" | "failed", at: number): void => {
    setFrame({ app: app.id, state, at });
  };
  const fresh = app.currentVersion === null && shown === undefined && !ready;
  if (fresh && busy) {
    return { setUp: "setting-up", onFrame };
  }
  const failed =
    fresh && built && ours?.state === "failed" && ours.at === revision;
  return { setUp: failed ? "failed" : "ready", onFrame };
};

/** Whom App `app` is shared with. */
const readAppMembers = async (session: Session, app: string) =>
  await readMembers(session, { kind: "app", id: app });

/**
 * Reads the page again once the chat's agent stops, or its drafts change
 * after (`worked`): during a turn they change at every write, and its end
 * reads anyway.
 */
const useReadAgainOnceBuilt = (running: boolean, worked: number) => {
  const router = useRouter();
  const seen = useRef({ running, worked });
  useEffect(() => {
    // Read again once the agent stops, or its drafts change after.
    const before = seen.current;
    seen.current = { running, worked };
    // During a turn the drafts change at every write; its end reads anyway.
    const draftsMoved = !running && before.worked !== worked;
    if ((before.running && !running) || draftsMoved) {
      void router.invalidate();
    }
  }, [router, running, worked]);
};

/**
 * Reads the App again once its draft moved onto another version than the
 * one the page read live (`base`): a builder elsewhere published, or rolled
 * back, so the page shows what is live now, as a fresh load would.
 */
const useReadAgainOnNewBase = (app: App, base: number | null | undefined) => {
  const router = useRouter();
  const live = app.currentVersion;
  useEffect(() => {
    if (base !== undefined && base !== live) {
      void router.invalidate();
    }
  }, [router, base, live]);
};

/**
 * The workspace with the App's chat (`chatId`, once found) beside it, and
 * the App's draft previewed.
 */
const Building = ({
  app,
  back,
  view,
  env,
  shown,
  section,
  identity,
}: {
  app: ViewedApp;
  back: Crumb;
  view: WorkspaceView;
  env: WorkspaceEnv;
  shown: ReadOnlyShown | undefined;
  section: AppSettingsSection | undefined;
  identity: Identity;
}) => {
  const { chatId, running, busy, built, worked } = useChatAbout({
    kind: "app",
    id: app.id,
  });
  const { draft, reread } = useDraft({ kind: "app", id: app.id }, worked);
  const changing = hasChanges(draft);
  // Each reset of the test data in Data starts the preview afresh on it,
  // without the alert that it didn't fit.
  const [resets, setResets] = useState(0);
  useReadAgainOnceBuilt(running, worked);
  useReadAgainOnNewBase(app, draft?.base);
  // Whom it is shared with: who uses it, and whom Share adds to.
  const membersRead = useAppRead(app.id, readAppMembers);
  const members = membersRead?.state === "ready" ? membersRead.data : undefined;
  const { setUp, onFrame } = useSetUp({
    app,
    shown,
    busy,
    built,
    revision: draft?.revision ?? 0,
  });
  const settingUp = setUp !== "ready";
  const theirs = showsTeams({ app, draft, env, shown });
  const showing: WorkspaceEnv = theirs ? "live" : "draft";
  const changesLine =
    !theirs &&
    sharesApp(app, identity) &&
    showsUnpublishedChanges(app.currentVersion, draft, members ?? []);
  return (
    <ItemShell
      bar={
        <WorkspaceBar
          app={app}
          back={back}
          chatId={chatId}
          draft={draft}
          identity={identity}
          members={members}
          onShared={reread}
          pending={changesLine}
          running={busy}
          settingUp={settingUp}
          view={view}
        />
      }
    >
      {env === "live" && changing ? <TeamViewBar app={app.id} /> : null}
      {changesLine && draft !== undefined ? (
        <UnpublishedChanges draft={draft} onChanged={reread} running={busy} />
      ) : null}
      <MainArea
        app={app}
        building={changing ? draft : undefined}
        env={showing}
        modelDraft={{
          revision: draft?.revision ?? 0,
          running,
          onChanged: reread,
          onTestDataReset: () => {
            setResets((before) => before + 1);
          },
        }}
        identity={identity}
        preview={
          theirs ? (
            <LivePreview app={app} building={{ running }} key="live" />
          ) : (
            <PreviewArea
              app={app}
              draft={draft}
              key={`${shownKey(shown)}/${resets}`}
              onChanged={reread}
              onFrame={onFrame}
              running={running}
              setUp={setUp}
              shown={shown}
            />
          )
        }
        section={section}
        // Setting up, there is only the App on its way to look at.
        view={settingUp ? "preview" : view}
      />
    </ItemShell>
  );
};

/** An archived App: kept as it was, with no chat to change it, until a builder restores it. */
const Archived = ({
  app,
  back,
  view,
  section,
  identity,
}: {
  app: ViewedApp;
  back: Crumb;
  view: WorkspaceView;
  section: AppSettingsSection | undefined;
  identity: Identity;
}) => {
  const { busy, failure, move } = useStatusMove(app.id);
  return (
    <ItemShell
      bar={
        <WorkspaceBar
          app={app}
          back={back}
          draft={undefined}
          identity={identity}
          members={undefined}
          view={view}
        />
      }
    >
      <MainArea
        app={app}
        env="draft"
        identity={identity}
        preview={
          <PreviewState
            action={
              <div className="flex flex-col items-center gap-2">
                <Button
                  disabled={busy}
                  onClick={() => {
                    move("restore");
                  }}
                  variant="outline"
                >
                  <Trans>Restore</Trans>
                </Button>
                <ErrorText>{failure}</ErrorText>
              </div>
            }
            icon={<ArchiveIcon />}
            title={<Trans>This App is archived</Trans>}
          >
            <Trans>
              It is kept as it was, and nobody works on it. Restore it to change
              it again.
            </Trans>
          </PreviewState>
        }
        section={section}
        view={view}
      />
    </ItemShell>
  );
};

/** Where the workspace is, as its address says (`/apps/$app`'s search). */
interface WorkspaceAt {
  app: ViewedApp;
  /** The way back: the Apps, or the project it was opened from. */
  back: Crumb;
  view: WorkspaceView;
  /** Draft or Live (`?env=live`): what Preview, Code and Data show. */
  env: WorkspaceEnv;
  /** A checkpoint or a version the preview shows read-only, if asked. */
  shown: ReadOnlyShown | undefined;
  section: AppSettingsSection | undefined;
  identity: Identity;
}

/**
 * The workspace of App `app`, for one who builds it: Grasp's chat is about
 * the App here, the App's chat, docked beside it; a chat handed over
 * (`handedOver`, building the App in Chat) becomes the App's.
 */
const Workspace = ({
  handedOver,
  ...at
}: WorkspaceAt & {
  /** The chat the person came from, building this App in Chat. */
  handedOver: string | undefined;
}) => {
  const { app } = at;
  useChatSubject({ kind: "app", id: app.id }, app.name);
  const navigate = useNavigate();
  useEffect(() => {
    if (handedOver === undefined) {
      return;
    }
    setActiveChat(handedOver, slotOf({ kind: "app", id: app.id }));
    // Carried on: the address no longer needs it.
    void navigate({
      to: ".",
      search: (held: Record<string, unknown>) => ({ ...held, chat: undefined }),
      replace: true,
    });
  }, [navigate, app.id, handedOver]);
  return <Building {...at} />;
};

/** The App's workspace, for one who builds it (`buildsApp`). */
export const AppWorkspace = ({
  handedOver,
  ...at
}: WorkspaceAt & {
  /** The chat the person came from, building this App in Chat. */
  handedOver: string | undefined;
}) =>
  at.app.archived ? (
    <Archived
      app={at.app}
      back={at.back}
      identity={at.identity}
      section={at.section}
      view={at.view}
    />
  ) : (
    <Workspace handedOver={handedOver} {...at} />
  );
