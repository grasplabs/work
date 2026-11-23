// Share dialog: share one thing with people at a level of access, in a Dialog. The add row on top
// (a Combobox over who can be added, the level to give, Add), then everyone who has access with
// their level (the owner's row says Owner; Remove is the last choice of a level), and a foot with
// the link to copy and Done. A level applies when it is chosen: there is no Save.
//
//   <ShareDialog
//     title="Share the spring launch plan"
//     trigger={<Button>Share</Button>}
//     people={team}
//     members={[{ id: "finance", name: "Finance team", icon: UsersIcon, level: "use" }]}
//     levels={[{ value: "use", label: "Can use" }, { value: "edit", label: "Can edit" }]}
//     onInvite={(id, level) => invite(id, level)}
//     onLevelChange={(id, level) => change(id, level)}
//     onRemove={(id) => remove(id)}
//     link="https://example.com/plans/spring"
//   />
//
// A block: install it and edit it. The people and the levels are the product's data.
"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { Avatar, AvatarFallback, AvatarImage } from "../../components/avatar";
import { Button } from "../../components/button";
import { Combobox, ComboboxEmpty } from "../../components/combobox";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../../components/dialog";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemDetail,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../../components/item";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "../../components/select";
import type { SelectItems } from "../../components/select";
import { Snippet } from "../../components/snippet";
import { useAction } from "../../hooks/use-action";
import { Icon, UsersIcon } from "../../lib/icons";
import type { IconData } from "../../lib/icons";
import { colors, font, space } from "../../lib/tokens.stylex";

/** The words a ShareDialog says itself: English here; pass the product's as `labels`. */
export interface ShareDialogLabels {
  /** The picker's add button. */
  add: string;
  /** Said once someone is added. */
  added: string;
  /** Said while someone is added. */
  adding: string;
  /** The link button. */
  copyLink: string;
  /** The close button. */
  done: string;
  /** Said in the add field's list when no one matches the words typed. */
  empty: string;
  /** Said when an invite failed. */
  failedInvite: string;
  /** The add field's name and placeholder. */
  find: string;
  /** The name of the access chosen for who you add. */
  inviteLevel: string;
  /** The name of a member's access, from their name. */
  level: (name: string) => string;
  /** The list's name. */
  list: string;
  /** The owner's access, which cannot change. */
  owner: string;
  /** The remove choice, at the end of a member's levels. */
  remove: string;
  /** After the viewer's own name. */
  you: string;
}

const LABELS: ShareDialogLabels = {
  add: "Add",
  added: "Added",
  adding: "Adding",
  copyLink: "Copy link",
  done: "Done",
  empty: "No one has that name",
  failedInvite: "Could not invite",
  find: "Add people or groups",
  inviteLevel: "Access for who you add",
  level: (name) => `Access for ${name}`,
  list: "People with access",
  owner: "Owner",
  remove: "Remove",
  you: "(you)",
};

/** One who has access: a person, or a group shown by its icon. */
export interface ShareMember {
  /** What the events receive. Unique in the list. */
  id: string;
  /** Their name ("Daan Mulder", "Finance team"). A person's initials come from it. */
  name: string;
  /** A quiet second line: a role, a count ("12 people"). */
  note?: string;
  /** A person's picture. Without it, and without `icon`, their initials. */
  src?: string;
  /** The icon of what kind of member it is, in place of a face: a team, a project, everyone. */
  icon?: IconData;
  /** The person looking at the dialog: "(you)" follows their name. @default false */
  you?: boolean;
  /** The owner: says Owner in place of a level, and cannot be changed or removed. @default false */
  owner?: boolean;
  /** Their level: one of `levels`' values. Not for the owner. */
  level?: string;
}

/** One who can be added: a person, or a group, found by typing their name. */
export interface SharePerson {
  /** What `onInvite` receives. Unique and lasting. */
  id: string;
  /** Their name ("Pieter de Boer", "Design team"). Typing finds it, and initials come from it. */
  name: string;
  /** A quiet line under the name: an email, a count ("6 people"). Typing finds it too. */
  detail?: string;
  /** Their picture. Without it, their initials. */
  src?: string;
}

/** One level of access ("Can edit"). */
export interface ShareLevel {
  /** What the events receive. A level with the value `"none"` is offered on the rows only. */
  value: string;
  /** Its words ("Can edit"). */
  label: string;
}

/** Every prop a ShareDialog takes. */
export interface ShareDialogProps {
  /** What is shared, as the dialog's title ("Share the spring launch plan"). */
  title: string;
  /** One sentence under the title. */
  description?: ReactNode;
  /** The control that opens it: a Button. Leave it out to open it with `open`. */
  trigger?: ReactNode;
  /** Open now. Pair it with `onOpenChange`. */
  open?: boolean;
  /** Runs when the dialog wants to open or close. */
  onOpenChange?: (open: boolean) => void;
  /** Who can be added, as the product knows them. Anyone already in `members` is left out. */
  people: readonly SharePerson[];
  /** Who has access, in the order shown: the owner first is usual. */
  members: readonly ShareMember[];
  /** The levels, from least to most. */
  levels: readonly ShareLevel[];
  /**
   * Adds the person picked, at the level chosen. Return a Promise and Add waits on it; a rejection
   * says so under the row and keeps the pick.
   */
  onInvite: (id: string, level: string) => unknown;
  /** A member's level changed. */
  onLevelChange?: (id: string, level: string) => void;
  /** Takes a member away. With it, each row's levels end with Remove. */
  onRemove?: (id: string) => void;
  /** The link to the shared thing: shown in the foot with a button that copies it. */
  link?: string;
  /** Its words in the product's language; each one left out keeps its English. */
  labels?: Partial<ShareDialogLabels>;
}

const NARROW = "@container (width < 30rem)";

const styles = stylex.create({
  body: { display: "grid", rowGap: space["6"], containerType: "inline-size" },
  // The add row: the picker takes what is left; on a narrow dialog it has a line of its own.
  add: {
    display: "grid",
    gridTemplateColumns: {
      default: "minmax(0, 1fr) auto auto",
      [NARROW]: "minmax(0, 1fr) auto",
    },
    gridTemplateAreas: {
      default: '"who level go"',
      [NARROW]: '"who who" "level go"',
    },
    gap: space["2"],
    alignItems: "start",
  },
  who: { gridArea: "who", minWidth: 0 },
  level: { gridArea: "level", minWidth: 0 },
  go: { gridArea: "go" },
  failed: {
    gridColumn: "1 / -1",
    margin: 0,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.destructive,
  },
  owner: {
    paddingInlineEnd: space["2"],
    fontSize: font.textSm,
    color: colors.mutedForeground,
  },
  link: { flexGrow: 1, minWidth: 0 },
});

// A choice in a row's levels that is not a level: it takes the member away.
const REMOVE = "\u0000remove";

/** A member's face: their picture or initials, or the icon of their kind. */
const Face = ({ member }: { member: ShareMember }) =>
  member.icon === undefined ? (
    <Avatar name={member.name} size="sm" decorative>
      <AvatarImage src={member.src} />
      <AvatarFallback />
    </Avatar>
  ) : (
    <Icon icon={member.icon} />
  );

/** The add row: who, at what level, and Add. */
const AddRow = ({
  people,
  levels,
  onInvite,
  words,
}: {
  people: readonly SharePerson[];
  levels: readonly ShareLevel[];
  onInvite: ShareDialogProps["onInvite"];
  words: ShareDialogLabels;
}) => {
  const giveable = levels.filter((level) => level.value !== "none");
  const [picked, setPicked] = useState<string | null>(null);
  const [level, setLevel] = useState(giveable[0]?.value ?? "");
  const who = useRef<HTMLDivElement>(null);
  const invite = useAction(
    async (user: string, at: string) => {
      await onInvite(user, at);
    },
    {
      loadingLabel: words.adding,
      successLabel: words.added,
      errorLabel: words.failedInvite,
    }
  );
  const add = async () => {
    if (picked === null) {
      return;
    }
    const result = await invite.run(picked, level);
    if (result.ok) {
      setPicked(null);
      // Add goes out of use with no one picked: the focus goes back to the field, for the next.
      who.current?.querySelector("input")?.focus();
    }
  };
  return (
    <div {...stylex.props(styles.add)}>
      <div ref={who} {...stylex.props(styles.who)}>
        <Combobox
          items={people.map((person) => ({
            value: person.id,
            label: person.name,
            description: person.detail,
            media: (
              <Avatar name={person.name} size="xs" decorative>
                <AvatarImage src={person.src} />
                <AvatarFallback />
              </Avatar>
            ),
          }))}
          media={<Icon icon={UsersIcon} />}
          value={picked}
          onValueChange={setPicked}
          aria-label={words.find}
          placeholder={words.find}
        >
          <ComboboxEmpty>{words.empty}</ComboboxEmpty>
        </Combobox>
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
          <SelectTrigger aria-label={words.inviteLevel}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent />
        </Select>
      </div>
      <div {...stylex.props(styles.go)}>
        {/* Its words stay Add: how the invite goes is said, and marked on the button. */}
        <Button disabled={picked === null} status={invite.status} onClick={add}>
          {words.add}
        </Button>
      </div>
      {/* Said once by the action as it fails; the line stays until the next try. */}
      {invite.error !== undefined && (
        <p {...stylex.props(styles.failed)}>{words.failedInvite}</p>
      )}
    </div>
  );
};

/** Who has access, each with their level, or Owner. */
const Members = ({
  members,
  levels,
  onLevelChange,
  onRemove,
  words,
}: Pick<
  ShareDialogProps,
  "members" | "levels" | "onLevelChange" | "onRemove"
> & {
  words: ShareDialogLabels;
}) => {
  const list = useRef<HTMLDivElement>(null);
  // After a member is taken away, focus goes to the level of the row that took its place, or the
  // row before, or the add field when the list is empty: never to the page's body.
  const removedAt = useRef<number | null>(null);
  const count = useRef(members.length);
  useEffect(() => {
    const at = removedAt.current;
    const fewer = members.length < count.current;
    count.current = members.length;
    if (at === null || !fewer) {
      return;
    }
    removedAt.current = null;
    const rows = [...(list.current?.querySelectorAll("li") ?? [])];
    const next =
      rows[Math.min(at, rows.length - 1)]?.querySelector("button") ??
      list.current?.closest("[data-slot=share-dialog]")?.querySelector("input");
    next?.focus();
  }, [members.length]);
  const choices: SelectItems =
    onRemove === undefined
      ? [...levels]
      : [
          ...levels,
          { type: "separator" as const },
          { value: REMOVE, label: words.remove },
        ];
  return (
    <div ref={list}>
      <ItemGroup aria-label={words.list}>
        {members.map((member, index) => (
          <Item key={member.id} size="xs">
            <ItemMedia align="center">
              <Face member={member} />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>
                {member.name}
                {member.you === true && <ItemDetail>{words.you}</ItemDetail>}
              </ItemTitle>
              <ItemDescription>{member.note}</ItemDescription>
            </ItemContent>
            <ItemActions>
              {member.owner === true ? (
                <span {...stylex.props(styles.owner)}>{words.owner}</span>
              ) : (
                <Select
                  items={choices}
                  value={member.level ?? null}
                  onValueChange={(value: string | null) => {
                    if (value === REMOVE) {
                      removedAt.current = index;
                      onRemove?.(member.id);
                    } else if (value !== null) {
                      onLevelChange?.(member.id, value);
                    }
                  }}
                >
                  <SelectTrigger
                    size="sm"
                    variant="ghost"
                    aria-label={words.level(member.name)}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent />
                </Select>
              )}
            </ItemActions>
          </Item>
        ))}
      </ItemGroup>
    </div>
  );
};

/** Share one thing with people at a level of access, in a Dialog. */
export const ShareDialog = ({
  title,
  description,
  trigger,
  open,
  onOpenChange,
  people,
  members,
  levels,
  onInvite,
  onLevelChange,
  onRemove,
  link,
  labels,
}: ShareDialogProps) => {
  const words = { ...LABELS, ...labels };
  const inList = new Set(members.map((member) => member.id));
  return (
    <Dialog
      {...(open === undefined ? {} : { open })}
      onOpenChange={(next: boolean) => {
        onOpenChange?.(next);
      }}
    >
      {trigger !== undefined && (
        <DialogTrigger asChild>{trigger}</DialogTrigger>
      )}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description !== undefined && (
            <DialogDescription>{description}</DialogDescription>
          )}
        </DialogHeader>
        <DialogBody>
          <div data-slot="share-dialog" {...stylex.props(styles.body)}>
            <AddRow
              people={people.filter((person) => !inList.has(person.id))}
              levels={levels}
              onInvite={onInvite}
              words={words}
            />
            <Members
              members={members}
              levels={levels}
              onLevelChange={onLevelChange}
              onRemove={onRemove}
              words={words}
            />
          </div>
        </DialogBody>
        <DialogFooter>
          {link !== undefined && (
            <span
              data-slot="share-dialog-copy-link"
              {...stylex.props(styles.link)}
            >
              <Snippet value={link} aria-label={words.copyLink} />
            </span>
          )}
          <DialogClose>{words.done}</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
