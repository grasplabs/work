import { isGeneratedServerFile } from "@grasp-os/runtime/host";
import type {
  AppDraft,
  AppDraftHistoryPoint,
} from "@grasp-os/shared/app-drafts";
import type {
  AppRelease,
  AppVersion,
  FileDiff,
  ViewedApp,
} from "@grasp-os/shared/apps";
import { failureText } from "@grasp-os/shared/errors";
import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@grasp-os/ui/components/alert-dialog";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button, buttonVariants } from "@grasp-os/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@grasp-os/ui/components/sheet";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useRouter } from "@tanstack/react-router";
import {
  EllipsisIcon,
  EyeIcon,
  GitCompareArrowsIcon,
  HistoryIcon,
  RotateCcwIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { decidesRequests } from "../dashboard/waiting.ts";
import { readPeople } from "../directory.ts";
import { ErrorText } from "../error-text.tsx";
import { formatList, formatSince } from "../format.ts";
import { LoadingLines } from "../frame/page-states.tsx";
import { loadFromCore, NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { buildsApp } from "./app-role.ts";
import { FileChanges } from "./draft-changes.tsx";
import { isConflict, publishFailureText, settled } from "./publish-errors.ts";
import {
  ReleaseBadges,
  ReleaseDialog,
  ReleaseMenuItems,
} from "./release-controls.tsx";
import type { ReleaseAction } from "./release-controls.tsx";
import { useAppDraft } from "./use-app-draft.ts";

// An App's history, in its settings (app-settings.tsx), as a deployments
// list reads: on top, while its draft has some, the unpublished changes,
// each undo point core keeps of it (core's app-drafts.ts): who, through
// Grasp's chat or by hand, when, and the files it touched, each to
// preview read-only in the workspace or restore, and the draft to
// discard. Below, every published version, newest first: its label, the
// live one marked, its note, who published it and when, and a menu to see
// what it changed against the version before it, preview it, or roll
// back to it (`apps.versions.publish`). The draft is reset to the version
// rolled back to, so the dialog says when that discards unpublished
// changes, and goes over the draft's revision it read then: a draft
// changed meanwhile is refused rather than lost. Core checks and seals it
// first, and, for anyone but an admin, asks again for the App's
// permissions to connections, workflows and other Apps; the dialog says
// so. An admin revokes a version's release or holds it from the same
// menu (release-controls.tsx). Restoring and discarding name the draft's
// revision the person saw too.

/** One more page of versions: core lists at most 100 at a time. */
const pageSize = 100;

/** Most files a point's line names before it counts the rest. */
const namedFiles = 3;

/** What a version is called: its label, or, never live, that it wasn't. */
const VersionName = ({ version }: { version: AppVersion }) =>
  version.label === null ? (
    <Trans>Not shared yet</Trans>
  ) : (
    <span className="font-mono">{version.label}</span>
  );

// -- Unpublished changes ---------------------------------------------------

/** What changing the draft from here asks the person to confirm. */
export type Asked = { kind: "restore"; number: number } | { kind: "discard" };

/**
 * Restores undo point `number` of the draft, or discards the draft, over
 * `revision`, the one the person saw: `onChanged` once it did; the
 * refusal otherwise.
 */
export const useDraftChange = (
  app: string,
  revision: number,
  onChanged: () => void
) => {
  const { t } = useLingui();
  const core = useCore();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const change = async (asked: Asked): Promise<void> => {
    setBusy(true);
    setFailure(undefined);
    const done = await settled(core, async (session) => {
      await (asked.kind === "restore"
        ? session.apps.drafts.restorePoint(app, asked.number, revision)
        : session.apps.drafts.discard(app, revision));
    });
    setBusy(false);
    if (!done.ok) {
      setFailure(
        isConflict(done.error)
          ? t`Someone changed the App meanwhile. Look at its history again, then try again.`
          : failureText(done.error)
      );
      return;
    }
    onChanged();
  };
  return { busy, failure, change };
};

/** Asks before restoring an undo point or discarding the draft. */
export const ConfirmChange = ({
  asked,
  onConfirm,
  onCancel,
}: {
  asked: Asked | undefined;
  onConfirm: (asked: Asked) => void;
  onCancel: () => void;
}) => (
  <AlertDialog
    onOpenChange={(open) => {
      if (!open) {
        onCancel();
      }
    }}
    open={asked !== undefined}
  >
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>
          {asked?.kind === "discard" ? (
            <Trans>Undo the changes only you see?</Trans>
          ) : (
            <Trans>Restore this earlier state?</Trans>
          )}
        </AlertDialogTitle>
        <AlertDialogDescription>
          {asked?.kind === "discard" ? (
            <Trans>
              They go, for everyone who builds this App. Its history in Settings
              keeps them, so you can bring them back.
            </Trans>
          ) : (
            <Trans>
              Your changes go back to how they were then, for everyone who
              builds this App. What came after stays in its history.
            </Trans>
          )}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>
          <Trans>Cancel</Trans>
        </AlertDialogCancel>
        <AlertDialogAction
          onClick={() => {
            if (asked !== undefined) {
              onConfirm(asked);
            }
          }}
          variant={asked?.kind === "discard" ? "destructive" : "default"}
        >
          {asked?.kind === "discard" ? (
            <Trans>Undo changes</Trans>
          ) : (
            <Trans>Restore</Trans>
          )}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
);

/** Who made an undo point, and how, as its line says it. */
const PointTitle = ({
  point,
  name,
}: {
  point: AppDraftHistoryPoint;
  name: string;
}) => {
  if (point.restoredFrom !== null) {
    return <Trans>{name} restored an earlier state</Trans>;
  }
  return point.chatId === null ? (
    <Trans>{name} edited it</Trans>
  ) : (
    <Trans>Grasp, in {name}&apos;s chat</Trans>
  );
};

/** The files an undo point touched, a few by name and a count of the rest. */
const touchedText = (touched: readonly string[]): string => {
  const more = touched.length - namedFiles;
  return formatList(
    more > 0
      ? [
          ...touched.slice(0, namedFiles),
          plural(more, { one: "# more file", other: "# more files" }),
        ]
      : touched
  );
};

/**
 * The undo points of the draft's unpublished changes, newest first:
 * those after the last a publish or roll back left (which changes
 * nothing over the version it is over).
 */
const unpublishedPoints = (
  points: readonly AppDraftHistoryPoint[]
): AppDraftHistoryPoint[] => {
  const published = points.findIndex(({ changes }) => changes === 0);
  return published === -1 ? [...points] : points.slice(0, published);
};

/** The undo points and people's names, as read at the draft's revision. */
interface PointsRead {
  points: AppDraftHistoryPoint[];
  people: ReadonlyMap<string, string>;
}

/** The draft's undo points, read again at each of its revisions. */
const usePoints = (
  app: string,
  revision: number
): PointsRead | undefined | "failed" => {
  const core = useCore();
  const [read, setRead] = useState<{
    key: string;
    read: PointsRead | "failed";
  }>();
  const key = `${app}:${revision}`;
  useEffect(() => {
    let current = true;
    const load = async (): Promise<void> => {
      const found = await settled(core, async (session) => {
        const [points, people] = await Promise.all([
          session.apps.drafts.points(app),
          readPeople(session),
        ]);
        return { points, people };
      });
      if (current) {
        setRead({ key, read: found.ok ? found.value : "failed" });
      }
    };
    void load();
    return () => {
      current = false;
    };
  }, [core, app, key]);
  return read?.key === key ? read.read : undefined;
};

/** One undo point: who, when and what; previewed or restored from here. */
const PointItem = ({
  app,
  point,
  name,
  latest,
  busy,
  onRestore,
}: {
  app: string;
  point: AppDraftHistoryPoint;
  name: string;
  latest: boolean;
  busy: boolean;
  onRestore: () => void;
}) => (
  <Item render={<li />} size="sm" variant="row">
    <ItemContent>
      <ItemTitle>
        <PointTitle name={name} point={point} />
        {latest ? (
          <Badge variant="secondary">
            <Trans>Now</Trans>
          </Badge>
        ) : null}
      </ItemTitle>
      <ItemDescription>
        <time dateTime={point.createdAt}>{formatSince(point.createdAt)}</time>
        {point.touched.length === 0 ? null : (
          <span className="block truncate font-mono text-xs">
            {touchedText(point.touched)}
          </span>
        )}
      </ItemDescription>
    </ItemContent>
    {latest ? null : (
      <ItemActions>
        <Link
          className={buttonVariants({ size: "sm", variant: "ghost" })}
          params={{ app }}
          search={{ point: point.number }}
          to="/apps/$app"
        >
          <EyeIcon data-icon="inline-start" />
          <Trans>See it</Trans>
        </Link>
        <Button disabled={busy} onClick={onRestore} size="sm" variant="outline">
          <Trans>Restore</Trans>
        </Button>
      </ItemActions>
    )}
  </Item>
);

/** The draft's unpublished changes, its undo points, and discarding it. */
const UnpublishedChanges = ({
  draft,
  onChanged,
}: {
  draft: AppDraft;
  onChanged: () => void;
}) => {
  const { t } = useLingui();
  const read = usePoints(draft.app, draft.revision);
  const [asked, setAsked] = useState<Asked>();
  const { busy, failure, change } = useDraftChange(
    draft.app,
    draft.revision,
    onChanged
  );
  const points = typeof read === "object" ? unpublishedPoints(read.points) : [];
  const [newest] = points;
  return (
    <section aria-labelledby="app-unpublished" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-medium" id="app-unpublished">
          <Trans>Changes only you see</Trans>
        </h3>
        <span className="flex-1" />
        <Button
          disabled={busy}
          onClick={() => {
            setAsked({ kind: "discard" });
          }}
          size="sm"
          variant="outline"
        >
          <Trans>Undo changes</Trans>
        </Button>
      </div>
      <ErrorText>{failure}</ErrorText>
      {read === undefined ? <LoadingLines lines={2} /> : null}
      {read === "failed" ? (
        <ErrorText>{t`The history of your changes couldn't be read. Try again in a moment.`}</ErrorText>
      ) : null}
      {points.length === 0 ? null : (
        <ItemGroup render={<ol />} variant="card">
          {points.map((point) => (
            <PointItem
              app={draft.app}
              busy={busy}
              key={point.number}
              latest={point.number === newest?.number}
              name={
                typeof read === "object"
                  ? (read.people.get(point.personId) ?? point.personId)
                  : point.personId
              }
              onRestore={() => {
                setAsked({ kind: "restore", number: point.number });
              }}
              point={point}
            />
          ))}
        </ItemGroup>
      )}
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
    </section>
  );
};

/** The draft's unpublished changes, followed as it is written; none without any. */
const Unpublished = ({ app }: { app: string }) => {
  const { draft, reread } = useAppDraft(app, 0);
  return draft === undefined || draft.changed.length === 0 ? null : (
    <UnpublishedChanges draft={draft} onChanged={reread} />
  );
};

// -- Published versions ----------------------------------------------------

/** Publishing `version` again, against the live one. */
interface Move {
  version: AppVersion;
  rollback: boolean;
}

/** A move, with the App's draft as read when it was asked for. */
interface AskedMove extends Move {
  /** The draft's revision then, which the publish goes over. */
  revision: number;
  /** Whether it discards the draft's unpublished changes. */
  discards: boolean;
}

/** The move's question, naming the version by its label while it has one. */
const MoveTitle = ({
  rollback,
  label,
}: {
  rollback: boolean;
  label: string | null;
}) => {
  if (!rollback) {
    return <Trans>Give your team this version?</Trans>;
  }
  return label === null ? (
    <Trans>Go back to this version?</Trans>
  ) : (
    <Trans>Go back to {label}?</Trans>
  );
};

/** The confirmation of a move: what it does, and that it asks again for permissions. */
const MoveDialog = ({
  move,
  admin,
  onConfirm,
  onOpenChange,
}: {
  move: AskedMove | null;
  admin: boolean;
  onConfirm: (move: AskedMove) => void;
  onOpenChange: (open: boolean) => void;
}) => {
  const label = move?.version.label ?? null;
  return (
    <AlertDialog onOpenChange={onOpenChange} open={move !== null}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            <MoveTitle label={label} rollback={move?.rollback === true} />
          </AlertDialogTitle>
          <AlertDialogDescription>
            <Trans>
              Its pages and workflows run on it from now on. Grasp checks and
              builds it first.
            </Trans>{" "}
            {move?.discards === true ? (
              <>
                <strong>
                  <Trans>
                    The changes only you see are dropped, and you go on from
                    this version.
                  </Trans>
                </strong>{" "}
              </>
            ) : null}
            {admin ? null : (
              <Trans>
                Its permissions on connections, to start workflows and to call
                other Apps wait for an admin to grant them again.
              </Trans>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>
            <Trans>Cancel</Trans>
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              if (move !== null) {
                onConfirm(move);
              }
            }}
            variant={move?.discards === true ? "destructive" : "default"}
          >
            {move?.rollback === true ? (
              <Trans>Go back</Trans>
            ) : (
              <Trans>Give it to your team</Trans>
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

/** What a version changed against the one it was made from, in a sheet. */
const VersionChanges = ({
  app,
  version,
  onClose,
}: {
  app: string;
  version: AppVersion;
  onClose: () => void;
}) => {
  const { t } = useLingui();
  const core = useCore();
  const [read, setRead] = useState<Loaded<FileDiff[]>>();
  const { parent } = version;
  useEffect(() => {
    const left = new AbortController();
    const load = async (): Promise<void> => {
      if (parent === null) {
        return;
      }
      const found = await loadFromCore(
        core,
        async (session) => {
          const diffs = await session.apps.versions.diff(
            app,
            parent,
            version.version
          );
          // What Grasp generates (`server/_generated/`) isn't shown.
          return diffs.filter(({ path }) => !isGeneratedServerFile(path));
        },
        left.signal
      );
      if (!left.signal.aborted) {
        setRead(found);
      }
    };
    void load();
    return () => {
      left.abort();
    };
  }, [core, app, parent, version.version]);
  return (
    <Sheet
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
    >
      <SheetContent closeLabel={t`Close`} size="wide">
        <SheetHeader>
          <SheetTitle>
            <Trans>
              What <VersionName version={version} /> changed
            </Trans>
          </SheetTitle>
          <SheetDescription>{version.message}</SheetDescription>
        </SheetHeader>
        <div className="overflow-y-auto px-4 pb-4">
          {read === undefined ? <LoadingLines lines={4} /> : null}
          {read !== undefined && read.state !== "ready" ? (
            <NotLoaded page={read} />
          ) : null}
          {read?.state === "ready" ? <FileChanges files={read.data} /> : null}
        </div>
      </SheetContent>
    </Sheet>
  );
};

/** A version's menu: its changes, its preview, publishing it, its release. */
const VersionMenu = ({
  app,
  version,
  current,
  builds,
  release,
  disabled,
  onShowChanges,
  onMove,
  onAsk,
}: {
  app: string;
  version: AppVersion;
  current: number | null;
  builds: boolean;
  /** Its sealed release, for an admin; none for anyone else. */
  release: AppRelease | undefined;
  disabled: boolean;
  onShowChanges: () => void;
  onMove: (move: Move) => void;
  onAsk: (action: ReleaseAction) => void;
}) => {
  const { t } = useLingui();
  // A revoked version can't be published again: core refuses it.
  const moves =
    builds &&
    version.version !== current &&
    (release?.revokedAt ?? null) === null;
  const rollback = current !== null && version.version < current;
  const { label } = version;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        render={
          <Button
            aria-label={
              label === null
                ? t`Actions for the version not shared yet`
                : t`Actions for ${label}`
            }
            size="icon-sm"
            variant="ghost"
          />
        }
      >
        <EllipsisIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {version.parent === null ? null : (
          <DropdownMenuItem onClick={onShowChanges}>
            <GitCompareArrowsIcon />
            <Trans>View changes</Trans>
          </DropdownMenuItem>
        )}
        {builds ? (
          <DropdownMenuItem
            render={
              <Link
                params={{ app }}
                search={{ version: version.version }}
                to="/apps/$app"
              />
            }
          >
            <EyeIcon />
            <Trans>See this version</Trans>
          </DropdownMenuItem>
        ) : null}
        {moves ? (
          <DropdownMenuItem
            onClick={() => {
              onMove({ version, rollback });
            }}
          >
            <RotateCcwIcon />
            {rollback ? (
              <Trans>Go back to this version</Trans>
            ) : (
              <Trans>Give your team this version</Trans>
            )}
          </DropdownMenuItem>
        ) : null}
        {release === undefined ? null : (
          <>
            <DropdownMenuSeparator />
            <ReleaseMenuItems onAsk={onAsk} release={release} />
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** One published version, as the list shows it. */
const VersionItem = ({
  version,
  live,
  release,
  by,
  menu,
}: {
  version: AppVersion;
  live: boolean;
  release: AppRelease | undefined;
  /** Who published it, as the list names them. */
  by: string;
  menu: ReactNode;
}) => {
  const since = formatSince(version.createdAt);
  return (
    <Item render={<li />} variant="row">
      <ItemContent>
        <ItemTitle>
          <VersionName version={version} />
          {live ? (
            <Badge variant="passed">
              <Trans>Your team has this one</Trans>
            </Badge>
          ) : null}
          {release === undefined ? null : <ReleaseBadges release={release} />}
        </ItemTitle>
        <ItemDescription>{version.message}</ItemDescription>
        <span className="text-muted-foreground text-xs">
          {/* A version never live (the first of an App made from a
            blueprint) was made, not published. */}
          {version.label === null ? (
            <Trans>
              {by} created it <time dateTime={version.createdAt}>{since}</time>
            </Trans>
          ) : (
            <Trans>
              {by} shared it <time dateTime={version.createdAt}>{since}</time>
            </Trans>
          )}
        </span>
      </ItemContent>
      <ItemActions>{menu}</ItemActions>
    </Item>
  );
};

/**
 * The versions as read, newest first, with what each changed, its
 * preview and publishing it again for a builder, and their releases,
 * revoked or held, for an admin.
 */
export const VersionsView = ({
  app,
  identity,
  versions,
  releases,
  people,
  next,
  more = false,
  onMore,
  onRelease,
}: {
  app: ViewedApp;
  identity: Pick<Identity, "userId" | "role" | "staff">;
  versions: readonly AppVersion[];
  /** Each sealed version's release, by version: read for admins only. */
  releases: ReadonlyMap<number, AppRelease>;
  /** People's names, by ID. */
  people: ReadonlyMap<string, string>;
  /** Where an older page starts; null once every version is listed. */
  next: number | null;
  /** An older page is being read. */
  more?: boolean;
  onMore: () => void;
  /** A release as core answered a change to it. */
  onRelease: (release: AppRelease) => void;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const core = useCore();
  const { busy: asking, failure: askFailure, run } = useCoreAction();
  const [moving, setMoving] = useState(false);
  const [moveFailure, setMoveFailure] = useState<string>();
  const busy = asking || moving;
  const failure = askFailure ?? moveFailure;
  const [move, setMove] = useState<AskedMove | null>(null);
  const [asked, setAsked] = useState<ReleaseAction | null>(null);
  const [showing, setShowing] = useState<AppVersion>();
  const builds = buildsApp(app, identity) && !app.archived;
  const acts = builds || decidesRequests(identity);
  const current = app.currentVersion;
  // The draft is read as the move is asked for: the dialog says whether it
  // discards changes, and the publish goes over that revision.
  const askMove = (wanted: Move): void => {
    void run(async (session) => {
      const draft = await session.apps.drafts.get(app.id);
      setMove({
        ...wanted,
        revision: draft.revision,
        discards: draft.changed.length > 0,
      });
    });
  };
  const confirm = async ({ version, revision }: AskedMove): Promise<void> => {
    setMove(null);
    setMoving(true);
    setMoveFailure(undefined);
    // Only over the version this page shows live: one a colleague
    // published since stays, and the page reads it again.
    const moved = await settled(
      core,
      async (session) =>
        await session.apps.versions.publish(
          app.id,
          version.version,
          revision,
          current
        )
    );
    setMoving(false);
    // Read again whatever core answered, so the list shows what is live.
    await router.invalidate({ sync: true });
    if (!moved.ok) {
      setMoveFailure(publishFailureText(moved.error));
    }
  };
  if (versions.length === 0) {
    return (
      <p className="text-muted-foreground">
        <Trans>
          Nothing shared yet: the first time you share it shows here.
        </Trans>
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <ErrorText>{failure}</ErrorText>
      <ItemGroup render={<ol />} variant="card">
        {versions.map((each) => (
          <VersionItem
            by={
              each.author === identity.userId
                ? t`You`
                : (people.get(each.author) ?? each.author)
            }
            key={each.version}
            live={each.version === current}
            menu={
              acts ? (
                <VersionMenu
                  app={app.id}
                  builds={builds}
                  current={current}
                  disabled={busy}
                  onAsk={setAsked}
                  onMove={askMove}
                  onShowChanges={() => {
                    setShowing(each);
                  }}
                  release={releases.get(each.version)}
                  version={each}
                />
              ) : null
            }
            release={releases.get(each.version)}
            version={each}
          />
        ))}
      </ItemGroup>
      {next === null ? null : (
        <div>
          <Button disabled={more} onClick={onMore} size="sm" variant="outline">
            <Trans>Show older versions</Trans>
          </Button>
        </div>
      )}
      <MoveDialog
        admin={isAdmin(identity.role)}
        move={move}
        onConfirm={(confirmed) => {
          void confirm(confirmed);
        }}
        onOpenChange={(open) => {
          if (!open) {
            setMove(null);
          }
        }}
      />
      {showing === undefined ? null : (
        <VersionChanges
          app={app.id}
          onClose={() => {
            setShowing(undefined);
          }}
          version={showing}
        />
      )}
      {asked === null ? null : (
        <ReleaseDialog
          action={asked}
          app={app.id}
          label={
            versions.find(({ version }) => version === asked.version)?.label ??
            null
          }
          onChanged={onRelease}
          onClose={() => {
            setAsked(null);
          }}
        />
      )}
    </div>
  );
};

/**
 * The releases of a page of the App's versions, from before `before`, for
 * an admin; none for anyone else. A refusal stays one: unknown releases
 * aren't shown as none.
 */
const releasesOf = async (
  core: Pick<CoreConnection, "withSession">,
  app: string,
  admin: boolean,
  before: number | undefined,
  left?: AbortSignal
): Promise<Loaded<AppRelease[]>> => {
  if (!admin) {
    return { state: "ready", data: [] };
  }
  return await loadFromCore(
    core,
    async (session) => await session.apps.versions.releases(app, before),
    left
  );
};

/** The App's versions, read when History opens, a page at a time. */
const Published = ({
  app,
  identity,
}: {
  app: ViewedApp;
  identity: Pick<Identity, "userId" | "role" | "staff">;
}) => {
  const core = useCore();
  const [pages, setPages] = useState<Loaded<AppVersion[]>[]>([]);
  const [people, setPeople] = useState<ReadonlyMap<string, string>>(new Map());
  // The releases' reads, a page at a time, kept to show one that failed.
  const [releaseReads, setReleaseReads] = useState<Loaded<AppRelease[]>[]>([]);
  const [reading, setReading] = useState(false);
  // The newest page's read, aborted as the next starts: an older page read
  // under it is dropped then, as it continues pages that are gone.
  const newest = useRef<AbortController | null>(null);
  const [releases, setReleases] = useState<ReadonlyMap<number, AppRelease>>(
    new Map()
  );
  const admin = decidesRequests(identity);
  const keep = (read: readonly AppRelease[]): void => {
    setReleases((held) => {
      const next = new Map(held);
      for (const release of read) {
        next.set(release.version, release);
      }
      return next;
    });
  };
  // The newest page again whenever the App's versions move.
  const moved = app.currentVersion;
  useEffect(() => {
    const left = new AbortController();
    newest.current = left;
    const read = async (): Promise<void> => {
      const [loaded, found, named] = await Promise.all([
        loadFromCore(
          core,
          async (session) => await session.apps.versions.list(app.id),
          left.signal
        ),
        releasesOf(core, app.id, admin, undefined, left.signal),
        loadFromCore(core, readPeople, left.signal),
      ]);
      if (!left.signal.aborted) {
        setReading(false);
        setPages([loaded]);
        setReleaseReads([found]);
        setPeople(named.state === "ready" ? named.data : new Map());
        setReleases(
          new Map(
            (found.state === "ready" ? found.data : []).map((release) => [
              release.version,
              release,
            ])
          )
        );
      }
    };
    void read();
    return () => {
      left.abort();
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `moved` says when to read again
  }, [admin, app.id, core, moved]);
  const [first] = pages;
  if (first === undefined) {
    return <LoadingLines lines={3} />;
  }
  const failed = [...pages, ...releaseReads].find(
    (page) => page.state !== "ready"
  );
  if (failed !== undefined) {
    return <NotLoaded page={failed} />;
  }
  const versions = pages.flatMap((page) =>
    page.state === "ready" ? page.data : []
  );
  const last = pages.at(-1);
  const oldest = versions.at(-1)?.version ?? null;
  const full = last?.state === "ready" && last.data.length === pageSize;
  const more = async (): Promise<void> => {
    // One older page at a time: a second click would read the same one.
    if (oldest === null || reading) {
      return;
    }
    const under = newest.current?.signal;
    setReading(true);
    const [loaded, read] = await Promise.all([
      loadFromCore(
        core,
        async (session) => await session.apps.versions.list(app.id, oldest),
        under
      ),
      releasesOf(core, app.id, admin, oldest, under),
    ]);
    // The newest page was read again meanwhile: this page followed pages
    // that are gone, and the list goes on from the new one instead.
    if (under?.aborted === true) {
      return;
    }
    setPages((held) => [...held, loaded]);
    setReleaseReads((held) => [...held, read]);
    if (read.state === "ready") {
      keep(read.data);
    }
    setReading(false);
  };
  return (
    <VersionsView
      app={app}
      identity={identity}
      more={reading}
      next={full ? oldest : null}
      onMore={() => {
        void more();
      }}
      onRelease={(release) => {
        keep([release]);
      }}
      people={people}
      releases={releases}
      versions={versions}
    />
  );
};

/**
 * History: the App's unpublished changes, for its builders, while it has
 * any, then its published versions.
 */
export const AppHistory = ({
  app,
  identity,
}: {
  app: ViewedApp;
  identity: Pick<Identity, "userId" | "role" | "staff">;
}) => (
  <div className="flex flex-col gap-8">
    {buildsApp(app, identity) && !app.archived ? (
      <Unpublished app={app.id} />
    ) : null}
    <section aria-labelledby="app-published" className="flex flex-col gap-3">
      <h3
        className="flex items-center gap-2 text-base font-medium"
        id="app-published"
      >
        <HistoryIcon aria-hidden className="size-4" />
        <Trans>Versions</Trans>
      </h3>
      <Published app={app} identity={identity} />
    </section>
  </div>
);
