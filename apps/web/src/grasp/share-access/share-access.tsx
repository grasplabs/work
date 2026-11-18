// ShareAccess: who has something, and at what level, in one list: an add row on top (a field to
// find a person or group, the level to give, Invite), then each person, group and the whole company
// with the level they have (Select's quiet text variant), the owner's row saying Owner; an optional
// preview of what the receiver will see; and a foot with Copy link and Done. It is the content of
// a Dialog or a Sheet, never a layer of its own.
//
//   <ShareAccess
//     members={[{ id: "finance", name: "Finance team", note: "12 people", kind: "group", level: "use" }]}
//     levels={[{ value: "use", label: "Can use" }, { value: "edit", label: "Can edit" }]}
//     onInvite={(who, level) => invite(who, level)}
//     onLevelChange={(id, level) => change(id, level)}
//     onRemove={(id) => remove(id)}
//     onDone={close}
//   />
//
// Every word is a prop with an English default. Every value is a token (src/tokens). A caller may
// set layout only (the `style` prop).
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { Avatar, AvatarImage, AvatarFallback } from "../avatar";
import { Button, useAction } from "../button";
import { Company, Folder, Icon, Link, People } from "../icons";
import { Input } from "../input";
import { Select, SelectTrigger, SelectValue, SelectContent } from "../select";
import { grasp } from "../tokens/tokens.stylex";
import { useWords, withGiven } from "../words/words";
import { SharePicker } from "./picker";
import type { ShareCandidate, SharePicked } from "./picker";
import { shareAccessWords } from "./words";
import type { ShareAccessWords } from "./words";

type Layout = string | number | null;

/** What a caller may style: where the list sits and how wide it is. Never its look. */
export type ShareAccessLayoutStyle = stylex.StyleXStyles<{
  alignSelf?: Layout;
  justifySelf?: Layout;
  flexGrow?: Layout;
  flexShrink?: Layout;
  gridArea?: Layout;
  gridColumn?: Layout;
  gridRow?: Layout;
  width?: Layout;
  minWidth?: Layout;
  maxWidth?: Layout;
  margin?: Layout;
  marginBlock?: Layout;
  marginInline?: Layout;
}>;

/** One who has access: a person, a group, or everyone at the company. */
export interface ShareMember {
  /** What the events receive. Unique in the list. */
  id: string;
  /** Their name ("Daan Mulder", "Finance team"). Their initials come from it. */
  name: string;
  /**
   * The person looking at the sheet: `youLabel` follows their name ("Sanne de Wit (you)").
   * @default false
   */
  you?: boolean;
  /** A quiet second line: a person's role, a group's count ("12 people"). */
  note?: string;
  /**
   * A person shows their picture or initials; a group the people icon; a project the folder icon;
   * everyone the company icon.
   * @default "person"
   */
  kind?: "person" | "group" | "project" | "everyone";
  /** A person's picture. Without it, their initials. */
  src?: string;
  /** Their level: one of `levels`' values. Not for the owner. */
  level?: string;
  /**
   * The owner: says `ownerLabel` in place of a level, and cannot be changed or removed here.
   * @default false
   */
  owner?: boolean;
}

/** One level of access ("Can use"). */
export interface ShareLevel {
  /** What the events receive. `"none"` is offered on the rows only, never to someone being added. */
  value: string;
  /** Its words ("Can edit"). */
  label: string;
}

/** Every prop a ShareAccess takes. */
export interface ShareAccessProps {
  /** Who has access, in the order shown: the owner first is usual. */
  members: ShareMember[];
  /** The levels, from least to most. A level with the value `"none"` is No access. */
  levels: ShareLevel[];
  /**
   * Adds whoever was typed, at the chosen level: Enter in the field, or Invite. Return a Promise
   * and Invite is out of use while it works; once it settles the field empties and keeps the
   * focus. A rejection says `failedInviteLabel` under the row and keeps the words. Not used when
   * `candidates` makes the add row a picker (see `onAdd`).
   */
  onInvite?: (who: string, level: string) => unknown;
  /**
   * Who can be added, as the host offers them: people, teams and projects, each by id. The add
   * row becomes a picker over them: typing finds them (or, with `filter={false}`, the host's own
   * results for `query`), several can be picked as chips, then Add gives them the chosen level.
   * Someone already in `members` (by id) is shown as having access, not offered again.
   */
  candidates?: ShareCandidate[];
  /**
   * Adds who was picked, at the chosen level: their ids, and typed addresses with `allowAddress`.
   * Return a Promise and Add is out of use while it works; once it settles the picks clear. A
   * rejection says `failedInviteLabel` under the row and keeps them.
   */
  onAdd?: (picked: SharePicked, level: string) => unknown;
  /**
   * With `candidates`: `false` shows them as given, for a server's results for `query`, and the
   * picker does not match them itself.
   * @default true
   */
  filter?: boolean;
  /** With `candidates` and `filter={false}`: the host is fetching results for `query`. */
  loading?: boolean;
  /**
   * With `candidates`: a typed email address is offered as a row of its own ("Invite anna@…"), and
   * reaches `onAdd` among `addresses`. Without it, only candidates can be added.
   * @default false
   */
  allowAddress?: boolean;
  /** A member's level changed. */
  onLevelChange?: (id: string, level: string) => void;
  /** Takes a member away. With it, each row's levels end with `removeLabel`. */
  onRemove?: (id: string) => void;
  /** The level the add row starts at. @default the first level */
  inviteLevel?: string;
  /**
   * The words in the add field, when the page holds them (with `onQueryChange`): to open the
   * sheet with a name already typed, Invite live.
   */
  query?: string;
  /** The words the add field starts with, when it holds its own. */
  defaultQuery?: string;
  /** Called with the add field's words each time they change, and with "" once an invite went through. */
  onQueryChange?: (query: string) => void;
  /** What the receiver will see, under the list, named by `previewLabel`. */
  preview?: ReactNode;
  /**
   * Copies the link to the shared thing. Without it, there is no Copy link. Return a Promise to
   * wait on it. In a Dialog or a Sheet, leave it out here and put a `ShareAccessFoot` in the
   * layer's own footer, so the foot keeps the layer's inset.
   */
  onCopyLink?: () => unknown;
  /** Closes the sheet. Without it, there is no Done. In a Dialog or a Sheet, see `onCopyLink`. */
  onDone?: () => void;
  /**
   * The field's name and placeholder.
   * @default "Add people or groups"
   */
  findLabel?: string;
  /**
   * The add row's level, as a screen reader names it.
   * @default "Access for who you add"
   */
  inviteLevelLabel?: string;
  /**
   * The add button's words.
   * @default "Invite"
   */
  inviteLabel?: string;
  /**
   * Said under the add row when inviting failed.
   * @default "Could not invite"
   */
  failedInviteLabel?: string;
  /**
   * What follows the name of the person looking at the sheet.
   * @default "(you)"
   */
  youLabel?: string;
  /**
   * The list's name, as a screen reader says it.
   * @default "People with access"
   */
  listLabel?: string;
  /**
   * What the owner's row says in place of a level.
   * @default "Owner"
   */
  ownerLabel?: string;
  /**
   * A row's level, as a screen reader names it, from the member's name.
   * @default (name) => `Access for ${name}`
   */
  levelLabel?: (name: string) => string;
  /**
   * The last choice in each row's levels, with `onRemove`.
   * @default "Remove"
   */
  removeLabel?: string;
  /**
   * The words over the preview.
   * @default "What they will see"
   */
  previewLabel?: string;
  /**
   * The link button's words.
   * @default "Copy link"
   */
  copyLinkLabel?: string;
  /**
   * Said on the link button once it copied.
   * @default "Link copied"
   */
  copiedLabel?: string;
  /**
   * Said on the link button when it could not copy.
   * @default "Could not copy"
   */
  copyFailedLabel?: string;
  /**
   * The close button's words.
   * @default "Done"
   */
  doneLabel?: string;
  /** Layout only: margins, alignment and width. */
  layout?: ShareAccessLayoutStyle;
  /** @deprecated Use `layout`. */
  style?: ShareAccessLayoutStyle;
}

// The add row follows its own width, not the window's: in a narrow Sheet on a wide screen it
// stands on two lines as it does on a phone.
const NARROW = "@container (width < 30rem)";

const styles = stylex.create({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space6,
    minWidth: 0,
    fontFamily: grasp.fontSans,
    containerType: "inline-size",
  },
  // The add row: the field, its level, Invite; on a phone the field takes a line of its own.
  add: {
    display: "grid",
    // The field takes what is left; the level and Invite are as wide as their words.
    gridTemplateColumns: {
      default: "minmax(0, 1fr) auto auto",
      [NARROW]: "minmax(0, 1fr) auto",
    },
    gridTemplateAreas: {
      default: '"who level go"',
      [NARROW]: '"who who" "level go"',
    },
    gap: grasp.space2,
    alignItems: "start",
  },
  who: { gridArea: "who", minWidth: 0 },
  level: { gridArea: "level", minWidth: 0 },
  go: { gridArea: "go" },
  rows: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space1,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  row: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr) auto",
    alignItems: "center",
    columnGap: grasp.space3,
    minHeight: grasp.controlLg,
  },
  // A group's or the company's face: its icon in a round the size of a small avatar.
  tile: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: grasp.avatarSm,
    height: grasp.avatarSm,
    borderRadius: grasp.cornerCircle,
    backgroundColor: grasp.soft,
    color: grasp.muted,
  },
  words: { display: "flex", flexDirection: "column", minWidth: 0 },
  name: {
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.ink,
    overflowWrap: "anywhere",
  },
  note: {
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
    overflowWrap: "anywhere",
  },
  // The owner's word ends where every level's chevron ends: the quiet trigger keeps {space-1}
  // after its chevron, so the word keeps the same. Their boxes, the field and Done share the edge.
  owner: {
    justifySelf: "end",
    paddingInlineEnd: grasp.space1,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.muted,
  },
  previewTitle: {
    margin: 0,
    marginBlockEnd: grasp.space2,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    fontWeight: grasp.weightMedium,
    color: grasp.muted,
  },
  previewBox: {
    padding: grasp.space4,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.soft,
  },
  foot: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: grasp.space2,
  },
  // Copy link at the start of the foot, Done at its end, in the sheet's foot or a layer's footer.
  footStart: { marginInlineEnd: "auto" },
  // An invite that failed: one line under the add row, in the danger colour.
  failed: {
    gridColumn: "1 / -1",
    margin: 0,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.danger,
  },
});

// A choice in a row's levels that is not a level: it takes the member away.
const REMOVE = "\u0000remove";

/** A member's face: their picture or initials, or the icon of a group or the company. */
const Face = ({ member }: { member: ShareMember }) => {
  if (
    member.kind === "group" ||
    member.kind === "project" ||
    member.kind === "everyone"
  ) {
    const marks = { group: People, project: Folder, everyone: Company };
    return (
      <span aria-hidden="true" {...stylex.props(styles.tile)}>
        <Icon icon={marks[member.kind]} />
      </span>
    );
  }
  return (
    <Avatar name={member.name} size="sm" decorative>
      <AvatarImage src={member.src} />
      <AvatarFallback />
    </Avatar>
  );
};

interface RowProps {
  member: ShareMember;
  youLabel: string;
  levels: ShareLevel[];
  ownerLabel: string;
  levelLabel: (name: string) => string;
  removeLabel: string;
  onLevelChange: ((id: string, level: string) => void) | undefined;
  onRemove: ((id: string) => void) | undefined;
}

/** One who has access: face, name and note, and the level (or Owner). */
const Row = ({
  member,
  youLabel,
  levels,
  ownerLabel,
  levelLabel,
  removeLabel,
  onLevelChange,
  onRemove,
}: RowProps) => {
  const items =
    onRemove === undefined
      ? levels
      : [
          ...levels,
          { type: "separator" as const },
          { value: REMOVE, label: removeLabel },
        ];
  return (
    <li data-share-member={member.id} {...stylex.props(styles.row)}>
      <Face member={member} />
      <span {...stylex.props(styles.words)}>
        <span {...stylex.props(styles.name)}>
          {member.you === true ? `${member.name} ${youLabel}` : member.name}
        </span>
        {member.note !== undefined && member.note !== "" && (
          <span {...stylex.props(styles.note)}>{member.note}</span>
        )}
      </span>
      {member.owner === true ? (
        <span {...stylex.props(styles.owner)}>{ownerLabel}</span>
      ) : (
        <Select
          items={items}
          value={member.level ?? null}
          onValueChange={(value: string | null) => {
            if (value === REMOVE) {
              onRemove?.(member.id);
            } else if (value !== null) {
              onLevelChange?.(member.id, value);
            }
          }}
        >
          <SelectTrigger
            size="sm"
            variant="text"
            aria-label={levelLabel(member.name)}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent />
        </Select>
      )}
    </li>
  );
};

/**
 * After a member is taken away, the focus goes to the level of the row that took its place, or the
 * row before, or the field when the list is empty: never to the page's body.
 */
const useFocusAfterRemove = (
  count: number,
  list: { current: HTMLUListElement | null },
  field: () => HTMLElement | null
) => {
  const pending = useRef<number | null>(null);
  const before = useRef(count);
  useEffect(() => {
    const at = pending.current;
    if (count < before.current && at !== null) {
      // Rows, not buttons: the owner's row has no level, so counting buttons would skip one.
      const rows = [
        ...(list.current?.querySelectorAll<HTMLElement>(":scope > li") ?? []),
      ];
      const target =
        rows[Math.min(at, rows.length - 1)]?.querySelector<HTMLElement>(
          "button"
        ) ?? field();
      target?.focus({ preventScroll: true });
      pending.current = null;
    }
    before.current = count;
  }, [count, list, field]);
  return (index: number) => {
    pending.current = index;
  };
};

// The props with their words filled in: the caller's, else the catalogue's, else English.
const withDefaults = (props: ShareAccessProps, words: ShareAccessWords) => ({
  ...props,
  findLabel: props.findLabel ?? words.find,
  inviteLevelLabel: props.inviteLevelLabel ?? words.inviteLevel,
  inviteLabel: props.inviteLabel ?? words.invite,
  failedInviteLabel: props.failedInviteLabel ?? words.failedInvite,
  listLabel: props.listLabel ?? words.list,
  ownerLabel: props.ownerLabel ?? words.owner,
  youLabel: props.youLabel ?? words.you,
  levelLabel: props.levelLabel ?? words.level,
  removeLabel: props.removeLabel ?? words.remove,
  previewLabel: props.previewLabel ?? words.preview,
  copyLinkLabel: props.copyLinkLabel ?? words.copyLink,
  copiedLabel: props.copiedLabel ?? words.copied,
  copyFailedLabel: props.copyFailedLabel ?? words.copyFailed,
  doneLabel: props.doneLabel ?? words.done,
});

type Resolved = ReturnType<typeof withDefaults>;

/** Whether the page's work finished without throwing or rejecting. */
const settles = async (work: () => unknown) => {
  try {
    await work();
    return true;
  } catch {
    return false;
  }
};

/** The add row: a field, the level to give, and Invite. Enter in the field invites. */
const AddRow = ({
  props,
  field,
}: {
  props: Resolved;
  field: () => HTMLElement | null;
}) => {
  const giveable = props.levels.filter((level) => level.value !== "none");
  const [held, setHeld] = useState(props.defaultQuery ?? "");
  const who = props.query ?? held;
  const setWho = (next: string) => {
    if (props.query === undefined) {
      setHeld(next);
    }
    props.onQueryChange?.(next);
  };
  const [level, setLevel] = useState(
    props.inviteLevel ?? giveable[0]?.value ?? ""
  );
  // Invite keeps the width of its own word: while it works it is out of use, and a failure is said
  // on a line under the row, never in the button (whose words would set its width).
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const empty = who.trim() === "";
  const invite = async () => {
    if (empty || busy) {
      return;
    }
    setBusy(true);
    setFailed(false);
    const ok = await settles(() => props.onInvite?.(who.trim(), level));
    setBusy(false);
    if (ok) {
      setWho("");
      field()?.focus({ preventScroll: true });
    } else {
      setFailed(true);
    }
  };
  const onFieldKeys = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" && !empty) {
      event.preventDefault();
      void invite();
    }
  };
  return (
    <div {...stylex.props(styles.add)}>
      <div {...stylex.props(styles.who)}>
        <Input
          aria-label={props.findLabel}
          placeholder={props.findLabel}
          value={who}
          onValueChange={setWho}
          onKeyDown={onFieldKeys}
        />
      </div>
      <div {...stylex.props(styles.level)}>
        <Select
          items={giveable}
          value={level}
          onValueChange={(value: string | null) => {
            if (value !== null) {
              setLevel(value);
            }
          }}
        >
          <SelectTrigger aria-label={props.inviteLevelLabel}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent />
        </Select>
      </div>
      <div {...stylex.props(styles.go)}>
        <Button variant="ink" disabled={empty || busy} onClick={invite}>
          {props.inviteLabel}
        </Button>
      </div>
      {failed && (
        <p role="alert" {...stylex.props(styles.failed)}>
          {props.failedInviteLabel}
        </p>
      )}
    </div>
  );
};

/** The add row as a picker over the host's candidates: chips, the level, and Add. */
const PickerRow = ({
  props,
  words,
}: {
  props: Resolved;
  words: ShareAccessWords;
}) => {
  const giveable = props.levels.filter((level) => level.value !== "none");
  const [held, setHeld] = useState(props.defaultQuery ?? "");
  const query = props.query ?? held;
  const [level, setLevel] = useState(
    props.inviteLevel ?? giveable[0]?.value ?? ""
  );
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const add = async (picked: SharePicked, chosen: string) => {
    setBusy(true);
    setFailed(false);
    const ok = await settles(() => props.onAdd?.(picked, chosen));
    setBusy(false);
    setFailed(!ok);
    return ok;
  };
  return (
    <div {...stylex.props(styles.add)}>
      <SharePicker
        candidates={props.candidates ?? []}
        inList={new Set(props.members.map((member) => member.id))}
        levels={giveable}
        level={level}
        onLevelChange={setLevel}
        onAdd={add}
        query={query}
        onQueryChange={(next) => {
          if (props.query === undefined) {
            setHeld(next);
          }
          props.onQueryChange?.(next);
        }}
        filter={props.filter !== false}
        loading={props.loading === true}
        allowAddress={props.allowAddress === true}
        busy={busy}
        areas={{ who: styles.who, level: styles.level, go: styles.go }}
        words={{
          find: props.findLabel === words.find ? words.pick : props.findLabel,
          add: words.add,
          inviteLevel: props.inviteLevelLabel,
          added: words.added,
          empty: words.noMatch,
          searching: words.searching,
          address: words.address,
          unpick: words.unpick,
        }}
        failed={
          failed ? (
            <p role="alert" {...stylex.props(styles.failed)}>
              {props.failedInviteLabel}
            </p>
          ) : null
        }
      />
    </div>
  );
};

/** Every prop a ShareAccessFoot takes. */
export interface ShareAccessFootProps {
  /** Copies the link to the shared thing. Without it, there is no Copy link. Return a Promise to wait on it. */
  onCopyLink?: () => unknown;
  /** Closes the sheet. Without it, there is no Done. */
  onDone?: () => void;
  /**
   * The link button's words.
   * @default "Copy link"
   */
  copyLinkLabel?: string;
  /**
   * Said on the link button once it copied.
   * @default "Link copied"
   */
  copiedLabel?: string;
  /**
   * Said on the link button when it could not copy.
   * @default "Could not copy"
   */
  copyFailedLabel?: string;
  /**
   * The close button's words.
   * @default "Done"
   */
  doneLabel?: string;
}

/**
 * Copy link at the start and Done at the end. Put it in a DialogFooter or a SheetFooter, so it
 * keeps the layer's inset; ShareAccess draws it itself when given `onCopyLink` or `onDone`.
 */
export const ShareAccessFoot = ({
  onCopyLink,
  onDone,
  copyLinkLabel: copyLinkGiven,
  copiedLabel: copiedGiven,
  copyFailedLabel: copyFailedGiven,
  doneLabel: doneGiven,
}: ShareAccessFootProps) => {
  const {
    copyLink: copyLinkLabel,
    copied: copiedLabel,
    copyFailed: copyFailedLabel,
    done: doneLabel,
  } = withGiven(useWords("shareAccess", shareAccessWords), {
    copyLink: copyLinkGiven,
    copied: copiedGiven,
    copyFailed: copyFailedGiven,
    done: doneGiven,
  });
  const copy = useAction(
    async () => {
      await onCopyLink?.();
    },
    { done: copiedLabel, failed: copyFailedLabel }
  );
  return (
    <>
      {onCopyLink !== undefined && (
        <span data-slot="share-access-copy" {...stylex.props(styles.footStart)}>
          <Button variant="ghost" icon={Link} {...copy.props}>
            {copyLinkLabel}
          </Button>
        </span>
      )}
      {onDone !== undefined && (
        <Button variant="quiet" onClick={onDone}>
          {doneLabel}
        </Button>
      )}
    </>
  );
};

/** The sheet's own foot, for a ShareAccess outside a layer's footer. */
const Foot = ({ props }: { props: Resolved }) => {
  if (props.onCopyLink === undefined && props.onDone === undefined) {
    return null;
  }
  return (
    <div {...stylex.props(styles.foot)}>
      <ShareAccessFoot
        onCopyLink={props.onCopyLink}
        onDone={props.onDone}
        copyLinkLabel={props.copyLinkLabel}
        copiedLabel={props.copiedLabel}
        copyFailedLabel={props.copyFailedLabel}
        doneLabel={props.doneLabel}
      />
    </div>
  );
};

/** What the receiver will see, under the list, when the page gives it. */
const Preview = ({ preview, label }: { preview: ReactNode; label: string }) => {
  const id = useId();
  if (preview === undefined || preview === null) {
    return null;
  }
  return (
    <section aria-labelledby={id}>
      <p id={id} {...stylex.props(styles.previewTitle)}>
        {label}
      </p>
      <div {...stylex.props(styles.previewBox)}>{preview}</div>
    </section>
  );
};

/** Who has access, at what level, and how to add more: the content of a Dialog or a Sheet. */
export const ShareAccess = (given: ShareAccessProps) => {
  const words = useWords("shareAccess", shareAccessWords);
  const props = withDefaults(given, words);
  const { members, onRemove } = props;
  const box = useRef<HTMLDivElement | null>(null);
  const list = useRef<HTMLUListElement | null>(null);
  const field = () => box.current?.querySelector<HTMLElement>("input") ?? null;
  const willRemove = useFocusAfterRemove(members.length, list, field);
  const remove =
    onRemove === undefined
      ? undefined
      : (id: string) => {
          willRemove(members.findIndex((member) => member.id === id));
          onRemove(id);
        };

  return (
    <div
      ref={box}
      data-slot="share-access"
      {...stylex.props(styles.root, props.layout ?? props.style)}
    >
      {props.candidates === undefined ? (
        <AddRow props={props} field={field} />
      ) : (
        <PickerRow props={props} words={words} />
      )}
      <ul
        ref={list}
        aria-label={props.listLabel}
        {...stylex.props(styles.rows)}
      >
        {members.map((member) => (
          <Row
            key={member.id}
            member={member}
            youLabel={props.youLabel}
            levels={props.levels}
            ownerLabel={props.ownerLabel}
            levelLabel={props.levelLabel}
            removeLabel={props.removeLabel}
            onLevelChange={props.onLevelChange}
            onRemove={remove}
          />
        ))}
      </ul>
      <Preview preview={props.preview} label={props.previewLabel} />
      <Foot props={props} />
    </div>
  );
};
