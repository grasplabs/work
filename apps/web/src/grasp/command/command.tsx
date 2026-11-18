// Command: a search field over a list of actions, from shadcn's (registry/bases/base/ui/command.tsx,
// on cmdk), converted from Tailwind to StyleX and rebuilt on UI SDK's Command, then made Grasp's:
// the popup's raised surface with the one corner, a search icon before the field, a hairline under
// it, and the list Select and Combobox share. The list is always shown; typing ranks it.
//
// Since release step 6 it is drawn by parts, as in shadcn's. The commands can stay data: a
// CommandList with no children draws the root's `items`, so an agent and the keyboard know every
// one before anything is typed.
//
//   <Command items={commands} onAction={(value) => run(value)}>
//     <CommandInput aria-label="Search actions" placeholder="Search actions" />
//     <CommandEmpty>No results</CommandEmpty>
//     <CommandList />
//   </Command>
//
// Or written out by hand:
//
//   <CommandList>
//     <CommandGroup heading="Project">
//       <CommandItem value="new" icon={Plus} shortcut="mod+j">New project</CommandItem>
//     </CommandGroup>
//   </CommandList>
//
// The older shape below keeps working until step 9: the root draws the parts itself.
//
//   <Command aria-label="Search actions" items={commands} onAction={(value) => run(value)} />
//
// Every value is a token (src/tokens).
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import {
  Command as CommandPrimitive,
  CommandEmpty as EmptyPrimitive,
  CommandGroup as GroupPrimitive,
  CommandGroupLabel,
  CommandInput as InputPrimitive,
  CommandItem as ItemPrimitive,
  CommandItemIcon,
  CommandItemText,
  CommandList as ListPrimitive,
  CommandSeparator as SeparatorPrimitive,
  CommandShortcut,
  CommandStatus,
} from "@ui-sdk/react/command";
import type {
  CommandActionDetails,
  CommandData,
  CommandItemState,
  CommandItemTextState,
  CommandListState,
  CommandShortcutState,
} from "@ui-sdk/react/command";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent, MouseEvent, PointerEvent, ReactNode } from "react";

import { listStyles } from "../combobox/list.styles";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
  createMenuController,
} from "../dropdown-menu";
import type { MenuController } from "../dropdown-menu";
import { visuallyHidden } from "../hidden/hidden";
import { Icon, More, Search, Spinner } from "../icons";
import type { IconData } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import type { LayoutStyle } from "../layout/layout";
import { scroll } from "../scroll/scroll";
import { grasp, media } from "../tokens/tokens.stylex";
import { useWords, withGiven } from "../words/words";
import { commandMarking, commandRow } from "./markers.stylex";
import { commandWords } from "./words";

/** One command. */
export interface CommandEntry {
  /** What `onAction` receives, and how an agent may name it. Unique in the list. */
  value: string;
  /** The words on the command, a verb first ("Invite people"). Typing matches them. */
  label: string;
  /** An icon before the words. Import it from the icons entry (`@/components/grasp/icons`). */
  icon?: IconData;
  /**
   * What stands before the words in the icon's place, for a row that is a person or a thing with
   * a mark of its own: an Avatar, a Brand icon, an Agent mark. It is decoration: the row is named
   * by its `label`. Given with `icon`, it wins.
   */
  media?: ReactNode;
  /** A keyboard shortcut that runs it while the list is on the page, like `"mod+j"`. Shown at the end. */
  shortcut?: string;
  /** Other words typing finds it by ("member" for Invite people). */
  keywords?: string[];
  /** Out of use: skipped by the keys and the pointer. */
  disabled?: boolean;
  /** For an action that can fail: the words shown on the command, and given to an agent, when it does. */
  failedLabel?: string;
  /**
   * A second line under the words, quiet and smaller: where a search result comes from, or what it
   * is ("Project · edited Tuesday"), or where a hit was, with the matched words marked
   * (`<CommandMatch>`). One line, cut with an ellipsis. Typing does not match it; give `keywords`.
   */
  description?: ReactNode;
  /**
   * What stands at the command's end, before its shortcut: a Badge, an Avatar, a count. Words in it
   * are the caller's, so they can be translated. Gives way to the spinner and the failure.
   */
  end?: ReactNode;
  /**
   * More things to do with this one, besides running it: a quiet More at the row's end opens them
   * on the highlighted or hovered row (always shown on a touch screen), and the right arrow opens
   * them from the keys. Enter still runs the command itself.
   */
  actions?: CommandRowAction[];
  /**
   * The one open now (the chat on the page, in a list of chats): in a list that marks one, the rows
   * stand at the regular weight and this one at the medium, with no fill of its own (the highlight
   * stays the list's only fill); said as current.
   */
  current?: boolean;
}

/** One of a command's further actions, in its More menu. */
export interface CommandRowAction {
  /** What `onRowAction` receives with the command's value. */
  value: string;
  /** Its words, a verb first ("Copy link"). */
  label: string;
  /** An icon before the words. */
  icon?: IconData;
  /** An action that deletes or cannot be undone: drawn in the danger colour. */
  danger?: boolean;
}

/** A named run of commands. */
export interface CommandGroupEntry {
  /** Marks this entry as a group. */
  type: "group";
  /** The group's name, small and quiet above it ("Project"). */
  label: string;
  /** The commands in the group, in order. */
  items: CommandEntry[];
}

/** The commands: commands, groups `{ type: "group", label, items }` and separators `{ type: "separator" }`. */
export type CommandItems = (
  | CommandEntry
  | CommandGroupEntry
  | { type: "separator" }
)[];

/** What a caller may style: where the command list sits and how wide it is. */
export type CommandLayoutStyle = LayoutStyle;

/** Every prop a Command takes. */
export interface CommandProps {
  /**
   * Its parts: a CommandInput, a CommandEmpty and a CommandList. Leave it out only in the older
   * shape, where the Command draws them itself.
   */
  children?: ReactNode;
  /**
   * The commands, in the order they show before anything is typed, drawn by a CommandList with no
   * children. Leave it out when the CommandList holds CommandItem parts.
   */
  items?: CommandItems;
  /**
   * Runs the command with this value: Enter, a click, or its shortcut. Return a Promise and the
   * command shows it is working until it settles. If it throws or rejects, the command shows its
   * `failedLabel`, and a screen reader hears it.
   */
  onAction?: (value: string, details: CommandActionDetails) => unknown;
  /** @deprecated Use `CommandInput.aria-label`. */
  "aria-label"?: string;
  /** @deprecated Use `CommandInput.placeholder`. */
  placeholder?: string;
  /** @deprecated Use `CommandEmpty`. */
  empty?: string;
  /** What a failed command says when it has no `failedLabel` of its own. @default "Failed" */
  failedLabel?: string;
  /** The words in the field at first, so the list starts ranked by them. */
  defaultQuery?: string;
  /**
   * The words in the field, when the page holds them (with `onQueryChange`): for search results the
   * page fetches itself.
   */
  query?: string;
  /** Called with the field's words each time they change: typing, clearing with Escape. */
  onQueryChange?: (query: string) => void;
  /**
   * Whether typing narrows and ranks `items`. Set it to false when the page owns the results (a
   * search on a server): the list then shows `items` as given, in their order.
   * @default true
   */
  filter?: boolean;
  /**
   * The page is fetching results: the list is marked busy, `loadingLabel` shows with a spinner
   * where the results come, and `empty` waits until it is done.
   * @default false
   */
  loading?: boolean;
  /**
   * What the list says while results load.
   * @default "Searching"
   */
  loadingLabel?: string;
  /** Runs one of a command's `actions`, with the command's value and the action's. */
  onRowAction?: (value: string, action: string) => unknown;
  /**
   * The More button's name, from the command's words.
   * @default (label) => `More for ${label}`
   */
  moreLabel?: (label: string) => string;
  /**
   * Said with a command that has actions, so the keys are found.
   * @default "Right arrow for more"
   */
  moreHint?: string;
  /** @deprecated Use `layout`. */
  style?: CommandLayoutStyle;
  /** Layout only: margins, alignment and width. */
  layout?: CommandLayoutStyle;
  /**
   * No fill, lift, corner or border of its own, for a Command inside a panel that is already a
   * surface (a dialog, CommandDialog's panel).
   * @default false
   */
  bare?: boolean;
}

// ---- The look --------------------------------------------------------------------------------------

const COARSE = media.coarse;
const FORCED = media.forced;
const REDUCED = media.reduced;

const spin = stylex.keyframes({
  from: { transform: "rotate(0turn)" },
  to: { transform: "rotate(1turn)" },
});

const styles = stylex.create({
  // A face or a mark in the icon's place: it keeps its own size and never squeezes.
  media: { display: "inline-flex", alignItems: "center", flexShrink: 0 },
  // The surface: the popup's, standing in the page.
  root: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    display: "flex",
    flexDirection: "column",
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    overflow: "hidden",
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "currentColor",
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.popupFill,
    boxShadow: grasp.popupLift,
    color: grasp.ink,
    fontFamily: grasp.fontSans,
    fontSize: { default: grasp.textSm, [media.typing]: grasp.fieldTextTouch },
    lineHeight: grasp.textSmLine,
  },
  // In a panel that is already a surface (Commandbar): no fill, lift or corner of its own.
  bare: {
    backgroundColor: "transparent",
    boxShadow: "none",
    borderRadius: 0,
    borderWidth: 0,
  },
  // The search row: the icon, then the field, with a hairline under them.
  // Its top corners are the surface's (inherit: the corner, or none when bare), and so are the
  // field's: the forced-colours outline the field keeps follows the surface's rounded top instead of
  // running square into it and being cut at both corners (A3-layers-06).
  search: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    borderStartStartRadius: "inherit",
    borderStartEndRadius: "inherit",
    cornerShape: "inherit",
    borderBottomWidth: grasp.hairline,
    borderBottomStyle: "solid",
    borderBottomColor: { default: grasp.line, [FORCED]: "CanvasText" },
  },
  searchIcon: {
    position: "absolute",
    insetInlineStart: grasp.space3,
    display: "inline-flex",
    color: grasp.muted,
    pointerEvents: "none",
  },
  // The field draws no box of its own: the surface is its box. Palermo's measure: 40px, words in
  // text-md. On a touch screen 44px and 16px, so a finger finds it and iOS does not zoom.
  input: {
    flexGrow: 1,
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    minHeight: { default: 0, [COARSE]: grasp.tap },
    margin: 0,
    paddingBlock: grasp.space2,
    paddingInlineStart: `calc(${grasp.space3} + ${grasp.iconSm} + ${grasp.space2})`,
    paddingInlineEnd: grasp.space3,
    appearance: "none",
    borderWidth: 0,
    backgroundColor: "transparent",
    color: grasp.ink,
    caretColor: grasp.ink,
    fontFamily: grasp.fontSans,
    fontSize: { default: grasp.textMd, [media.typing]: grasp.fieldTextTouch },
    lineHeight: grasp.textMdLine,
    // No ring of its own (see search): in forced colours, where the hairline is the system's line,
    // the system's own highlight marks it while it has focus.
    outline: {
      default: "none",
      ":focus-visible": {
        default: "none",
        [FORCED]: `${grasp.ringWidth} solid Highlight`,
      },
    },
    outlineOffset: `calc(-1 * ${grasp.ringWidth})`,
    borderStartStartRadius: "inherit",
    borderStartEndRadius: "inherit",
    cornerShape: "inherit",
    "::selection": { backgroundColor: grasp.fieldSelection, color: grasp.ink },
    "::placeholder": { color: grasp.muted, opacity: 1 },
  },
  // The list scrolls past popup-height.
  list: {
    boxSizing: "border-box",
    maxHeight: grasp.popupHeight,
    overflowY: "auto",
    overscrollBehavior: "auto",
    padding: grasp.popupPadding,
    outline: "none",
  },
  // Nothing matches: one line where the list was, as far from the edge as an item's words.
  empty: {
    marginInline: grasp.popupPadding,
    marginBlockStart: grasp.popupPadding,
  },
  // Working: the pointer says so and the spinner at the end turns.
  pending: {
    cursor: "progress",
  },
  spinner: {
    display: "inline-flex",
    animationName: { default: spin, [REDUCED]: "none" },
    animationDuration: grasp.durationSpin,
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },
  failed: {
    color: grasp.danger,
  },
  // The open one (`current`): Item's selected fill while another is highlighted, its words heavier;
  // a border in forced colours, where fills drop.
  current: {
    fontWeight: grasp.weightMedium,
    // In forced colours, where weight can be hard to tell, a hairline marks it too.
    outlineStyle: { default: "none", [FORCED]: "solid" },
    outlineWidth: { default: null, [FORCED]: grasp.hairline },
    outlineOffset: { default: null, [FORCED]: `calc(-1 * ${grasp.hairline})` },
  },
  // The other rows of a list that marks the open one: the regular weight. Read from the page itself
  // (:has), so a list written as parts marks it as one given as `items` does.
  notCurrent: {
    fontWeight: {
      default: grasp.weightMedium,
      [stylex.when.ancestor(":has([aria-current=true])", commandMarking)]:
        grasp.weightRegular,
    },
  },
  // The words a search matched, in a result's second line: in ink at the medium weight, no fill, so
  // the line stays calm (in forced colours, the system's mark).
  match: {
    backgroundColor: { default: "transparent", [FORCED]: "Mark" },
    color: { default: grasp.ink, [FORCED]: "MarkText" },
    fontWeight: grasp.weightMedium,
  },
  // A command's words and its second line, stacked; the second line quiet and a size down.
  stack: {
    display: "grid",
    flexGrow: 1,
    minWidth: 0,
  },
  description: {
    color: grasp.muted,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  // The page's own thing at a command's end, before its keys.
  endSlot: {
    display: "inline-flex",
    flexShrink: 0,
    alignItems: "center",
    gap: grasp.space2,
    marginInlineStart: "auto",
  },
  // A row with actions holds its More at its end, over its own end when shown, so no words move.
  hasActions: {
    position: "relative",
    paddingInlineEnd: { default: null, [COARSE]: grasp.tap },
  },
  more: {
    position: "absolute",
    insetBlock: 0,
    insetInlineEnd: grasp.space1,
    display: "flex",
    alignItems: "center",
    visibility: {
      default: "hidden",
      [stylex.when.ancestor(":hover", commandRow)]: "visible",
      [COARSE]: "visible",
    },
    // Hidden by opacity and pointer events too: the Button inside draws its words' layer with
    // visibility: visible, which a parent's hidden does not reach, so More showed on every row.
    opacity: {
      default: 0,
      [stylex.when.ancestor(":hover", commandRow)]: 1,
      [COARSE]: 1,
    },
    pointerEvents: {
      default: "none",
      [stylex.when.ancestor(":hover", commandRow)]: "auto",
      [COARSE]: "auto",
    },
  },
  moreShown: {
    visibility: "visible",
    opacity: 1,
    pointerEvents: "auto",
  },
  // The row's own end steps aside while More stands over it.
  endAside: {
    visibility: {
      default: null,
      [stylex.when.ancestor(":hover", commandRow)]: {
        default: "hidden",
        [COARSE]: null,
      },
    },
  },
  endAsideNow: {
    visibility: { default: "hidden", [COARSE]: null },
  },
  // While results load: a spinner and the words, where the results come.
  loading: {
    [iconVars.size]: grasp.iconSm,
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    marginInline: grasp.popupPadding,
    marginBlockStart: grasp.popupPadding,
    paddingInline: grasp.space2,
    color: grasp.muted,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
  },
});

const className = (...parts: (stylex.StyleXStyles | false)[]) =>
  stylex.props(...parts).className;

/** Why a command failed, in the words it shows. */
class CommandFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandFailedError";
  }
}

/** What stands at the end of a command: the spinner while it works, its failure, or its keys. */
const End = ({
  state,
  failed,
  shortcut,
  end,
}: {
  state: CommandItemState;
  failed: string;
  shortcut?: string;
  end?: ReactNode;
}) => {
  if (state.pending) {
    return (
      <span
        aria-hidden="true"
        {...stylex.props(listStyles.itemEnd, styles.spinner)}
      >
        <Icon icon={Spinner} />
      </span>
    );
  }
  if (state.error !== undefined) {
    return (
      <span {...stylex.props(listStyles.itemEnd, styles.failed)}>{failed}</span>
    );
  }
  const keys = shortcut !== undefined && shortcut !== "" && (
    <CommandShortcut {...stylex.props(listStyles.itemEnd)}>
      {(keyState: CommandShortcutState) => keyState.text}
    </CommandShortcut>
  );
  if (end === undefined || end === null) {
    return keys;
  }
  return (
    <span {...stylex.props(styles.endSlot)}>
      {end}
      {keys}
    </span>
  );
};

const Words = () => (
  <CommandItemText {...stylex.props(listStyles.itemWords)}>
    {(state: CommandItemTextState) =>
      state.segments.map((segment, index) =>
        segment.match ? (
          // A match has no id of its own; its place in the label is its key.
          <mark key={index} {...stylex.props(listStyles.mark)}>
            {segment.text}
          </mark>
        ) : (
          segment.text
        )
      )
    }
  </CommandItemText>
);

/** What the list keeps of each command, to find it by value: its name, its failure words, its actions. */
type Known = Pick<CommandEntry, "value" | "label" | "failedLabel" | "actions">;

/** What a row needs for its More: the one menu, and how it is named and opened. */
interface RowMenu {
  menu: MenuController;
  moreLabel: (label: string) => string;
  hintId: string;
  onOpen: (entry: Known | null) => void;
  field: () => HTMLInputElement | null;
}

/** The quiet More at a row's end: the pointer's way to the row's actions (the keys use the right arrow). */
const MoreButton = ({
  entry,
  rows,
  shown,
}: {
  entry: Known;
  rows: RowMenu;
  shown: boolean;
}) => (
  <span {...stylex.props(styles.more, shown && styles.moreShown)}>
    <DropdownMenuTrigger
      controller={rows.menu}
      icon={More}
      aria-label={rows.moreLabel(entry.label)}
      variant="ghost"
      size="xs"
      // The keys stay in the field: Tab never stops here.
      tabIndex={-1}
      onPointerDown={(event: PointerEvent) => {
        event.stopPropagation();
      }}
      onClick={(event: MouseEvent) => {
        event.stopPropagation();
        rows.onOpen(entry);
      }}
    />
  </span>
);

// ---- The parts (release step 6) --------------------------------------------------------------------

/** What the parts read from their Command: its words, its state, and the one menu of row actions. */
interface Scope {
  fieldLabel: string | undefined;
  placeholder: string;
  empty: string;
  loading: boolean;
  loadingLabel: string;
  said: string;
  handleFieldKeys: (event: KeyboardEvent<HTMLInputElement>) => void;
  failedLabel: string;
  rows: RowMenu;
  byValue: Map<string, CommandEntry>;
  register: (entry: Known) => () => void;
}

const CommandScope = createContext<Scope | null>(null);

const useScope = (): Scope => {
  const scope = useContext(CommandScope);
  if (scope === null) {
    throw new Error(
      "A Command part belongs inside a Command or a CommandDialog."
    );
  }
  return scope;
};

/** Every prop a CommandInput takes. */
export interface CommandInputProps {
  /**
   * The search field's name, as a screen reader and an agent say it ("Search actions"). In a
   * CommandDialog, the dialog's `aria-label` when left out.
   */
  "aria-label"?: string;
  /**
   * What the empty field says: a verb and the thing. In a CommandDialog, "Type a command or search"
   * when left out.
   * @default "Search"
   */
  placeholder?: string;
}

/** The search field, with its icon and the hairline under it; the list says here when it is loading. */
export const CommandInput = ({
  "aria-label": ariaLabel,
  placeholder,
}: CommandInputProps) => {
  const scope = useScope();
  return (
    <>
      <div {...stylex.props(styles.search)}>
        <span aria-hidden="true" {...stylex.props(styles.searchIcon)}>
          <Icon icon={Search} />
        </span>
        <InputPrimitive
          aria-label={ariaLabel ?? scope.fieldLabel}
          placeholder={placeholder ?? scope.placeholder}
          onKeyDown={scope.handleFieldKeys}
          {...stylex.props(styles.input)}
        />
      </div>
      <output {...stylex.props(visuallyHidden)}>{scope.said}</output>
      <CommandStatus
        {...stylex.props(scope.loading ? styles.loading : visuallyHidden)}
      >
        {scope.loading && (
          <>
            <span aria-hidden="true" {...stylex.props(styles.spinner)}>
              <Icon icon={Spinner} />
            </span>
            {scope.loadingLabel}
          </>
        )}
      </CommandStatus>
    </>
  );
};

/** Every prop a CommandEmpty takes. */
export interface CommandEmptyProps {
  /**
   * What the list says when nothing matches.
   * @default "No results"
   */
  children?: ReactNode;
}

/** What the list says when nothing matches; it waits while results load. */
export const CommandEmpty = ({ children }: CommandEmptyProps) => {
  const { empty, loading } = useScope();
  return (
    <EmptyPrimitive
      {...stylex.props(
        listStyles.empty,
        styles.empty,
        loading && visuallyHidden
      )}
    >
      {loading ? "" : (children ?? empty)}
    </EmptyPrimitive>
  );
};

/** Every prop a CommandGroup takes. */
export interface CommandGroupProps {
  /** The group's name, small and quiet above it ("Project"). */
  heading?: string;
  /** Its CommandItem parts, in order. */
  children: ReactNode;
}

/** A named run of commands. */
export const CommandGroup = ({ heading, children }: CommandGroupProps) => (
  <GroupPrimitive>
    {heading !== undefined && heading !== "" && (
      <CommandGroupLabel {...stylex.props(listStyles.groupLabel)}>
        {heading}
      </CommandGroupLabel>
    )}
    {children}
  </GroupPrimitive>
);

/** A hairline between commands or groups. */
export const CommandSeparator = () => (
  <SeparatorPrimitive {...stylex.props(listStyles.separator)} />
);

/** Every prop a CommandItem takes: a command's, as `items` gives them, with its words as children. */
export interface CommandItemProps extends Omit<CommandEntry, "label"> {
  /** The words on the command, a verb first ("Invite people"). Typing matches them when they are plain words. */
  children: ReactNode;
  /** The words typing matches and its More is named by, when `children` is not plain words. */
  label?: string;
}

/** One command: Enter, a click or its shortcut runs it. */
export const CommandItem = ({
  children,
  label: labelGiven,
  value,
  icon,
  media: mark,
  shortcut,
  keywords,
  disabled,
  failedLabel,
  description,
  end,
  actions,
  current = false,
}: CommandItemProps) => {
  const { rows, failedLabel: fallback, register } = useScope();
  const plain = typeof children === "string";
  const label = plain ? children : labelGiven;
  const name = label ?? value;
  const withActions = actions !== undefined && actions.length > 0;
  // Known by value, so a failure finds its words and the right arrow its actions.
  useEffect(
    () => register({ value, label: name, failedLabel, actions }),
    [register, value, name, failedLabel, actions]
  );
  const words = plain ? (
    <Words />
  ) : (
    <span {...stylex.props(listStyles.itemWords)}>{children}</span>
  );
  return (
    <ItemPrimitive
      data-command-value={value}
      aria-current={current ? "true" : undefined}
      aria-describedby={withActions ? rows.hintId : undefined}
      value={value}
      label={label}
      keywords={keywords}
      disabled={disabled}
      shortcut={shortcut}
      className={(state: CommandItemState) =>
        className(
          listStyles.item,
          // A list that marks the open one draws its rows at the regular weight, the open one at the
          // medium: the weight alone tells it, the highlight the list's only fill.
          styles.notCurrent,
          current && styles.current,
          state.highlighted && listStyles.itemHighlighted,
          state.disabled && !state.pending && listStyles.itemDisabled,
          state.pending && styles.pending,
          withActions && commandRow,
          withActions && styles.hasActions
        )
      }
    >
      {(state: CommandItemState) => (
        <>
          {mark !== undefined && mark !== null && mark !== false ? (
            <span
              aria-hidden="true"
              data-slot="command-media"
              {...stylex.props(styles.media)}
            >
              {mark}
            </span>
          ) : (
            icon && (
              <CommandItemIcon {...stylex.props(listStyles.itemIcon)}>
                <Icon icon={icon} />
              </CommandItemIcon>
            )
          )}
          {description !== undefined && description !== "" ? (
            <span {...stylex.props(styles.stack)}>
              {words}
              <span {...stylex.props(styles.description)}>{description}</span>
            </span>
          ) : (
            words
          )}
          {withActions ? (
            <span
              {...stylex.props(
                styles.endSlot,
                styles.endAside,
                state.highlighted && styles.endAsideNow
              )}
            >
              <End
                state={state}
                failed={failedLabel ?? fallback}
                shortcut={shortcut}
                end={end}
              />
            </span>
          ) : (
            <End
              state={state}
              failed={failedLabel ?? fallback}
              shortcut={shortcut}
              end={end}
            />
          )}
          {withActions && (
            <MoreButton
              entry={{ value, label: name, failedLabel, actions }}
              rows={rows}
              shown={state.highlighted}
            />
          )}
        </>
      )}
    </ItemPrimitive>
  );
};

/** One command from `items`, as its part. */
const Entry = ({ entry }: { entry: CommandEntry }) => {
  const { label, ...rest } = entry;
  return <CommandItem {...rest}>{label}</CommandItem>;
};

/** The commands from `items` as parts, in the order the list gives them. */
const Entries = ({
  items,
  byValue,
}: {
  items: CommandData;
  byValue: Map<string, CommandEntry>;
}) =>
  items.map((entry, index) => {
    if (typeof entry === "string") {
      const known = byValue.get(entry);
      return known ? <Entry key={entry} entry={known} /> : null;
    }
    if ("type" in entry && entry.type === "separator") {
      // A separator has no value; its place in the list is its key.
      return <CommandSeparator key={`separator-${index}`} />;
    }
    if ("type" in entry && entry.type === "group") {
      return (
        <CommandGroup
          key={`group-${entry.label ?? index}`}
          heading={entry.label}
        >
          {entry.items.map((inner) => {
            const value = typeof inner === "string" ? inner : inner.value;
            const known = byValue.get(value);
            return known ? <Entry key={value} entry={known} /> : null;
          })}
        </CommandGroup>
      );
    }
    const known = byValue.get(entry.value);
    return known ? <Entry key={entry.value} entry={known} /> : null;
  });

/** Every prop a CommandList takes. */
export interface CommandListProps {
  /**
   * The commands: CommandItem, CommandGroup and CommandSeparator parts, in order. Leave it out to
   * draw the Command's `items`, ranked as the user types.
   */
  children?: ReactNode;
}

/** The commands, under the field; it scrolls past a popup's height. */
export const CommandList = ({ children }: CommandListProps) => {
  const { byValue } = useScope();
  return (
    <ListPrimitive {...stylex.props(styles.list, scroll.bar)}>
      {children ??
        ((state: CommandListState) => (
          <Entries items={state.items} byValue={byValue} />
        ))}
    </ListPrimitive>
  );
};

/** Runs the page's action, and says whether it threw rather than letting the throw through. */
const callAction = (
  action: () => unknown
): { ok: true; result: unknown } | { ok: false } => {
  try {
    return { ok: true, result: action() };
  } catch {
    return { ok: false };
  }
};

/** Waits for the action's Promise; a rejection fails the command, with its words. */
const settled = async (result: unknown, fail: () => never) => {
  try {
    return await result;
  } catch {
    return fail();
  }
};

/** Each command by its value, so the parts can wear its icon and failure words. */
const commandsByValue = (items: CommandItems): Map<string, CommandEntry> => {
  const map = new Map<string, CommandEntry>();
  for (const entry of items) {
    if ("type" in entry && entry.type === "group") {
      for (const inner of entry.items) {
        map.set(inner.value, inner);
      }
    } else if (!("type" in entry)) {
      map.set(entry.value, entry);
    }
  }
  return map;
};

/**
 * A command's further actions: one menu for every row, opened from a row's More or by the right
 * arrow at the end of the words, which come back to the field when it closes.
 */
const useRowActions = (
  find: (value: string) => Known | undefined,
  moreLabel: (label: string) => string
) => {
  const root = useRef<HTMLDivElement | null>(null);
  const hintId = useId();
  // One menu for every row's actions, opened from a row's More or the right arrow.
  // oxlint-disable-next-line react/hook-use-state -- made once, never set
  const [menu] = useState(() => createMenuController());
  const [opened, setOpened] = useState<Known | null>(null);
  const field = () =>
    root.current?.querySelector<HTMLInputElement>("input") ?? null;
  const rowOf = (value: string) =>
    [
      ...(root.current?.querySelectorAll<HTMLElement>("[data-command-value]") ??
        []),
    ].find((row) => row.dataset.commandValue === value) ?? null;
  const rows: RowMenu = { menu, moreLabel, hintId, onOpen: setOpened, field };
  // The right arrow at the end of the words opens the highlighted command's actions.
  const handleFieldKeys = (event: KeyboardEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const atEnd =
      input.selectionStart === input.value.length &&
      input.selectionEnd === input.value.length;
    // The highlighted row, as the list marks it (it is highlighted before any key moves it).
    const highlighted = root.current?.querySelector<HTMLElement>(
      "[data-command-value][data-highlighted]"
    )?.dataset.commandValue;
    const entry = highlighted === undefined ? undefined : find(highlighted);
    if (
      event.key !== "ArrowRight" ||
      !atEnd ||
      entry?.actions === undefined ||
      entry.actions.length === 0
    ) {
      return;
    }
    event.preventDefault();
    setOpened(entry);
    void menu.open({ anchor: rowOf(entry.value) ?? undefined, focus: "first" });
  };
  return { root, rows, handleFieldKeys, opened: opened ?? undefined };
};

/** The one menu of a row's actions, beside the row it was opened from. */
const RowActionsMenu = ({
  rows,
  opened,
  moreHint,
  onRowAction,
}: {
  rows: RowMenu;
  opened: Known | undefined;
  moreHint: string;
  onRowAction: CommandProps["onRowAction"];
}) => {
  const { menu, hintId, field } = rows;
  return (
    <>
      <span id={hintId} {...stylex.props(visuallyHidden)}>
        {moreHint}
      </span>
      <DropdownMenu
        controller={menu}
        onOpenChange={(open: boolean) => {
          if (!open) {
            rows.onOpen(null);
            field()?.focus({ preventScroll: true });
          }
        }}
      >
        <DropdownMenuContent
          // Under the row, at its end where More stands: it fits on a phone as on a wide screen.
          side="bottom"
          align="end"
          finalFocus={field}
          onKeyDown={(event: KeyboardEvent<HTMLElement>) => {
            // Left goes back to the results, as Escape does.
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              menu.close();
            }
          }}
        >
          {(opened?.actions ?? []).map((action) => (
            <DropdownMenuItem
              key={action.value}
              icon={action.icon}
              variant={action.danger === true ? "danger" : undefined}
              onSelect={() => {
                if (opened !== undefined) {
                  onRowAction?.(opened.value, action.value);
                }
              }}
            >
              {action.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
};

const NO_ITEMS: CommandItems = [];

/** The command list, with or without a surface of its own; CommandDialog uses it bare in its panel. */
export const CommandView = ({
  children,
  items,
  onAction,
  "aria-label": ariaLabel,
  placeholder: placeholderGiven,
  empty: emptyGiven,
  failedLabel: failedLabelGiven,
  defaultQuery,
  query,
  onQueryChange,
  filter = true,
  loading = false,
  loadingLabel: loadingLabelGiven,
  onRowAction,
  moreLabel: moreLabelGiven,
  moreHint: moreHintGiven,
  style: styleProp,
  layout,
  bare = false,
}: CommandProps) => {
  const {
    placeholder,
    empty,
    failed: failedLabel,
    loading: loadingLabel,
    more: moreLabel,
    moreHint,
  } = withGiven(useWords("command", commandWords), {
    placeholder: placeholderGiven,
    empty: emptyGiven,
    failed: failedLabelGiven,
    loading: loadingLabelGiven,
    more: moreLabelGiven,
    moreHint: moreHintGiven,
  });
  const byValue = commandsByValue(items ?? NO_ITEMS);
  // The commands written as parts, known by value once they are on the page.
  const known = useRef(new Map<string, Known>());
  const find = (value: string): Known | undefined =>
    byValue.get(value) ?? known.current.get(value);
  const register = (entry: Known) => {
    known.current.set(entry.value, entry);
    return () => {
      if (known.current.get(entry.value) === entry) {
        known.current.delete(entry.value);
      }
    };
  };
  const { root, rows, handleFieldKeys, opened } = useRowActions(
    find,
    moreLabel
  );
  // A failed action shows its failedLabel on the command, and the status line says it aloud.
  const [said, setSaid] = useState("");
  const run = (value: string, details: CommandActionDetails) => {
    const words = find(value)?.failedLabel ?? failedLabel;
    const fail = () => {
      setSaid(words);
      throw new CommandFailedError(words);
    };
    setSaid("");
    const outcome = callAction(() => onAction?.(value, details));
    if (!outcome.ok) {
      return fail();
    }
    const { result } = outcome;
    const thenable =
      result !== null && typeof result === "object" && "then" in result;
    return thenable ? settled(result, fail) : result;
  };
  const scope: Scope = {
    fieldLabel: ariaLabel,
    placeholder,
    empty,
    loading,
    loadingLabel,
    said,
    handleFieldKeys,
    failedLabel,
    rows,
    byValue,
    register,
  };
  return (
    <CommandPrimitive
      ref={root}
      items={items}
      defaultQuery={defaultQuery}
      query={query}
      onQueryChange={
        onQueryChange === undefined
          ? undefined
          : (next: string) => {
              onQueryChange(next);
            }
      }
      filter={filter ? undefined : false}
      status={loading ? "loading" : "idle"}
      autoHighlight
      loop
      onAction={run}
      pendingAnnouncement="Working"
      {...stylex.props(
        commandMarking,
        styles.root,
        bare && styles.bare,
        layout ?? styleProp
      )}
    >
      {/* A function, so UI SDK does not look for its own CommandList among the children: not finding
          it (Grasp's wraps it), it would mount a second list for `items` first. */}
      {() => (
        <>
          {/* oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled */}
          <CommandScope value={scope}>
            {children ?? (
              <>
                <CommandInput />
                <CommandEmpty />
                <CommandList />
              </>
            )}
          </CommandScope>
          <RowActionsMenu
            rows={rows}
            opened={opened}
            moreHint={moreHint}
            onRowAction={onRowAction}
          />
        </>
      )}
    </CommandPrimitive>
  );
};

/** A search field over a list of actions, on a surface of its own, or bare inside one. */
export const Command = (props: CommandProps) => <CommandView {...props} />;

/** The words a search matched, marked in a result's second line: `<CommandMatch>invoice</CommandMatch>`. */
export const CommandMatch = ({ children }: { children: ReactNode }) => (
  <mark {...stylex.props(styles.match)}>{children}</mark>
);
