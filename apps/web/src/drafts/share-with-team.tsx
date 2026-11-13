import { isGeneratedServerFile } from "@grasp-os/runtime/host";
import type { AppReview } from "@grasp-os/shared/app-review";
import type { AppMemberRef, ShareCandidates } from "@grasp-os/shared/apps";
import type { Draft, DraftProblem } from "@grasp-os/shared/drafts";
import type { Subject } from "@grasp-os/shared/subject";
import { Button } from "@grasp-os/ui/components/button";
import { Checkbox } from "@grasp-os/ui/components/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import { Field, FieldLabel } from "@grasp-os/ui/components/field";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@grasp-os/ui/components/sheet";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { toast } from "@grasp-os/ui/components/toast";
import { i18n as pageI18n } from "@lingui/core";
import type { I18n } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import {
  ChevronRightIcon,
  DatabaseIcon,
  KeyRoundIcon,
  SparklesIcon,
  UsersIcon,
} from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { ComponentProps, ReactNode } from "react";

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
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { formatList } from "../format.ts";
import { usePeopleApart } from "../people/people-apart.ts";
import { useCore } from "../use-core.ts";
import { ConfirmChange, useDraftChange } from "./draft-history.tsx";
import type { Asked } from "./draft-history.tsx";
import { isConflict, publishFailureText, settled } from "./publish-errors.ts";
import { membersOf, readMembers } from "./sharing.tsx";
import type { Member } from "./sharing.tsx";
import { hasChanges } from "./use-draft.ts";

// Share with your team, in the bar of an App's workspace and of a
// workflow's page alike: the page's one lime action (`PublishButton`), in
// place of a separate Publish and Share. It opens a sheet that asks who
// gets it (its teams and people, by name, those it is shared with already
// ticked), says what they'll see, names any access an admin approves
// first, and what in its changes stops it from being shared, with Fix with
// Grasp. Share does both in one step, with core's own calls: it publishes
// the changes only the builders see (`drafts.publish`, over the revision
// the sheet read, so a draft someone changed meanwhile is refused with
// `draft.conflict` and read again rather than shared unseen), then shares
// it with whoever was ticked and has no share of it yet (members.ts), so
// nobody's role changes. A toast says "Shared with …", with Undo: whoever
// the share added is taken off again, the version the team had before is
// theirs again (`versions.rollback` over the one just made, so a
// colleague's since stays), and the changes shared are the builders'
// draft again (`drafts.restore`), as before the share; confirmed first
// when it changed since. The toasts outlive the page, so Undo works after
// leaving it.
//
// Once it is shared, changes stay its builders' until they share them:
// one slim line under the bar (`UnpublishedChanges`) says so, with Undo,
// which discards them once the person confirms (draft-history.tsx).

/**
 * What the sheet read of the draft's changes, at the draft's `revision`:
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
    // publish (`draft.conflict`), and the sheet reads both again.
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

/** What the sheet read of the draft's changes, or why it couldn't. */
type ReviewRead =
  | { state: "ready"; review: Review }
  | { state: "failed"; text: string };

/**
 * The draft's changes, read at each write of the draft (`revision`) and
 * each time the sheet asks (`again`), while `reading` (the draft has
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

/** Whether publishing changes the App's records, as the sheet says once. */
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

/** The problems that stop it from being shared, a few, and Fix with Grasp. */
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
    <div className="flex flex-col gap-2">
      <p className="text-destructive">
        <Plural
          one="It can't be shared yet: # problem"
          other="It can't be shared yet: # problems"
          value={count}
        />
      </p>
      <ul aria-label={t`Problems`} className="flex flex-col gap-1 text-xs">
        {shown.map(({ at, line, message }, index) => (
          // A problem has no ID, and the same message may come twice.
          <li className="flex flex-col" key={index}>
            {at === null ? null : (
              <span className="text-muted-foreground font-mono">
                {line === null ? at : `${at}:${line}`}
              </span>
            )}
            <span>{message}</span>
          </li>
        ))}
        {more > 0 ? (
          <li className="text-muted-foreground">
            <Plural one="and # more" other="and # more" value={more} />
          </li>
        ) : null}
      </ul>
      <div>
        <Button onClick={onFix} size="sm" variant="outline">
          <SparklesIcon data-icon="inline-start" />
          <Trans>Fix with Grasp</Trans>
        </Button>
      </div>
    </div>
  );
};

/** One line the sheet says only when it applies, with its icon. */
const Line = ({ icon, children }: { icon: ReactNode; children: ReactNode }) => (
  <p className="text-muted-foreground flex items-start gap-2">
    <span aria-hidden className="mt-0.5 flex-none">
      {icon}
    </span>
    <span>{children}</span>
  </p>
);

/** Everything an App's changes hold, folded away. */
const Summary = ({ changes }: { changes: AppReview }) => (
  <Collapsible>
    <CollapsibleTrigger render={<Button size="sm" variant="ghost" />}>
      <ChevronRightIcon data-icon="inline-start" />
      <Trans>What changes</Trans>
    </CollapsibleTrigger>
    <CollapsibleContent>
      <div className="flex flex-col gap-4">
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

/** What applies to an App's changes being shared: their data, an admin's approval. */
const AppNotes = ({ changes }: { changes: AppReview }) => {
  const { i18n } = useLingui();
  const asksAgain = [...changes.grants, ...changes.callers].some(
    ({ askedAgain }) => askedAgain
  );
  const waiting = changes.permissions.length;
  return (
    <>
      {changes.files.length === 0 ? null : <Summary changes={changes} />}
      {changesData(changes, i18n) ? (
        <Line icon={<DatabaseIcon className="size-4" />}>
          <Trans>It changes the App&apos;s data: see What changes.</Trans>
        </Line>
      ) : null}
      {waiting > 0 ? (
        <Line icon={<KeyRoundIcon className="size-4" />}>
          <Plural
            one="It uses # new kind of access. An admin approves that once."
            other="It uses # new kinds of access. An admin approves those once."
            value={waiting}
          />
        </Line>
      ) : null}
      {asksAgain ? (
        <Line icon={<KeyRoundIcon className="size-4" />}>
          <Trans>
            An admin approves its access again before it works for your team.
          </Trans>
        </Line>
      ) : null}
    </>
  );
};

/** What applies to the changes being shared: an App's notes, and problems. */
const ChangesNotes = ({
  review,
  onFix,
}: {
  review: Review;
  onFix: (problems: readonly DraftProblem[]) => void;
}) => (
  <div className="flex flex-col gap-3">
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
 * What Undo puts back: whom a share added, and, when it made a new
 * version live over one the team had (`before`) from the draft at
 * `revision`, that version again over the new one (`made`), with the
 * draft as it was shared.
 */
interface Undoable {
  subject: Subject;
  added: readonly AppMemberRef[];
  back: { before: number; made: number; revision: number } | undefined;
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
  toast.add({ type: "error", title: publishFailureText(error) });
};

/**
 * The version the team had before, live again over the draft at
 * `revision`, while the one the share made still is: a colleague's share
 * since stays. Then the draft as it was shared is the draft again, over
 * that version (its checkpoint at the revision shared), so nothing of the
 * builders' work is left only in History.
 */
const takeBack = async (
  { core, router, onDone }: UndoTools,
  subject: Subject,
  back: NonNullable<Undoable["back"]>,
  revision: number
): Promise<void> => {
  const done = await settled(core, async (session) => {
    await session.versions.rollback(subject, back.before, revision, back.made);
    const [checkpoints, now] = await Promise.all([
      session.drafts.checkpoints(subject),
      session.drafts.get(subject),
    ]);
    const shared = checkpoints.find(
      (checkpoint) => checkpoint.revision === back.revision
    );
    if (shared !== undefined) {
      await session.drafts.restore(subject, shared.number, now.revision);
    }
  });
  onDone();
  await router.invalidate();
  if (!done.ok) {
    undoFailed(done.error);
    return;
  }
  toast.add({ type: "success", title: pageI18n._(msg`Sharing undone`) });
};

/**
 * Undo, from the toast that says it was shared: takes off whoever was
 * added, then puts back the version the team had before, once the person
 * confirms in a toast of its own when it changed since. Works from the
 * toast alone, after the page was left.
 */
const undoShare = async (
  tools: UndoTools,
  { subject, added, back }: Undoable
): Promise<void> => {
  const { core, router, onDone } = tools;
  const removed = await settled(core, async (session) => {
    for (const member of added) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time, in order
      await membersOf(session, subject.kind).remove(subject.id, {
        type: member.type,
        id: member.id,
      });
    }
  });
  if (!removed.ok) {
    undoFailed(removed.error);
    return;
  }
  if (back === undefined) {
    onDone();
    await router.invalidate();
    toast.add({ type: "success", title: pageI18n._(msg`Sharing undone`) });
    return;
  }
  const draft = await settled(
    core,
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
  toast.add({
    type: "warning",
    title: pageI18n._(msg`Give your team the version they had before?`),
    description: pageI18n._(
      msg`It changed since you shared it. Going back drops those changes, for everyone who builds it.`
    ),
    timeout: 0,
    actionProps: {
      children: pageI18n._(msg`Drop them and go back`),
      onClick: () => {
        void takeBack(tools, subject, back, revision);
      },
    },
  });
};

/**
 * The version sharing makes live as it is, with nothing live yet and
 * changes over it that change nothing (the first of an App made from a
 * blueprint); none otherwise, when the changes are what is shared.
 */
const versionToShare = (
  live: number | null,
  draft: Draft | undefined
): number | undefined =>
  draft !== undefined &&
  !hasChanges(draft) &&
  live === null &&
  draft.base !== null
    ? draft.base
    : undefined;

/** A share's key: its kind and ID. */
const keyOf = ({ type, id }: AppMemberRef): string => `${type}:${id}`;

/** Someone to share with, by name. */
interface Recipient extends AppMemberRef {
  name: string;
}

/** What is shared: the subject, its name, owner and live version. */
export interface Shared {
  subject: Subject;
  name: string;
  /** Its owner, who has it always: never offered. */
  owner: string;
  /** The version live now; null before the first. */
  live: number | null;
}

/**
 * Shares it: publishes its changes (as `review` read them, when there are
 * any to share), then shares it with `recipients`; `onShared` and a toast
 * with Undo once done; why not otherwise, and `again` when it moved, so
 * its changes are read again.
 */
const useSharing = (
  { subject, live }: Shared,
  draft: Draft | undefined,
  {
    onShared,
    again,
  }: {
    onShared: () => void;
    again: () => void;
  }
) => {
  const { t } = useLingui();
  const core = useCore();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const version = versionToShare(live, draft);
  const share = async (
    review: Review | undefined,
    recipients: readonly Recipient[]
  ): Promise<boolean> => {
    setBusy(true);
    setFailure(undefined);
    const before = live;
    const shared = await settled(core, async (session) => {
      let made = before;
      // Only who has no share yet: a builder ticked stays one.
      const sharedWith = await readMembers(session, subject);
      const had = new Set(sharedWith.map((member) => keyOf(member)));
      const added = recipients.filter(
        (recipient) => !had.has(keyOf(recipient))
      );
      if (version !== undefined) {
        const rolled = await session.versions.rollback(
          subject,
          version,
          draft?.revision ?? 0,
          null
        );
        made = rolled.version;
      } else if (review !== undefined) {
        const published = await session.drafts.publish(
          subject,
          review.revision
        );
        made = published.version;
      }
      for (const recipient of added) {
        // oxlint-disable-next-line no-await-in-loop -- one at a time, in order
        await membersOf(session, subject.kind).add(subject.id, {
          type: recipient.type,
          id: recipient.id,
          role: "user",
        });
      }
      return { made, added };
    });
    setBusy(false);
    if (!shared.ok) {
      setFailure(publishFailureText(shared.error));
      // It moved: what changes is read again, to look at.
      if (isConflict(shared.error)) {
        again();
      }
      return false;
    }
    onShared();
    await router.invalidate();
    const { made, added } = shared.value;
    const tools = { core, router, onDone: onShared };
    const undoable: Undoable = {
      subject,
      added: added.map(({ type, id }) => ({ type, id })),
      back:
        before === null ||
        made === null ||
        made === before ||
        review === undefined
          ? undefined
          : { before, made, revision: review.revision },
    };
    const who = formatList(recipients.map(({ name }) => name));
    toast.add({
      type: "success",
      title:
        recipients.length === 0
          ? t`Your changes are shared`
          : t`Shared with ${who}`,
      timeout: 10_000,
      actionProps: {
        children: t`Undo`,
        onClick: () => {
          void undoShare(tools, undoable);
        },
      },
    });
    return true;
  };
  return {
    busy,
    failure,
    share,
    clear: () => {
      setFailure(undefined);
    },
  };
};

/**
 * The changes to share, read while it has some and Grasp isn't working on
 * it, with whether they may be shared now (`ready`) and Fix with Grasp
 * for what stops them.
 */
const useShareable = (
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
        t`Fix these problems the check found, so it can be shared:`,
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
    /** Whether the changes may be shared now: read, passing, Grasp done. */
    ready: !changing || (current && review.passed && !running),
    fix,
  };
};

/** Who the sheet offers: the teams, then the people, by name. */
const recipientsOf = (
  candidates: ShareCandidates | undefined,
  owner: string
): Recipient[] =>
  candidates === undefined
    ? []
    : [
        ...candidates.teams.map(({ id, name }) => ({
          type: "team" as const,
          id,
          name,
        })),
        ...candidates.people
          .filter(({ id }) => id !== owner)
          .map(({ id, name }) => ({ type: "person" as const, id, name })),
      ];

/** Ticks who gets it: whom it is shared with already stays ticked. */
const WhoGetsIt = ({
  offered,
  members,
  chosen,
  disabled,
  onChosen,
}: {
  offered: readonly Recipient[] | undefined;
  members: readonly Member[];
  chosen: readonly string[];
  disabled: boolean;
  onChosen: (chosen: string[]) => void;
}) => {
  const { t } = useLingui();
  const ids = useId();
  // Everyone offered or shared with, so a person is told apart from a
  // namesake by the end of their ID.
  const apart = usePeopleApart(
    [...(offered ?? []), ...members].flatMap(({ type, id, name }) =>
      type === "person" && name !== null ? [{ id, name }] : []
    )
  );
  if (offered === undefined) {
    return <Spinner aria-label={t`Loading…`} />;
  }
  const shared = new Set(members.map((member) => keyOf(member)));
  if (offered.length === 0) {
    return (
      <p className="text-muted-foreground">
        <Trans>Nobody else to share with.</Trans>
      </p>
    );
  }
  return (
    <ul aria-label={t`Who gets it`} className="flex flex-col gap-2">
      {offered.map((recipient) => {
        const key = keyOf(recipient);
        const has = shared.has(key);
        return (
          <li key={key}>
            <Field orientation="horizontal">
              <Checkbox
                checked={has || chosen.includes(key)}
                disabled={has || disabled}
                id={`${ids}-${key}`}
                onCheckedChange={(checked) => {
                  const rest = chosen.filter((one) => one !== key);
                  onChosen(checked ? [...rest, key] : rest);
                }}
              />
              <FieldLabel htmlFor={`${ids}-${key}`}>
                {recipient.type === "team" ? (
                  <UsersIcon aria-hidden className="size-4" />
                ) : null}
                {recipient.type === "person"
                  ? apart.named(recipient)
                  : recipient.name}
                {has ? (
                  <span className="text-muted-foreground">
                    <Trans>has it</Trans>
                  </span>
                ) : null}
              </FieldLabel>
            </Field>
          </li>
        );
      })}
    </ul>
  );
};

/**
 * The page's one lime action, always labelled: "Share with your team",
 * or "Share changes" once it is shared and has changes only its builders
 * see (`pending`), with a dot while there are changes to share. Given as
 * the trigger of Share with your team's sheet, whose props it takes.
 */
export const PublishButton = ({
  pending,
  changes,
  ...props
}: Omit<ComponentProps<typeof Button>, "size" | "variant"> & {
  pending: boolean;
  /** Whether the draft has changes to share: the dot. */
  changes: boolean;
}) => (
  <Button {...props} size="sm" variant="highlight">
    <UsersIcon data-icon="inline-start" />
    {pending ? (
      <Trans>Share changes</Trans>
    ) : (
      <Trans>Share with your team</Trans>
    )}
    {changes ? (
      <span
        aria-hidden="true"
        className="bg-status-attention size-1.5 rounded-full"
      />
    ) : null}
  </Button>
);

/** What the sheet says they'll find, for its kind. */
const FoundUnder = ({ kind }: { kind: Subject["kind"] }) =>
  kind === "app" ? (
    <Trans>They&apos;ll find it under Apps, and see it as it is now.</Trans>
  ) : (
    <Trans>
      They&apos;ll find it under Workflows, and run it as it is now.
    </Trans>
  );

/**
 * Share with your team, and its sheet: who gets it, what they'll see,
 * what an admin approves first and what stops it; Share does it all. The
 * page's one lime action, for an App and a workflow alike.
 */
export const ShareWithTeam = ({
  shared,
  draft,
  members,
  running,
  pending = false,
  onShared,
}: {
  shared: Shared;
  /** Its draft, as read last; none while it is read. */
  draft: Draft | undefined;
  /** Whom it is shared with now. */
  members: readonly Member[];
  /** Whether Grasp is working on it, or checking it. */
  running: boolean;
  /** Whether it is shared and has changes only its builders see. */
  pending?: boolean;
  onShared?: () => void;
}) => {
  const { t } = useLingui();
  const core = useCore();
  const { subject, name, owner, live } = shared;
  const [open, setOpen] = useState(false);
  const [candidates, setCandidates] = useState<ShareCandidates>();
  const [chosen, setChosen] = useState<string[]>([]);
  const shareable = useShareable(subject, draft, running);
  const { busy, failure, share, clear } = useSharing(shared, draft, {
    onShared: () => {
      onShared?.();
    },
    again: shareable.again,
  });
  const offered =
    candidates === undefined ? undefined : recipientsOf(candidates, owner);
  const recipients = (offered ?? []).filter((each) =>
    chosen.includes(keyOf(each))
  );
  // Something to share: someone new, or changes for whom it is shared
  // with; a workflow's changes for its owner alone too, as its triggers and
  // Run start its live version, whoever else has it.
  const forSomeone = members.length > 0 || subject.kind === "workflow";
  const something =
    recipients.length > 0 ||
    (forSomeone &&
      (shareable.changing || versionToShare(live, draft) !== undefined));
  const canShare = something && shareable.ready && !busy && !running;
  const readOffered = async (): Promise<void> => {
    if (candidates !== undefined) {
      return;
    }
    const listed = await settled(
      core,
      async (session) =>
        await membersOf(session, subject.kind).candidates(subject.id)
    );
    setCandidates(
      listed.ok ? listed.value : { people: [], teams: [], projects: [] }
    );
  };
  return (
    <Sheet
      onOpenChange={(opening) => {
        setOpen(opening);
        if (opening) {
          clear();
          void readOffered();
        }
      }}
      open={open}
    >
      <SheetTrigger
        render={
          <PublishButton
            changes={shareable.changing}
            disabled={draft === undefined}
            pending={pending}
          />
        }
      />
      <SheetContent closeLabel={t`Close`} side="right">
        <SheetHeader>
          <SheetTitle>
            <Trans>Share {name}</Trans>
          </SheetTitle>
          <SheetDescription>
            <FoundUnder kind={subject.kind} />
          </SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4">
          <WhoGetsIt
            chosen={chosen}
            disabled={busy}
            members={members}
            offered={offered}
            onChosen={setChosen}
          />
          {running || (shareable.changing && shareable.review === undefined) ? (
            <p className="text-muted-foreground flex items-center gap-2">
              <Spinner aria-hidden />
              {running ? (
                <Trans>Grasp is still working on it…</Trans>
              ) : (
                <Trans>Checking it…</Trans>
              )}
            </p>
          ) : null}
          {shareable.read?.state === "failed" ? (
            <ErrorText>{shareable.read.text}</ErrorText>
          ) : null}
          {shareable.review === undefined ? null : (
            <ChangesNotes
              onFix={(problems) => {
                setOpen(false);
                shareable.fix(problems);
              }}
              review={shareable.review}
            />
          )}
          <ErrorText>{failure}</ErrorText>
        </div>
        <SheetFooter>
          <Button
            disabled={!canShare}
            onClick={() => {
              void (async () => {
                if (await share(shareable.review, recipients)) {
                  setOpen(false);
                  setChosen([]);
                }
              })();
            }}
          >
            {busy ? <Spinner data-icon="inline-start" /> : null}
            <Trans>Share</Trans>
          </Button>
          <SheetClose render={<Button variant="outline" />}>
            <Trans>Not yet</Trans>
          </SheetClose>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
};

/**
 * Whether the line of unpublished changes shows: live and shared, with
 * changes only its builders see.
 */
export const showsUnpublishedChanges = (
  live: number | null,
  draft: Draft | undefined,
  members: readonly Member[]
): boolean => live !== null && members.length > 0 && hasChanges(draft);

/** How many changes only its builders see, as the line counts them. */
const ChangesCount = ({
  draft,
  review,
}: {
  draft: Draft;
  review: Review | undefined;
}) => {
  // A workflow's draft is one file: the line says it has changes.
  if (draft.subject.kind === "workflow") {
    return <Trans>Changes only you see</Trans>;
  }
  const count =
    review?.app?.files.length ??
    draft.changed.filter((path) => !isGeneratedServerFile(path)).length;
  const changed = Math.max(count, 1);
  return (
    <Plural
      one="# change only you see"
      other="# changes only you see"
      value={changed}
    />
  );
};

/**
 * Under the bar, once it is shared and has changes only its builders
 * see: how many and of what, that the page shows them, and Undo, which
 * discards them once the person confirms. Share changes is the bar's
 * (`ShareWithTeam`).
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
  const shareable = useShareable(subject, draft, running);
  const [asked, setAsked] = useState<Asked>();
  const undo = useDraftChange(subject, draft.revision, onChanged);
  const { review } = shareable;
  const appChanges = review?.app ?? null;
  const summaries = appChanges === null ? [] : changeSummaries(appChanges);
  const problems = review?.passed === false ? review.problems : [];
  return (
    <section
      aria-label={t`Changes only you see`}
      className="bg-muted flex flex-none flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-1.5"
    >
      <p className="font-medium">
        <ChangesCount draft={draft} review={review} />
      </p>
      {/* The page shows them while there are some. */}
      <p className="text-muted-foreground">
        <Trans>You’re seeing your version.</Trans>
      </p>
      {summaries.length === 0 ? null : (
        <p className="text-muted-foreground truncate">
          {formatList(summaries)}
        </p>
      )}
      <span className="flex-1" />
      <ErrorText>{undo.failure}</ErrorText>
      {problems.length > 0 ? (
        <Button
          onClick={() => {
            shareable.fix(problems);
          }}
          size="sm"
          variant="outline"
        >
          <SparklesIcon data-icon="inline-start" />
          <Trans>Fix with Grasp</Trans>
        </Button>
      ) : null}
      <Button
        disabled={undo.busy || running}
        onClick={() => {
          setAsked({ kind: "discard" });
        }}
        size="sm"
        variant="outline"
      >
        <Trans>Undo</Trans>
      </Button>
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
