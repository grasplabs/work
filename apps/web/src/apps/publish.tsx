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
import { i18n as pageI18n } from "@lingui/core";
import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { useGlobalChat } from "../chat/global-chat.tsx";
import { formatList } from "../format.ts";
import { Alert } from "../grasp/alert/index.ts";
import { Avatar, AvatarFallback } from "../grasp/avatar/index.ts";
import { Badge } from "../grasp/badge/index.ts";
import { Button } from "../grasp/button/index.ts";
import { Checkbox } from "../grasp/checkbox/index.ts";
import { Collapsible } from "../grasp/collapsible/index.ts";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "../grasp/field/index.ts";
import {
  ChevronRight,
  Database,
  Done,
  Edit,
  Key,
  Link as LinkIcon,
  People,
  Sparkles,
  Upload,
} from "../grasp/icons/index.ts";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import {
  Popover,
  PopoverContent,
  PopoverFooter,
  PopoverTitle,
  PopoverTrigger,
} from "../grasp/popover/index.ts";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetTitle,
} from "../grasp/sheet/index.ts";
import { Spinner } from "../grasp/spinner/index.ts";
import { Text } from "../grasp/text/index.ts";
import { toast } from "../grasp/toast/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import { usePeopleApart } from "../people/people-apart.ts";
import { useCore } from "../use-core.ts";
import { ConfirmChange, useDraftChange } from "./app-history.tsx";
import type { Asked } from "./app-history.tsx";
import { AppLinkDialog, linkAddress } from "./app-own-link.tsx";
import { userNames } from "./app-status.tsx";
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
import { hasChanges } from "./use-app-draft.ts";

// The end of the App's workspace bar (app-workspace.tsx): Share, then
// Publish, the page's one ink action.
//
// Share opens a sheet that asks who gets the App (its teams and people,
// by name, those it is shared with already ticked) and shares it with
// whoever was ticked and has no share of it yet (`apps.members.add`), so
// nobody's role changes. A toast says "Shared with …", with Undo, which
// takes them off again.
//
// Publish opens a popover that says where the App stands (live and at
// which version, or not yet), its address, who can open it, and how the
// check of its changes stands, with what an admin approves first and
// what stops it, with Fix with Grasp. Publish makes the changes only the
// builders see what everyone it is shared with opens, with core's own
// call (`apps.drafts.publish`, over the revision the popover read, so a
// draft someone changed meanwhile is refused with `app.conflict` and read
// again rather than published unseen). A toast says it is live, with
// Undo over a version the team had before: that version is theirs again
// (`apps.versions.publish` over the one just made, so a colleague's since
// stays), and the changes published are the builders' draft again
// (`apps.drafts.restorePoint`); confirmed first when the App changed
// since. The toasts outlive the workspace, so Undo works after leaving
// it.
//
// Once the App is live, changes stay its builders' until they publish
// them: one slim line under the bar says how many and of what, and Undo,
// which discards them once the person confirms (app-history.tsx).

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

const styles = stylex.create({
  // Share and Publish's words from a phone's width on; below it Publish's
  // icon alone, and Share in its popover.
  wide: { display: { default: "contents", [media.belowPhone]: "none" } },
  narrow: { display: { default: "none", [media.belowPhone]: "contents" } },
  stack: { display: "grid", gap: grasp.space3, minWidth: 0 },
  facts: { display: "grid", gap: grasp.space1, minWidth: 0 },
  tight: {
    display: "grid",
    gap: grasp.space1,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  problem: { display: "grid", minWidth: 0 },
  where: { fontFamily: grasp.fontMono },
  working: { display: "flex", alignItems: "center", gap: grasp.space2 },
  strip: { flexShrink: 0 },
});

/** What stops the changes being published, the first few, and Fix with Grasp. */
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
    <Alert
      title={t`${plural(count, {
        one: "It can't be published yet: # problem",
        other: "It can't be published yet: # problems",
      })}`}
      tone="danger"
    >
      <ul aria-label={t`Problems`} {...stylex.props(styles.tight)}>
        {shown.map(({ at, line, message }, index) => (
          // A problem has no ID, and the same message may come twice.
          <li key={index} {...stylex.props(styles.problem)}>
            {at === null ? null : (
              <Text element="span" size="xs" tone="muted">
                <span {...stylex.props(styles.where)}>
                  {line === null ? at : `${at}:${line}`}
                </span>
              </Text>
            )}
            <Text element="span" size="xs">
              {message}
            </Text>
          </li>
        ))}
        {more > 0 ? (
          <li>
            <Text element="span" size="xs" tone="muted">
              <Plural one="and # more" other="and # more" value={more} />
            </Text>
          </li>
        ) : null}
      </ul>
      <Button icon={Sparkles} onClick={onFix} size="xs" variant="quiet">
        {t`Fix with Grasp`}
      </Button>
    </Alert>
  );
};

/** Everything the changes hold, folded away. */
const Summary = ({ changes }: { changes: AppDraftChanges }) => {
  const { t } = useLingui();
  return (
    <Collapsible title={t`What changes`}>
      <div {...stylex.props(styles.stack)}>
        <FileChanges files={changes.files} />
        <ChangesSection title={<Trans>Data</Trans>}>
          <DataChanges changes={changes} />
        </ChangesSection>
        <ChangesSection title={<Trans>Access</Trans>}>
          <AccessChanges changes={changes} />
        </ChangesSection>
      </div>
    </Collapsible>
  );
};

/** What applies to the changes being published: their data, an admin's approval, problems. */
const ChangesNotes = ({
  changes,
  onFix,
}: {
  changes: AppDraftChanges;
  onFix: (problems: readonly AppDraftProblem[]) => void;
}) => {
  const { t, i18n } = useLingui();
  const asksAgain = [...changes.grants, ...changes.callers].some(
    ({ askedAgain }) => askedAgain
  );
  const waiting = changes.permissions.length;
  return (
    <div {...stylex.props(styles.stack)}>
      {changes.files.length === 0 ? null : <Summary changes={changes} />}
      {changesData(changes, i18n) ? (
        <Alert icon={Database} quiet>
          {t`It changes the App's data: see What changes.`}
        </Alert>
      ) : null}
      {waiting > 0 ? (
        <Alert icon={Key} quiet>
          <Plural
            one="It uses # new kind of access. An admin approves that once."
            other="It uses # new kinds of access. An admin approves those once."
            value={waiting}
          />
        </Alert>
      ) : null}
      {asksAgain ? (
        <Alert icon={Key} quiet>
          {t`An admin approves its access again before it works for your team.`}
        </Alert>
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
 * What Undo puts back: whom a share added, and, when publishing made a
 * new version current over one the team had (`before`) from the draft at
 * `revision`, that version again over the new one (`made`), with the
 * draft as it was published; `undone` says so once it is.
 */
interface Undoable {
  app: string;
  added: readonly AppMemberRef[];
  back: { before: number; made: number; revision: number } | undefined;
  undone: MessageDescriptor;
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
  toast.error(publishFailureText(error));
};

/**
 * The version the team had before, current again over the App's changes
 * at `revision`, while the one publishing made still is: a colleague's
 * since stays. Then the draft as it was published is the draft again,
 * over that version (its undo point at the revision published), so
 * nothing of the builders' work is left only in History.
 */
const takeBack = async (
  { core, router, onDone }: UndoTools,
  { app, undone }: Undoable,
  back: NonNullable<Undoable["back"]>,
  revision: number
): Promise<void> => {
  const done = await settled(core, async (session) => {
    await session.apps.versions.publish(app, back.before, revision, back.made);
    const [points, now] = await Promise.all([
      session.apps.drafts.points(app),
      session.apps.drafts.get(app),
    ]);
    const published = points.find((point) => point.revision === back.revision);
    if (published !== undefined) {
      await session.apps.drafts.restorePoint(
        app,
        published.number,
        now.revision
      );
    }
  });
  onDone();
  await router.invalidate();
  if (!done.ok) {
    undoFailed(done.error);
    return;
  }
  toast.success(pageI18n._(undone));
};

/**
 * Undo, from the toast that says it was shared or published: takes off
 * whoever was added, then puts back the version the team had before, once
 * the person confirms in a toast of its own when the App changed since.
 * Works from the toast alone, after the workspace was left.
 */
const undoChange = async (
  tools: UndoTools,
  undoable: Undoable
): Promise<void> => {
  const { core, router, onDone } = tools;
  const { app, added, back, undone } = undoable;
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
    toast.success(pageI18n._(undone));
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
  const { revision } = draft.value;
  if (!hasChanges(draft.value)) {
    await takeBack(tools, undoable, back, revision);
    return;
  }
  toast.warning(pageI18n._(msg`Give your team the version they had before?`), {
    description: pageI18n._(
      msg`The App changed since you published it. Going back drops those changes, for everyone who builds this App.`
    ),
    // It stays until it is answered: it asks something.
    duration: Number.POSITIVE_INFINITY,
    action: {
      label: pageI18n._(msg`Drop them and go back`),
      onAction: () => {
        void takeBack(tools, undoable, back, revision);
      },
    },
  });
};

/**
 * The version publishing makes current as it is, with nothing published
 * yet and changes over it that change nothing (the first of an App made
 * from a blueprint); none otherwise, when the changes are what is
 * published.
 */
const versionToPublish = (
  app: App,
  draft: AppDraft | undefined
): number | undefined =>
  draft !== undefined &&
  !hasChanges(draft) &&
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
 * Publishes `app`: its changes (`changes`, as read) or, with none, its
 * first version as it is; `onPublished` and a toast once done, with Undo
 * where the team had a version before; why not otherwise, and `again`
 * when the App moved, so its changes are read again.
 */
const usePublishing = (
  app: App,
  draft: AppDraft | undefined,
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
  const version = versionToPublish(app, draft);
  const { name } = app;
  const publish = async (
    changes: AppDraftChanges | undefined
  ): Promise<boolean> => {
    setBusy(true);
    setFailure(undefined);
    const message = t({
      message: "Published from the App's workspace",
      context: "a version's message",
    });
    const before = app.currentVersion;
    const published = await settled(core, async (session) => {
      if (version !== undefined) {
        const made = await session.apps.versions.publish(
          app.id,
          version,
          draft?.revision ?? 0,
          null
        );
        return made.currentVersion;
      }
      if (changes !== undefined) {
        const made = await session.apps.drafts.publish(
          app.id,
          changes.revision,
          message
        );
        return made.currentVersion;
      }
      return before;
    });
    setBusy(false);
    if (!published.ok) {
      setFailure(publishFailureText(published.error));
      // The App moved: what changes is read again, to look at.
      if (isConflict(published.error)) {
        again();
      }
      return false;
    }
    onPublished();
    await router.invalidate();
    const made = published.value;
    // Nothing to go back to after a first version: Undo only over one.
    const back =
      before === null ||
      made === null ||
      made === before ||
      changes === undefined
        ? undefined
        : { before, made, revision: changes.revision };
    const tools = { core, router, onDone: onPublished };
    toast.success(
      t`${name} is live`,
      back === undefined
        ? {}
        : {
            action: {
              label: t`Undo`,
              onAction: () => {
                void undoChange(tools, {
                  app: app.id,
                  added: [],
                  back,
                  undone: msg`Publishing undone`,
                });
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
 * Shares `app` with `recipients`, those with no share of it yet, so
 * nobody's role changes; `onShared` and a toast with Undo once done, why
 * not otherwise.
 */
const useSharing = (app: App, onShared: () => void) => {
  const { t } = useLingui();
  const core = useCore();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const share = async (recipients: readonly Recipient[]): Promise<boolean> => {
    setBusy(true);
    setFailure(undefined);
    const shared = await settled(core, async (session) => {
      // Only who has no share yet: a builder ticked stays one.
      const sharedWith = await session.apps.members.list(app.id);
      const had = new Set(sharedWith.map((member) => keyOf(member)));
      const added = recipients.filter(
        (recipient) => !had.has(keyOf(recipient))
      );
      for (const { type, id } of added) {
        // oxlint-disable-next-line no-await-in-loop -- one at a time, in order
        await session.apps.members.add(app.id, { type, id, role: "user" });
      }
      return added;
    });
    setBusy(false);
    if (!shared.ok) {
      setFailure(publishFailureText(shared.error));
      return false;
    }
    onShared();
    await router.invalidate();
    const tools = { core, router, onDone: onShared };
    const who = formatList(recipients.map(({ name }) => name));
    toast.success(t`Shared with ${who}`, {
      action: {
        label: t`Undo`,
        onAction: () => {
          void undoChange(tools, {
            app: app.id,
            added: shared.value.map(({ type, id }) => ({ type, id })),
            back: undefined,
            undone: msg`Sharing undone`,
          });
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
 * The changes to publish, read while the App has some and Grasp isn't
 * working on it, with whether they may be published now (`ready`) and
 * Fix with Grasp for what stops them.
 */
const usePublishable = (
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
        t`Fix these problems the check found, so the App can be published:`,
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
    /** Whether the changes may be published now: read, passing, Grasp done. */
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
      <Text size="sm" tone="muted">
        {t`Nobody else to share with.`}
      </Text>
    );
  }
  // Teams, then people, each under its own heading, never "Team" on
  // every row; a person by their face.
  const groups = [
    { label: t`Teams`, of: offered.filter(({ type }) => type === "team") },
    { label: t`People`, of: offered.filter(({ type }) => type === "person") },
  ].filter(({ of }) => of.length > 0);
  return (
    <section aria-label={t`Who gets it`} {...stylex.props(styles.stack)}>
      {groups.map((group) => (
        <div key={group.label} {...stylex.props(styles.tight)}>
          <Text size="xs" tone="muted" weight="medium">
            {group.label}
          </Text>
          <ul aria-label={group.label} {...stylex.props(styles.tight)}>
            {group.of.map((recipient) => {
              const key = keyOf(recipient);
              const has = shared.has(key);
              const named =
                recipient.type === "person"
                  ? apart.named(recipient)
                  : (recipient.name ?? "");
              return (
                <li key={key}>
                  <Field orientation="horizontal">
                    <Checkbox
                      checked={has || chosen.includes(key)}
                      disabled={has || disabled}
                      onCheckedChange={(checked) => {
                        const rest = chosen.filter((one) => one !== key);
                        onChosen(checked === true ? [...rest, key] : rest);
                      }}
                    />
                    {recipient.type === "person" ? (
                      <Avatar decorative name={named} size="xs">
                        <AvatarFallback />
                      </Avatar>
                    ) : null}
                    <FieldContent>
                      <FieldLabel>{named}</FieldLabel>
                      {has ? (
                        <FieldDescription>{t`has it`}</FieldDescription>
                      ) : null}
                    </FieldContent>
                  </Field>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
};

/**
 * Share's sheet: who gets the App, its teams and people by name, whom it
 * is shared with already ticked. Share gives it to whoever was ticked and
 * nothing else: what they open is what was published.
 */
const ShareSheet = ({
  app,
  members,
  open,
  onOpenChange,
  onShared,
}: {
  app: App;
  /** Whom it is shared with now. */
  members: readonly AppMember[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onShared: () => void;
}) => {
  const { t } = useLingui();
  const core = useCore();
  const { name } = app;
  const [candidates, setCandidates] = useState<ShareCandidates>();
  const [chosen, setChosen] = useState<string[]>([]);
  const { busy, failure, share, clear } = useSharing(app, onShared);
  const offered =
    candidates === undefined ? undefined : recipientsOf(candidates, app.owner);
  const recipients = (offered ?? []).filter((each) =>
    chosen.includes(keyOf(each))
  );
  // Who may get it, read each time the sheet opens, from the bar or from
  // Publish.
  useEffect(() => {
    let current = true;
    const load = async (): Promise<void> => {
      if (!open) {
        return;
      }
      const listed = await settled(
        core,
        async (session) => await session.apps.members.candidates(app.id)
      );
      if (current) {
        setCandidates(
          listed.ok ? listed.value : { people: [], teams: [], projects: [] }
        );
      }
    };
    void load();
    return () => {
      current = false;
    };
  }, [core, app.id, open]);
  const close = (): void => {
    clear();
    onOpenChange(false);
  };
  return (
    <Sheet
      onOpenChange={(opening) => {
        if (opening) {
          onOpenChange(true);
        } else {
          close();
        }
      }}
      open={open}
    >
      <SheetContent closeLabel={t`Close`}>
        <SheetTitle>{t`Share ${name}`}</SheetTitle>
        <SheetDescription>
          {app.currentVersion === null
            ? t`They'll find it under Apps once it is published.`
            : t`They'll find it under Apps, and see it as it is now.`}
        </SheetDescription>
        <SheetBody>
          <div {...stylex.props(styles.stack)}>
            <WhoGetsIt
              chosen={chosen}
              disabled={busy}
              members={members}
              offered={offered}
              onChosen={setChosen}
            />
            {failure === undefined ? null : (
              <Alert tone="danger">{failure}</Alert>
            )}
          </div>
        </SheetBody>
        <SheetFooter>
          <Button onClick={close} variant="ghost">
            {t`Not yet`}
          </Button>
          <Button
            disabled={recipients.length === 0 || busy}
            onClick={() => {
              void (async () => {
                if (await share(recipients)) {
                  close();
                  setChosen([]);
                }
              })();
            }}
            variant="ink"
          >
            {t`Share`}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
};

/** Where the App stands, in one line with a dot: live and at which version, or not yet. */
const StateLine = ({ app, changing }: { app: App; changing: boolean }) => {
  const { t } = useLingui();
  const label = app.liveLabel ?? "";
  if (app.currentVersion === null) {
    return (
      <Badge tone="attention" variant="dot">
        {t`Not live`}
      </Badge>
    );
  }
  return (
    <Badge tone="success" variant="dot">
      {changing ? t`Live, ${label}; changes not live yet` : t`Live, ${label}`}
    </Badge>
  );
};

/** How the changes' check stands, as one row: running, passed, or nothing to publish. */
const CheckLine = ({
  publishable,
  running,
  first,
}: {
  publishable: ReturnType<typeof usePublishable>;
  running: boolean;
  /** Whether its first version is published as it is, with no changes to check. */
  first: boolean;
}) => {
  const { t } = useLingui();
  if (running || (publishable.changing && publishable.changes === undefined)) {
    // Why the read failed stands under the rows.
    return publishable.read?.state === "failed" && !running ? null : (
      <Item size="sm">
        <ItemMedia>
          <Spinner />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>
            {running ? t`Grasp is still working on it…` : t`Checking it…`}
          </ItemTitle>
        </ItemContent>
      </Item>
    );
  }
  if (publishable.changes?.check.passed === false) {
    // What stops it stands under the rows, with Fix with Grasp.
    return null;
  }
  return (
    <Item size="sm">
      <ItemMedia icon={Done} />
      <ItemContent>
        <ItemTitle>
          {publishable.changing || first
            ? t`Checks pass`
            : t`Nothing new to publish`}
        </ItemTitle>
      </ItemContent>
    </Item>
  );
};

/**
 * What Publish's popover holds: where the App stands, its address, who
 * can open it and how its check stands, then what applies to the changes
 * and Publish.
 */
const PublishPanel = ({
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
  app: App;
  members: readonly AppMember[];
  publishable: ReturnType<typeof usePublishable>;
  running: boolean;
  /** Whether its first version is published as it is, with no changes to check. */
  first: boolean;
  /** Why publishing didn't go through. */
  failure: string | undefined;
  canPublish: boolean;
  onLink: () => void;
  onShare: () => void;
  onFix: (problems: readonly AppDraftProblem[]) => void;
  onPublish: () => void;
}) => {
  const { t } = useLingui();
  const who = userNames(members);
  return (
    <>
      <PopoverTitle>
        <StateLine app={app} changing={publishable.changing} />
      </PopoverTitle>
      <div {...stylex.props(styles.facts)}>
        <Item size="sm">
          <ItemMedia icon={LinkIcon} />
          <ItemContent>
            <ItemTitle>
              {app.link === null ? t`No address yet` : linkAddress(app.link)}
            </ItemTitle>
            <ItemDescription>{t`Address`}</ItemDescription>
          </ItemContent>
          <ItemActions>
            <Button
              aria-label={t`Change the address`}
              icon={Edit}
              onClick={onLink}
              size="xs"
              variant="ghost"
            />
          </ItemActions>
        </Item>
        <Item size="sm">
          <ItemMedia icon={People} />
          <ItemContent>
            <ItemTitle>
              {who.length === 0 ? t`Only its builders` : formatList(who)}
            </ItemTitle>
            <ItemDescription>{t`Who can open it`}</ItemDescription>
          </ItemContent>
          <ItemActions>
            <Button
              aria-label={t`Share`}
              icon={ChevronRight}
              onClick={onShare}
              size="xs"
              variant="ghost"
            />
          </ItemActions>
        </Item>
        <CheckLine first={first} publishable={publishable} running={running} />
      </div>
      {publishable.read?.state === "failed" ? (
        <Alert tone="danger">{publishable.read.text}</Alert>
      ) : null}
      {publishable.changes === undefined ? null : (
        <ChangesNotes changes={publishable.changes} onFix={onFix} />
      )}
      {failure === undefined ? null : <Alert tone="danger">{failure}</Alert>}
      <PopoverFooter>
        <Button disabled={!canPublish} onClick={onPublish} variant="ink">
          {t`Publish`}
        </Button>
      </PopoverFooter>
    </>
  );
};

/**
 * The end of the App's bar: Share, then Publish, the page's one ink
 * action. Share opens its sheet, who gets the App. Publish opens a
 * popover that says where the App stands, its address, who can open it
 * and whether its changes pass their check, and publishes them: the
 * changes only its builders see become what everyone it is shared with
 * opens. On a phone Share folds into Publish's popover (its "Who can open
 * it" row), and Publish is its icon alone, so the bar keeps one row.
 */
export const ShareAndPublish = ({
  app,
  draft,
  members,
  running,
  onShared,
}: {
  app: App;
  /** The App's changes, as read last; none while they are read. */
  draft: AppDraft | undefined;
  /** Whom it is shared with now. */
  members: readonly AppMember[];
  /** Whether Grasp is working on it, or checking it. */
  running: boolean;
  /** Told once it was shared or published from here. */
  onShared?: () => void;
}) => {
  const { t } = useLingui();
  // Which of Publish's two triggers has its popover open: the worded one, or a phone's icon.
  const [open, setOpen] = useState<"wide" | "narrow">();
  const [sharing, setSharing] = useState(false);
  const [linking, setLinking] = useState(false);
  const told = (): void => {
    onShared?.();
  };
  const publishable = usePublishable(app, draft, running);
  const { busy, failure, publish, clear } = usePublishing(app, draft, {
    onPublished: told,
    again: publishable.again,
  });
  const first = versionToPublish(app, draft) !== undefined;
  const canPublish =
    (publishable.changing || first) && publishable.ready && !busy && !running;
  const panel = (
    <PublishPanel
      app={app}
      canPublish={canPublish}
      failure={failure}
      first={first}
      members={members}
      onFix={(problems) => {
        setOpen(undefined);
        publishable.fix(problems);
      }}
      onLink={() => {
        setOpen(undefined);
        setLinking(true);
      }}
      onPublish={() => {
        void (async () => {
          if (await publish(publishable.changes)) {
            setOpen(undefined);
          }
        })();
      }}
      onShare={() => {
        setOpen(undefined);
        setSharing(true);
      }}
      publishable={publishable}
      running={running}
    />
  );
  const opens = (width: "wide" | "narrow") => (opening: boolean) => {
    if (opening) {
      clear();
    }
    setOpen(opening ? width : undefined);
  };
  return (
    <>
      <span {...stylex.props(styles.wide)}>
        <Button
          icon={People}
          onClick={() => {
            setSharing(true);
          }}
          size="sm"
          variant="quiet"
        >
          {t`Share`}
        </Button>
        <Popover onOpenChange={opens("wide")} open={open === "wide"}>
          <PopoverTrigger
            disabled={draft === undefined}
            size="sm"
            variant="ink"
          >
            {t`Publish`}
          </PopoverTrigger>
          <PopoverContent align="end">{panel}</PopoverContent>
        </Popover>
      </span>
      <span {...stylex.props(styles.narrow)}>
        <Popover onOpenChange={opens("narrow")} open={open === "narrow"}>
          <PopoverTrigger
            aria-label={t`Publish`}
            disabled={draft === undefined}
            icon={Upload}
            size="sm"
            variant="ink"
          />
          <PopoverContent align="end">{panel}</PopoverContent>
        </Popover>
      </span>
      <ShareSheet
        app={app}
        members={members}
        onOpenChange={setSharing}
        onShared={told}
        open={sharing}
      />
      <AppLinkDialog app={app} onOpenChange={setLinking} open={linking} />
    </>
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
 * which discards them once the person confirms. Publishing them is the
 * bar's (`ShareAndPublish`).
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
  const shareable = usePublishable(app, draft, running);
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
      {...stylex.props(styles.strip)}
    >
      <Alert
        action={
          <>
            {problems.length > 0 ? (
              <Button
                icon={Sparkles}
                onClick={() => {
                  shareable.fix(problems);
                }}
                size="xs"
                variant="quiet"
              >
                {t`Fix with Grasp`}
              </Button>
            ) : null}
            <Button
              disabled={undo.busy || running}
              onClick={() => {
                setAsked({ kind: "discard" });
              }}
              size="xs"
              variant="quiet"
            >
              {t`Undo`}
            </Button>
          </>
        }
        title={t`${plural(changed, {
          one: "# change only you see",
          other: "# changes only you see",
        })}`}
        tone={undo.failure === undefined ? "neutral" : "danger"}
        variant="banner"
      >
        {undo.failure ?? (
          <>
            {t`You’re seeing your version.`}
            {summaries.length === 0 ? null : ` ${formatList(summaries)}`}
          </>
        )}
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
