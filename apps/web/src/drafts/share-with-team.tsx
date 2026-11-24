import { isGeneratedServerFile } from "@grasp-os/runtime/host";
import type { AppReview } from "@grasp-os/shared/app-review";
import type { App } from "@grasp-os/shared/apps";
import type { Draft, DraftProblem } from "@grasp-os/shared/drafts";
import type { Subject } from "@grasp-os/shared/subject";
import type { SubjectMember } from "@grasp-os/shared/subject-members";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@grasp-os/ui/components/alert";
import { AvatarGroup } from "@grasp-os/ui/components/avatar";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import { KeyValueList } from "@grasp-os/ui/components/key-value";
import type { KeyValueItem } from "@grasp-os/ui/components/key-value";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { Text } from "@grasp-os/ui/components/text";
import { toast } from "@grasp-os/ui/components/toast";
import {
  CircleCheckIcon,
  DatabaseIcon,
  Icon,
  KeyIcon,
  LinkIcon,
  SparklesIcon,
  UploadIcon,
  UsersIcon,
} from "@grasp-os/ui/lib/icons";
import { font, space } from "@grasp-os/ui/lib/tokens.stylex";
import { i18n as pageI18n } from "@lingui/core";
import type { I18n } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { AppLinkDialog, linkAddress } from "../apps/app-own-link.tsx";
import { planLines } from "../apps/data-model-changes.tsx";
import {
  AccessChanges,
  ChangesSection,
  DataChanges,
  FileChanges,
  groupOf,
  groupOrder,
} from "../apps/draft-changes.tsx";
import type { FileGroup } from "../apps/draft-changes.tsx";
import { fixQuestion } from "../apps/fix-with-grasp.ts";
import { useGlobalChat } from "../chat/global-chat.tsx";
import { copyText } from "../copy.ts";
import type { Session } from "../core.ts";
import { formatList } from "../format.ts";
import { useCore } from "../use-core.ts";
import { ConfirmChange, useDraftChange } from "./draft-history.tsx";
import type { Asked } from "./draft-history.tsx";
import { isConflict, publishFailureText, settled } from "./publish-errors.ts";
import { memberNames, ShareMembersAccess } from "./sharing.tsx";
import { hasChanges } from "./use-draft.ts";

// The end of the bar of an App's workspace and of a workflow's page alike
// (`ShareWithTeam`): Share, then Publish, the page's one ink action.
//
// Share opens a dialog of whom it is shared with, as its Sharing settings
// list them (sharing.tsx), with Copy link.
//
// Publish opens a dialog that says where it stands (live and at which
// version, or not yet), an App's address, who can open it, and how the
// check of its changes stands, with what an admin approves first and
// what stops it, with Fix with Grasp. Publish makes the changes only the
// builders see what everyone it is shared with opens, with core's own
// call (`drafts.publish`, over the revision the dialog read, so a draft
// someone changed meanwhile is refused with `draft.conflict` and read
// again rather than published unseen). A toast says it is live, with Undo
// over a version the team had before: that version is theirs again
// (`versions.rollback` over the one just made, so a colleague's since
// stays), and the changes published are the builders' draft again
// (`drafts.restore`); confirmed first when it changed since. The toasts
// outlive the page, so Undo works after leaving it.
//
// Once it is shared, changes stay its builders' until they publish them:
// one slim line under the bar (`UnpublishedChanges`) says how many and of
// what, with Undo, which discards them once the person confirms
// (draft-history.tsx).

/**
 * What the dialog read of the draft's changes, at the draft's `revision`:
 * whether they pass their checks, what stops them, and, for an App, all
 * they change (`AppsApi.review`).
 */
interface Review {
  revision: number;
  passed: boolean;
  problems: readonly DraftProblem[];
  /** An App's changes, for its notes; none for a workflow. */
  app: AppReview | null;
}

/**
 * Reads the review of `subject`'s draft: its check, as core checks every
 * kind's (`drafts.check`), and an App's changes from core's review of
 * them, without what Grasp generates (`server/_generated/`), which every
 * save writes again and no one edits.
 */
const readReview = async (
  session: Session,
  subject: Subject
): Promise<Review> => {
  const [check, changes] = await Promise.all([
    session.drafts.check(subject),
    subject.kind === "app" ? session.apps.review(subject.id) : null,
  ]);
  return {
    // The older of the two reads: a write between them refuses the
    // publish (`draft.conflict`), and the dialog reads both again.
    revision: Math.min(check.revision, changes?.revision ?? check.revision),
    passed: check.passed,
    problems: check.problems,
    app:
      changes === null
        ? null
        : {
            ...changes,
            files: changes.files.filter(
              ({ path }) => !isGeneratedServerFile(path)
            ),
          },
  };
};

/** What the dialog read of the draft's changes, or why it couldn't. */
type ReviewRead =
  | { state: "ready"; review: Review }
  | { state: "failed"; text: string };

/**
 * The draft's changes, read at each write of the draft (`revision`) and
 * each time the dialog asks (`again`), while `reading` (the draft has
 * changes, and Grasp isn't writing it); otherwise the last read stays.
 * Publish never takes it for a later revision than it was read at.
 */
const useReview = (
  subject: Subject,
  revision: number,
  reading: boolean
): { read: ReviewRead | undefined; again: () => void } => {
  const core = useCore();
  const { kind, id } = subject;
  const key = `${kind}:${id}`;
  const [reads, setReads] = useState(0);
  const [read, setRead] = useState<{ key: string; read: ReviewRead }>();
  useEffect(() => {
    let current = true;
    const load = async (): Promise<void> => {
      if (!reading) {
        return;
      }
      // Not within a page read's few seconds: an App's check builds it.
      const found = await settled(
        core,
        async (session) => await readReview(session, { kind, id })
      );
      if (current) {
        setRead({
          key: `${kind}:${id}`,
          read: found.ok
            ? { state: "ready", review: found.value }
            : { state: "failed", text: publishFailureText(found.error) },
        });
      }
    };
    void load();
    return () => {
      current = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `revision` and `reads` say when to read again
  }, [core, kind, id, revision, reads, reading]);
  return {
    read: read?.key === key ? read.read : undefined,
    again: () => {
      setReads((before) => before + 1);
    },
  };
};

/** Whether publishing changes the App's records, as the dialog says once. */
const changesData = (changes: AppReview, i18n: I18n): boolean =>
  (changes.plan === null ? 0 : planLines(changes.plan, i18n).length) > 0 ||
  (changes.migrations?.length ?? 0) > 0;

/** How many files of `group` changed, as a change's summary says it. */
const groupCount = (group: FileGroup, count: number): string => {
  if (group === "pages") {
    return plural(count, { one: "# page", other: "# pages" });
  }
  if (group === "functions") {
    return plural(count, {
      one: "# part that works behind the pages",
      other: "# parts that work behind the pages",
    });
  }
  if (group === "data") {
    return plural(count, {
      one: "# change to its data",
      other: "# changes to its data",
    });
  }
  if (group === "tests") {
    return plural(count, { one: "# test", other: "# tests" });
  }
  return plural(count, { one: "# other file", other: "# other files" });
};

/** What an App's changes are, in a few words each: how many of what. */
const changeSummaries = (changes: AppReview): string[] =>
  groupOrder.flatMap((group) => {
    const count = changes.files.filter(
      ({ path }) => groupOf(path) === group
    ).length;
    return count === 0 ? [] : [groupCount(group, count)];
  });

// The bar's width (item-shell.tsx names it) below which Share folds into Publish.
const NARROW_BAR = "@container bar (width < 36rem)";

const styles = stylex.create({
  // Where the bar (item-shell.tsx) narrows, Share folds into Publish's
  // dialog and Publish is its icon alone, so the bar keeps one row.
  wide: { display: { default: "contents", [NARROW_BAR]: "none" } },
  narrow: { display: { default: "none", [NARROW_BAR]: "contents" } },
  stack: { display: "grid", gap: space[3], minWidth: 0 },
  // A fact's value with its own action after it.
  value: { display: "inline-flex", alignItems: "center", gap: space[2] },
  tight: {
    display: "grid",
    gap: space[1],
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  problem: { display: "grid", minWidth: 0 },
  where: { fontFamily: font.mono },
  strip: { flexShrink: 0 },
  // Who can open it, by name, for a screen reader: the faces say it to the eye.
  unseen: {
    position: "absolute",
    width: "1px",
    height: "1px",
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
  },
});

/** What stops the changes being published, the first few, and Fix with Grasp. */
const Problems = ({
  problems,
  onFix,
}: {
  problems: readonly DraftProblem[];
  onFix: () => void;
}) => {
  const { t } = useLingui();
  const shown = problems.slice(0, 3);
  const count = problems.length;
  const more = count - shown.length;
  return (
    <Alert variant="destructive">
      <AlertTitle>
        {t`${plural(count, {
          one: "It can't be published yet: # problem",
          other: "It can't be published yet: # problems",
        })}`}
      </AlertTitle>
      <AlertDescription>
        <ul aria-label={t`Problems`} {...stylex.props(styles.tight)}>
          {shown.map(({ at, line, message }, index) => (
            // A problem has no ID, and the same message may come twice.
            <li key={index} {...stylex.props(styles.problem)}>
              {at === null ? null : (
                <Text as="span" color="muted" size="xs">
                  <span {...stylex.props(styles.where)}>
                    {line === null ? at : `${at}:${line}`}
                  </span>
                </Text>
              )}
              <Text as="span" size="xs">
                {message}
              </Text>
            </li>
          ))}
          {more > 0 ? (
            <li>
              <Text as="span" color="muted" size="xs">
                <Plural one="and # more" other="and # more" value={more} />
              </Text>
            </li>
          ) : null}
        </ul>
      </AlertDescription>
      <AlertAction>
        <Button onClick={onFix} size="xs" variant="outline">
          <Icon icon={SparklesIcon} />
          {t`Fix with Grasp`}
        </Button>
      </AlertAction>
    </Alert>
  );
};

/** Everything an App's changes hold, folded away. */
const Summary = ({ changes }: { changes: AppReview }) => {
  const { t } = useLingui();
  return (
    <Collapsible>
      <CollapsibleTrigger>{t`What changes`}</CollapsibleTrigger>
      <CollapsibleContent asChild>
        <div {...stylex.props(styles.stack)}>
          <FileChanges files={changes.files} />
          <ChangesSection title={<Trans>Data</Trans>}>
            <DataChanges changes={changes} />
          </ChangesSection>
          <ChangesSection title={<Trans>Access</Trans>}>
            <AccessChanges changes={changes} />
          </ChangesSection>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};

/** What applies to an App's changes being published: their data, an admin's approval. */
const AppNotes = ({ changes }: { changes: AppReview }) => {
  const { t, i18n } = useLingui();
  const waiting = changes.permissions.length;
  return (
    <>
      {changes.files.length === 0 ? null : <Summary changes={changes} />}
      {changesData(changes, i18n) ? (
        <Alert appearance="subtle" icon={DatabaseIcon}>
          <AlertDescription>{t`It changes the App's data: see What changes.`}</AlertDescription>
        </Alert>
      ) : null}
      {waiting > 0 ? (
        <Alert appearance="subtle" icon={KeyIcon}>
          <AlertDescription>
            <Plural
              one="It uses # new kind of access. An admin approves that once."
              other="It uses # new kinds of access. An admin approves those once."
              value={waiting}
            />
          </AlertDescription>
        </Alert>
      ) : null}
    </>
  );
};

/** What applies to the changes being published: an App's notes, and problems. */
const ChangesNotes = ({
  review,
  onFix,
}: {
  review: Review;
  onFix: (problems: readonly DraftProblem[]) => void;
}) => (
  <div {...stylex.props(styles.stack)}>
    {review.app === null ? null : <AppNotes changes={review.app} />}
    {review.passed ? null : (
      <Problems
        onFix={() => {
          onFix(review.problems);
        }}
        problems={review.problems}
      />
    )}
  </div>
);

/**
 * What Undo puts back, when publishing made a new version live over one
 * the team had (`before`) from the draft at `revision`: that version again
 * over the new one (`made`), with the draft as it was published.
 */
interface Back {
  before: number;
  made: number;
  revision: number;
}

/**
 * What Undo works with: none of it state of a component, gone with it;
 * its words are read from the page's i18n, outside any component.
 */
interface UndoTools {
  core: ReturnType<typeof useCore>;
  router: ReturnType<typeof useRouter>;
  /** Told once it was undone, while the page still listens. */
  onDone: () => void;
}

/** Says Undo failed, in the page's words. */
const undoFailed = (error: unknown): void => {
  toast.error(publishFailureText(error));
};

/**
 * The draft as it was published (its checkpoint at `revision`) made the
 * draft again, over the draft as it is now: nothing, should no checkpoint
 * be at that revision.
 */
const restorePublished = async (
  session: Session,
  subject: Subject,
  revision: number
): Promise<void> => {
  const [checkpoints, now] = await Promise.all([
    session.drafts.checkpoints(subject),
    session.drafts.get(subject),
  ]);
  const published = checkpoints.find(
    (checkpoint) => checkpoint.revision === revision
  );
  if (published !== undefined) {
    await session.drafts.restore(subject, published.number, now.revision);
  }
};

/**
 * The version the team had before, live again over the draft at
 * `revision`, while the one publishing made still is: a colleague's since
 * stays. Then the draft as it was published is the draft again, over that
 * version, so nothing of the builders' work is left only in History: read
 * again and tried once more should someone write the draft in between
 * (`draft.conflict`). Should that fail too, the team has the version back
 * all the same, and the person is told the changes are in History, to
 * restore from there.
 */
const takeBack = async (
  { core, router, onDone }: UndoTools,
  subject: Subject,
  back: Back,
  revision: number
): Promise<void> => {
  const rolled = await settled(core, async (session) => {
    await session.versions.rollback(subject, back.before, revision, back.made);
  });
  const restore = async () =>
    await settled(core, async (session) => {
      await restorePublished(session, subject, back.revision);
    });
  let restored = rolled.ok ? await restore() : rolled;
  if (rolled.ok && !restored.ok && isConflict(restored.error)) {
    restored = await restore();
  }
  onDone();
  await router.invalidate({ sync: true });
  if (!rolled.ok) {
    undoFailed(rolled.error);
    return;
  }
  if (!restored.ok) {
    toast.warning(pageI18n._(msg`Your team has the version they had before`), {
      description: pageI18n._(
        msg`The changes you published couldn't be put back as the draft. They're in its History, to restore from there.`
      ),
    });
    return;
  }
  toast.success(pageI18n._(msg`Publishing undone`));
};

/**
 * Undo, from the toast that says it is live: puts back the version the
 * team had before, once the person confirms in a toast of its own when it
 * changed since. Works from the toast alone, after the page was left.
 */
const undoPublish = async (
  tools: UndoTools,
  subject: Subject,
  back: Back
): Promise<void> => {
  const draft = await settled(
    tools.core,
    async (session) => await session.drafts.get(subject)
  );
  if (!draft.ok) {
    undoFailed(draft.error);
    return;
  }
  const { revision } = draft.value;
  if (!hasChanges(draft.value)) {
    await takeBack(tools, subject, back, revision);
    return;
  }
  toast.warning(pageI18n._(msg`Give your team the version they had before?`), {
    description: pageI18n._(
      msg`It changed since you published it. Going back drops those changes, for everyone who builds it.`
    ),
    // It stays until it is answered: it asks something.
    duration: Number.POSITIVE_INFINITY,
    action: {
      label: pageI18n._(msg`Drop them and go back`),
      onAction: () => {
        void takeBack(tools, subject, back, revision);
      },
    },
  });
};

/**
 * The version publishing makes live as it is, with nothing live yet and
 * changes over it that change nothing (the first of an App made from a
 * blueprint); none otherwise, when the changes are what is published.
 */
const versionToPublish = (
  live: number | null,
  draft: Draft | undefined
): number | undefined =>
  draft !== undefined &&
  !hasChanges(draft) &&
  live === null &&
  draft.base !== null
    ? draft.base
    : undefined;

/** What is shared: the subject, its name, owner and live version. */
interface Shared {
  subject: Subject;
  name: string;
  /** Its owner, who has it always: never offered. */
  owner: string;
  /** The version live now; null before the first. */
  live: number | null;
}

/**
 * Publishes it: its changes (as `review` read them) or, with none, its
 * first version as it is; `onPublished` and a toast once done, with Undo
 * where the team had a version before; why not otherwise, and `again`
 * when it moved, so its changes are read again.
 */
const usePublishing = (
  { subject, name, live }: Shared,
  draft: Draft | undefined,
  {
    onPublished,
    again,
  }: {
    onPublished: () => void;
    again: () => void;
  }
) => {
  const { t } = useLingui();
  const core = useCore();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const version = versionToPublish(live, draft);
  const publish = async (review: Review | undefined): Promise<boolean> => {
    setBusy(true);
    setFailure(undefined);
    const before = live;
    const published = await settled(core, async (session) => {
      if (version !== undefined) {
        const rolled = await session.versions.rollback(
          subject,
          version,
          draft?.revision ?? 0,
          null
        );
        return rolled.version;
      }
      if (review !== undefined) {
        const made = await session.drafts.publish(subject, review.revision);
        return made.version;
      }
      return before;
    });
    setBusy(false);
    if (!published.ok) {
      setFailure(publishFailureText(published.error));
      // It moved: what changes is read again, to look at.
      if (isConflict(published.error)) {
        again();
      }
      return false;
    }
    onPublished();
    await router.invalidate({ sync: true });
    const made = published.value;
    // Nothing to go back to after a first version: Undo only over one.
    const back =
      before === null ||
      made === null ||
      made === before ||
      review === undefined
        ? undefined
        : { before, made, revision: review.revision };
    const tools = { core, router, onDone: onPublished };
    toast.success(
      t`${name} is live`,
      back === undefined
        ? {}
        : {
            action: {
              label: t`Undo`,
              onAction: () => {
                void undoPublish(tools, subject, back);
              },
            },
          }
    );
    return true;
  };
  return {
    busy,
    failure,
    publish,
    clear: () => {
      setFailure(undefined);
    },
  };
};

/**
 * The changes to publish, read while it has some and Grasp isn't working
 * on it, with whether they may be published now (`ready`) and Fix with
 * Grasp for what stops them.
 */
const usePublishable = (
  subject: Subject,
  draft: Draft | undefined,
  running: boolean
) => {
  const { t } = useLingui();
  const chat = useGlobalChat();
  const changing = hasChanges(draft);
  const { read, again } = useReview(
    subject,
    draft?.revision ?? 0,
    changing && !running
  );
  const review = read?.state === "ready" ? read.review : undefined;
  const current = review !== undefined && review.revision === draft?.revision;
  const fix = (problems: readonly DraftProblem[]): void => {
    void chat.ask(
      fixQuestion(
        t`Fix these problems the check found, so it can be published:`,
        problems
      )
    );
  };
  return {
    changing,
    read,
    again,
    /** The changes as read at the draft's revision; none while they're read. */
    review: current ? review : undefined,
    /** Whether the changes may be published now: read, passing, Grasp done. */
    ready: !changing || (current && review.passed && !running),
    fix,
  };
};

/** Where it stands, in one line with a dot: live and at which version, or not yet. */
const StateLine = ({
  live,
  label,
  changing,
}: {
  live: number | null;
  /** The live version's label, where the page has it (an App's). */
  label: string | undefined;
  changing: boolean;
}) => {
  const { t } = useLingui();
  if (live === null) {
    return (
      <Badge dot variant="warning">
        {t`Not live`}
      </Badge>
    );
  }
  const version = live;
  const named = label ?? t`Version ${version}`;
  return (
    <Badge dot variant="success">
      {changing ? t`Live, ${named}; changes not live yet` : t`Live, ${named}`}
    </Badge>
  );
};

/** How the changes' check stands, in words, and whether it is still going. */
const useCheckState = ({
  publishable,
  running,
  first,
}: {
  publishable: ReturnType<typeof usePublishable>;
  running: boolean;
  /** Whether its first version is published as it is, with no changes to check. */
  first: boolean;
}): { words: string; working: boolean } | undefined => {
  const { t } = useLingui();
  if (running || (publishable.changing && publishable.review === undefined)) {
    // Why the read failed stands under the facts.
    if (publishable.read?.state === "failed" && !running) {
      return undefined;
    }
    return {
      words: running ? t`Grasp is still working on it…` : t`Checking it…`,
      working: true,
    };
  }
  if (publishable.review?.passed === false) {
    // What stops it stands under the facts, with Fix with Grasp.
    return { words: t`Something to fix first`, working: false };
  }
  return {
    words:
      publishable.changing || first
        ? t`Checks pass`
        : t`Nothing new to publish`,
    working: false,
  };
};

/**
 * Publish's dialog: where it stands, an App's address, who can open it
 * and how its check stands, as facts, then what applies to the changes,
 * and Publish. Address and Who can open it each lead to their own dialog.
 */
const PublishDialog = ({
  open,
  onOpenChange,
  shared,
  app,
  members,
  publishable,
  running,
  first,
  failure,
  canPublish,
  onLink,
  onShare,
  onFix,
  onPublish,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shared: Shared;
  /** The App, for its address and live version's label; none for a workflow. */
  app: App | undefined;
  members: readonly SubjectMember[];
  publishable: ReturnType<typeof usePublishable>;
  running: boolean;
  /** Whether its first version is published as it is, with no changes to check. */
  first: boolean;
  /** Why publishing didn't go through. */
  failure: string | undefined;
  canPublish: boolean;
  onLink: () => void;
  onShare: () => void;
  onFix: (problems: readonly DraftProblem[]) => void;
  onPublish: () => void;
}) => {
  const { t } = useLingui();
  const { name, live } = shared;
  const who = memberNames(members);
  const check = useCheckState({ publishable, running, first });
  let says = t`Nothing changed since the live version.`;
  if (first) {
    says = t`Everyone it is shared with can open it once it is published.`;
  } else if (publishable.changing) {
    says = t`Your changes go live for everyone it is shared with.`;
  }
  const facts: KeyValueItem[] = [
    {
      id: "status",
      label: t({ message: "Status", context: "where an App stands" }),
      icon: UploadIcon,
      value: (
        <StateLine
          changing={publishable.changing}
          label={app?.liveLabel ?? undefined}
          live={live}
        />
      ),
    },
    ...(app === undefined
      ? []
      : [
          {
            id: "address",
            label: t`Address`,
            icon: LinkIcon,
            value: (
              <span {...stylex.props(styles.value)}>
                {app.link === null ? t`None yet` : linkAddress(app.link)}
                <Button onClick={onLink} size="xs" variant="outline">
                  {app.link === null ? t`Add` : t`Change`}
                </Button>
              </span>
            ),
          },
        ]),
    {
      id: "who",
      label: t`Who can open it`,
      icon: UsersIcon,
      value: (
        <span {...stylex.props(styles.value)}>
          {who.length === 0 ? (
            t`Only its builders`
          ) : (
            <>
              <AvatarGroup
                items={who.map((each) => ({ name: each }))}
                max={3}
              />
              <span {...stylex.props(styles.unseen)}>{formatList(who)}</span>
            </>
          )}
          <Button onClick={onShare} size="xs" variant="outline">
            {t`Manage`}
          </Button>
        </span>
      ),
    },
    ...(check === undefined
      ? []
      : [
          {
            id: "checks",
            label: t`Checks`,
            icon: CircleCheckIcon,
            value: check.working ? (
              <span {...stylex.props(styles.value)}>
                <Spinner />
                {check.words}
              </span>
            ) : (
              check.words
            ),
          },
        ]),
  ];
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t`Publish ${name}`}</DialogTitle>
          <DialogDescription>{says}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div {...stylex.props(styles.stack)}>
            <KeyValueList divided items={facts} orientation="horizontal" />
            {publishable.read?.state === "failed" ? (
              <Alert variant="destructive">
                <AlertTitle>{publishable.read.text}</AlertTitle>
              </Alert>
            ) : null}
            {publishable.review === undefined ? null : (
              <ChangesNotes onFix={onFix} review={publishable.review} />
            )}
            {failure === undefined ? null : (
              <Alert variant="destructive">
                <AlertTitle>{failure}</AlertTitle>
              </Alert>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <DialogClose>{t`Cancel`}</DialogClose>
          <Button disabled={!canPublish} onClick={onPublish}>
            {t`Publish`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** What Share's dialog says they'll find, for its kind, live or not yet. */
const useFoundUnder = ({ subject, live }: Shared): string => {
  const { t } = useLingui();
  if (subject.kind === "app") {
    return live === null
      ? t`They'll find it under Apps once it is published.`
      : t`They'll find it under Apps, and see it as it is now.`;
  }
  return live === null
    ? t`They'll find it under Workflows once it is published.`
    : t`They'll find it under Workflows, and run it as it is now.`;
};

/** Share's dialog: whom it is shared with, as its Sharing settings list them, with Copy link and Done. */
const ShareDialog = ({
  shared,
  members,
  open,
  onOpenChange,
  onShared,
}: {
  shared: Shared;
  members: readonly SubjectMember[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onShared: () => void;
}) => {
  const { t } = useLingui();
  const { subject, name, owner } = shared;
  const found = useFoundUnder(shared);
  const path =
    subject.kind === "app" ? `/apps/${subject.id}` : `/workflows/${subject.id}`;
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t`Share ${name}`}</DialogTitle>
          <DialogDescription>{found}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <ShareMembersAccess
            members={members}
            onChanged={onShared}
            owner={owner}
            subject={subject}
          />
        </DialogBody>
        <DialogFooter>
          <Button
            onClick={() => {
              void (async () => {
                if (await copyText(`${window.location.origin}${path}`)) {
                  toast.success(t`Link copied`);
                  return;
                }
                toast.error(t`Copying didn't work`);
              })();
            }}
            variant="outline"
          >
            <Icon icon={LinkIcon} />
            {t`Copy link`}
          </Button>
          <DialogClose>{t`Done`}</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/**
 * The end of the bar of an App's workspace and of a workflow's page:
 * Share, then Publish, the page's one ink action. Share opens its dialog,
 * whom it is shared with. Publish opens its dialog, which says where it
 * stands, an App's address, who can open it and whether its changes pass
 * their check, and publishes them: the changes only its builders see
 * become what everyone it is shared with opens. Where the bar is narrow
 * Share folds into Publish's dialog (its Who can open it), and Publish is
 * its icon alone, so the bar keeps one row.
 */
export const ShareWithTeam = ({
  shared,
  app,
  draft,
  members,
  running,
  onShared,
}: {
  shared: Shared;
  /** The App, on an App's page: its address and live version's label. */
  app?: App;
  /** Its draft, as read last; none while it is read. */
  draft: Draft | undefined;
  /** Whom it is shared with now. */
  members: readonly SubjectMember[];
  /** Whether Grasp is working on it, or checking it. */
  running: boolean;
  /**
   * Whether it is shared and has changes only its builders see. Taken for
   * the pages that pass it; Publish's dialog says so in its Status.
   */
  pending?: boolean;
  /** Told once it was shared or published from here. */
  onShared?: () => void;
}) => {
  const { t } = useLingui();
  const [publishing, setPublishing] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [linking, setLinking] = useState(false);
  const told = (): void => {
    onShared?.();
  };
  const publishable = usePublishable(shared.subject, draft, running);
  const { busy, failure, publish, clear } = usePublishing(shared, draft, {
    onPublished: told,
    again: publishable.again,
  });
  const first = versionToPublish(shared.live, draft) !== undefined;
  const canPublish =
    (publishable.changing || first) && publishable.ready && !busy && !running;
  const openPublish = (): void => {
    clear();
    setPublishing(true);
  };
  // Publish rests while there is nothing new to publish; its dialog still
  // says where it stands.
  const publishLook = publishable.changing || first ? "default" : "outline";
  return (
    <>
      <span {...stylex.props(styles.wide)}>
        <Button
          onClick={() => {
            setSharing(true);
          }}
          size="sm"
          variant="outline"
        >
          <Icon icon={UsersIcon} />
          {t`Share`}
        </Button>
        <Button
          disabled={draft === undefined}
          onClick={openPublish}
          size="sm"
          variant={publishLook}
        >
          {t`Publish`}
        </Button>
      </span>
      <span {...stylex.props(styles.narrow)}>
        <Button
          aria-label={t`Publish`}
          disabled={draft === undefined}
          onClick={openPublish}
          size="icon-sm"
          variant={publishLook}
        >
          <Icon icon={UploadIcon} />
        </Button>
      </span>
      <PublishDialog
        app={app}
        canPublish={canPublish}
        failure={failure}
        first={first}
        members={members}
        onFix={(problems) => {
          setPublishing(false);
          publishable.fix(problems);
        }}
        onLink={() => {
          setPublishing(false);
          setLinking(true);
        }}
        onOpenChange={setPublishing}
        onPublish={() => {
          void (async () => {
            if (await publish(publishable.review)) {
              setPublishing(false);
            }
          })();
        }}
        onShare={() => {
          setPublishing(false);
          setSharing(true);
        }}
        open={publishing}
        publishable={publishable}
        running={running}
        shared={shared}
      />
      <ShareDialog
        members={members}
        onOpenChange={setSharing}
        onShared={told}
        open={sharing}
        shared={shared}
      />
      {app === undefined ? null : (
        <AppLinkDialog app={app} onOpenChange={setLinking} open={linking} />
      )}
    </>
  );
};

/**
 * Whether the line of unpublished changes shows: live and shared, with
 * changes only its builders see.
 */
export const showsUnpublishedChanges = (
  live: number | null,
  draft: Draft | undefined,
  members: readonly SubjectMember[]
): boolean => live !== null && members.length > 0 && hasChanges(draft);

/**
 * Under the bar, once it is shared and has changes only its builders
 * see: how many and of what (of a workflow's, one file, that it has
 * some), that the page shows them, and Undo, which discards them once the
 * person confirms. Publishing them is the bar's (`ShareWithTeam`).
 */
export const UnpublishedChanges = ({
  draft,
  running,
  onChanged,
}: {
  draft: Draft;
  running: boolean;
  /** Told once the changes were shared or undone. */
  onChanged: () => void;
}) => {
  const { t } = useLingui();
  const { subject } = draft;
  const publishable = usePublishable(subject, draft, running);
  const [asked, setAsked] = useState<Asked>();
  const undo = useDraftChange(subject, draft.revision, onChanged);
  const { review } = publishable;
  const appChanges = review?.app ?? null;
  const summaries = appChanges === null ? [] : changeSummaries(appChanges);
  const problems = review?.passed === false ? review.problems : [];
  const changed = Math.max(
    appChanges?.files.length ??
      draft.changed.filter((path) => !isGeneratedServerFile(path)).length,
    1
  );
  return (
    <section
      aria-label={t`Changes only you see`}
      {...stylex.props(styles.strip)}
    >
      <Alert
        appearance="banner"
        variant={undo.failure === undefined ? "default" : "destructive"}
      >
        <AlertTitle>
          {subject.kind === "workflow"
            ? t`Changes only you see`
            : t`${plural(changed, {
                one: "# change only you see",
                other: "# changes only you see",
              })}`}
        </AlertTitle>
        <AlertDescription>
          {undo.failure ?? (
            <>
              {t`You’re seeing your version.`}
              {summaries.length === 0 ? null : ` ${formatList(summaries)}`}
            </>
          )}
        </AlertDescription>
        <AlertAction>
          {problems.length > 0 ? (
            <Button
              onClick={() => {
                publishable.fix(problems);
              }}
              size="xs"
              variant="outline"
            >
              <Icon icon={SparklesIcon} />
              {t`Fix with Grasp`}
            </Button>
          ) : null}
          <Button
            disabled={undo.busy || running}
            onClick={() => {
              setAsked({ kind: "discard" });
            }}
            size="xs"
            variant="outline"
          >
            {t`Undo`}
          </Button>
        </AlertAction>
      </Alert>
      <ConfirmChange
        asked={asked}
        onCancel={() => {
          setAsked(undefined);
        }}
        onConfirm={(confirmed) => {
          setAsked(undefined);
          void undo.change(confirmed);
        }}
      />
    </section>
  );
};
