import { isGeneratedServerFile } from "@grasp-os/runtime/host";
import type {
  AppDraft,
  AppDraftChanges,
  AppDraftProblem,
} from "@grasp-os/shared/app-drafts";
import type {
  App,
  AppMember,
  AppMemberRef,
  ShareCandidates,
} from "@grasp-os/shared/apps";
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
import type { ReactNode } from "react";

import { useGlobalChat } from "../chat/global-chat.tsx";
import { ErrorText } from "../error-text.tsx";
import { formatList } from "../format.ts";
import { usePeopleApart } from "../people/people-apart.ts";
import { useCore } from "../use-core.ts";
import { ConfirmChange, useDraftChange } from "./app-history.tsx";
import type { Asked } from "./app-history.tsx";
import { planLines } from "./data-model-changes.tsx";
import {
  AccessChanges,
  ChangesSection,
  DataChanges,
  FileChanges,
  groupOf,
  groupOrder,
} from "./draft-changes.tsx";
import type { FileGroup } from "./draft-changes.tsx";
import { fixQuestion } from "./fix-with-grasp.ts";
import { isConflict, publishFailureText, settled } from "./publish-errors.ts";

// Share with your team, in the App's workspace bar (app-workspace.tsx):
// the page's one lime action, in place of a separate Publish and Share.
// It opens a sheet that asks who gets the App (its teams and people, by
// name, those it is shared with already ticked), says what they'll see,
// names any access an admin approves first, and what in the App's
// changes stops it from being shared, with Fix with Grasp. Share does
// both in one step, with core's own calls: it publishes the changes only
// the builders see (`apps.drafts.publish`, over the revision the sheet
// read, so a draft someone changed meanwhile is refused with
// `app.conflict` and read again rather than shared unseen), then shares
// the App with whoever was ticked and has no share of it yet
// (`apps.members.add`), so nobody's role changes. A toast says "Shared
// with …", with Undo: whoever the share added is taken off again, the
// version the team had before is theirs again (`apps.versions.publish`
// over the one just made, so a colleague's since stays), and the changes
// shared are the builders' draft again (`apps.drafts.restorePoint`), as
// before the share; confirmed first when the App changed since. The
// toasts outlive the workspace, so Undo works after leaving it.
//
// Once the App is shared, changes stay its builders' until they share
// them: one slim line under the bar says how many and of what, with
// Share changes, which publishes them as Share does, and Undo, which
// discards them once the person confirms (app-history.tsx).

/** What the panel read of the draft's changes, or why it couldn't. */
type ChangesRead =
  | { state: "ready"; changes: AppDraftChanges }
  | { state: "failed"; text: string };

/**
 * The draft's changes, read at each write of the draft (`revision`) and
 * each time the panel asks (`again`), while `reading` (the draft has
 * changes, and Grasp isn't writing it); otherwise the last read of the
 * App's stays, so the button can say how many problems Grasp is fixing.
 * Publish never takes it for a later revision than it was read at.
 */
const useDraftChanges = (
  app: string,
  revision: number,
  reading: boolean
): { read: ChangesRead | undefined; again: () => void } => {
  const core = useCore();
  const [reads, setReads] = useState(0);
  const [read, setRead] = useState<{ app: string; read: ChangesRead }>();
  useEffect(() => {
    let current = true;
    const load = async (): Promise<void> => {
      if (!reading) {
        return;
      }
      // Not within a page read's few seconds: the draft's check builds it.
      const found = await settled(
        core,
        async (session) => await session.apps.drafts.changes(app)
      );
      if (current) {
        setRead({
          app,
          // What Grasp generates (`server/_generated/`) every save writes
          // again; no one edits it, so it isn't a change to review.
          read: found.ok
            ? {
                state: "ready",
                changes: {
                  ...found.value,
                  files: found.value.files.filter(
                    ({ path }) => !isGeneratedServerFile(path)
                  ),
                },
              }
            : { state: "failed", text: publishFailureText(found.error) },
        });
      }
    };
    void load();
    return () => {
      current = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `revision` and `reads` say when to read again
  }, [core, app, revision, reads, reading]);
  return {
    read: read?.app === app ? read.read : undefined,
    again: () => {
      setReads((before) => before + 1);
    },
  };
};

/** Whether publishing changes the App's records, as the panel says once. */
const changesData = (changes: AppDraftChanges, i18n: I18n): boolean =>
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

/** What the changes are, in a few words each: how many of what. */
export const changeSummaries = (changes: AppDraftChanges): string[] =>
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
  problems: readonly AppDraftProblem[];
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

/** Everything the changes hold, folded away. */
const Summary = ({ changes }: { changes: AppDraftChanges }) => (
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

/** What applies to the changes being shared: their data, an admin's approval, problems. */
const ChangesNotes = ({
  changes,
  onFix,
}: {
  changes: AppDraftChanges;
  onFix: (problems: readonly AppDraftProblem[]) => void;
}) => {
  const { i18n } = useLingui();
  const asksAgain = [...changes.grants, ...changes.callers].some(
    ({ askedAgain }) => askedAgain
  );
  const waiting = changes.permissions.length;
  return (
    <div className="flex flex-col gap-3">
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
      {changes.check.passed ? null : (
        <Problems
          onFix={() => {
            onFix(changes.check.problems);
          }}
          problems={changes.check.problems}
        />
      )}
    </div>
  );
};

/**
 * What Undo puts back: whom a share added, and, when it made a new
 * version current over one the team had (`before`) from the draft at
 * `revision`, that version again over the new one (`made`), with the
 * draft as it was shared.
 */
interface Undoable {
  app: string;
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
  /** Told once it was undone, while the workspace still listens. */
  onDone: () => void;
}

/** Says Undo failed, in the page's words. */
const undoFailed = (error: unknown): void => {
  toast.add({ type: "error", title: publishFailureText(error) });
};

/**
 * The version the team had before, current again over the App's changes
 * at `revision`, while the one the share made still is: a colleague's
 * share since stays. Then the draft as it was shared is the draft again,
 * over that version (its undo point at the revision shared), so nothing
 * of the builders' work is left only in History.
 */
const takeBack = async (
  { core, router, onDone }: UndoTools,
  app: string,
  back: NonNullable<Undoable["back"]>,
  revision: number
): Promise<void> => {
  const done = await settled(core, async (session) => {
    await session.apps.versions.publish(app, back.before, revision, back.made);
    const [points, now] = await Promise.all([
      session.apps.drafts.points(app),
      session.apps.drafts.get(app),
    ]);
    const shared = points.find((point) => point.revision === back.revision);
    if (shared !== undefined) {
      await session.apps.drafts.restorePoint(app, shared.number, now.revision);
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
 * confirms in a toast of its own when the App changed since. Works from
 * the toast alone, after the workspace was left.
 */
const undoShare = async (
  tools: UndoTools,
  { app, added, back }: Undoable
): Promise<void> => {
  const { core, router, onDone } = tools;
  const removed = await settled(core, async (session) => {
    for (const member of added) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time, in order
      await session.apps.members.remove(app, member);
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
    async (session) => await session.apps.drafts.get(app)
  );
  if (!draft.ok) {
    undoFailed(draft.error);
    return;
  }
  const { revision, changed } = draft.value;
  if (changed.length === 0) {
    await takeBack(tools, app, back, revision);
    return;
  }
  toast.add({
    type: "warning",
    title: pageI18n._(msg`Give your team the version they had before?`),
    description: pageI18n._(
      msg`The App changed since you shared it. Going back drops those changes, for everyone who builds this App.`
    ),
    timeout: 0,
    actionProps: {
      children: pageI18n._(msg`Drop them and go back`),
      onClick: () => {
        void takeBack(tools, app, back, revision);
      },
    },
  });
};

/**
 * The version sharing makes current as it is, with nothing shared yet and
 * changes over it that change nothing (the first of an App made from a
 * blueprint); none otherwise, when the changes are what is shared.
 */
const versionToShare = (
  app: App,
  draft: AppDraft | undefined
): number | undefined =>
  draft !== undefined &&
  draft.changed.length === 0 &&
  app.currentVersion === null &&
  draft.base !== null
    ? draft.base
    : undefined;

/** A share's key: its kind and ID. */
const keyOf = ({ type, id }: AppMemberRef): string => `${type}:${id}`;

/** Someone to share with, by name. */
export interface Recipient extends AppMemberRef {
  name: string;
}

/**
 * Shares `app`: publishes its changes (`changes`, as read, when there are
 * any to share), then shares it with `recipients`; `onShared` and a toast
 * with Undo once done; why not otherwise, and `again` when the App moved,
 * so its changes are read again.
 */
const useSharing = (
  app: App,
  draft: AppDraft | undefined,
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
  const version = versionToShare(app, draft);
  const share = async (
    changes: AppDraftChanges | undefined,
    recipients: readonly Recipient[]
  ): Promise<boolean> => {
    setBusy(true);
    setFailure(undefined);
    const message = t({
      message: "Shared from the App's workspace",
      context: "a version's message",
    });
    const before = app.currentVersion;
    const shared = await settled(core, async (session) => {
      let made = before;
      // Only who has no share yet: a builder ticked stays one.
      const sharedWith = await session.apps.members.list(app.id);
      const had = new Set(sharedWith.map((member) => keyOf(member)));
      const added = recipients.filter(
        (recipient) => !had.has(keyOf(recipient))
      );
      if (version !== undefined) {
        const published = await session.apps.versions.publish(
          app.id,
          version,
          draft?.revision ?? 0,
          null
        );
        made = published.currentVersion;
      } else if (changes !== undefined) {
        const published = await session.apps.drafts.publish(
          app.id,
          changes.revision,
          message
        );
        made = published.currentVersion;
      }
      for (const { type, id } of added) {
        // oxlint-disable-next-line no-await-in-loop -- one at a time, in order
        await session.apps.members.add(app.id, { type, id, role: "user" });
      }
      return { made, added };
    });
    setBusy(false);
    if (!shared.ok) {
      setFailure(publishFailureText(shared.error));
      // The App moved: what changes is read again, to look at.
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
      app: app.id,
      added: added.map(({ type, id }) => ({ type, id })),
      back:
        before === null ||
        made === null ||
        made === before ||
        changes === undefined
          ? undefined
          : { before, made, revision: changes.revision },
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

/** Whether the App has changes only its builders see, to share. */
const hasChanges = (draft: AppDraft | undefined): boolean =>
  draft !== undefined && (draft.changed.length > 0 || draft.definitionChanged);

/**
 * The changes to share, read while the App has some and Grasp isn't
 * working on it, with whether they may be shared now (`ready`) and Fix
 * with Grasp for what stops them.
 */
const useShareable = (
  app: App,
  draft: AppDraft | undefined,
  running: boolean
) => {
  const { t } = useLingui();
  const chat = useGlobalChat();
  const changing = hasChanges(draft);
  const { read, again } = useDraftChanges(
    app.id,
    draft?.revision ?? 0,
    changing && !running
  );
  const changes = read?.state === "ready" ? read.changes : undefined;
  const current = changes !== undefined && changes.revision === draft?.revision;
  const fix = (problems: readonly AppDraftProblem[]): void => {
    void chat.ask(
      fixQuestion(
        t`Fix these problems the check found, so the App can be shared:`,
        problems
      )
    );
  };
  return {
    changing,
    read,
    again,
    /** The changes as read at the draft's revision; none while they're read. */
    changes: current ? changes : undefined,
    /** Whether the changes may be shared now: read, passing, Grasp done. */
    ready: !changing || (current && changes.check.passed && !running),
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

/** Ticks who gets the App: whom it is shared with already stays ticked. */
const WhoGetsIt = ({
  offered,
  members,
  chosen,
  disabled,
  onChosen,
}: {
  offered: readonly Recipient[] | undefined;
  members: readonly AppMember[];
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
 * Share with your team, and its sheet: who gets it, what they'll see,
 * what an admin approves first and what stops it; Share does it all.
 * The page's one lime action, always labelled: "Share changes" once it
 * is shared and has changes only its builders see (`pending`, which the
 * line under the bar counts).
 */
export const ShareWithTeam = ({
  app,
  draft,
  members,
  running,
  pending = false,
  onShared,
}: {
  app: App;
  /** The App's changes, as read last; none while they are read. */
  draft: AppDraft | undefined;
  /** Whom it is shared with now. */
  members: readonly AppMember[];
  /** Whether Grasp is working on it, or checking it. */
  running: boolean;
  pending?: boolean;
  onShared?: () => void;
}) => {
  const { t } = useLingui();
  const core = useCore();
  const { name } = app;
  const [open, setOpen] = useState(false);
  const [candidates, setCandidates] = useState<ShareCandidates>();
  const [chosen, setChosen] = useState<string[]>([]);
  const shareable = useShareable(app, draft, running);
  const { busy, failure, share, clear } = useSharing(app, draft, {
    onShared: () => {
      onShared?.();
    },
    again: shareable.again,
  });
  const offered =
    candidates === undefined ? undefined : recipientsOf(candidates, app.owner);
  const recipients = (offered ?? []).filter((each) =>
    chosen.includes(keyOf(each))
  );
  // Something to share: someone new, or changes for whom it is shared with.
  const something =
    recipients.length > 0 ||
    (members.length > 0 &&
      (shareable.changing || versionToShare(app, draft) !== undefined));
  const canShare = something && shareable.ready && !busy && !running;
  const readCandidates = async (): Promise<void> => {
    if (candidates !== undefined) {
      return;
    }
    const listed = await settled(
      core,
      async (session) => await session.apps.members.candidates(app.id)
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
          void readCandidates();
        }
      }}
      open={open}
    >
      <SheetTrigger
        render={
          <Button
            disabled={draft === undefined}
            size="sm"
            variant="highlight"
          />
        }
      >
        <UsersIcon data-icon="inline-start" />
        {pending ? (
          <Trans>Share changes</Trans>
        ) : (
          <Trans>Share with your team</Trans>
        )}
      </SheetTrigger>
      <SheetContent closeLabel={t`Close`} side="right">
        <SheetHeader>
          <SheetTitle>
            <Trans>Share {name}</Trans>
          </SheetTitle>
          <SheetDescription>
            <Trans>
              They&apos;ll find it under Apps, and see it as it is now.
            </Trans>
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
          {running ||
          (shareable.changing && shareable.changes === undefined) ? (
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
          {shareable.changes === undefined ? null : (
            <ChangesNotes
              changes={shareable.changes}
              onFix={(problems) => {
                setOpen(false);
                shareable.fix(problems);
              }}
            />
          )}
          <ErrorText>{failure}</ErrorText>
        </div>
        <SheetFooter>
          <Button
            disabled={!canShare}
            onClick={() => {
              void (async () => {
                if (await share(shareable.changes, recipients)) {
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

/** Whether the changes line shows: shared, with changes only its builders see. */
export const showsChangesLine = (
  app: App,
  draft: AppDraft | undefined,
  members: readonly AppMember[]
): boolean =>
  app.currentVersion !== null && members.length > 0 && hasChanges(draft);

/**
 * Under the bar, once the App is shared and has changes only its builders
 * see: how many and of what, that the workspace shows them, and Undo,
 * which discards them once the person confirms. Share changes is the
 * bar's (`ShareWithTeam`).
 */
export const ChangesLine = ({
  app,
  draft,
  running,
  onChanged,
}: {
  app: App;
  draft: AppDraft;
  running: boolean;
  /** Told once the changes were shared or undone. */
  onChanged: () => void;
}) => {
  const { t } = useLingui();
  const shareable = useShareable(app, draft, running);
  const [asked, setAsked] = useState<Asked>();
  const undo = useDraftChange(app.id, draft.revision, onChanged);
  const { changes } = shareable;
  const count =
    changes?.files.length ??
    draft.changed.filter((path) => !isGeneratedServerFile(path)).length;
  const summaries = changes === undefined ? [] : changeSummaries(changes);
  const changed = Math.max(count, 1);
  const problems =
    changes?.check.passed === false ? changes.check.problems : [];
  return (
    <section
      aria-label={t`Changes only you see`}
      className="bg-muted flex flex-none flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-1.5"
    >
      <p className="font-medium">
        <Plural
          one="# change only you see"
          other="# changes only you see"
          value={changed}
        />
      </p>
      {/* The workspace shows them while there are some (app-workspace.tsx). */}
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
