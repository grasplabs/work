import type { AppRelease, AppVersion, ViewedApp } from "@grasp-os/shared/apps";
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
import { Button } from "@grasp-os/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { EllipsisIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import type { CoreConnection } from "../core-connection.ts";
import { decidesRequests } from "../dashboard/waiting.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import { LoadingLines } from "../frame/page-states.tsx";
import { loadFromCore, NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { buildsApp } from "./app-role.ts";
import {
  ReleaseBadges,
  ReleaseDialog,
  ReleaseMenuItems,
} from "./release-controls.tsx";
import type { ReleaseAction } from "./release-controls.tsx";

// A domain's versions on its page: every version of its App, newest first,
// which one runs and which is up for review, and, for its builders, making
// one current: the one up for review, or an earlier one to roll back to
// (`apps.versions.setCurrent`, over the version current as shown, so a
// change made meanwhile is refused rather than undone). Core makes it
// current only through a candidate it verified, and, for anyone but an
// admin, asks again for the App's permissions to connections, workflows
// and other Apps, which allow nothing until an admin grants them again;
// the dialog says so. A version's actions are a menu, so revoking a
// version or holding it for legal reasons can join them.

/** One more page of versions: core lists at most 100 at a time. */
const pageSize = 100;

/** What making `version` current would be, against `current`. */
interface Move {
  version: number;
  rollback: boolean;
}

/** The confirmation of a move: what it does, and that it asks again for permissions. */
const MoveDialog = ({
  move,
  admin,
  onConfirm,
  onOpenChange,
}: {
  move: Move | null;
  admin: boolean;
  onConfirm: (move: Move) => void;
  onOpenChange: (open: boolean) => void;
}) => {
  const version = move?.version ?? 0;
  return (
    <AlertDialog onOpenChange={onOpenChange} open={move !== null}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {move?.rollback === true ? (
              <Trans>Roll back to version {version}?</Trans>
            ) : (
              <Trans>Make version {version} current?</Trans>
            )}
          </AlertDialogTitle>
          <AlertDialogDescription>
            <Trans>
              Its apps and workflows run on it from now on. Grasp checks and
              builds it first, and refuses if the version that runs changed
              since you looked.
            </Trans>{" "}
            {admin ? null : (
              <Trans>
                Its permissions on connections, to start workflows and to call
                other domains wait for an admin to grant them again.
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
          >
            {move?.rollback === true ? (
              <Trans>Roll back</Trans>
            ) : (
              <Trans>Make current</Trans>
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

/** A version's release as an admin sees it: revoked, or held. */
const VersionRelease = ({ release }: { release: AppRelease | undefined }) =>
  release === undefined ? null : <ReleaseBadges release={release} />;

/**
 * A version's own actions: for a builder, what moving to it would be; for
 * an admin, what they may do to its release.
 */
const VersionActions = ({
  version,
  current,
  builds,
  release,
  disabled,
  onMove,
  onAsk,
}: {
  version: number;
  current: number | null;
  builds: boolean;
  /** Its sealed release, for an admin; none for anyone else. */
  release: AppRelease | undefined;
  disabled: boolean;
  onMove: (move: Move) => void;
  onAsk: (action: ReleaseAction) => void;
}) => {
  const { t } = useLingui();
  const moves = builds && version !== current;
  if (!moves && release === undefined) {
    return null;
  }
  const rollback = current !== null && version < current;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        render={
          <Button
            aria-label={t`Actions for version ${version}`}
            size="icon-sm"
            variant="ghost"
          />
        }
      >
        <EllipsisIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {moves ? (
          <DropdownMenuItem
            onClick={() => {
              onMove({ version, rollback });
            }}
          >
            {rollback ? (
              <Trans>Roll back to this version</Trans>
            ) : (
              <Trans>Make current</Trans>
            )}
          </DropdownMenuItem>
        ) : null}
        {release === undefined ? null : (
          <ReleaseMenuItems onAsk={onAsk} release={release} />
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/**
 * The versions as read, with making one current for a builder, and their
 * releases, revoked or held, for an admin.
 */
export const VersionsView = ({
  app,
  identity,
  versions,
  releases,
  next,
  onMore,
  onRelease,
}: {
  app: ViewedApp;
  identity: Pick<Identity, "userId" | "role" | "staff">;
  versions: readonly AppVersion[];
  /** Each sealed version's release, by version: read for admins only. */
  releases: ReadonlyMap<number, AppRelease>;
  /** Where an older page starts; null once every version is listed. */
  next: number | null;
  onMore: () => void;
  /** A release as core answered a change to it. */
  onRelease: (release: AppRelease) => void;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const [move, setMove] = useState<Move | null>(null);
  const [asked, setAsked] = useState<ReleaseAction | null>(null);
  const builds = buildsApp(app, identity) && app.status !== "archived";
  const acts = builds || decidesRequests(identity);
  const current = app.currentVersion;
  const confirm = async ({ version }: Move): Promise<void> => {
    setMove(null);
    await run(async (session) => {
      await changeThenRefresh(
        async () => {
          // Over the version current as shown: a change since is refused.
          await session.apps.versions.setCurrent(app.id, version, current);
        },
        async () => {
          await router.invalidate({ sync: true });
        }
      );
    });
  };
  if (versions.length === 0) {
    return (
      <p className="text-muted-foreground">
        <Trans>No version yet: its builders make the first in a chat.</Trans>
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <ErrorText>{failure}</ErrorText>
      <div className="bg-card overflow-hidden rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-28" variant="card">
                <Trans>Version</Trans>
              </TableHead>
              <TableHead variant="card">
                <Trans>What changed</Trans>
              </TableHead>
              <TableHead className="w-48" variant="card">
                <Trans>Made</Trans>
              </TableHead>
              {acts ? (
                <TableHead className="w-12" variant="card">
                  <span className="sr-only">
                    <Trans>Actions</Trans>
                  </span>
                </TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {versions.map((each) => (
              <TableRow key={each.version}>
                <TableCell variant="card">
                  <span className="flex flex-wrap items-center gap-2">
                    {each.version}
                    {each.version === current ? (
                      <Badge variant="secondary">
                        <Trans>Current</Trans>
                      </Badge>
                    ) : null}
                    {each.version === app.pendingVersion ? (
                      <Badge variant="outline">
                        <Trans>Up for review</Trans>
                      </Badge>
                    ) : null}
                    <VersionRelease release={releases.get(each.version)} />
                  </span>
                </TableCell>
                <TableCell variant="card">
                  <span className="flex flex-col">
                    <span>{each.message}</span>
                    {each.proposedBy === null ? null : (
                      <span className="text-muted-foreground text-xs">
                        <Trans>Written in a chat</Trans>
                      </span>
                    )}
                  </span>
                </TableCell>
                <TableCell variant="card">
                  <time dateTime={each.createdAt}>
                    {formatDateTime(each.createdAt)}
                  </time>
                  {each.author === identity.userId ? (
                    <span className="text-muted-foreground"> {t`by you`}</span>
                  ) : null}
                </TableCell>
                {acts ? (
                  <TableCell className="text-right" variant="card">
                    <VersionActions
                      builds={builds}
                      current={current}
                      disabled={busy}
                      onAsk={setAsked}
                      onMove={setMove}
                      release={releases.get(each.version)}
                      version={each.version}
                    />
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {next === null ? null : (
        <div>
          <Button onClick={onMore} size="sm" variant="outline">
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
      {asked === null ? null : (
        <ReleaseDialog
          action={asked}
          app={app.id}
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
 * an admin; none for anyone else, or when core refuses.
 */
const releasesOf = async (
  core: Pick<CoreConnection, "withSession">,
  app: string,
  admin: boolean,
  before: number | undefined,
  left?: AbortSignal
): Promise<AppRelease[]> => {
  if (!admin) {
    return [];
  }
  const loaded = await loadFromCore(
    core,
    async (session) => await session.apps.versions.releases(app, before),
    left
  );
  return loaded.state === "ready" ? loaded.data : [];
};

/** The domain's versions, read when its tab opens, a page at a time. */
export const AppVersions = ({
  app,
  identity,
}: {
  app: ViewedApp;
  identity: Pick<Identity, "userId" | "role" | "staff">;
}) => {
  const core = useCore();
  const [pages, setPages] = useState<Loaded<AppVersion[]>[]>([]);
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
  const moved = `${app.currentVersion ?? ""}/${app.pendingVersion ?? ""}`;
  useEffect(() => {
    const left = new AbortController();
    const read = async (): Promise<void> => {
      const [loaded, found] = await Promise.all([
        loadFromCore(
          core,
          async (session) => await session.apps.versions.list(app.id),
          left.signal
        ),
        releasesOf(core, app.id, admin, undefined, left.signal),
      ]);
      if (!left.signal.aborted) {
        setPages([loaded]);
        setReleases(
          new Map(found.map((release) => [release.version, release]))
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
  if (pages.some((page) => page.state !== "ready")) {
    const failed = pages.find((page) => page.state !== "ready") ?? first;
    return <NotLoaded page={failed} />;
  }
  const versions = pages.flatMap((page) =>
    page.state === "ready" ? page.data : []
  );
  const last = pages.at(-1);
  const oldest = versions.at(-1)?.version ?? null;
  const full = last?.state === "ready" && last.data.length === pageSize;
  const more = async (): Promise<void> => {
    if (oldest === null) {
      return;
    }
    const [loaded, read] = await Promise.all([
      loadFromCore(
        core,
        async (session) => await session.apps.versions.list(app.id, oldest)
      ),
      releasesOf(core, app.id, admin, oldest),
    ]);
    setPages((held) => [...held, loaded]);
    keep(read);
  };
  return (
    <VersionsView
      app={app}
      identity={identity}
      next={full ? oldest : null}
      onMore={() => {
        void more();
      }}
      onRelease={(release) => {
        keep([release]);
      }}
      releases={releases}
      versions={versions}
    />
  );
};
