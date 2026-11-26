import { Avatar, AvatarFallback } from "@grasp-os/ui/components/avatar";
import { Button } from "@grasp-os/ui/components/button";
import { Combobox } from "@grasp-os/ui/components/combobox";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { FolderIcon, Icon, UsersIcon } from "@grasp-os/ui/lib/icons";
import {
  colors,
  font,
  radius,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

// Whom something is shared with, as #2503's Share access drew it, on
// Damsko's parts: the add row on top (who, from the people, teams and
// projects the page offers; the role to give; Add), then each member with
// their role at the row's end, a quiet Select whose last choice takes them
// away. Damsko's own share dialog (blocks/share-dialog-01) is a whole
// Dialog: this is the list it holds, for Sharing's settings and Share's
// dialog alike (sharing.tsx). Several can be picked at once, each a chip
// in the field, and Add gives them all the level chosen.

/** Someone, or something, who can be given access. */
export interface ShareCandidate {
  /** What `onAdd` receives; a member's own id once added. */
  id: string;
  name: string;
  kind: "person" | "team" | "project";
  /** A quiet second line, typed into too: a namesake's hint, "Guest". */
  note?: string;
}

/** Someone who has access, at a level. */
export interface ShareMember {
  id: string;
  name: string;
  note?: string;
  kind: "person" | "group" | "project";
  /** Their level: one of the levels' values; none for the owner. */
  level?: string;
  /** The owner: says the owner's word in place of a level, and can't be changed or taken away here. */
  owner?: boolean;
}

/** One level of access ("User"). */
export interface ShareLevel {
  value: string;
  label: string;
}

const NARROW = "@container (width < 30rem)";

const styles = stylex.create({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: space[6],
    minWidth: 0,
    containerType: "inline-size",
  },
  // The field, its level, Add; on a narrow column the field takes a line of its own.
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
    gap: space[2],
    alignItems: "start",
  },
  who: { gridArea: "who", minWidth: 0 },
  level: { gridArea: "level", minWidth: 0 },
  go: { gridArea: "go" },
  rows: {
    display: "flex",
    flexDirection: "column",
    gap: space[1],
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  row: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr) auto",
    alignItems: "center",
    columnGap: space[3],
    minHeight: size.controlLg,
  },
  // A team's or a project's face: its icon in a round the size of a small avatar.
  tile: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: size.avatarSm,
    height: size.avatarSm,
    borderRadius: radius.full,
    backgroundColor: colors.muted,
    color: colors.mutedForeground,
  },
  words: { display: "flex", flexDirection: "column", minWidth: 0 },
  name: {
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.foreground,
    overflowWrap: "anywhere",
  },
  note: {
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    color: colors.mutedForeground,
    overflowWrap: "anywhere",
  },
  // The owner's word ends where every level's chevron ends: the quiet
  // trigger keeps space-1 after its chevron, so the word keeps the same.
  owner: {
    justifySelf: "end",
    paddingInlineEnd: space[1],
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.mutedForeground,
  },
  failed: {
    gridColumn: "1 / -1",
    margin: 0,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.destructive,
  },
});

// A choice in a row's levels that is not a level: it takes the member away.
const REMOVE = "\u0000remove";

/** A member's face: a person's initials, a team's or a project's icon. */
const Face = ({ kind, name }: { kind: ShareMember["kind"]; name: string }) =>
  kind === "person" ? (
    <Avatar decorative name={name} size="sm">
      <AvatarFallback />
    </Avatar>
  ) : (
    <span aria-hidden="true" {...stylex.props(styles.tile)}>
      <Icon icon={kind === "group" ? UsersIcon : FolderIcon} />
    </span>
  );

/**
 * A candidate's face in the list and in its chip: an Avatar, which the
 * chip draws at its own line's size; a team's or a project's icon in it.
 * The decision's people picker draws its people and teams with it too.
 */
export const choiceFace = (
  candidate: Pick<ShareCandidate, "name" | "kind">
) => (
  <Avatar decorative name={candidate.name} size="xs">
    <AvatarFallback>
      {candidate.kind === "person" ? undefined : (
        <Icon icon={candidate.kind === "team" ? UsersIcon : FolderIcon} />
      )}
    </AvatarFallback>
  </Avatar>
);

/** An option's line under its name, when it has one. */
const describedBy = (line: string | undefined) =>
  line === undefined ? {} : { description: line };

/** Whether the page's work finished without throwing or rejecting. */
const settles = async (work: () => unknown): Promise<boolean> => {
  try {
    await work();
    return true;
  } catch {
    return false;
  }
};

/** The add row: who, the level to give, and Add. */
const AddRow = ({
  candidates,
  members,
  levels,
  failedLabel,
  findLabel,
  onAdd,
}: {
  candidates: readonly ShareCandidate[];
  members: readonly ShareMember[];
  levels: readonly ShareLevel[];
  failedLabel: string;
  findLabel: string | undefined;
  onAdd: (ids: string[], level: string) => unknown;
}) => {
  const { t } = useLingui();
  const [picked, setPicked] = useState<string[]>([]);
  const [level, setLevel] = useState(levels[0]?.value ?? "");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const has = new Set(members.map(({ id }) => id));
  const find = findLabel ?? t`Add people, teams or projects`;
  const hasAccess = t`Has access`;
  const add = async (): Promise<void> => {
    setBusy(true);
    setFailed(false);
    const ok = await settles(() => onAdd(picked, level));
    setBusy(false);
    setFailed(!ok);
    if (ok) {
      setPicked([]);
    }
  };
  return (
    <div {...stylex.props(styles.add)}>
      <Combobox
        aria-label={find}
        multiple
        items={candidates.map((candidate) => ({
          value: candidate.id,
          label: candidate.name,
          disabled: has.has(candidate.id),
          media: choiceFace(candidate),
          // Who has it already is marked, not offered again.
          ...describedBy(has.has(candidate.id) ? hasAccess : candidate.note),
          ...(candidate.note === undefined
            ? {}
            : { keywords: [candidate.note] }),
        }))}
        onValueChange={(value) => {
          setPicked(value);
        }}
        placeholder={find}
        style={styles.who}
        value={picked}
      />
      <Select
        items={[...levels]}
        onValueChange={(value: string | null) => {
          if (value !== null) {
            setLevel(value);
          }
        }}
        value={level}
      >
        <SelectTrigger
          aria-label={t`Access for who you add`}
          style={styles.level}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent />
      </Select>
      <Button
        disabled={picked.length === 0 || busy}
        onClick={() => {
          void add();
        }}
        style={styles.go}
      >
        {t`Add`}
      </Button>
      {failed ? (
        <p role="alert" {...stylex.props(styles.failed)}>
          {failedLabel}
        </p>
      ) : null}
    </div>
  );
};

/** One who has access: face, name and note, and the level, whose last choice takes them away. */
const Row = ({
  member,
  levels,
  ownerLabel,
  onLevelChange,
  onRemove,
}: {
  member: ShareMember;
  levels: readonly ShareLevel[];
  ownerLabel: string | undefined;
  onLevelChange: (id: string, level: string) => void;
  onRemove: (id: string) => void;
}) => {
  const { t } = useLingui();
  const { name } = member;
  return (
    <li data-share-member={member.id} {...stylex.props(styles.row)}>
      <Face kind={member.kind} name={name} />
      <span {...stylex.props(styles.words)}>
        <span {...stylex.props(styles.name)}>{name}</span>
        {member.note === undefined ? null : (
          <span {...stylex.props(styles.note)}>{member.note}</span>
        )}
      </span>
      {member.owner === true ? (
        <span {...stylex.props(styles.owner)}>{ownerLabel}</span>
      ) : (
        <Select
          items={[
            ...levels,
            { type: "separator" },
            { value: REMOVE, label: t`Remove` },
          ]}
          onValueChange={(value: string | null) => {
            if (value === REMOVE) {
              onRemove(member.id);
            } else if (value !== null) {
              onLevelChange(member.id, value);
            }
          }}
          value={member.level}
        >
          <SelectTrigger
            aria-label={t`Access for ${name}`}
            size="sm"
            variant="ghost"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent />
        </Select>
      )}
    </li>
  );
};

/** Who has access and the add row over them: Sharing's list, and Share's dialog's. */
export const ShareAccess = ({
  candidates,
  members,
  levels,
  listLabel,
  failedLabel,
  findLabel,
  ownerLabel,
  onAdd,
  onLevelChange,
  onRemove,
}: {
  candidates: readonly ShareCandidate[];
  members: readonly ShareMember[];
  levels: readonly ShareLevel[];
  /** The list's name, for a screen reader. */
  listLabel: string;
  /** Said under the add row when adding failed. */
  failedLabel: string;
  /** The add row's field, its name and its placeholder. @default "Add people, teams or projects" */
  findLabel?: string;
  /** What the owner's row says in place of a level ("Owner"). */
  ownerLabel?: string;
  /** Adds who was picked at the level chosen; a rejection says `failedLabel`. */
  onAdd: (ids: string[], level: string) => unknown;
  onLevelChange: (id: string, level: string) => void;
  onRemove: (id: string) => void;
}) => (
  <div {...stylex.props(styles.root)}>
    <AddRow
      candidates={candidates}
      failedLabel={failedLabel}
      findLabel={findLabel}
      levels={levels}
      members={members}
      onAdd={onAdd}
    />
    {/* Always there, empty too, as #2503's: who has it is a list of none
        before anyone is added, and the dialog keeps its height. */}
    <ul aria-label={listLabel} {...stylex.props(styles.rows)}>
      {members.map((member) => (
        <Row
          key={member.id}
          levels={levels}
          member={member}
          ownerLabel={ownerLabel}
          onLevelChange={onLevelChange}
          onRemove={onRemove}
        />
      ))}
    </ul>
  </div>
);
