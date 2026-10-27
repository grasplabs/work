import type { App, AppContents, ViewedApp } from "@grasp-os/shared/apps";
import type { Identity } from "@grasp-os/shared/rpc";
import { Button, buttonVariants } from "@grasp-os/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import { cn } from "@grasp-os/ui/lib/utils";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ChevronDownIcon,
  GlobeIcon,
  LayoutGridIcon,
  MessageSquareIcon,
  SettingsIcon,
  SquarePenIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { setActiveChat } from "../chat/active-chat.ts";
import { setDockMode } from "../chat/dock-mode.ts";
import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { buildsApp } from "./app-role.ts";
import { StatusBadge, useStatusMove } from "./app-status.tsx";

// An App's own page (grasplabs/prototype `routes/apps/$appId.tsx`): its bar
// with its name, its screens as tabs, its settings, Edit and the Publish
// menu; under the bar, that it is archived, with Restore; then the open
// screen, or, while it has none, that it is only described, with the way
// to design it in the chat. The prototype's app is our App (a domain), its
// tabs our App's screens.
//
// Editing is the chat's: Edit opens the App's own chat beside the page
// (the shell's dock, chat-dock.tsx), the one core keeps for the person and
// the App (`chats.forApp`), where Grasp changes the App with them, as the
// prototype's chat bottom right does. What the prototype's Publish
// menu adds, a link to publish at and saving as a blueprint, waits on
// core (a published screen's address) and the blueprints page.

/**
 * Opens the App's own chat beside the page, to change the App there: the
 * person's chat for it, which core makes the first time. Says why when
 * core refuses (they no longer build it, say).
 */
const useAppChat = (app: string) => {
  const { busy, failure, run } = useCoreAction();
  const open = async (): Promise<void> => {
    const chat = await run(async (session) => await session.chats.forApp(app));
    if (chat === undefined) {
      return;
    }
    setActiveChat(chat.id);
    setDockMode("frame");
  };
  return {
    busy,
    failure,
    handleOpen: () => {
      void open();
    },
  };
};

/**
 * Publish, for a builder: a draft is published for the people it is shared
 * with, a published App goes back to a draft. Off while it has no version
 * to publish, as core refuses that.
 */
const PublishMenu = ({ app }: { app: App }) => {
  const { busy, failure, move } = useStatusMove(app.id);
  const published = app.status === "published";
  return (
    <div className="flex flex-col items-end gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={busy || app.currentVersion === null}
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
                move("unpublish");
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
          ) : (
            <DropdownMenuItem
              onClick={() => {
                move("publish");
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
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};

/** That the App is archived, under its bar; a builder can restore it. */
const ArchivedNotice = ({ app, builds }: { app: App; builds: boolean }) => {
  const { busy, failure, move } = useStatusMove(app.id);
  return (
    <div className="bg-muted flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3 py-2">
      <ArchiveIcon
        aria-hidden="true"
        className="text-muted-foreground size-4 flex-none"
      />
      <span className="min-w-0 flex-1 basis-64">
        <Trans>
          This app is archived. It is kept as it was, and nobody works on it.
        </Trans>
      </span>
      {builds ? (
        <Button
          disabled={busy}
          onClick={() => {
            move("restore");
          }}
          size="sm"
          variant="outline"
        >
          <Trans>Restore</Trans>
        </Button>
      ) : null}
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};

/** An App with no screen yet: only described, and designed in the chat. */
const OnlyDescribed = ({
  editable,
  onOpenChat,
}: {
  editable: boolean;
  onOpenChat: () => void;
}) => (
  <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed p-6">
    <div className="flex max-w-prose flex-col gap-1">
      <span className="font-medium">
        <Trans>Only described</Trans>
      </span>
      <p className="text-muted-foreground">
        <Trans>
          This app has no screen yet. Grasp designs it with you in the chat.
        </Trans>
      </p>
    </div>
    {editable ? (
      <Button onClick={onOpenChat}>
        <MessageSquareIcon data-icon="inline-start" />
        <Trans>Design it in the chat</Trans>
      </Button>
    ) : null}
  </div>
);

/** The App's screens as tabs in its bar, the open one marked; none for one. */
const ScreenTabs = ({
  app,
  screens,
  open,
}: {
  app: string;
  screens: readonly string[];
  open: string | undefined;
}) => {
  const { t } = useLingui();
  if (screens.length < 2) {
    return null;
  }
  return (
    <nav aria-label={t`Screens`} className="flex flex-wrap gap-1">
      {screens.map((screen) => (
        <Link
          aria-current={screen === open ? "page" : undefined}
          className={cn(
            buttonVariants({
              size: "sm",
              variant: screen === open ? "secondary" : "ghost",
            }),
            "capitalize"
          )}
          key={screen}
          params={{ app }}
          replace
          search={{ screen }}
          to="/apps/$app"
        >
          {screen}
        </Link>
      ))}
    </nav>
  );
};

/**
 * The App's page: its bar, then under it that it is archived, then its
 * open screen (`children`), or that it has none. Only one who builds it
 * (`buildsApp`, by their role in this App) edits, publishes and restores
 * it.
 */
export const AppPage = ({
  app,
  contents,
  open,
  identity,
  children,
}: {
  app: ViewedApp;
  contents: AppContents;
  /** The screen open, of `contents.screens`; none while it has none. */
  open: string | undefined;
  identity: Pick<Identity, "staff">;
  children: ReactNode;
}) => {
  const { t } = useLingui();
  const { name } = app;
  const builds = buildsApp(app, identity);
  const archived = app.status === "archived";
  const editable = builds && !archived;
  const chat = useAppChat(app.id);
  return (
    <div className="flex min-h-0 flex-1 flex-col text-sm">
      <div className="bg-background flex flex-none flex-wrap items-center gap-x-6 gap-y-2 border-b px-4 py-3 md:px-6">
        <span className="flex min-w-0 items-center gap-2.5">
          <span
            aria-hidden="true"
            className="bg-muted text-foreground inline-flex size-8 flex-none items-center justify-center rounded-lg"
          >
            <LayoutGridIcon className="size-4" />
          </span>
          <h1 className="truncate text-base font-medium">{name}</h1>
          <StatusBadge status={app.status} />
        </span>
        <ScreenTabs app={app.id} open={open} screens={contents.screens} />
        <span className="ml-auto flex items-start gap-2">
          <Link
            aria-label={t`Settings of ${name}`}
            className={buttonVariants({ size: "icon-sm", variant: "ghost" })}
            params={{ app: app.id }}
            title={t`Settings`}
            to="/apps/$app/settings"
          >
            <SettingsIcon />
          </Link>
          {editable ? (
            <>
              <Button
                disabled={chat.busy}
                onClick={chat.handleOpen}
                size="sm"
                variant="outline"
              >
                <SquarePenIcon data-icon="inline-start" />
                <Trans>Edit</Trans>
              </Button>
              <PublishMenu app={app} />
            </>
          ) : null}
        </span>
      </div>
      {chat.failure === undefined ? null : (
        <div className="px-4 pt-4 md:px-6">
          <ErrorText>{chat.failure}</ErrorText>
        </div>
      )}
      {archived ? (
        <div className="px-4 pt-4 md:px-6">
          <ArchivedNotice app={app} builds={builds} />
        </div>
      ) : null}
      {open === undefined ? (
        <div className="px-4 pt-4 md:px-6">
          {archived ? null : (
            <OnlyDescribed editable={editable} onOpenChat={chat.handleOpen} />
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      )}
    </div>
  );
};
