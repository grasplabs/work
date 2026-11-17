import type { AppDraft } from "@grasp-os/shared/app-drafts";
import type { App, AppMember, ViewedApp } from "@grasp-os/shared/apps";
import type { Identity } from "@grasp-os/shared/rpc";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { setActiveChat } from "../chat/active-chat.ts";
import { answeredAfterBuild } from "../chat/build-answered.ts";
import { chatLink } from "../chat/chat-link.ts";
import { slotOf, useChatSubject } from "../chat/chat-subject.ts";
import { useGlobalChat } from "../chat/global-chat.tsx";
import { ItemBar, ItemShell } from "../frame/item-shell.tsx";
import { LoadingLines } from "../frame/page-states.tsx";
import { SettingUp, SettingUpBar, Updating } from "../frame/setting-up.tsx";
import type { SetUp } from "../frame/setting-up.tsx";
import type { Crumb } from "../frame/site-header.tsx";
import { AppBuilding } from "../grasp/app-building/index.ts";
import { Banner } from "../grasp/banner/index.ts";
import { Button } from "../grasp/button/index.ts";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuPanel,
  DropdownMenuTrigger,
} from "../grasp/dropdown-menu/index.ts";
import { Empty } from "../grasp/empty/index.ts";
import {
  AppWindow,
  Archive,
  Chat,
  Expand,
  Link as LinkIcon,
  More,
  People,
  Sparkles,
} from "../grasp/icons/index.ts";
import type { IconData } from "../grasp/icons/index.ts";
import { Spinner } from "../grasp/spinner/index.ts";
import { TabsLink, TabsNav } from "../grasp/tabs/nav.tsx";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { PageFrame } from "../pages/page-frame.tsx";
import type { FrameFix } from "../pages/page-frame.tsx";
import { useVersionPushes } from "../pages/use-version-pushes.ts";
import { AppDataModel } from "./app-data-model.tsx";
import { AppData } from "./app-data.tsx";
import { ConfirmChange, useDraftChange } from "./app-history.tsx";
import type { Asked } from "./app-history.tsx";
import { AppLinkDialog } from "./app-own-link.tsx";
import { AppSettings, Read } from "./app-settings.tsx";
import type { AppSettingsSection } from "./app-settings.tsx";
import { readMembers, sharesApp } from "./app-sharing.tsx";
import { AppStart } from "./app-start.tsx";
import { StatusBadge, useStatusMove, userNames } from "./app-status.tsx";
import { DraftPreview } from "./draft-preview.tsx";
import { fixQuestion } from "./fix-with-grasp.ts";
import { dismissMadeTip, showsMadeTip } from "./made-tip.ts";
import { ChangesLine, ShareWithTeam, showsChangesLine } from "./publish.tsx";
import { hasChanges, useAppDraft } from "./use-app-draft.ts";
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
// your team, the page's one lime action (publish.tsx). The main area
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
// Share changes and Undo (publish.tsx). The chat's agent never shares.
// History, in Settings, steps the changes back and goes back to an
// earlier version (app-history.tsx); its Preview opens an undo point or a
// version here, read-only (`?point=`, `?version=`).

/** What the main area shows. */
export type WorkspaceView = "preview" | "code" | "data" | "settings";

/** What Preview, Code and Data show: the builders' version, or what the team sees. */
export type WorkspaceEnv = "draft" | "live";

/** An undo point of the draft, or a version, the preview shows read-only. */
export type ReadOnlyShown = { point: number } | { version: number };

/** What the preview shows, as a key: another starts it afresh. */
const shownKey = (shown: ReadOnlyShown | undefined): string => {
  if (shown === undefined) {
    return "draft";
  }
  return "point" in shown ? `point:${shown.point}` : `version:${shown.version}`;
};

const styles = stylex.create({
  // A state in place of the preview, on the page's soft ground.
  place: {
    display: "flex",
    flexGrow: 1,
    minHeight: 0,
    alignItems: "center",
    justifyContent: "center",
    padding: grasp.space6,
    backgroundColor: grasp.soft,
  },
  // The first build, filling the preview's place.
  building: {
    display: "flex",
    flexGrow: 1,
    minHeight: 0,
  },
  column: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
    minWidth: 0,
  },
  fill: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    minHeight: 0,
    minWidth: 0,
  },
  hidden: { display: "none" },
  // Over the preview: the first build, or a write that broke it mid-turn.
  over: {
    position: "absolute",
    inset: 0,
    display: "flex",
    flexDirection: "column",
  },
  stage: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
  },
  // Running unseen while Grasp sets it up, so it is there to fade in.
  frame: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
    opacity: 1,
    transitionProperty: {
      default: "opacity",
      "@media (prefers-reduced-motion: reduce)": "none",
    },
    transitionDuration: grasp.durationUi,
    transitionTimingFunction: grasp.ease,
  },
  unseen: { opacity: 0 },
  strip: { flexShrink: 0 },
  padded: { padding: grasp.space4 },
});

/** The switch's entries, in order. */
const views = ["preview", "code", "data", "settings"] as const;

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
    <TabsNav aria-label={t`Workspace views`} variant="segmented">
      {views.map((each) => (
        <TabsLink
          current={each === view}
          key={each}
          render={
            <Link
              // The App's own view has no `view` in its address: said
              // so, so the router's own match marks it only there.
              activeOptions={{ explicitUndefined: true }}
              params={{ app }}
              replace
              search={(held) => ({
                env: held.env,
                project: held.project,
                view: each === "preview" ? undefined : each,
              })}
              to="/apps/$app"
            />
          }
        >
          {labels[each]}
        </TabsLink>
      ))}
    </TabsNav>
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
  const navigate = useNavigate();
  const [linking, setLinking] = useState(false);
  const live = app.currentVersion !== null && !app.archived;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger icon={More} label={t`More`} variant="ghost" />
        <DropdownMenuPanel align="end">
          {app.archived ? null : (
            <DropdownMenuItem
              icon={LinkIcon}
              onSelect={() => {
                setLinking(true);
              }}
            >
              {t`Link`}
            </DropdownMenuItem>
          )}
          {live && changing ? (
            <DropdownMenuItem
              icon={People}
              onSelect={() => {
                void navigate({
                  from: "/apps/$app",
                  to: "/apps/$app",
                  params: { app: app.id },
                  replace: true,
                  search: (held) => ({ project: held.project, env: "live" }),
                });
              }}
            >
              {t`See what your team sees`}
            </DropdownMenuItem>
          ) : null}
          {live ? (
            <DropdownMenuItem
              icon={Expand}
              onSelect={() => {
                // Outside the shell: a document of its own.
                window.location.assign(`/apps/${app.id}/full`);
              }}
            >
              {t`Open full page`}
            </DropdownMenuItem>
          ) : null}
          {chatId === undefined ? null : (
            <DropdownMenuItem
              icon={Chat}
              onSelect={() => {
                void navigate(chatLink(chatId));
              }}
            >
              {t`Open the chat in Chat`}
            </DropdownMenuItem>
          )}
        </DropdownMenuPanel>
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
  draft: AppDraft | undefined;
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
              app={app}
              draft={draft}
              members={members ?? []}
              pending={pending}
              running={running}
              {...(onShared === undefined ? {} : { onShared })}
            />
          ) : null}
        </>
      }
      back={back}
      name={app.name}
      state={
        members === undefined && !archived ? undefined : (
          <StatusBadge app={app} who={userNames(members ?? [])} />
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
  kind = "empty",
}: {
  icon?: IconData;
  title: string;
  children: ReactNode;
  action?: ReactNode;
  kind?: "empty" | "error";
}) => (
  <div {...stylex.props(styles.place)}>
    <Empty
      {...(icon === undefined ? {} : { icon })}
      {...(action === undefined ? {} : { action })}
      kind={kind}
      title={title}
    >
      {children}
    </Empty>
  </div>
);

/**
 * Over the preview, once a call of it was refused as its test data
 * doesn't fit the draft's data model: core applies the change to the
 * test data only once it is reset (core's sealed-previews.ts), in Data.
 */
const StaleTestData = ({ app }: { app: string }) => {
  const { t } = useLingui();
  return (
    <Banner
      action={
        <Button
          render={
            <Link
              params={{ app }}
              replace
              search={(held) => ({ project: held.project, view: "data" })}
              to="/apps/$app"
            />
          }
          size="xs"
          variant="quiet"
        >
          {t`Open Data`}
        </Button>
      }
      layout={styles.strip}
      title={t`The example data doesn't fit the change`}
      tone="attention"
    >
      <Trans>
        Your change reshapes the App&apos;s data in a way the example records
        can&apos;t follow. Reset the example data in Data to try it. What your
        team entered isn&apos;t touched.
      </Trans>
    </Banner>
  );
};

/**
 * The first build: Grasp's cursors assembling an App in the preview's
 * place (Grasp UI's App building), until there is something to see.
 */
const FirstBuild = () => {
  const { t } = useLingui();
  return (
    <div {...stylex.props(styles.building)}>
      <AppBuilding
        aria-label={t`Grasp is building`}
        cursors={{
          layout: t({ message: "Layout", context: "who builds an app's look" }),
          data: t({ message: "Data", context: "who builds an app's data" }),
          copy: t({ message: "Words", context: "who writes an app's words" }),
        }}
        layout={styles.building}
        step={t`It shows here as soon as there is something to see.`}
      />
    </div>
  );
};

/** Whether the App has no page to preview yet: nothing written to it and no version. */
const hasNoPage = (app: App, draft: AppDraft): boolean =>
  draft.revision === 0 && app.currentVersion === null;

/**
 * An App with no page yet: Grasp building it, or, before anything was
 * asked, what it should do (app-start.tsx).
 */
const NoPageYet = ({ app, running }: { app: string; running: boolean }) =>
  running ? <FirstBuild /> : <AppStart app={app} />;

/** The label of the App's version `version`, read to name it. */
const useVersionLabel = (
  app: string,
  version: number | undefined
): string | undefined => {
  const read = useCoreRead(`${app}/${version ?? ""}`, async (session) =>
    version === undefined ? null : await session.apps.versions.get(app, version)
  );
  return read?.state === "ready" ? (read.data?.label ?? undefined) : undefined;
};

/** What the read-only preview shows: an earlier state, or a version by its label. */
const useShownTitle = (
  shown: ReadOnlyShown,
  label: string | undefined
): string => {
  const { t } = useLingui();
  if ("point" in shown) {
    return t`An earlier state, read-only`;
  }
  return label === undefined
    ? t`This version, read-only`
    : t`${label}, read-only`;
};

/**
 * Over the preview of an undo point or a version, read-only (`shown`):
 * what it is, the way back to the draft, and, for an undo point,
 * restoring it, once the person confirms.
 */
const ReadOnlyBar = ({
  draft,
  shown,
  onChanged,
}: {
  draft: AppDraft;
  shown: ReadOnlyShown;
  onChanged: () => void;
}) => {
  const { t } = useLingui();
  const navigate = useNavigate();
  const [asked, setAsked] = useState<Asked>();
  const label = useVersionLabel(
    draft.app,
    "version" in shown ? shown.version : undefined
  );
  const title = useShownTitle(shown, label);
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
    draft.app,
    draft.revision,
    () => {
      onChanged();
      back();
    }
  );
  return (
    <>
      <Banner
        action={
          <>
            {"point" in shown ? (
              <Button
                disabled={busy}
                onClick={() => {
                  setAsked({ kind: "restore", number: shown.point });
                }}
                size="xs"
                variant="quiet"
              >
                {t`Restore`}
              </Button>
            ) : null}
            <Button onClick={back} size="xs" variant="ghost">
              {t`Back to your version`}
            </Button>
          </>
        }
        layout={styles.strip}
        title={title}
        tone={failure === undefined ? "attention" : "danger"}
      >
        {failure}
      </Banner>
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
    </>
  );
};

/**
 * Over the main area while it shows what the team sees (`?env=live`,
 * from "See what your team sees"): what it is, and the way back.
 */
const TeamViewBar = ({ app }: { app: string }) => {
  const { t } = useLingui();
  return (
    <Banner
      action={
        <Button
          render={
            <Link
              from="/apps/$app"
              params={{ app }}
              replace
              search={(held) => ({
                view: held.view,
                project: held.project,
                env: undefined,
              })}
              to="/apps/$app"
            />
          }
          size="xs"
          variant="ghost"
        >
          {t`Back to your version`}
        </Button>
      }
      icon={People}
      layout={styles.strip}
      title={t`What your team sees`}
      tone="success"
    />
  );
};

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
    <Banner
      dismissLabel={t`Dismiss the tip`}
      icon={Sparkles}
      layout={styles.strip}
      onDismiss={() => {
        dismissMadeTip(app);
        setShown(false);
      }}
      title={t`This is your new App, with example data.`}
    >
      <Trans>
        Try it out: only you see it, and the example data is just for trying. To
        change anything, tell Grasp in the chat. When it&apos;s right, share it
        with your team.
      </Trans>
    </Banner>
  );
};

/** In the preview's place while a new App is set up: its first build, or that it isn't ready. */
const SetUpOver = ({ failed, name }: { failed: boolean; name: string }) => (
  <div {...stylex.props(styles.over)}>
    {failed ? <SettingUp failed name={name} /> : <FirstBuild />}
  </div>
);

/**
 * The main area's preview of the builders' working version: the App as
 * its draft has it, never the live App itself, while it has changes or
 * no version yet; an undo point or a version read-only when History
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
  draft: AppDraft | undefined;
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
      <div {...stylex.props(styles.place)}>
        <Spinner label={t`Loading…`} size="lg" />
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
    <div {...stylex.props(styles.stage)}>
      {shown === undefined ? null : (
        <ReadOnlyBar draft={draft} onChanged={onChanged} shown={shown} />
      )}
      {shown === undefined && ready ? (
        <>
          {/* Once Grasp is done: the example data it speaks of is there then. */}
          {running ? null : <MadeTip app={app.id} />}
          {staleAt === revision ? <StaleTestData app={app.id} /> : null}
        </>
      ) : null}
      {/* Running unseen while Grasp sets it up, so it is there to fade
        in once its first version runs; nothing of it reached before. */}
      <div
        inert={!ready}
        {...stylex.props(styles.frame, !ready && styles.unseen)}
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
      {ready ? null : <SetUpOver failed={setUp === "failed"} name={name} />}
      {/* Broken mid-turn: never the error while Grasp still works on it. */}
      {ready && running && failedAt === revision ? (
        <div {...stylex.props(styles.over)}>
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
      <PreviewState icon={AppWindow} title={t`Your team has nothing yet`}>
        <Trans>They see it once you share it with them.</Trans>
      </PreviewState>
    );
  }
  return (
    <section
      aria-label={t`${name}, as your team sees it`}
      {...stylex.props(styles.column)}
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
    <div {...stylex.props(styles.column)}>
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
  building?: AppDraft | undefined;
  /** The draft the Data view changes; none without one. */
  modelDraft?: ModelDraft;
}) => (
  <div {...stylex.props(styles.fill)}>
    <div {...stylex.props(view === "preview" ? styles.column : styles.hidden)}>
      {preview}
    </div>
    {view === "code" ? (
      <div {...stylex.props(styles.column)}>
        <Suspense
          fallback={
            <div {...stylex.props(styles.padded)}>
              <LoadingLines lines={6} />
            </div>
          }
        >
          <AppCode app={app} building={env === "live" ? undefined : building} />
        </Suspense>
      </div>
    ) : null}
    {view === "data" ? (
      <div {...stylex.props(styles.column)}>
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
  draft: AppDraft | undefined;
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

/**
 * Grasp's chat on App `app`, once it is (chat-subject.ts), and nothing of
 * the chat it showed before: its ID, whether its agent works on the App
 * (`running`), or checks it too (`busy`), and how often it wrote drafts,
 * which reads the App again as its build moves on (its name may change).
 */
const useAppChat = (app: string) => {
  const chat = useGlobalChat();
  const ours = chat.slot === slotOf({ kind: "app", id: app });
  const running = ours && chat.view.running;
  return {
    chatId: ours ? chat.chatId : undefined,
    running,
    busy: running || (ours && chat.view.checking),
    built:
      ours && answeredAfterBuild(chat.view.messages, { kind: "app", id: app }),
    draftChanges: chat.view.worked,
  };
};

/**
 * Reads the page again once the chat's agent stops, or its drafts change
 * after (`draftChanges`): during a turn they change at every write, and
 * its end reads anyway.
 */
const useReadAgainOnceBuilt = (running: boolean, draftChanges: number) => {
  const router = useRouter();
  const seen = useRef({ running, draftChanges });
  useEffect(() => {
    // Read again once the agent stops, or its drafts change after.
    const before = seen.current;
    seen.current = { running, draftChanges };
    // During a turn the drafts change at every write; its end reads anyway.
    const draftsMoved = !running && before.draftChanges !== draftChanges;
    if ((before.running && !running) || draftsMoved) {
      void router.invalidate();
    }
  }, [router, running, draftChanges]);
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
  const { chatId, running, busy, built, draftChanges } = useAppChat(app.id);
  const { draft, reread } = useAppDraft(app.id, draftChanges);
  const changing = hasChanges(draft);
  // Each reset of the test data in Data starts the preview afresh on it,
  // without the alert that it didn't fit.
  const [resets, setResets] = useState(0);
  useReadAgainOnceBuilt(running, draftChanges);
  useReadAgainOnNewBase(app, draft?.base);
  // Whom it is shared with: who uses it, and whom Share adds to.
  const membersRead = useAppRead(app.id, readMembers);
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
    showsChangesLine(app, draft, members ?? []);
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
        <ChangesLine
          app={app}
          draft={draft}
          onChanged={reread}
          running={busy}
        />
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
  const { t } = useLingui();
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
              <Button
                disabled={busy}
                onClick={() => {
                  move("restore");
                }}
                variant="quiet"
              >
                {t`Restore`}
              </Button>
            }
            icon={Archive}
            kind={failure === undefined ? "empty" : "error"}
            title={t`This App is archived`}
          >
            {failure ?? (
              <Trans>
                It is kept as it was, and nobody works on it. Restore it to
                change it again.
              </Trans>
            )}
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
  /** An undo point or a version the preview shows read-only, if asked. */
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
