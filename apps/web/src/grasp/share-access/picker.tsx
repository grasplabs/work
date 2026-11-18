// Share access's add row as a picker: the host offers who can be added (people, teams, projects,
// each by id), the person picks one or several as chips, chooses the level, and adds them. Built
// on UI SDK's Combobox with `multiple` and drawn from the list Combobox, Select and Owner picker
// share. Someone already in the list is shown as having access, not offered again. With
// `allowAddress`, a typed email address is offered as a row of its own.
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  Combobox as ComboboxPrimitive,
  ComboboxChip,
  ComboboxChipRemove,
  ComboboxChips,
  ComboboxContent,
  ComboboxCreate,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxItemIcon,
  ComboboxItemIndicator,
  ComboboxItemText,
  ComboboxList,
  ComboboxValue,
} from "@ui-sdk/react/combobox";
import type {
  ComboboxItemState,
  ComboboxItemTextState,
  ListData,
  ListItem,
} from "@ui-sdk/react/combobox";
import { useId, useState } from "react";
import type { ReactNode } from "react";

import { Avatar, AvatarFallback, AvatarImage } from "../avatar";
import { Button } from "../button";
import { listStyles } from "../combobox/list.styles";
import { Cross, Folder, Icon, Mail, People, Tick } from "../icons";
import type { IconData } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import { scroll } from "../scroll/scroll";
import { Select, SelectContent, SelectTrigger, SelectValue } from "../select";
import { grasp, media } from "../tokens/tokens.stylex";
import { popup } from "../tokens/tokens.values";

/** Someone, or something, who can be given access: a person, a team, a project. */
export interface ShareCandidate {
  /** What `onAdd` receives. Unique; the same as their `ShareMember` id once added. */
  id: string;
  /** Their name ("Daan Mulder", "Finance", "Spring launch"). Typing finds it. */
  name: string;
  /**
   * A person shows their picture or initials; a team the people icon; a project its icon.
   * @default "person"
   */
  kind?: "person" | "team" | "project";
  /** A person's picture. Without it, their initials. */
  src?: string;
  /** In place of a team's or project's icon. */
  icon?: IconData;
  /** A quiet second line: an email, a count ("12 people"). Typing finds it too. */
  note?: string;
}

/** Who was picked to be added: candidates by id, and typed addresses. */
export interface SharePicked {
  ids: string[];
  addresses: string[];
}

const ADDRESS = "address:";
// A plain check that the words are an email address, as a field's type="email" does.
const isAddress = (words: string) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(words.trim());

const styles = stylex.create({
  // The chips and the field in one box with the field's own look; it grows a line as picks wrap.
  box: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: grasp.space1,
    boxSizing: "border-box",
    minWidth: 0,
    minHeight: grasp.controlMd,
    paddingBlock: `calc((${grasp.controlMd} - ${grasp.controlXs}) / 2)`,
    paddingInline: grasp.space1,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.fieldFill,
    boxShadow: {
      default: `inset 0 0 0 1px ${grasp.fieldEdge}, ${grasp.fieldLift}`,
      ":focus-within": grasp.fieldFocus,
    },
    outline: { default: "none", [media.forced]: "1px solid CanvasText" },
    cursor: "text",
  },
  input: {
    flexGrow: 1,
    flexBasis: "8rem",
    minWidth: 0,
    height: grasp.controlXs,
    margin: 0,
    paddingInline: grasp.space2,
    borderWidth: 0,
    outline: "none",
    appearance: "none",
    backgroundColor: "transparent",
    color: grasp.ink,
    caretColor: grasp.ink,
    fontFamily: grasp.fontSans,
    fontSize: { default: grasp.textSm, [media.typing]: grasp.fieldTextTouch },
    lineHeight: grasp.textSmLine,
    "::placeholder": { color: grasp.muted, opacity: 1 },
  },
  chip: {
    [iconVars.size]: grasp.badgeIcon,
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space1,
    maxWidth: "100%",
    height: grasp.controlXs,
    boxSizing: "border-box",
    paddingInlineStart: grasp.space1,
    borderRadius: grasp.cornerCircle,
    backgroundColor: grasp.soft,
    boxShadow: grasp.edge,
    color: grasp.ink,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    outline: {
      default: "none",
      ":focus-visible": `${grasp.ringWidth} solid ${grasp.ring}`,
    },
  },
  chipName: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  chipRemove: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: grasp.controlXs,
    height: grasp.controlXs,
    margin: 0,
    padding: 0,
    borderWidth: 0,
    borderRadius: grasp.cornerCircle,
    backgroundColor: { default: "transparent", ":hover": grasp.ghostFillHover },
    color: grasp.muted,
    cursor: "pointer",
  },
  // A team's or a project's face: its icon in a round the size of the avatar beside it.
  tile: {
    [iconVars.size]: grasp.badgeIcon,
    display: "inline-flex",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    width: grasp.avatarXs,
    height: grasp.avatarXs,
    borderRadius: grasp.cornerCircle,
    backgroundColor: grasp.soft,
    color: grasp.muted,
  },
  tileSmall: {
    width: grasp.iconSm,
    height: grasp.iconSm,
    backgroundColor: "transparent",
  },
  words: { display: "flex", flexDirection: "column", flexGrow: 1, minWidth: 0 },
  note: {
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: { default: grasp.muted, [media.forced]: "inherit" },
    overflowWrap: "anywhere",
  },
  row: { paddingBlock: grasp.space1 },
  icon: { display: "flex", flexShrink: 0 },
  content: { width: "var(--anchor-width)", minWidth: "16rem" },
});

const className = (...parts: (stylex.StyleXStyles | false)[]) =>
  stylex.props(...parts).className;

/** A candidate's face: a person's picture or initials, a team's or project's icon. */
const Face = ({
  candidate,
  small = false,
}: {
  candidate: ShareCandidate;
  small?: boolean;
}) => {
  if (candidate.kind === "team" || candidate.kind === "project") {
    return (
      <span
        aria-hidden="true"
        {...stylex.props(styles.tile, small && styles.tileSmall)}
      >
        <Icon
          icon={candidate.icon ?? (candidate.kind === "team" ? People : Folder)}
        />
      </span>
    );
  }
  return (
    <Avatar name={candidate.name} size={small ? "2xs" : "xs"} decorative>
      <AvatarImage src={candidate.src} />
      <AvatarFallback />
    </Avatar>
  );
};

/** A candidate's name, the letters typing matched marked. */
const Words = () => (
  <ComboboxItemText {...stylex.props(listStyles.itemWords)}>
    {(state: ComboboxItemTextState) =>
      state.segments.map((segment, index) =>
        segment.match ? (
          <mark key={index} {...stylex.props(listStyles.mark)}>
            {segment.text}
          </mark>
        ) : (
          segment.text
        )
      )
    }
  </ComboboxItemText>
);

export interface PickerWords {
  find: string;
  add: string;
  inviteLevel: string;
  added: string;
  empty: string;
  searching: string;
  address: (address: string) => string;
  unpick: (name: string) => string;
}

export interface PickerProps {
  candidates: readonly ShareCandidate[];
  /** Who already has access: shown as such, not offered. */
  inList: ReadonlySet<string>;
  levels: { value: string; label: string }[];
  level: string;
  onLevelChange: (level: string) => void;
  onAdd: (picked: SharePicked, level: string) => unknown;
  query: string;
  onQueryChange: (query: string) => void;
  filter: boolean;
  loading: boolean;
  allowAddress: boolean;
  words: PickerWords;
  /** The add row's grid areas, from Share access. */
  areas: {
    who: stylex.StyleXStyles;
    level: stylex.StyleXStyles;
    go: stylex.StyleXStyles;
  };
  failed: ReactNode;
  busy: boolean;
}

/** The add row as a picker: chips of who is picked, the level, and Add. */
export const SharePicker = ({
  candidates,
  inList,
  levels,
  level,
  onLevelChange,
  onAdd,
  query,
  onQueryChange,
  filter,
  loading,
  allowAddress,
  words,
  areas,
  failed,
  busy,
}: PickerProps) => {
  const ids = useId();
  const byId = new Map(
    candidates.map((candidate) => [candidate.id, candidate])
  );
  // Names of picks the host's results no longer hold (a search moved on): kept so a chip keeps its name.
  const [known, setKnown] = useState<Map<string, ShareCandidate>>(new Map());
  const [picked, setPicked] = useState<string[]>([]);
  const nameOf = (value: string) =>
    value.startsWith(ADDRESS)
      ? value.slice(ADDRESS.length)
      : ((byId.get(value) ?? known.get(value))?.name ?? value);
  const candidateOf = (value: string): ShareCandidate | undefined =>
    byId.get(value) ?? known.get(value);
  const items: ListData = candidates.map((candidate): ListItem => ({
    value: candidate.id,
    label: candidate.name,
    keywords: candidate.note === undefined ? undefined : [candidate.note],
    disabled: inList.has(candidate.id),
  }));
  const add = async () => {
    const picks = {
      ids: picked.filter((value) => !value.startsWith(ADDRESS)),
      addresses: picked
        .filter((value) => value.startsWith(ADDRESS))
        .map((value) => value.slice(ADDRESS.length)),
    };
    const ok = await onAdd(picks, level);
    if (ok !== false) {
      setPicked([]);
    }
  };
  const typed = query.trim();
  const offerAddress =
    allowAddress && isAddress(typed) && !picked.includes(`${ADDRESS}${typed}`);
  return (
    <>
      <div {...stylex.props(areas.who)}>
        <ComboboxPrimitive
          multiple
          items={items}
          value={picked}
          onValueChange={(next: string[]) => {
            setKnown((all) => {
              const kept = new Map(all);
              for (const value of next) {
                const candidate = byId.get(value);
                if (candidate) {
                  kept.set(value, candidate);
                }
              }
              return kept;
            });
            setPicked(next);
          }}
          query={query}
          onQueryChange={(next: string) => {
            onQueryChange(next);
          }}
          filter={filter ? "contains" : false}
          itemToLabel={nameOf}
          autoHighlight="always"
        >
          <ComboboxChips {...stylex.props(styles.box)}>
            <ComboboxValue>
              {() =>
                picked.map((value) => {
                  const candidate = candidateOf(value);
                  const name = nameOf(value);
                  return (
                    <ComboboxChip
                      key={value}
                      value={value}
                      {...stylex.props(styles.chip)}
                    >
                      {candidate ? (
                        <Face candidate={candidate} small />
                      ) : (
                        <span aria-hidden="true" {...stylex.props(styles.icon)}>
                          <Icon icon={Mail} />
                        </span>
                      )}
                      <span {...stylex.props(styles.chipName)}>{name}</span>
                      <ComboboxChipRemove
                        aria-label={words.unpick(name)}
                        {...stylex.props(styles.chipRemove)}
                      >
                        <Icon icon={Cross} />
                      </ComboboxChipRemove>
                    </ComboboxChip>
                  );
                })
              }
            </ComboboxValue>
            <ComboboxInput
              aria-label={words.find}
              placeholder={picked.length === 0 ? words.find : undefined}
              {...stylex.props(styles.input)}
            />
          </ComboboxChips>
          <ComboboxContent
            sideOffset={popup.gap}
            collisionPadding={popup.gutter}
            {...stylex.props(listStyles.popup, styles.content, scroll.bar)}
          >
            {/* With an address to offer, its row is the answer: no "nothing matches" above it. */}
            {offerAddress ? null : (
              <ComboboxEmpty {...stylex.props(listStyles.empty)}>
                {loading ? words.searching : words.empty}
              </ComboboxEmpty>
            )}
            <ComboboxList>
              {(state: { items: ListData<unknown> }) =>
                state.items.map((entry) => {
                  const value =
                    typeof entry === "object" &&
                    entry !== null &&
                    "value" in entry &&
                    typeof entry.value === "string"
                      ? entry.value
                      : undefined;
                  const candidate =
                    value === undefined ? undefined : byId.get(value);
                  if (!candidate) {
                    return null;
                  }
                  const added = inList.has(candidate.id);
                  const line = added ? words.added : candidate.note;
                  return (
                    <ComboboxItem
                      key={candidate.id}
                      value={candidate.id}
                      label={candidate.name}
                      disabled={added}
                      aria-label={candidate.name}
                      aria-describedby={
                        line === undefined
                          ? undefined
                          : `${ids}-${candidate.id}`
                      }
                      className={(itemState: ComboboxItemState) =>
                        className(
                          listStyles.item,
                          styles.row,
                          itemState.highlighted && listStyles.itemHighlighted,
                          itemState.disabled && listStyles.itemDisabled
                        )
                      }
                    >
                      <ComboboxItemIcon {...stylex.props(styles.icon)}>
                        <Face candidate={candidate} />
                      </ComboboxItemIcon>
                      <span {...stylex.props(styles.words)}>
                        <Words />
                        {line !== undefined && (
                          <span
                            id={`${ids}-${candidate.id}`}
                            {...stylex.props(styles.note)}
                          >
                            {line}
                          </span>
                        )}
                      </span>
                      <ComboboxItemIndicator {...stylex.props(listStyles.tick)}>
                        <Icon icon={Tick} />
                      </ComboboxItemIndicator>
                    </ComboboxItem>
                  );
                })
              }
            </ComboboxList>
            {offerAddress && (
              <ComboboxCreate
                minLength={3}
                onCreate={(address: string) => {
                  setPicked((all) => [...all, `${ADDRESS}${address.trim()}`]);
                }}
                className={(itemState: { highlighted: boolean }) =>
                  className(
                    listStyles.item,
                    styles.row,
                    itemState.highlighted && listStyles.itemHighlighted
                  )
                }
              >
                <span aria-hidden="true" {...stylex.props(styles.tile)}>
                  <Icon icon={Mail} />
                </span>
                <span {...stylex.props(listStyles.itemWords)}>
                  {words.address(typed)}
                </span>
              </ComboboxCreate>
            )}
          </ComboboxContent>
        </ComboboxPrimitive>
      </div>
      <div {...stylex.props(areas.level)}>
        <Select
          items={levels}
          value={level}
          onValueChange={(value: string | null) => {
            if (value !== null) {
              onLevelChange(value);
            }
          }}
        >
          <SelectTrigger aria-label={words.inviteLevel}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent />
        </Select>
      </div>
      <div {...stylex.props(areas.go)}>
        <Button
          variant="ink"
          disabled={picked.length === 0 || busy}
          onClick={add}
        >
          {words.add}
        </Button>
      </div>
      {failed}
    </>
  );
};
