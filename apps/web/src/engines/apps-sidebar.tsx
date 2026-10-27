import { appLimits } from "@grasp-os/shared/app-limits";
import type { ViewedApp } from "@grasp-os/shared/apps";
import type { Identity } from "@grasp-os/shared/rpc";
import { Button } from "@grasp-os/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import { Sheet, SheetContent, SheetTitle } from "@grasp-os/ui/components/sheet";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ChevronRightIcon,
  EllipsisIcon,
  GlobeIcon,
  LayoutGridIcon,
  PanelLeftIcon,
  PencilIcon,
  SettingsIcon,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { useDockMode } from "../chat/dock-mode.ts";
import { ErrorText } from "../error-text.tsx";
import {
  PageSidebar,
  PageSidebarBody,
  PageSidebarTop,
  RailButton,
  RailDivider,
  RailExpand,
  usePageSidebarFold,
} from "../frame/page-sidebar.tsx";
import { RenameField, useClickOrDoubleClick } from "../frame/rename-field.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { buildsApp } from "./app-role.ts";
import { ArchiveDialog, useStatusMove } from "./app-status.tsx";

// The Apps beside an App's page, as the prototype has them
// (`components/apps/apps-sidebar.tsx`): Published, Draft and Archived, the
// last folded, the newest first in each. A click opens one; for its
// builders (`buildsApp`: their role in that App, not in the organization)
// a double click renames it, and its menu renames it, opens its settings,
// and archives or restores it, through core's audited calls. While the
// chat beside the page is open to change the App, the sidebar is its rail,
// to give the App the room; on a phone the list opens in a sheet. Screen
// previews are left out: our screens are sandboxed builds.

/** How many drafts the folded rail shows. */
const onRail = 6;

/** The Apps by where they stand, the newest first in each. */
export const appsByStatus = (
  apps: readonly ViewedApp[]
): Record<ViewedApp["status"], ViewedApp[]> => {
  const newest = apps.toSorted((a, b) =>
    b.createdAt.localeCompare(a.createdAt)
  );
  return {
    published: newest.filter(({ status }) => status === "published"),
    draft: newest.filter(({ status }) => status === "draft"),
    archived: newest.filter(({ status }) => status === "archived"),
  };
};

/** An App's menu, for its builders: rename, settings, archive or restore. */
const AppMenu = ({
  app,
  onRename,
}: {
  app: ViewedApp;
  onRename: () => void;
}) => {
  const { t } = useLingui();
  const navigate = useNavigate();
  const { busy, failure, move } = useStatusMove(app.id);
  const [archiving, setArchiving] = useState(false);
  // Choosing Rename leaves the focus in the field that opens.
  const renamingFromMenu = useRef(false);
  const { name } = app;
  return (
    <>
      <span className="absolute top-1 right-1.5 opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100 has-data-popup-open:opacity-100 pointer-coarse:opacity-100">
        <DropdownMenu
          onOpenChange={(open) => {
            if (open) {
              renamingFromMenu.current = false;
            }
          }}
        >
          <DropdownMenuTrigger
            aria-label={t`More for ${name}`}
            render={<Button size="icon-xs" variant="ghost" />}
          >
            <EllipsisIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-56"
            finalFocus={() => !renamingFromMenu.current}
          >
            <DropdownMenuItem
              onClick={() => {
                renamingFromMenu.current = true;
                onRename();
              }}
            >
              <PencilIcon />
              <Trans>Rename</Trans>
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                void navigate({
                  to: "/domains/$engine",
                  params: { engine: app.id },
                  search: { tab: "settings" },
                });
              }}
            >
              <SettingsIcon />
              <Trans>Settings</Trans>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {app.status === "archived" ? (
              <DropdownMenuItem
                disabled={busy}
                onClick={() => {
                  move("restore");
                }}
              >
                <ArchiveRestoreIcon />
                <Trans>Restore</Trans>
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem
                disabled={busy}
                onClick={() => {
                  setArchiving(true);
                }}
              >
                <ArchiveIcon />
                {app.status === "published" ? (
                  <Trans>Archive and take offline</Trans>
                ) : (
                  <Trans>Archive</Trans>
                )}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
      <ErrorText>{failure}</ErrorText>
      <ArchiveDialog
        name={name}
        onArchive={() => {
          setArchiving(false);
          move("archive");
        }}
        onOpenChange={setArchiving}
        open={archiving}
      />
    </>
  );
};

/**
 * One App in the list: its name on one line, marked when it is the one
 * open. A click opens it; for its builders a double click renames it in
 * place, as its menu's Rename does.
 */
const AppRow = ({
  app,
  current,
  identity,
  onPick,
}: {
  app: ViewedApp;
  current: boolean;
  identity: Identity;
  onPick?: () => void;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const navigate = useNavigate();
  const { failure, run } = useCoreAction();
  const [renaming, setRenaming] = useState(false);
  const builds = buildsApp(app, identity);
  // Enter or Escape gives the focus back to the row once the field goes.
  const link = useRef<HTMLAnchorElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (renaming || !refocus.current) {
      return;
    }
    refocus.current = false;
    link.current?.focus();
  }, [renaming]);
  const open = (): void => {
    onPick?.();
    void navigate({ to: "/apps/$app", params: { app: app.id } });
  };
  const clicks = useClickOrDoubleClick(open, () => {
    if (builds) {
      setRenaming(true);
    } else {
      open();
    }
  });
  const rename = async (name: string): Promise<void> => {
    const renamed = await run(async (session) => {
      await session.apps.update(app.id, { name });
      return true;
    });
    if (renamed === true) {
      await router.invalidate();
    }
  };
  const { name } = app;
  return (
    <li className="group/row relative">
      {renaming ? (
        <div className="flex items-center px-2 py-0.5">
          <RenameField
            label={t`Domain name`}
            maxLength={appLimits.nameLength}
            onDone={(next, byKey) => {
              refocus.current = byKey;
              setRenaming(false);
              const trimmed = next?.trim();
              if (trimmed !== undefined && trimmed !== "" && trimmed !== name) {
                void rename(trimmed);
              }
            }}
            value={name}
          />
        </div>
      ) : (
        <Link
          aria-current={current ? "page" : undefined}
          className={
            current
              ? "bg-muted focus-visible:ring-ring/50 flex w-full items-center gap-2 rounded-md py-1.5 pr-9 pl-2 text-left font-medium outline-none focus-visible:ring-3"
              : "hover:bg-muted focus-visible:ring-ring/50 flex w-full items-center gap-2 rounded-md py-1.5 pr-9 pl-2 text-left transition-colors duration-150 outline-none focus-visible:ring-3"
          }
          onClick={(event) => {
            clicks.onClick(event);
            if (event.detail === 0) {
              onPick?.();
            }
          }}
          onDoubleClick={() => {
            clicks.onDoubleClick();
          }}
          params={{ app: app.id }}
          ref={link}
          to="/apps/$app"
        >
          {app.status === "published" ? (
            <GlobeIcon
              aria-hidden="true"
              className="text-muted-foreground size-3.5 flex-none"
            />
          ) : null}
          <span className="min-w-0 flex-1 truncate">{name}</span>
        </Link>
      )}
      {renaming || !builds ? null : (
        <AppMenu
          app={app}
          onRename={() => {
            setRenaming(true);
          }}
        />
      )}
      <ErrorText>{failure}</ErrorText>
    </li>
  );
};

/** A group of the list: its heading, then its Apps. */
const Group = ({
  title,
  apps,
  current,
  identity,
  onPick,
}: {
  title: string;
  apps: readonly ViewedApp[];
  current: string | undefined;
  identity: Identity;
  onPick?: () => void;
}) => {
  const heading = useId();
  return (
    <section aria-labelledby={heading} className="flex flex-col gap-0.5">
      <h3 className="text-muted-foreground px-2 pb-1 text-xs" id={heading}>
        {title}
      </h3>
      <ul className="flex flex-col gap-0.5">
        {apps.map((app) => (
          <AppRow
            app={app}
            current={app.id === current}
            identity={identity}
            key={app.id}
            onPick={onPick}
          />
        ))}
      </ul>
    </section>
  );
};

/**
 * The list itself: All Apps on top, with the fold beside it; then the
 * Apps by where they stand, Archived folded until opened. In the sheet on
 * a phone there is no fold, and a pick closes the sheet.
 */
export const AppsList = ({
  apps,
  current,
  identity,
  fold,
  onPick,
}: {
  apps: readonly ViewedApp[];
  current: string | undefined;
  identity: Identity;
  fold?: { label: string; onFold: () => void };
  onPick?: () => void;
}) => {
  const { t } = useLingui();
  const [archivedOpen, setArchivedOpen] = useState(false);
  const archivedHeading = useId();
  const { published, draft, archived } = appsByStatus(apps);
  const count = archived.length;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageSidebarTop fold={fold}>
        <Button
          nativeButton={false}
          render={<Link onClick={onPick} to="/domains" />}
          variant="outline"
        >
          <LayoutGridIcon data-icon="inline-start" />
          <Trans>All domains</Trans>
        </Button>
      </PageSidebarTop>
      <PageSidebarBody>
        <nav aria-label={t`Domains`} className="flex flex-col gap-3">
          {published.length === 0 ? null : (
            <Group
              apps={published}
              current={current}
              identity={identity}
              onPick={onPick}
              title={t({
                message: "Published",
                context: "apps open to the people they are shared with",
              })}
            />
          )}
          {draft.length === 0 ? null : (
            <Group
              apps={draft}
              current={current}
              identity={identity}
              onPick={onPick}
              title={t({ message: "Draft", context: "apps still being made" })}
            />
          )}
          {count === 0 ? null : (
            <section
              aria-labelledby={archivedHeading}
              className="flex flex-col gap-0.5"
            >
              <h3 id={archivedHeading}>
                <button
                  aria-expanded={archivedOpen}
                  className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex w-full items-center gap-1 rounded-md px-2 pb-1 text-left text-xs outline-none focus-visible:ring-3"
                  onClick={() => {
                    setArchivedOpen(!archivedOpen);
                  }}
                  type="button"
                >
                  <ChevronRightIcon
                    aria-hidden="true"
                    className={
                      archivedOpen
                        ? "size-3 rotate-90 transition-transform"
                        : "size-3 transition-transform"
                    }
                  />
                  <Trans context="apps put away">Archived ({count})</Trans>
                </button>
              </h3>
              {archivedOpen ? (
                <ul className="flex flex-col gap-0.5">
                  {archived.map((app) => (
                    <AppRow
                      app={app}
                      current={app.id === current}
                      identity={identity}
                      key={app.id}
                      onPick={onPick}
                    />
                  ))}
                </ul>
              ) : null}
            </section>
          )}
        </nav>
      </PageSidebarBody>
    </div>
  );
};

/**
 * The sidebar, open or folded to its rail, kept as the person left it.
 * While the chat beside the page is open to change the App, it is the
 * rail: opened there, it stays open for that App only.
 */
export const AppsSidebar = ({
  apps,
  current,
  identity,
}: {
  apps: readonly ViewedApp[];
  current: string;
  identity: Identity;
}) => {
  const { t } = useLingui();
  const building = useDockMode() === "frame";
  const [browsingFolded, setBrowsingFolded] = usePageSidebarFold("apps");
  // The App beside whose chat the person opened the sidebar.
  const [openedBeside, setOpenedBeside] = useState<string>();
  const folded = building ? openedBeside !== current : browsingFolded;
  const setFolded = (next: boolean): void => {
    if (building) {
      setOpenedBeside(next ? undefined : current);
    } else {
      setBrowsingFolded(next);
    }
  };
  if (folded) {
    const { published, draft } = appsByStatus(apps);
    return (
      <PageSidebar folded label={t`Domains`}>
        <RailExpand
          label={t`Expand the domains`}
          onExpand={() => {
            setFolded(false);
          }}
        />
        <RailDivider />
        {published.map((app) => (
          <RailButton
            active={app.id === current}
            key={app.id}
            label={app.name}
            render={<Link params={{ app: app.id }} to="/apps/$app" />}
          >
            <GlobeIcon />
          </RailButton>
        ))}
        {published.length === 0 ? null : <RailDivider />}
        {draft.slice(0, onRail).map((app) => (
          <RailButton
            active={app.id === current}
            key={app.id}
            label={app.name}
            render={<Link params={{ app: app.id }} to="/apps/$app" />}
          >
            <LayoutGridIcon />
          </RailButton>
        ))}
      </PageSidebar>
    );
  }
  return (
    <PageSidebar folded={false} label={t`Domains`}>
      <AppsList
        apps={apps}
        current={current}
        fold={{
          label: t`Fold the domains`,
          onFold: () => {
            setFolded(true);
          },
        }}
        identity={identity}
      />
    </PageSidebar>
  );
};

/** On a phone: the Apps, from a button in the bar on top, in a sheet. */
export const AppsSheetButton = ({
  apps,
  current,
  identity,
}: {
  apps: readonly ViewedApp[];
  current: string;
  identity: Identity;
}) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        className="md:hidden"
        onClick={() => {
          setOpen(true);
        }}
        size="sm"
        variant="outline"
      >
        <PanelLeftIcon data-icon="inline-start" />
        <Trans>Domains</Trans>
      </Button>
      <Sheet onOpenChange={setOpen} open={open}>
        <SheetContent closeLabel={t`Close`} side="left">
          <SheetTitle className="sr-only">
            <Trans>Domains</Trans>
          </SheetTitle>
          <AppsList
            apps={apps}
            current={current}
            identity={identity}
            onPick={() => {
              setOpen(false);
            }}
          />
        </SheetContent>
      </Sheet>
    </>
  );
};
