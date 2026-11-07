import type { App, ViewedApp } from "@grasp-os/shared/apps";
import type { ModelEfforts } from "@grasp-os/shared/models";
import type { Identity } from "@grasp-os/shared/rpc";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button, buttonVariants } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
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
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@grasp-os/ui/components/resizable";
import { Sheet, SheetContent, SheetTitle } from "@grasp-os/ui/components/sheet";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useRouter } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ArrowLeftIcon,
  ChevronDownIcon,
  CodeIcon,
  DatabaseIcon,
  EyeIcon,
  GlobeIcon,
  LayoutGridIcon,
  LinkIcon,
  MoreHorizontalIcon,
  PanelRightIcon,
  SendIcon,
  SettingsIcon,
} from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { appSlot, setActiveChat } from "../chat/active-chat.ts";
import {
  changesApp,
  draftsOf,
  PendingVersion,
  useChatBuilds,
} from "../chat/builds.tsx";
import type { NamedDraft } from "../chat/builds.tsx";
import { useFollowedChat } from "../chat/chat-watch.ts";
import { DraftVersionBar, shownVersion } from "../chat/draft-versions.tsx";
import type { ShownVersion } from "../chat/draft-versions.tsx";
import { DraftPreview } from "../chat/studio.tsx";
import { ErrorText } from "../error-text.tsx";
import { LoadingLines } from "../frame/page-states.tsx";
import { useWide } from "../frame/wide.ts";
import { useVersionPushes } from "../pages/use-version-pushes.ts";
import { useCoreAction } from "../use-core-action.ts";
import {
  AppChat,
  AppChatPending,
  useAppAsk,
  useAppChatId,
} from "./app-chat.tsx";
import type { ChatBuilding } from "./app-code.tsx";
import { AppDataModel } from "./app-data-model.tsx";
import { AppData } from "./app-data.tsx";
import { AppLinkDialog, linkAddress } from "./app-own-link.tsx";
import { AppSettings, Read } from "./app-settings.tsx";
import type { AppSettingsSection } from "./app-settings.tsx";
import { readMembers, sharesApp, ShareApp } from "./app-sharing.tsx";
import { StatusBadge, useStatusMove } from "./app-status.tsx";
import { readTables, useAppRead } from "./use-app-read.ts";

// The Code view, with its renderer and highlighter, loads once it opens.
const AppCode = lazy(async () => {
  const { AppCode: code } = await import("./app-code.tsx");
  return { default: code };
});

// An App's workspace, where its builders change it (/apps/$app/edit),
// apart from the App itself (/apps/$app), which its people use and which
// nothing here touches. A slim bar on top: back to the App, its name and
// where it stands, what the main area shows (Preview, Code, Data,
// Settings), the chat's panel, Share and Publish. The main area, by
// default, previews the App as the App's chat has it: the compiled pages
// of core's draft, which change nothing and read no real data; with no
// changes (none asked for yet, or proposed), the App's latest version, the
// one up for review included, built the same way, so builders always see
// the App and what they publish. The chat that builds it
// is docked on the right, its edge dragged to make it wider or narrower;
// on a narrow window it opens over the page.
//
// Publishing is what makes changes live. The chat's agent proposes its
// draft as the App's next version once it is done; Publish then reviews
// that version and makes it current (and, for an App never published,
// opens it to its people). While the draft isn't proposed yet, Publish
// proposes it as the person themselves (`chats.proposeDraft`, checked as
// the agent's proposal is), then reviews the version it became.

/** What the main area shows. */
export type WorkspaceView = "preview" | "code" | "data" | "settings";

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
    preview: t({ message: "Preview", context: "an app's workspace view" }),
    code: t({ message: "Code", context: "an app's workspace view" }),
    data: t({ message: "Data", context: "an app's workspace view" }),
    settings: t({ message: "Settings", context: "an app's workspace view" }),
  };
  return (
    <nav
      aria-label={t`Workspace views`}
      className="bg-muted flex flex-none gap-0.5 rounded-lg p-0.5"
    >
      {views.map(({ view: each, icon: Icon }) => (
        <Link
          aria-current={each === view ? "page" : undefined}
          className={buttonVariants({
            size: "sm",
            variant: each === view ? "outline" : "ghost",
          })}
          key={each}
          params={{ app }}
          replace
          // The chat handed over from Chat's studio stays with the person.
          search={(held) => ({
            chat: held.chat,
            ...(each === "preview" ? {} : { view: each }),
          })}
          to="/apps/$app/edit"
        >
          <Icon data-icon="inline-start" />
          <span className="max-sm:sr-only">{labels[each]}</span>
        </Link>
      ))}
    </nav>
  );
};

/** The chat's draft of the App, not proposed yet. */
interface UnproposedDraft {
  chatId: string;
  /** Whether the chat's agent is at work, writing it still. */
  running: boolean;
}

/**
 * Publish, for an App with no version up for review: a draft is published
 * for the people it is shared with, a published App goes back to a
 * draft, as core allows only for an App with a version to publish. With
 * the chat's draft not proposed yet (`draft`), Publish changes proposes
 * it as the person (core checks it first, and refuses it while its checks
 * fail: the chat says what fails, once asked to fix it), then
 * `onProposed` with the version it became, to review; off while the
 * chat's agent still writes it. Its link is set from here too.
 */
const PublishMenu = ({
  app,
  draft,
  onProposed,
}: {
  app: App;
  draft?: UnproposedDraft;
  onProposed?: (version: number) => void;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, failure, move } = useStatusMove(app.id);
  const proposing = useCoreAction();
  // One line says why: the action tried last, never an older one's.
  const [tried, setTried] = useState<"move" | "propose">("move");
  const [linking, setLinking] = useState(false);
  const published = app.status === "published";
  const versioned = app.currentVersion !== null;
  const message = t({
    message: "Changes published from the App's workspace",
    context: "a version's message",
  });
  const moveTo = (transition: "publish" | "unpublish"): void => {
    setTried("move");
    move(transition);
  };
  const propose = (chatId: string): void => {
    setTried("propose");
    void proposing.run(async (session) => {
      const version = await session.chats.proposeDraft(chatId, app.id, message);
      onProposed?.(version);
      await router.invalidate();
    });
  };
  return (
    <div className="flex flex-col items-end gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={
            busy || proposing.busy || (!versioned && draft === undefined)
          }
          render={<Button size="sm" />}
        >
          <GlobeIcon data-icon="inline-start" />
          {published ? <Trans>Published</Trans> : <Trans>Publish</Trans>}
          <ChevronDownIcon data-icon="inline-end" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          {published ? (
            <DropdownMenuItem
              onClick={() => {
                moveTo("unpublish");
              }}
            >
              <ArchiveIcon />
              <span className="flex flex-col">
                <Trans>Unpublish</Trans>
                <span className="text-muted-foreground text-xs">
                  <Trans>Back to a draft, for its builders alone</Trans>
                </span>
              </span>
            </DropdownMenuItem>
          ) : null}
          {draft === undefined ? null : (
            <DropdownMenuItem
              disabled={draft.running}
              onClick={() => {
                propose(draft.chatId);
              }}
            >
              <SendIcon />
              <span className="flex flex-col">
                <Trans>Publish changes</Trans>
                <span className="text-muted-foreground text-xs">
                  <Trans>Check what the chat built, then review it</Trans>
                </span>
              </span>
            </DropdownMenuItem>
          )}
          {!published && versioned ? (
            <DropdownMenuItem
              onClick={() => {
                moveTo("publish");
              }}
            >
              <GlobeIcon />
              <span className="flex flex-col">
                <Trans>Publish</Trans>
                <span className="text-muted-foreground text-xs">
                  <Trans>For the people it is shared with</Trans>
                </span>
              </span>
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            onClick={() => {
              setLinking(true);
            }}
          >
            <LinkIcon />
            <span className="flex min-w-0 flex-col">
              <Trans>Link</Trans>
              <span className="text-muted-foreground truncate text-xs">
                {app.link === null ? (
                  <Trans>None yet</Trans>
                ) : (
                  linkAddress(app.link)
                )}
              </span>
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ErrorText>{tried === "move" ? failure : proposing.failure}</ErrorText>
      <AppLinkDialog app={app} onOpenChange={setLinking} open={linking} />
    </div>
  );
};

/**
 * Publishing version `version`, up for review: what core says it
 * changes, then making it current (and publishing a draft App with it),
 * in a dialog.
 */
const PublishDialog = ({
  app,
  version,
  open,
  onOpenChange,
}: {
  app: App;
  version: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-2xl" closeLabel={t`Close`}>
        <DialogHeader>
          <DialogTitle>
            <Trans>Publish version {version}</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              What it changes, as Grasp checked it. Once made current, it is the
              live App for everyone who uses it.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        <PendingVersion
          app={app}
          // A newer proposal is a review of its own: nothing read for the
          // last one may stand for it, nor publish it.
          key={`${app.id}:${version}`}
          onDone={() => {
            onOpenChange(false);
            void router.invalidate();
          }}
          version={version}
        />
      </DialogContent>
    </Dialog>
  );
};

/**
 * Opening the review of version `version` up for review, and publishing
 * it: rendered only while one is, so its open state goes with it.
 */
const ReviewAndPublish = ({
  app,
  version,
  size,
  children,
}: {
  app: App;
  version: number;
  size?: "sm";
  children: ReactNode;
}) => {
  const [reviewing, setReviewing] = useState(false);
  return (
    <>
      <Button
        onClick={() => {
          setReviewing(true);
        }}
        size={size}
      >
        {children}
      </Button>
      <PublishDialog
        app={app}
        onOpenChange={setReviewing}
        open={reviewing}
        version={version}
      />
    </>
  );
};

/**
 * Publish: the version up for review, if there is one; otherwise the
 * App's status, and the chat's draft (`draft`), proposed first.
 */
const PublishAction = ({
  app,
  draft,
}: {
  app: App;
  /** The chat's draft of the App, not proposed yet; none without one. */
  draft: UnproposedDraft | undefined;
}) => {
  // The version just proposed here, reviewed at once: held here, so its
  // review stays open as the bar moves on to the version up for review.
  const [proposed, setProposed] = useState<number>();
  const pending = app.pendingVersion;
  return (
    <>
      {pending === null ? (
        <PublishMenu app={app} draft={draft} onProposed={setProposed} />
      ) : (
        <>
          {/* A published App can still go back to a draft, or get its link. */}
          {app.status === "published" ? <PublishMenu app={app} /> : null}
          <ReviewAndPublish app={app} size="sm" version={pending}>
            <GlobeIcon data-icon="inline-start" />
            <Trans>Publish version {pending}</Trans>
          </ReviewAndPublish>
        </>
      )}
      {proposed === undefined ? null : (
        <PublishDialog
          app={app}
          onOpenChange={(open) => {
            if (!open) {
              setProposed(undefined);
            }
          }}
          open
          version={proposed}
        />
      )}
    </>
  );
};

/** Share, for whoever may share the App: whom it is shared with is left out of its list. */
const ShareOnBar = ({ app }: { app: App }) => {
  const read = useAppRead(app.id, readMembers);
  return (
    <ShareApp app={app} members={read?.state === "ready" ? read.data : []} />
  );
};

/** The rest, under "…": the App itself, at full size too, and its chat on Chat. */
const MoreMenu = ({
  app,
  chatId,
}: {
  app: string;
  chatId: string | undefined;
}) => {
  const { t } = useLingui();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button aria-label={t`More`} size="icon-sm" variant="ghost" />}
      >
        <MoreHorizontalIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem render={<Link params={{ app }} to="/apps/$app" />}>
          <LayoutGridIcon />
          <Trans>Open the live App</Trans>
        </DropdownMenuItem>
        {chatId === undefined ? null : (
          <DropdownMenuItem
            render={<Link search={{ chat: chatId, panel: true }} to="/" />}
          >
            <PanelRightIcon />
            <Trans>Open the chat in Chat</Trans>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** The workspace's bar. */
const WorkspaceBar = ({
  app,
  view,
  identity,
  unpublished,
  running = false,
  chat,
}: {
  app: ViewedApp;
  view: WorkspaceView;
  identity: Pick<Identity, "staff">;
  /** Whether a draft with changes not yet live is being built. */
  unpublished: boolean;
  /** Whether the chat's agent is at work, writing it still. */
  running?: boolean;
  /** The chat's panel and its toggle; none for an archived App. */
  chat:
    | { open: boolean; handleToggle: () => void; chatId: string | undefined }
    | undefined;
}) => {
  const { t } = useLingui();
  const { name } = app;
  const archived = app.status === "archived";
  return (
    <div className="bg-background flex flex-none flex-wrap items-center gap-x-4 gap-y-2 border-b px-3 py-2">
      <span className="flex min-w-0 flex-1 basis-48 items-center gap-2">
        <Link
          aria-label={t`Back to ${name}`}
          className={buttonVariants({ size: "icon-sm", variant: "ghost" })}
          params={{ app: app.id }}
          title={t`Back to ${name}`}
          to="/apps/$app"
        >
          <ArrowLeftIcon />
        </Link>
        <h1 className="truncate text-base font-medium">{name}</h1>
        <StatusBadge status={app.status} />
        {unpublished ? (
          <Badge variant="attention">
            <Trans>Unpublished changes</Trans>
          </Badge>
        ) : null}
      </span>
      <ViewSwitch app={app.id} view={view} />
      <span className="flex flex-1 basis-48 items-center justify-end gap-2">
        {chat === undefined ? null : (
          <Button
            aria-label={t`Chat`}
            aria-pressed={chat.open}
            onClick={chat.handleToggle}
            size="icon-sm"
            title={t`Chat`}
            variant={chat.open ? "secondary" : "ghost"}
          >
            <PanelRightIcon />
          </Button>
        )}
        {sharesApp(app, identity) ? <ShareOnBar app={app} /> : null}
        {archived ? null : (
          <PublishAction
            app={app}
            draft={
              unpublished && chat?.chatId !== undefined
                ? { chatId: chat.chatId, running }
                : undefined
            }
          />
        )}
        <MoreMenu app={app.id} chatId={chat?.chatId} />
      </span>
    </div>
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

/** The version proposed, said to be ready, with the way to publish it. */
const ReadyToPublish = ({ app, version }: { app: App; version: number }) => (
  <PreviewState
    action={
      <ReviewAndPublish app={app} version={version}>
        <Trans>Review and publish</Trans>
      </ReviewAndPublish>
    }
    icon={<GlobeIcon />}
    title={<Trans>Version {version} is ready to publish</Trans>}
  >
    <Trans>
      Grasp finished these changes. Review what they change, then publish them
      to make them the live App.
    </Trans>
  </PreviewState>
);

/** Where the App stands, with no preview to show: its version up for review, or its live one. */
const Stands = ({ app }: { app: App }) => {
  const { pendingVersion, currentVersion } = app;
  if (pendingVersion !== null) {
    return <ReadyToPublish app={app} version={pendingVersion} />;
  }
  return (
    <PreviewState
      action={
        <Link
          className={buttonVariants({ variant: "outline" })}
          params={{ app: app.id }}
          to="/apps/$app"
        >
          <Trans>Open the live App</Trans>
        </Link>
      }
      icon={<EyeIcon />}
      title={<Trans>No unpublished changes</Trans>}
    >
      <Trans>
        Version {currentVersion} is live. Ask in the chat for a change: it shows
        here as a preview before anything goes live.
      </Trans>
    </PreviewState>
  );
};

/**
 * What the preview's top row says of what it shows: the draft's changes,
 * with its versions; otherwise the App's version the preview shows, as
 * core says (`shows`): up for review, with the way to publish it; live;
 * or neither. Nothing while the preview hasn't shown one yet.
 */
const PreviewBar = ({
  app,
  chatId,
  draft,
  shows,
  shown,
  onShow,
}: {
  app: App;
  chatId: string;
  /** The chat's draft, when it changes the App. */
  draft: NamedDraft | undefined;
  /** The App's version the preview shows, when it shows one. */
  shows: number | undefined;
  shown: number | undefined;
  onShow: (version?: number) => void;
}) => {
  const { pendingVersion, currentVersion } = app;
  let says: ReactNode = null;
  let action: ReactNode = null;
  if (draft !== undefined) {
    action = (
      <DraftVersionBar
        chatId={chatId}
        draft={draft.draft}
        onShow={onShow}
        shown={shown}
      />
    );
  } else if (shows !== undefined && shows === pendingVersion) {
    const version = shows;
    says = <Trans>Version {version} is ready to publish</Trans>;
    action = (
      <ReviewAndPublish app={app} size="sm" version={shows}>
        <Trans>Review and publish</Trans>
      </ReviewAndPublish>
    );
  } else if (shows !== undefined && shows === currentVersion) {
    const version = shows;
    says = <Trans>Version {version} is live</Trans>;
  } else if (shows !== undefined) {
    const version = shows;
    says = (
      <Trans>Version {version} isn&apos;t published or up for review</Trans>
    );
  }
  return (
    <div className="flex flex-none flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-2">
      <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
        {says}
      </span>
      {action}
    </div>
  );
};

/**
 * What the preview shows in place of the App, if anything: that nothing
 * is built yet, for an App with no version or one core said has none to
 * run; where it stands, without a chat, or when core found no page of it
 * (`ended`, while still at the revision and the App's version `at` it
 * ended).
 */
const nothingShown = ({
  app,
  chatId,
  ended,
  at,
}: {
  app: App;
  chatId: string | undefined;
  ended: Ended | undefined;
  at: { revision: number; pushes: number };
}): "unbuilt" | "stands" | undefined => {
  const endedNow =
    ended !== undefined &&
    ended.at === at.revision &&
    ended.pushes === at.pushes;
  if (chatId !== undefined && !endedNow) {
    return undefined;
  }
  const unversioned =
    app.currentVersion === null && app.pendingVersion === null;
  return unversioned || (endedNow && ended.reason === "not-running")
    ? "unbuilt"
    : "stands";
};

/** An App with no version: Grasp building its first, or nothing asked for yet. */
const NothingBuilt = ({
  name,
  running,
}: {
  name: string;
  running: boolean;
}) => {
  const { t } = useLingui();
  return running ? (
    <PreviewState
      icon={<Spinner aria-label={t`Building…`} />}
      title={<Trans>Grasp is building</Trans>}
    >
      <Trans>
        The preview shows here as soon as there is something to see.
      </Trans>
    </PreviewState>
  ) : (
    <PreviewState
      icon={<LayoutGridIcon />}
      title={<Trans>Nothing built yet</Trans>}
    >
      <Trans>
        Say in the chat what {name} should do. Grasp builds it, and the preview
        shows here.
      </Trans>
    </PreviewState>
  );
};

/**
 * Why a preview showed no App, at which revision of the chat's draft and
 * after how many of the App's version pushes (`useVersionPushes`).
 */
interface Ended {
  at: number;
  pushes: number;
  /** Core has no version of the App to show, or no page of it. */
  reason: "not-running" | "not-found";
}

/**
 * The main area's preview: the App as the chat's draft has it, never the
 * live App itself. Its changes while it has some; otherwise the App's
 * latest version (core's `previewDraft`), the one up for review included.
 * One frame throughout, so the chat's first write, and each after it,
 * comes into the App it shows in place. Core decides what there is to
 * show: an App with no version yet has nothing, and one whose version has
 * no page (an App of workflows alone) says where it stands instead, until
 * the chat's next write or the App's next version, from wherever it
 * comes.
 */
const PreviewArea = ({
  app,
  chatId,
  finding,
  draft,
  running,
}: {
  app: App;
  /** The App's chat; none while core finds it, or when it gave none. */
  chatId: string | undefined;
  /** Whether core is finding the App's chat still. */
  finding: boolean;
  draft: NamedDraft | undefined;
  running: boolean;
}) => {
  const { t } = useLingui();
  const [opened, setOpened] = useState<ShownVersion>();
  const [ended, setEnded] = useState<Ended>();
  const pushes =
    useVersionPushes(chatId === undefined ? [] : [app.id])[app.id] ?? 0;
  // The App's version the preview shows, as core said (`onShows`).
  const [shows, setShows] = useState<number>();
  const { name } = app;
  const changing =
    draft !== undefined && changesApp(draft.draft) ? draft : undefined;
  const revision = draft?.draft.revision ?? 0;
  // A preview is of a chat's: it opens once core found the App's chat.
  if (chatId === undefined && finding) {
    return (
      <div className="bg-muted flex min-h-0 flex-1 items-center justify-center p-6">
        <Spinner aria-label={t`Loading…`} />
      </div>
    );
  }
  // Where the App stands when core gave no chat, or showed no App at the
  // draft's revision and the App's version now.
  const nothing = nothingShown({
    app,
    chatId,
    ended: changing === undefined ? ended : undefined,
    at: { revision, pushes },
  });
  if (nothing === "unbuilt") {
    return <NothingBuilt name={name} running={running} />;
  }
  if (nothing === "stands" || chatId === undefined) {
    return <Stands app={app} />;
  }
  const version =
    changing === undefined ? undefined : shownVersion(changing.draft, opened);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PreviewBar
        app={app}
        chatId={chatId}
        draft={changing}
        shows={shows}
        onShow={(number) => {
          setOpened(
            number === undefined || changing === undefined
              ? undefined
              : {
                  app: app.id,
                  revision: changing.draft.revision,
                  number,
                }
          );
        }}
        shown={version}
      />
      <div className="flex min-h-0 flex-1 flex-col">
        <DraftPreview
          app={app.id}
          chatId={chatId}
          draft={draft?.draft}
          name={name}
          onShows={setShows}
          onEnded={(end) => {
            if (
              changing === undefined &&
              end.status === "failed" &&
              (end.reason === "not-running" || end.reason === "not-found")
            ) {
              setEnded({ at: revision, pushes, reason: end.reason });
            }
          }}
          version={version}
        />
      </div>
    </div>
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

/** The workspace's chat, and where its draft of the App stands: what the Data view changes. */
interface ModelChat {
  chatId: string;
  /** The draft's revision: 0 while the chat has none. */
  revision: number;
  /** Whether the chat's agent is at work, writing the draft still. */
  running: boolean;
}

/**
 * The App's data, for its builders: its data model, changed in the
 * chat's draft (`modelChat`), each table with its records; without a
 * chat to change it in (an archived App), its live tables' records.
 */
const DataArea = ({
  app,
  modelChat,
}: {
  app: string;
  modelChat: ModelChat | undefined;
}) =>
  modelChat === undefined ? (
    <LiveData app={app} />
  ) : (
    <AppDataModel
      app={app}
      // Each chat's own model: what one chat made never shows in another's.
      key={modelChat.chatId}
      {...modelChat}
    />
  );

/** What the main area holds besides the preview, which stays (hidden) so it doesn't load again. */
const MainArea = ({
  app,
  view,
  section,
  identity,
  preview,
  building,
  modelChat,
}: {
  app: ViewedApp;
  view: WorkspaceView;
  section: AppSettingsSection | undefined;
  identity: Identity;
  preview: ReactNode;
  /** The chat's draft the preview shows, which the code shows too. */
  building?: ChatBuilding;
  /** The chat whose draft the Data view changes; none without one. */
  modelChat?: ModelChat;
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
          <AppCode app={app} building={building} />
        </Suspense>
      </div>
    ) : null}
    {view === "data" ? (
      <div className="flex min-h-0 flex-1 flex-col">
        <DataArea app={app.id} modelChat={modelChat} />
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

/** The main area and the chat beside it: side by side when wide, the chat over it when not. */
const Split = ({
  main,
  chat,
  open,
  onOpenChange,
}: {
  main: ReactNode;
  chat: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const { t } = useLingui();
  const wide = useWide();
  // One tree on either side of the breakpoint: the main area stays where it
  // is, so the preview, and anything typed in it, outlives a resize. The
  // chat sits beside it when wide, over it in a sheet when not.
  return (
    <>
      <ResizablePanelGroup className="min-h-0 flex-1" orientation="horizontal">
        <ResizablePanel id="app-main" minSize="35">
          {main}
        </ResizablePanel>
        {wide && open ? (
          <>
            <ResizableHandle aria-label={t`Resize the chat`} withHandle />
            <ResizablePanel
              defaultSize={420}
              id="app-chat"
              maxSize="60"
              minSize={320}
            >
              {chat}
            </ResizablePanel>
          </>
        ) : null}
      </ResizablePanelGroup>
      {wide ? null : (
        <Sheet onOpenChange={onOpenChange} open={open}>
          {/* The chat's own header closes it. */}
          <SheetContent showCloseButton={false} side="right" size="wide">
            <SheetTitle className="sr-only">
              <Trans context="the chat that builds an app">Chat</Trans>
            </SheetTitle>
            <div className="flex min-h-0 flex-1 flex-col">{chat}</div>
          </SheetContent>
        </Sheet>
      )}
    </>
  );
};

/**
 * The workspace with its chat (`chatId`, once core found it): the chat
 * followed, the drafts it builds read, and the App's draft previewed
 * beside it.
 */
const Building = ({
  app,
  view,
  section,
  identity,
  chatId,
  failure,
  onChatGone,
  onRetryChat,
  models,
  efforts,
}: {
  app: ViewedApp;
  view: WorkspaceView;
  section: AppSettingsSection | undefined;
  identity: Identity;
  /** The App's chat; none while core finds it. */
  chatId: string | undefined;
  /** Why core gave no chat, if it didn't. */
  failure: Parameters<typeof AppChatPending>[0]["failure"];
  /** The chat followed couldn't be: it is gone, or isn't the person's. */
  onChatGone: (chatId: string) => void;
  /** Asks core for the App's chat again, after it gave none. */
  onRetryChat: () => void;
  models: string[];
  efforts: Record<string, ModelEfforts>;
}) => {
  const router = useRouter();
  const followed = useFollowedChat(chatId);
  // Here, not in the chat's panel: hiding it keeps what was typed.
  const asking = useAppAsk(app.id, chatId, models, efforts);
  const { running } = followed.view;
  const builds = useChatBuilds(chatId, running, followed.view.drafts);
  const draft = draftsOf(builds).find((each) => each.draft.app === app.id);
  const wide = useWide();
  const [open, setOpen] = useState(wide);
  // Over the page, the chat's own header closes it.
  const closing = wide
    ? {}
    : {
        onClose: () => {
          setOpen(false);
        },
      };
  // The App is read again as its build moves on: it may have proposed a
  // version to publish, or changed the App's name.
  const { drafts: draftChanges } = followed.view;
  const seen = useRef({ running, draftChanges });
  useEffect(() => {
    // Read again once the agent stops, or its drafts change after: a build
    // job may propose a version after the turn ended, which drops its draft.
    const before = seen.current;
    seen.current = { running, draftChanges };
    // During a turn the drafts change at every write; its end reads anyway.
    const draftsMoved = !running && before.draftChanges !== draftChanges;
    if ((before.running && !running) || draftsMoved) {
      void router.invalidate();
    }
  }, [router, running, draftChanges]);
  // Core has no such chat (deleted, or not the person's): the App's own
  // chat takes its place. Core out of reach, or refusing to follow it for
  // now (too many of the person's pages follow chats), keeps it, saying why.
  useEffect(() => {
    if (chatId !== undefined && followed.gone === true) {
      onChatGone(chatId);
    }
  }, [chatId, followed.gone, onChatGone]);
  return (
    <div className="flex min-h-0 flex-1 flex-col text-sm">
      <WorkspaceBar
        app={app}
        chat={{
          open,
          handleToggle: () => {
            setOpen(!open);
          },
          chatId,
        }}
        identity={identity}
        running={running}
        unpublished={draft !== undefined && changesApp(draft.draft)}
        view={view}
      />
      <Split
        chat={
          chatId === undefined ? (
            <AppChatPending
              failure={failure}
              onRetry={onRetryChat}
              {...closing}
            />
          ) : (
            <AppChat
              asking={asking}
              // Another chat's thread, held writes and requests never stay.
              key={chatId}
              builds={builds}
              chatId={chatId}
              followed={followed}
              models={models}
              name={app.name}
              {...closing}
            />
          )
        }
        main={
          <MainArea
            app={app}
            building={
              chatId === undefined || draft === undefined
                ? undefined
                : { chatId, draft: draft.draft }
            }
            modelChat={
              chatId === undefined
                ? undefined
                : { chatId, revision: draft?.draft.revision ?? 0, running }
            }
            identity={identity}
            preview={
              <PreviewArea
                app={app}
                chatId={chatId}
                draft={draft}
                finding={failure === undefined}
                running={running}
              />
            }
            section={section}
            view={view}
          />
        }
        onOpenChange={setOpen}
        open={open}
      />
    </div>
  );
};

/** An archived App: kept as it was, with no chat to change it, until a builder restores it. */
const Archived = ({
  app,
  view,
  section,
  identity,
}: {
  app: ViewedApp;
  view: WorkspaceView;
  section: AppSettingsSection | undefined;
  identity: Identity;
}) => {
  const { busy, failure, move } = useStatusMove(app.id);
  return (
    <div className="flex min-h-0 flex-1 flex-col text-sm">
      <WorkspaceBar
        app={app}
        chat={undefined}
        identity={identity}
        unpublished={false}
        view={view}
      />
      <MainArea
        app={app}
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
    </div>
  );
};

/** The workspace of App `app`, for one who builds it, with the chat that builds it. */
const Workspace = ({
  app,
  view,
  section,
  identity,
  models,
  efforts,
  handedOver,
}: {
  app: ViewedApp;
  view: WorkspaceView;
  section: AppSettingsSection | undefined;
  identity: Identity;
  models: string[];
  efforts: Record<string, ModelEfforts>;
  /** The chat the person came from, building this App (Chat's studio). */
  handedOver: string | undefined;
}) => {
  // One tree whether the chat is found yet or not: the main area, and
  // what is typed in it, stays as the chat comes.
  // A handed-over chat that can't be followed gives way to the App's own.
  const [gone, setGone] = useState<string>();
  const { chatId, failure, retry } = useAppChatId(
    app.id,
    handedOver === gone ? undefined : handedOver
  );
  return (
    <Building
      app={app}
      chatId={chatId}
      failure={failure}
      onRetryChat={retry}
      onChatGone={(lost) => {
        if (lost === handedOver) {
          setGone(lost);
        } else {
          // The App's chat this tab kept (deleted in another tab, say):
          // core is asked for the App's chat again.
          setActiveChat(undefined, appSlot(app.id));
        }
      }}
      efforts={efforts}
      identity={identity}
      models={models}
      section={section}
      view={view}
    />
  );
};

/** For someone who doesn't build the App: the workspace isn't theirs. */
const NotABuilder = ({ app }: { app: App }) => {
  const { name } = app;
  return (
    <PreviewState
      action={
        <Link
          className={buttonVariants({ variant: "outline" })}
          params={{ app: app.id }}
          to="/apps/$app"
        >
          <Trans>Open {name}</Trans>
        </Link>
      }
      icon={<LayoutGridIcon />}
      title={<Trans>Only its builders change {name}</Trans>}
    >
      <Trans>You can use the App itself.</Trans>
    </PreviewState>
  );
};

/** The App's workspace: building it for its builders, the way to the App for anyone else. */
export const AppWorkspace = ({
  app,
  view,
  section,
  identity,
  builds,
  models,
  efforts,
  handedOver,
}: {
  app: ViewedApp;
  view: WorkspaceView;
  section: AppSettingsSection | undefined;
  identity: Identity;
  builds: boolean;
  models: string[];
  efforts: Record<string, ModelEfforts>;
  /** The chat the person came from, building this App (Chat's studio). */
  handedOver: string | undefined;
}) => {
  if (!builds) {
    return <NotABuilder app={app} />;
  }
  if (app.status === "archived") {
    return (
      <Archived app={app} identity={identity} section={section} view={view} />
    );
  }
  return (
    <Workspace
      app={app}
      efforts={efforts}
      handedOver={handedOver}
      identity={identity}
      models={models}
      section={section}
      view={view}
    />
  );
};
