import { isGeneratedServerFile } from "@grasp-os/runtime/host";
import type { AppRelease, FileDiff } from "@grasp-os/shared/apps";
import type { Draft, DraftCheckpoint, Version } from "@grasp-os/shared/drafts";
import { failureText } from "@grasp-os/shared/errors";
import type { Identity } from "@grasp-os/shared/rpc";
import type { Subject } from "@grasp-os/shared/subject";
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

import { FileChanges } from "../apps/draft-changes.tsx";
import {
  ReleaseBadges,
  ReleaseDialog,
  ReleaseMenuItems,
} from "../apps/release-controls.tsx";
import type { ReleaseAction } from "../apps/release-controls.tsx";
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
import { isConflict, publishFailureText, settled } from "./publish-errors.ts";
import { hasChanges, useDraft } from "./use-draft.ts";

// The history of an App or a workflow, in its settings, as a deployments
// list reads: on top, while its draft has some, the changes only its
// builders see, each checkpoint core keeps of the draft (core's
// drafts.ts): who, through Grasp's chat or by hand, when, and the files it
// touched, each to restore (and, for an App, to preview read-only in its
// workspace), and the draft to discard. Below, every published version,
// newest first: its label, the live one marked, its note, who published
// it and when, and a menu to see what it changed against the version
// before it, preview an App's, or roll back to it (`versions.rollback`).
// The draft is reset to the version rolled back to, so the dialog says
// when that discards unpublished changes, and goes over the draft's
// revision it read then: a draft changed meanwhile is refused rather than
// lost. An admin revokes an App's release or holds it from the same menu
// (release-controls.tsx). Restoring and discarding name the draft's
// revision the person saw too. Apps and workflows have the one history.

/** One more page of versions: core lists at most 100 at a time. */
const pageSize = 100;

/** Most files a checkpoint's line names before it counts the rest. */
const namedFiles = 3;

/** What a version is called: its label, or, never live, that it wasn't. */
const VersionName = ({ version }: { version: Version }) =>
  version.label === null ? (
    <Trans>Not shared yet</Trans>
  ) : (
    <span className="font-mono">{version.label}</span>
  );

/**
 * The version `version` was made from, to compare it with: an App's
 * parent, or a workflow's version before it; none for a first.
 */
const parentOf = (version: Version): number | null => {
  if (version.kind === "app") {
    return version.parent;
  }
  return version.version > 1 ? version.version - 1 : null;
};

// -- Changes only its builders see ----------------------------------------

/** What changing the draft from here asks the person to confirm. */
export type Asked = { kind: "restore"; number: number } | { kind: "discard" };

/**
 * Restores checkpoint `number` of the draft, or discards the draft, over
 * `revision`, the one the person saw: `onChanged` once it did; the
 * refusal otherwise.
 */
export const useDraftChange = (
  subject: Subject,
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
        ? session.drafts.restore(subject, asked.number, revision)
        : session.drafts.discard(subject, revision));
    });
    setBusy(false);
    if (!done.ok) {
      setFailure(
        isConflict(done.error)
          ? t`Someone changed it meanwhile. Look at its history again, then try again.`
          : failureText(done.error)
      );
      return;
    }
    onChanged();
  };
  return { busy, failure, change };
};

/** Asks before restoring a checkpoint or discarding the draft. */
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
              They go, for everyone who builds it. Its history in Settings keeps
              them, so you can bring them back.
            </Trans>
          ) : (
            <Trans>
              Your changes go back to how they were then, for everyone who
              builds it. What came after stays in its history.
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

/** Who made a checkpoint, and how, as its line says it. */
const CheckpointTitle = ({
  checkpoint,
  name,
}: {
  checkpoint: DraftCheckpoint;
  name: string;
}) => {
  if (checkpoint.restoredFrom !== null) {
    return <Trans>{name} restored an earlier state</Trans>;
  }
  return checkpoint.chatId === null ? (
    <Trans>{name} edited it</Trans>
  ) : (
    <Trans>Grasp, in {name}&apos;s chat</Trans>
  );
};

/** The files a checkpoint touched, a few by name and a count of the rest. */
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
 * The checkpoints of the draft's unpublished changes, newest first: those
 * after the last a publish or roll back left (which changes nothing over
 * the version it is over).
 */
const unpublishedCheckpoints = (
  checkpoints: readonly DraftCheckpoint[]
): DraftCheckpoint[] => {
  const published = checkpoints.findIndex(({ changes }) => changes === 0);
  return published === -1 ? [...checkpoints] : checkpoints.slice(0, published);
};

/** The checkpoints and people's names, as read at the draft's revision. */
interface CheckpointsRead {
  checkpoints: DraftCheckpoint[];
  people: ReadonlyMap<string, string>;
}

/** The draft's checkpoints, read again at each of its revisions. */
const useCheckpoints = (
  subject: Subject,
  revision: number
): CheckpointsRead | undefined | "failed" => {
  const core = useCore();
  const { kind, id } = subject;
  const [read, setRead] = useState<{
    key: string;
    read: CheckpointsRead | "failed";
  }>();
  const key = `${kind}:${id}:${revision}`;
  useEffect(() => {
    let current = true;
    const load = async (): Promise<void> => {
      const found = await settled(core, async (session) => {
        const [checkpoints, people] = await Promise.all([
          session.drafts.checkpoints({ kind, id }),
          readPeople(session),
        ]);
        return { checkpoints, people };
      });
      if (current) {
        setRead({ key, read: found.ok ? found.value : "failed" });
      }
    };
    void load();
    return () => {
      current = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `revision` says when to read again
  }, [core, kind, id, key, revision]);
  return read?.key === key ? read.read : undefined;
};

/** See it: an App's checkpoint, read-only in its workspace. */
const SeeCheckpoint = ({ app, number }: { app: string; number: number }) => (
  <Link
    className={buttonVariants({ size: "sm", variant: "ghost" })}
    params={{ app }}
    search={{ point: number }}
    to="/apps/$app"
  >
    <EyeIcon data-icon="inline-start" />
    <Trans>See it</Trans>
  </Link>
);

/** One checkpoint: who, when and what; restored from here. */
const CheckpointItem = ({
  subject,
  checkpoint,
  name,
  latest,
  busy,
  onRestore,
}: {
  subject: Subject;
  checkpoint: DraftCheckpoint;
  name: string;
  latest: boolean;
  busy: boolean;
  onRestore: () => void;
}) => (
  <Item render={<li />} size="sm" variant="row">
    <ItemContent>
      <ItemTitle>
        <CheckpointTitle checkpoint={checkpoint} name={name} />
        {latest ? (
          <Badge variant="secondary">
            <Trans>Now</Trans>
          </Badge>
        ) : null}
      </ItemTitle>
      <ItemDescription>
        <time dateTime={checkpoint.createdAt}>
          {formatSince(checkpoint.createdAt)}
        </time>
        {checkpoint.touched.length === 0 ? null : (
          <span className="block truncate font-mono text-xs">
            {touchedText(checkpoint.touched)}
          </span>
        )}
      </ItemDescription>
    </ItemContent>
    {latest ? null : (
      <ItemActions>
        {subject.kind === "app" ? (
          <SeeCheckpoint app={subject.id} number={checkpoint.number} />
        ) : null}
        <Button disabled={busy} onClick={onRestore} size="sm" variant="outline">
          <Trans>Restore</Trans>
        </Button>
      </ItemActions>
    )}
  </Item>
);

/**
 * The draft's unpublished changes, its checkpoints, and discarding it;
 * once they were undone (the draft changes nothing), the checkpoints they
 * left, to restore, while there are any.
 */
const DraftCheckpoints = ({
  draft,
  onChanged,
}: {
  draft: Draft;
  onChanged: () => void;
}) => {
  const { t } = useLingui();
  const { subject } = draft;
  const read = useCheckpoints(subject, draft.revision);
  const [asked, setAsked] = useState<Asked>();
  const { busy, failure, change } = useDraftChange(
    subject,
    draft.revision,
    onChanged
  );
  const checkpoints =
    typeof read === "object" ? unpublishedCheckpoints(read.checkpoints) : [];
  const changing = hasChanges(draft);
  // Undone, the draft is none of its checkpoints: each is one to restore.
  const [newest] = changing ? checkpoints : [];
  if (!changing && checkpoints.length === 0) {
    return null;
  }
  return (
    <section
      aria-labelledby="draft-unpublished"
      className="flex flex-col gap-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-medium" id="draft-unpublished">
          {changing ? (
            <Trans>Changes only you see</Trans>
          ) : (
            <Trans>Undone changes</Trans>
          )}
        </h3>
        <span className="flex-1" />
        {changing ? (
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
        ) : null}
      </div>
      <ErrorText>{failure}</ErrorText>
      {read === undefined ? <LoadingLines lines={2} /> : null}
      {read === "failed" ? (
        <ErrorText>{t`The history of your changes couldn't be read. Try again in a moment.`}</ErrorText>
      ) : null}
      {checkpoints.length === 0 ? null : (
        <ItemGroup render={<ol />} variant="card">
          {checkpoints.map((checkpoint) => (
            <CheckpointItem
              busy={busy}
              checkpoint={checkpoint}
              key={checkpoint.number}
              latest={checkpoint.number === newest?.number}
              name={
                typeof read === "object"
                  ? (read.people.get(checkpoint.personId) ??
                    checkpoint.personId)
                  : checkpoint.personId
              }
              onRestore={() => {
                setAsked({ kind: "restore", number: checkpoint.number });
              }}
              subject={subject}
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

/**
 * The draft's unpublished changes, followed as it is written, or the
 * checkpoints of those undone; none without either.
 */
const Unpublished = ({ subject }: { subject: Subject }) => {
  const { draft, reread } = useDraft(subject, 0);
  return draft === undefined ? null : (
    <DraftCheckpoints draft={draft} onChanged={reread} />
  );
};

// -- Published versions ----------------------------------------------------

/** Making `version` live again, against the live one. */
interface Move {
  version: Version;
  rollback: boolean;
}

/** A move, with the draft as read when it was asked for. */
interface AskedMove extends Move {
  /** The draft's revision then, which the roll back goes over. */
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

/**
 * What a move does: an App's pages and workflows run on it; a workflow's
 * triggers start it, while runs going keep their version.
 */
const MoveText = ({ kind }: { kind: Subject["kind"] }) => {
  if (kind === "workflow") {
    return (
      <Trans>
        Its triggers start it from now on; runs already going keep their
        version. Grasp checks it first.
      </Trans>
    );
  }
  return (
    <Trans>
      Its pages and workflows run on it from now on. Grasp checks and builds it
      first.
    </Trans>
  );
};

/** The confirmation of a move: what it does, and what it drops. */
const MoveDialog = ({
  kind,
  move,
  onConfirm,
  onOpenChange,
}: {
  kind: Subject["kind"];
  move: AskedMove | null;
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
            <MoveText kind={kind} />
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
  subject,
  version,
  onClose,
}: {
  subject: Subject;
  version: Version;
  onClose: () => void;
}) => {
  const { t } = useLingui();
  const core = useCore();
  const [read, setRead] = useState<Loaded<FileDiff[]>>();
  const { kind, id } = subject;
  const parent = parentOf(version);
  useEffect(() => {
    const left = new AbortController();
    const load = async (): Promise<void> => {
      if (parent === null) {
        return;
      }
      const found = await loadFromCore(
        core,
        async (session) => {
          const diffs = await session.versions.diff(
            { kind, id },
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
  }, [core, kind, id, parent, version.version]);
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

/** See this version: an App's, read-only in its workspace. */
const SeeVersion = ({ app, version }: { app: string; version: number }) => (
  <DropdownMenuItem
    render={<Link params={{ app }} search={{ version }} to="/apps/$app" />}
  >
    <EyeIcon />
    <Trans>See this version</Trans>
  </DropdownMenuItem>
);

/** A version's menu: its changes, its preview, rolling back, its release. */
const VersionMenu = ({
  subject,
  version,
  live,
  builds,
  release,
  disabled,
  onShowChanges,
  onMove,
  onAsk,
}: {
  subject: Subject;
  version: Version;
  live: number | null;
  builds: boolean;
  /** Its sealed release, for an admin; none for anyone else. */
  release: AppRelease | undefined;
  disabled: boolean;
  onShowChanges: () => void;
  onMove: (move: Move) => void;
  onAsk: (action: ReleaseAction) => void;
}) => {
  const { t } = useLingui();
  // A revoked version can't be made live again: core refuses it.
  const moves =
    builds && version.version !== live && (release?.revokedAt ?? null) === null;
  const rollback = live !== null && version.version < live;
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
        {parentOf(version) === null ? null : (
          <DropdownMenuItem onClick={onShowChanges}>
            <GitCompareArrowsIcon />
            <Trans>View changes</Trans>
          </DropdownMenuItem>
        )}
        {builds && subject.kind === "app" ? (
          <SeeVersion app={subject.id} version={version.version} />
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
  details,
  menu,
}: {
  version: Version;
  live: boolean;
  release: AppRelease | undefined;
  /** Who published it, as the list names them. */
  by: string;
  /** What its kind says of it besides (`DraftHistory`'s `details`). */
  details: ReactNode;
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
        {details}
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

/** What the versions list knows of the subject and the reader. */
interface VersionsOf {
  subject: Subject;
  /** The version live now; null before the first. */
  live: number | null;
  /** Whether the reader builds it: rolls back, previews, restores. */
  builds: boolean;
  identity: Pick<Identity, "userId" | "role" | "staff">;
  /** What its kind says of a version besides, under its note. */
  renderDetails?: ((version: Version) => ReactNode) | undefined;
}

/**
 * The versions as read, newest first, with what each changed, and rolling
 * back for a builder, and an App's releases, revoked or held, for an
 * admin.
 */
const VersionsView = ({
  subject,
  live,
  builds,
  identity,
  renderDetails,
  versions,
  releases,
  people,
  next,
  more = false,
  onMore,
  onRelease,
}: VersionsOf & {
  versions: readonly Version[];
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
  const [showing, setShowing] = useState<Version>();
  // An App's admins revoke and hold its releases from the menu too.
  const acts = builds || (subject.kind === "app" && decidesRequests(identity));
  // The draft is read as the move is asked for: the dialog says whether it
  // discards changes, and the roll back goes over that revision.
  const askMove = (wanted: Move): void => {
    void run(async (session) => {
      const draft = await session.drafts.get(subject);
      setMove({
        ...wanted,
        revision: draft.revision,
        discards: hasChanges(draft),
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
        await session.versions.rollback(
          subject,
          version.version,
          revision,
          live
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
            details={renderDetails?.(each)}
            key={each.version}
            live={each.version === live}
            menu={
              acts ? (
                <VersionMenu
                  builds={builds}
                  disabled={busy}
                  live={live}
                  onAsk={setAsked}
                  onMove={askMove}
                  onShowChanges={() => {
                    setShowing(each);
                  }}
                  release={releases.get(each.version)}
                  subject={subject}
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
        kind={subject.kind}
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
          onClose={() => {
            setShowing(undefined);
          }}
          subject={subject}
          version={showing}
        />
      )}
      {asked === null || subject.kind !== "app" ? null : (
        <ReleaseDialog
          action={asked}
          app={subject.id}
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
 * The releases of a page of an App's versions, from before `before`, for
 * an admin; none for anyone else, nor for a workflow, which has none. A
 * refusal stays one: unknown releases aren't shown as none.
 */
const releasesOf = async (
  core: Pick<CoreConnection, "withSession">,
  subject: Subject,
  admin: boolean,
  before: number | undefined,
  left?: AbortSignal
): Promise<Loaded<AppRelease[]>> => {
  if (!admin || subject.kind !== "app") {
    return { state: "ready", data: [] };
  }
  return await loadFromCore(
    core,
    async (session) => await session.apps.releases.list(subject.id, before),
    left
  );
};

/** The versions, read when History opens, a page at a time. */
const Published = (of: VersionsOf) => {
  const { subject, live, identity } = of;
  const { kind, id } = subject;
  const core = useCore();
  const [pages, setPages] = useState<Loaded<Version[]>[]>([]);
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
  // The newest page again whenever the live version moves.
  useEffect(() => {
    const left = new AbortController();
    newest.current = left;
    const read = async (): Promise<void> => {
      const [loaded, found, named] = await Promise.all([
        loadFromCore(
          core,
          async (session) => await session.versions.list({ kind, id }),
          left.signal
        ),
        releasesOf(core, { kind, id }, admin, undefined, left.signal),
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
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `live` says when to read again
  }, [admin, kind, id, core, live]);
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
        async (session) => await session.versions.list({ kind, id }, oldest),
        under
      ),
      releasesOf(core, { kind, id }, admin, oldest, under),
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
      {...of}
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
 * History, an App's or a workflow's: the changes only its builders see,
 * for them, while it has any, then its published versions.
 */
export const DraftHistory = (of: VersionsOf) => (
  <div className="flex flex-col gap-8">
    {of.builds ? <Unpublished subject={of.subject} /> : null}
    <section aria-labelledby="draft-published" className="flex flex-col gap-3">
      <h3
        className="flex items-center gap-2 text-base font-medium"
        id="draft-published"
      >
        <HistoryIcon aria-hidden className="size-4" />
        <Trans>Versions</Trans>
      </h3>
      <Published {...of} />
    </section>
  </div>
);
