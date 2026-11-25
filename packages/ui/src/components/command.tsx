// Command: a search field over a list of actions,
// in StyleX, built on UI SDK's Command: the
// popup's raised surface with the one corner, a search icon before the field, a hairline under it,
// and the list Select and Combobox share (lib/styles listStyles). The list is always shown; typing
// ranks it. CommandDialog puts it in a dialog's panel over the page, opened by its trigger or
// mod+k.
//
//   <Command items={commands} onAction={(value) => run(value)}>
//     <CommandInput aria-label="Search actions" placeholder="Search actions" />
//     <CommandEmpty />
//     <CommandList />
//   </Command>
//
// Or written out by hand:
//
//   <CommandList>
//     <CommandGroup heading="Project">
//       <CommandItem value="new" icon={PlusIcon}>
//         New project <CommandShortcut>mod+j</CommandShortcut>
//       </CommandItem>
//     </CommandGroup>
//   </CommandList>
//
// The commands can be data: a CommandList with no children draws the root's `items`, so an agent
// and the keyboard know every one before anything is typed. A command's further actions (`actions`)
// open from a quiet More at its end, or the right arrow from the field.
"use client";

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
  CommandShortcut as ShortcutPrimitive,
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
  DialogContent as DialogContentPrimitive,
  DialogBackdrop,
  DialogTitle,
} from "@ui-sdk/react/dialog";
import type { DialogOpenChangeDetails } from "@ui-sdk/react/dialog";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuItemIcon,
  MenuTrigger,
  createMenuController,
} from "@ui-sdk/react/menu";
import type { MenuController, MenuItemState } from "@ui-sdk/react/menu";
import { useShortcut } from "@ui-sdk/react/shortcuts";
import {
  createContext,
  isValidElement,
  use,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type {
  KeyboardEvent,
  MouseEvent,
  PointerEvent,
  ReactElement,
  ReactNode,
} from "react";

import { useI18n } from "../lib/i18n";
import { EllipsisIcon, Icon, LoaderIcon, SearchIcon } from "../lib/icons";
import type { IconData } from "../lib/icons";
import { watchPanel } from "../lib/layer";
import {
  listStyles,
  menuStyles,
  scrollbarHidden,
  visuallyHidden,
} from "../lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  shadow,
  size,
  space,
} from "../lib/tokens.stylex";
import { popup } from "../lib/tokens.values";
import { announce, className, isThenable } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { iconVars, motionVars } from "../lib/vars.stylex";
import { Button } from "./button";
import { commandMarker, commandRowMarker } from "./command.stylex";
import { Dialog, DialogTrigger, dialogStyles } from "./dialog";

/** One of a command's further actions, in its More menu. */
export interface CommandItemAction {
  /** What `onItemAction` receives with the command's value. */
  value: string;
  /** Its words, a verb first ("Copy link"). */
  label: string;
  /** An icon before the words. */
  icon?: IconData;
  /** `destructive` for an action that deletes or cannot be undone: drawn in the destructive colour. */
  variant?: "default" | "destructive";
}

/** One command, as `items` gives it. */
export interface CommandItemData {
  /** What `onAction` receives, and how an agent may name it. Unique in the list. */
  value: string;
  /** The words on the command, a verb first ("Invite people"). Typing matches them. */
  label: string;
  /** An icon before the words, from lib/icons. */
  icon?: IconData;
  /**
   * What stands before the words in the icon's place, for a row that is a person or a thing with
   * a mark of its own: an Avatar, a Brand icon. It is decoration: the row is named by its `label`.
   * Given with `icon`, it wins.
   */
  media?: ReactNode;
  /** A keyboard shortcut that runs it while the list is on the page, like `"mod+j"`. Shown at the end. */
  shortcut?: string;
  /** Other words typing finds it by ("member" for Invite people). */
  keywords?: string[];
  /** Out of use: skipped by the keys and the pointer. */
  disabled?: boolean;
  /** For an action that can fail: the words shown on the command, and given to an agent, when it does. */
  errorText?: string;
  /**
   * A second line under the words, quiet and smaller: where a search result comes from, or what it
   * is ("Project · edited Tuesday"), with the matched words marked by CommandHighlight. One line,
   * cut with an ellipsis. Typing does not match it; give `keywords`.
   */
  description?: ReactNode;
  /**
   * What stands at the command's end, before its shortcut: a Badge, an Avatar, a count. Gives way
   * to the spinner and the failure.
   */
  end?: ReactNode;
  /**
   * More things to do with this one, besides running it: a quiet More at the row's end opens them
   * on the highlighted or hovered row (always shown on a touch screen), and the right arrow opens
   * them from the keys. Enter still runs the command itself.
   */
  actions?: CommandItemAction[];
  /**
   * The one open now (the chat on the page, in a list of chats): in a list that marks one, the rows
   * stand at the regular weight and this one at the medium; said as current.
   */
  current?: boolean;
}

/** A named run of commands. */
export interface CommandGroupData {
  /** Marks this entry as a group. */
  type: "group";
  /** The group's name, small and quiet above it ("Project"). */
  label: string;
  /** The commands in the group, in order. */
  items: CommandItemData[];
}

/** The commands: commands, groups `{ type: "group", label, items }` and separators `{ type: "separator" }`. */
export type CommandItems = (
  | CommandItemData
  | CommandGroupData
  | { type: "separator" }
)[];

// Every prop is documented once, here; the props on the docs page are read from these types.

/** Every prop a Command takes. */
export interface CommandProps {
  /** Its parts: a CommandInput, a CommandEmpty and a CommandList. */
  children: ReactNode;
  /**
   * The commands, in the order they show before anything is typed, drawn by a CommandList with no
   * children. Leave it out when the CommandList holds CommandItem parts.
   */
  items?: CommandItems;
  /**
   * Runs the command with this value: Enter, a click, or its shortcut. Return a Promise and the
   * command shows it is working until it settles. If it throws or rejects, the command shows its
   * `errorText`, and a screen reader hears it.
   */
  onAction?: (value: string, details: CommandActionDetails) => unknown;
  /**
   * What a failed command says when it has no `errorText` of its own.
   * @default "Failed"
   */
  errorText?: string;
  /** The words in the field at first, so the list starts ranked by them. */
  defaultInputValue?: string;
  /**
   * The words in the field, when the page holds them (with `onInputValueChange`): for search
   * results the page fetches itself.
   */
  inputValue?: string;
  /** Called with the field's words each time they change: typing, clearing with Escape. */
  onInputValueChange?: (value: string) => void;
  /**
   * Whether typing narrows and ranks `items`. Set it to false when the page owns the results (a
   * search on a server): the list then shows `items` as given, in their order.
   * @default true
   */
  filter?: boolean;
  /**
   * The page is fetching results: the list is marked busy, the catalogue's `command.loading` shows
   * with a spinner where the results come, and CommandEmpty waits until it is done.
   * @default false
   */
  loading?: boolean;
  /** Runs one of a command's `actions`, with the command's value and the action's. */
  onItemAction?: (value: string, action: string) => unknown;
  /** Layout only: margins, alignment and width. */
  style?: LayoutStyle;
}

// ---- The look --------------------------------------------------------------------------------------

const COARSE = media.pointerCoarse;
const FORCED = media.forcedColors;
const REDUCED = media.reducedMotion;
const PHONE = media.maxSm;

const spin = stylex.keyframes({
  from: { transform: "rotate(0turn)" },
  to: { transform: "rotate(1turn)" },
});

const MOVING = ":is([data-starting-style], [data-ending-style])";

/**
 * The palette's ref: as a dialog panel's; opened by a press it also grows from that trigger at the
 * dialog's start scale (`--palette-grow`). Opened from the keyboard (no trigger) it stays a fade
 * alone.
 */
const watchPalette = (element: HTMLElement | null) => {
  const stop = watchPanel(element);
  if (element?.dataset.fromTrigger !== undefined) {
    element.style.setProperty(
      "--palette-grow",
      "scale(var(--damsko-dialog-from-scale))"
    );
  }
  return stop;
};

const styles = stylex.create({
  // A face or a mark in the icon's place: it keeps its own size and never squeezes.
  media: { display: "inline-flex", alignItems: "center", flexShrink: 0 },
  // The surface: the popup's, standing in the page.
  root: {
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    display: "flex",
    flexDirection: "column",
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    overflow: "hidden",
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "currentColor",
    borderRadius: radius.xl,
    cornerShape: radius.shape,
    backgroundColor: colors.popover,
    boxShadow: shadow.popupShadow,
    color: colors.foreground,
    fontFamily: font.sans,
    fontSize: {
      default: font.textSm,
      [media.maxSmOrCoarse]: size.inputTextTouch,
    },
    lineHeight: font.textSmLine,
  },
  // In CommandDialog's panel, which is already a surface: no fill, lift or corner of its own.
  bare: {
    backgroundColor: "transparent",
    boxShadow: "none",
    borderRadius: 0,
    borderWidth: 0,
  },
  // The search row: the icon, then the field, with a hairline under them. Its top corners are the
  // surface's, and so are the field's: the forced-colours outline the field keeps follows the
  // surface's rounded top instead of running square into it.
  search: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    borderStartStartRadius: "inherit",
    borderStartEndRadius: "inherit",
    cornerShape: "inherit",
    // Under the field, only the quiet hairline every separator draws, at rest and focused alike.
    // The field holds focus the whole time the surface is open, so a focus mark there is noise:
    // focus shows on the active row instead.
    borderBottomWidth: size.hairline,
    borderBottomStyle: "solid",
    borderBottomColor: { default: colors.border, [FORCED]: "CanvasText" },
  },
  searchIcon: {
    position: "absolute",
    insetInlineStart: space[3],
    display: "inline-flex",
    color: colors.mutedForeground,
    pointerEvents: "none",
  },
  // The field draws no box of its own: the surface is its box. 40px, words in text-base; on a touch
  // screen 44px and 16px, so a finger finds it and iOS does not zoom.
  input: {
    flexGrow: 1,
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    minHeight: { default: 0, [COARSE]: size.tapTarget },
    margin: 0,
    paddingBlock: space[2],
    paddingInlineStart: `calc(${space[3]} + ${size.iconSm} + ${space[2]})`,
    paddingInlineEnd: space[3],
    appearance: "none",
    borderWidth: 0,
    backgroundColor: "transparent",
    color: colors.foreground,
    caretColor: colors.foreground,
    fontFamily: font.sans,
    fontSize: {
      default: font.textBase,
      [media.maxSmOrCoarse]: size.inputTextTouch,
    },
    lineHeight: font.textBaseLine,
    // No ring of its own (see search): in forced colours the system's highlight marks it while it
    // has focus.
    outline: {
      default: "none",
      ":focus-visible": {
        default: "none",
        [FORCED]: `${size.lineStrong} solid Highlight`,
      },
    },
    outlineOffset: `calc(-1 * ${size.ringWidth})`,
    borderStartStartRadius: "inherit",
    borderStartEndRadius: "inherit",
    cornerShape: "inherit",
    "::selection": {
      backgroundColor: colors.inputSelection,
      color: colors.foreground,
    },
    "::placeholder": { color: colors.mutedForeground, opacity: 1 },
  },
  // The list scrolls past popup-height.
  list: {
    boxSizing: "border-box",
    maxHeight: size.popupHeight,
    overflowY: "auto",
    overscrollBehavior: "auto",
    padding: space.popupPadding,
    outline: "none",
  },
  // Nothing matches: one line where the list was, as far from the edge as an item's words.
  empty: {
    marginInline: space.popupPadding,
    marginBlockStart: space.popupPadding,
  },
  // Working: the pointer says so and the spinner at the end turns.
  pending: { cursor: "progress" },
  spinner: {
    display: "inline-flex",
    animationName: { default: spin, [REDUCED]: "none" },
    animationDuration: duration.spin,
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },
  error: { color: colors.destructive },
  // The open one (`current`): its words heavier; a hairline in forced colours, where weight can be
  // hard to tell.
  current: {
    fontWeight: font.weightMedium,
    outlineStyle: { default: "none", [FORCED]: "solid" },
    outlineWidth: { default: null, [FORCED]: size.hairline },
    outlineOffset: { default: null, [FORCED]: `calc(-1 * ${size.hairline})` },
  },
  // The other rows of a list that marks the open one: the regular weight. Read from the page itself
  // (:has), so a list written as parts marks it as one given as `items` does.
  notCurrent: {
    fontWeight: {
      default: font.weightMedium,
      [stylex.when.ancestor(":has([aria-current=true])", commandMarker)]:
        font.weightNormal,
    },
  },
  // The words a search matched, in a result's second line: in the foreground colour at the medium
  // weight, no fill (in forced colours, the system's mark).
  highlight: {
    backgroundColor: { default: "transparent", [FORCED]: "Mark" },
    color: { default: colors.foreground, [FORCED]: "MarkText" },
    fontWeight: font.weightMedium,
  },
  // A command's words and its second line, stacked; the second line quiet and a size down.
  stack: { display: "grid", flexGrow: 1, minWidth: 0 },
  description: {
    // In forced colours it takes its row's colour, the highlighted row's too.
    color: { default: colors.mutedForeground, [FORCED]: "inherit" },
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  // The page's own thing at a command's end, before its keys.
  endSlot: {
    display: "inline-flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space[2],
    marginInlineStart: "auto",
  },
  // A row with actions holds its More at its end, over its own end when shown, so no words move.
  hasActions: {
    position: "relative",
    paddingInlineEnd: { default: null, [COARSE]: size.tapTarget },
  },
  more: {
    position: "absolute",
    insetBlock: 0,
    insetInlineEnd: space[1],
    display: "flex",
    alignItems: "center",
    visibility: {
      default: "hidden",
      [stylex.when.ancestor(":hover", commandRowMarker)]: "visible",
      [COARSE]: "visible",
    },
    // Hidden by opacity and pointer events too: the Button inside draws its words' layer with
    // visibility: visible, which a parent's hidden does not reach.
    opacity: {
      default: 0,
      [stylex.when.ancestor(":hover", commandRowMarker)]: 1,
      [COARSE]: 1,
    },
    pointerEvents: {
      default: "none",
      [stylex.when.ancestor(":hover", commandRowMarker)]: "auto",
      [COARSE]: "auto",
    },
  },
  moreShown: { visibility: "visible", opacity: 1, pointerEvents: "auto" },
  // The row's own end steps aside while More stands over it.
  endAside: {
    visibility: {
      default: null,
      [stylex.when.ancestor(":hover", commandRowMarker)]: {
        default: "hidden",
        [COARSE]: null,
      },
    },
  },
  endAsideNow: { visibility: { default: "hidden", [COARSE]: null } },
  // While results load: a spinner and the words, where the results come.
  loading: {
    [iconVars.size]: size.iconSm,
    display: "flex",
    alignItems: "center",
    gap: space[2],
    marginInline: space.popupPadding,
    marginBlockStart: space.popupPadding,
    paddingInline: space[2],
    color: colors.mutedForeground,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
  },
  // CommandDialog in and out: a fade, at most 150ms in and faster out, the shade with it. A palette
  // is opened from the keyboard many times a day: then it answers at once and does not travel or
  // grow. Opened by a press, it grows from that trigger as a dialog does (--palette-grow, set by
  // watchPalette below).
  fade: {
    opacity: { default: 1, [MOVING]: 0 },
    transform: { default: "none", [MOVING]: "var(--palette-grow, none)" },
    transitionProperty: "opacity, transform",
    transitionDuration: {
      default: motionVars.searchOpen,
      ":is([data-ending-style])": motionVars.searchClose,
    },
    transitionTimingFunction: duration.ease,
  },
  // The palette's panel: the dialog's surface, place and width (a sheet on a phone), set three
  // gutters from the top so the list grows down from the field without moving it.
  palette: {
    marginBlockStart: {
      default: `calc(3 * ${size.dialogGutter})`,
      [PHONE]: 0,
    },
    maxHeight: {
      default: `calc(var(--visual-viewport-height, 100dvh) - 4 * ${size.dialogGutter})`,
      [PHONE]: `calc(var(--visual-viewport-height, 100dvh) - ${size.dialogGutter})`,
    },
  },
});

/** Waits for an action's work: `done` with what it gave, or `fail` with why it was refused. */
const settle = async (
  work: () => unknown,
  fail: (reason: unknown) => never,
  done?: (result: unknown) => void
) => {
  let result: unknown;
  try {
    result = await work();
  } catch (error) {
    return fail(error);
  }
  done?.(result);
  return result;
};

/**
 * Runs an action, then `done` with what it returned: at once for a value, once it settles for a
 * Promise. A throw or a rejection goes to `fail` instead, which throws. Out here, so no component
 * holds a try.
 */
const runAction = (
  action: () => unknown,
  fail: (reason: unknown) => never,
  done?: (result: unknown) => void
): unknown => {
  let result: unknown;
  try {
    result = action();
  } catch (error) {
    // A throw fails it as a rejection does: UI SDK shows a command's error only from a rejection.
    return settle(() => {
      throw error;
    }, fail);
  }
  if (isThenable(result)) {
    return settle(() => result, fail, done);
  }
  done?.(result);
  return result;
};

/** Whether an element reads right to left, where the arrow keys swap. */
const isRtl = (element: Element) =>
  getComputedStyle(element).direction === "rtl";

// ---- The row actions -------------------------------------------------------------------------------

/** What the list keeps of each command, to find it by value: its name, its error words, its actions. */
type Known = Pick<CommandItemData, "value" | "label" | "errorText" | "actions">;

/** What a row needs for its More: the one menu, and how it is named and opened. */
interface RowMenu {
  menu: MenuController;
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
}) => {
  const { expand } = useI18n().command;
  return (
    <span {...stylex.props(styles.more, shown && styles.moreShown)}>
      <MenuTrigger
        controller={rows.menu}
        // The keys stay in the field: Tab never stops here.
        tabIndex={-1}
        onPointerDown={(event: PointerEvent) => {
          event.stopPropagation();
        }}
        onClick={(event: MouseEvent) => {
          event.stopPropagation();
          rows.onOpen(entry);
        }}
        render={({
          children: _children,
          ...props
        }: Record<string, unknown>) => (
          <Button
            {...props}
            variant="ghost"
            size="icon-xs"
            aria-label={expand(entry.label)}
          >
            <Icon icon={EllipsisIcon} />
          </Button>
        )}
      />
    </span>
  );
};

/**
 * A command's further actions: one menu for every row, opened from a row's More or by the right
 * arrow at the end of the words, which come back to the field when it closes.
 */
const useRowActions = (find: (value: string) => Known | undefined) => {
  const root = useRef<HTMLDivElement | null>(null);
  const hintId = useId();
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
  const rows: RowMenu = { menu, hintId, onOpen: setOpened, field };
  // The arrow towards the line's end (right, left in right to left) at the end of the words opens
  // the highlighted command's actions.
  const handleFieldKeys = (event: KeyboardEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const opens = isRtl(input) ? "ArrowLeft" : "ArrowRight";
    const atEnd =
      input.selectionStart === input.value.length &&
      input.selectionEnd === input.value.length;
    const highlighted = root.current?.querySelector<HTMLElement>(
      "[data-command-value][data-highlighted]"
    )?.dataset.commandValue;
    const entry = highlighted === undefined ? undefined : find(highlighted);
    if (
      event.key !== opens ||
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
  onItemAction,
}: {
  rows: RowMenu;
  opened: Known | undefined;
  onItemAction: CommandProps["onItemAction"];
}) => {
  const { moreHint } = useI18n().command;
  const { menu, hintId, field } = rows;
  return (
    <>
      <span id={hintId} {...stylex.props(visuallyHidden)}>
        {moreHint}
      </span>
      <Menu
        controller={menu}
        pendingAnnouncement=""
        onOpenChange={(open: boolean) => {
          if (!open) {
            rows.onOpen(null);
            field()?.focus({ preventScroll: true });
          }
        }}
      >
        <MenuContent
          // Under the row, at its end where More stands: it fits on a phone as on a wide screen.
          side="bottom"
          align="end"
          sideOffset={popup.menuGap}
          collisionPadding={popup.gutter}
          finalFocus={field}
          onKeyDown={(event: KeyboardEvent<HTMLElement>) => {
            // The arrow back (left, right in right to left) goes back to the results, as Escape does.
            if (
              event.key ===
              (isRtl(event.currentTarget) ? "ArrowRight" : "ArrowLeft")
            ) {
              event.preventDefault();
              menu.close();
            }
          }}
          {...stylex.props(
            menuStyles.panel,
            menuStyles.motion,
            scrollbarHidden
          )}
        >
          {(opened?.actions ?? []).map((action) => {
            const destructive = action.variant === "destructive";
            return (
              <MenuItem
                key={action.value}
                label={action.label}
                destructive={destructive}
                onSelect={() => {
                  if (opened !== undefined) {
                    onItemAction?.(opened.value, action.value);
                  }
                }}
                className={(state: MenuItemState) =>
                  className(
                    menuStyles.item,
                    state.highlighted && menuStyles.highlighted,
                    destructive && menuStyles.destructive,
                    destructive &&
                      state.highlighted &&
                      menuStyles.destructiveHighlighted
                  )
                }
              >
                {action.icon && (
                  <MenuItemIcon {...stylex.props(menuStyles.icon)}>
                    <Icon icon={action.icon} />
                  </MenuItemIcon>
                )}
                <span
                  {...stylex.props(
                    menuStyles.text,
                    action.icon === undefined && menuStyles.inset
                  )}
                >
                  {action.label}
                </span>
              </MenuItem>
            );
          })}
        </MenuContent>
      </Menu>
    </>
  );
};

// ---- The parts -------------------------------------------------------------------------------------

/** What the parts read from their Command: its state, and the one menu of row actions. */
interface Scope {
  dialogLabel: string | undefined;
  placeholder: string | undefined;
  loading: boolean;
  handleFieldKeys: (event: KeyboardEvent<HTMLInputElement>) => void;
  errorText: string;
  rows: RowMenu;
  byValue: Map<string, CommandItemData>;
  register: (entry: Known) => () => void;
  fail: (words: string) => never;
}

const CommandScope = createContext<Scope | null>(null);

const useScope = (): Scope => {
  const scope = use(CommandScope);
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
   * What the empty field says: a verb and the thing.
   * @default "Search", in a CommandDialog "Type a command or search"
   */
  placeholder?: string;
  /** Layout only: the search row's. */
  style?: LayoutStyle;
}

/** The search field, with its icon and the hairline under it; the list says here when it is loading. */
export const CommandInput = ({
  "aria-label": ariaLabel,
  placeholder,
  style,
}: CommandInputProps) => {
  const scope = useScope();
  const words = useI18n().command;
  return (
    <>
      <div {...stylex.props(styles.search, style)}>
        <span aria-hidden="true" {...stylex.props(styles.searchIcon)}>
          <Icon icon={SearchIcon} />
        </span>
        <InputPrimitive
          aria-label={ariaLabel ?? scope.dialogLabel}
          placeholder={placeholder ?? scope.placeholder ?? words.placeholder}
          onKeyDown={scope.handleFieldKeys}
          {...stylex.props(styles.input)}
        />
      </div>
      <CommandStatus
        {...stylex.props(scope.loading ? styles.loading : visuallyHidden)}
      >
        {scope.loading && (
          <>
            <span aria-hidden="true" {...stylex.props(styles.spinner)}>
              <Icon icon={LoaderIcon} />
            </span>
            {words.loading}
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
  /** Layout only. */
  style?: LayoutStyle;
}

/** What the list says when nothing matches; it waits while results load. */
export const CommandEmpty = ({ children, style }: CommandEmptyProps) => {
  const { loading } = useScope();
  const { empty } = useI18n().command;
  return (
    <EmptyPrimitive
      {...stylex.props(
        listStyles.empty,
        styles.empty,
        loading && visuallyHidden,
        style
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
  /** Layout only. */
  style?: LayoutStyle;
}

/** A named run of commands; it hides while none of its commands matches. */
export const CommandGroup = ({
  heading,
  children,
  style,
}: CommandGroupProps) => (
  <GroupPrimitive {...stylex.props(style)}>
    {heading !== undefined && heading !== "" && (
      <CommandGroupLabel {...stylex.props(listStyles.groupLabel)}>
        {heading}
      </CommandGroupLabel>
    )}
    {children}
  </GroupPrimitive>
);

/** Every prop a CommandSeparator takes. */
export interface CommandSeparatorProps {
  /** Layout only. */
  style?: LayoutStyle;
}

/** A hairline between commands or groups. */
export const CommandSeparator = ({ style }: CommandSeparatorProps) => (
  <SeparatorPrimitive {...stylex.props(listStyles.separator, style)} />
);

/** Every prop a CommandShortcut takes. */
export interface CommandShortcutProps {
  /** The keys, as the command binds them: `"mod+j"` is ⌘J on a Mac and Ctrl+J elsewhere. */
  children: string;
}

/**
 * The keys at the end of a CommandItem, formatted for the platform: `<CommandShortcut>mod+j
 * </CommandShortcut>`. The item binds them, so they run it while the list is on the page.
 */
export const CommandShortcut = ({ children }: CommandShortcutProps) => (
  <ShortcutPrimitive shortcut={children} {...stylex.props(listStyles.itemEnd)}>
    {(state: CommandShortcutState) => state.text}
  </ShortcutPrimitive>
);

/** The CommandShortcut among an item's children, and the rest: the shortcut stands at the end. */
const split = (children: ReactNode) => {
  const all = [children].flat();
  const shortcut = all.find(
    (child): child is ReactElement<CommandShortcutProps> =>
      isValidElement(child) && child.type === CommandShortcut
  );
  const words = all.filter(
    (child) =>
      child !== shortcut &&
      child !== false &&
      child !== null &&
      child !== undefined &&
      child !== ""
  );
  const [only] = words;
  return {
    keys: shortcut?.props.children,
    words: words.length === 1 ? only : words,
  };
};

/** What stands at the end of a command: the spinner while it works, its failure, or its keys. */
const End = ({
  state,
  error,
  keys,
  end,
}: {
  state: CommandItemState;
  error: string;
  keys?: string;
  end?: ReactNode;
}) => {
  if (state.pending) {
    return (
      <span
        aria-hidden="true"
        {...stylex.props(listStyles.itemEnd, styles.spinner)}
      >
        <Icon icon={LoaderIcon} />
      </span>
    );
  }
  if (state.error !== undefined) {
    return (
      <span {...stylex.props(listStyles.itemEnd, styles.error)}>{error}</span>
    );
  }
  const shortcut = keys !== undefined && keys !== "" && (
    <CommandShortcut>{keys}</CommandShortcut>
  );
  if (end === undefined || end === null) {
    return shortcut;
  }
  return (
    <span {...stylex.props(styles.endSlot)}>
      {end}
      {shortcut}
    </span>
  );
};

/** A command's words, the letters the typed words matched marked. */
const Words = () => (
  <CommandItemText {...stylex.props(listStyles.itemText)}>
    {(state: CommandItemTextState) =>
      state.segments.map((segment, index) =>
        segment.match ? (
          // A match has no id of its own; its place in the label is its key.
          <mark key={index} {...stylex.props(listStyles.match)}>
            {segment.text}
          </mark>
        ) : (
          segment.text
        )
      )
    }
  </CommandItemText>
);

/** Every prop a CommandItem takes: a command's, as `items` gives them, with its words as children. */
export interface CommandItemProps extends Omit<
  CommandItemData,
  "label" | "shortcut"
> {
  /**
   * The words on the command, a verb first ("Invite people"), and a CommandShortcut at the end
   * when it has keys. Typing matches the words when they are plain words.
   */
  children: ReactNode;
  /** The words typing matches and its More is named by, when `children` is not plain words. */
  label?: string;
  /**
   * Runs this command, before the Command's `onAction`: Enter, a click, or its shortcut. Return a
   * Promise and it shows it is working until it settles; if it throws or rejects, it shows its
   * `errorText`.
   */
  onAction?: () => unknown;
  /** Layout only. */
  style?: LayoutStyle;
}

/** One command: Enter, a click or its shortcut runs it. */
export const CommandItem = ({
  children,
  label: labelGiven,
  value,
  icon,
  media: mark,
  keywords,
  disabled,
  errorText,
  description,
  end,
  actions,
  current = false,
  onAction,
  style,
}: CommandItemProps) => {
  const { rows, errorText: fallback, register, fail } = useScope();
  const { keys, words: content } = split(children);
  const plain = typeof content === "string";
  const label = plain ? content : labelGiven;
  const name = label ?? value;
  const error = errorText ?? fallback;
  const withActions = actions !== undefined && actions.length > 0;
  // Known by value, so a failure finds its words and the right arrow its actions.
  useEffect(
    () => register({ value, label: name, errorText, actions }),
    [register, value, name, errorText, actions]
  );
  const words = plain ? (
    <Words />
  ) : (
    <span {...stylex.props(listStyles.itemText)}>{content}</span>
  );
  const ending = (state: CommandItemState) => (
    <End state={state} error={error} keys={keys} end={end} />
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
      shortcut={keys}
      onSelect={
        onAction === undefined
          ? undefined
          : () => runAction(onAction, () => fail(error))
      }
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
          withActions && commandRowMarker,
          withActions && styles.hasActions,
          style
        )
      }
    >
      {(state: CommandItemState) => (
        <>
          {mark !== undefined && mark !== null && mark !== false ? (
            <span
              aria-hidden="true"
              data-slot="command-item-media"
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
              {ending(state)}
            </span>
          ) : (
            ending(state)
          )}
          {withActions && (
            <MoreButton
              entry={{ value, label: name, errorText, actions }}
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
const Entry = ({ entry }: { entry: CommandItemData }) => {
  const { label, shortcut, ...rest } = entry;
  return (
    <CommandItem {...rest}>
      {label}
      {shortcut !== undefined && shortcut !== "" && (
        <CommandShortcut>{shortcut}</CommandShortcut>
      )}
    </CommandItem>
  );
};

/** The commands from `items` as parts, in the order the list gives them. */
const Entries = ({
  items,
  byValue,
}: {
  items: CommandData;
  byValue: Map<string, CommandItemData>;
}) => {
  // A command, by its value or as an entry; one `items` does not hold draws nothing.
  const entry = (command: string | { value: string }) => {
    const value = typeof command === "string" ? command : command.value;
    const known = byValue.get(value);
    return known ? <Entry key={value} entry={known} /> : null;
  };
  return items.map((item, index) => {
    if (typeof item === "string" || !("type" in item)) {
      return entry(item);
    }
    if (item.type === "group") {
      return (
        <CommandGroup key={`group-${item.label ?? index}`} heading={item.label}>
          {item.items.map(entry)}
        </CommandGroup>
      );
    }
    // A separator has no value; its place in the list is its key.
    return <CommandSeparator key={`separator-${index}`} />;
  });
};

/** Every prop a CommandList takes. */
export interface CommandListProps {
  /**
   * The commands: CommandItem, CommandGroup and CommandSeparator parts, in order. Leave it out to
   * draw the Command's `items`, ranked as the user types.
   */
  children?: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** The commands, under the field; it scrolls past a popup's height. */
export const CommandList = ({ children, style }: CommandListProps) => {
  const { byValue } = useScope();
  return (
    <ListPrimitive {...stylex.props(styles.list, scrollbarHidden, style)}>
      {children ??
        ((state: CommandListState) => (
          <Entries items={state.items} byValue={byValue} />
        ))}
    </ListPrimitive>
  );
};

/** Each command by its value, so the parts can wear its icon and error words. */
const commandsByValue = (items: CommandItems): Map<string, CommandItemData> =>
  new Map(
    items
      .flatMap((entry) => {
        if (!("type" in entry)) {
          return [entry];
        }
        return entry.type === "group" ? entry.items : [];
      })
      .map((command) => [command.value, command])
  );

/** Why a command failed, in the words it shows. */
class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandError";
  }
}

const NO_ITEMS: CommandItems = [];

/** What CommandDialog adds to a Command's own props, to draw it bare in its panel. */
interface RootProps extends CommandProps {
  bare?: boolean;
  dialogLabel?: string;
  placeholder?: string;
}

/** The command list, on a surface of its own, or bare in CommandDialog's panel. */
const CommandRoot = ({
  children,
  items,
  onAction,
  errorText: errorGiven,
  defaultInputValue,
  inputValue,
  onInputValueChange,
  filter = true,
  loading = false,
  onItemAction,
  style,
  bare = false,
  dialogLabel,
  placeholder,
}: RootProps) => {
  const catalog = useI18n();
  const errorText = errorGiven ?? catalog.command.error;
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
  const { root, rows, handleFieldKeys, opened } = useRowActions(find);
  // A failed action shows its errorText on the command, and a screen reader hears it, each time.
  const fail = (words: string): never => {
    announce(words);
    throw new CommandError(words);
  };
  const run = (value: string, details: CommandActionDetails) =>
    runAction(
      () => onAction?.(value, details),
      () => fail(find(value)?.errorText ?? errorText)
    );
  const scope: Scope = {
    dialogLabel,
    placeholder,
    loading,
    handleFieldKeys,
    errorText,
    rows,
    byValue,
    register,
    fail,
  };
  return (
    <CommandPrimitive
      ref={root}
      items={items}
      defaultQuery={defaultInputValue}
      query={inputValue}
      onQueryChange={
        onInputValueChange === undefined
          ? undefined
          : (next: string) => {
              onInputValueChange(next);
            }
      }
      filter={filter ? undefined : false}
      status={loading ? "loading" : "idle"}
      autoHighlight
      loop
      onAction={run}
      pendingAnnouncement={catalog.action.loading}
      {...stylex.props(commandMarker, styles.root, bare && styles.bare, style)}
    >
      {/* A function, so UI SDK does not look for its own CommandList among the children: not finding
          it (this file wraps it), it would mount a second list for `items` first. */}
      {() => (
        <>
          {/* oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled */}
          <CommandScope value={scope}>{children}</CommandScope>
          <RowActionsMenu
            rows={rows}
            opened={opened}
            onItemAction={onItemAction}
          />
        </>
      )}
    </CommandPrimitive>
  );
};

/** A search field over a list of actions, on a surface of its own. */
export const Command = (props: CommandProps) => <CommandRoot {...props} />;

/** Every prop a CommandHighlight takes. */
export interface CommandHighlightProps {
  /** The words a search matched. */
  children: ReactNode;
}

/** The words a search matched, marked in a result's second line: `<CommandHighlight>invoice</CommandHighlight>`. */
export const CommandHighlight = ({ children }: CommandHighlightProps) => (
  <mark {...stylex.props(styles.highlight)}>{children}</mark>
);

// ---- CommandDialog ---------------------------------------------------------------------------------

/** Every prop a CommandDialog takes: a Command's, and the palette's own. */
export interface CommandDialogProps extends Omit<CommandProps, "style"> {
  /**
   * The palette's name, and its search field's unless a CommandInput names it, as a screen reader
   * and an agent say it ("Search actions").
   */
  "aria-label": string;
  /**
   * Runs the command with this value. The palette closes once it has run; when it returns a
   * Promise, once that settles, and it stays open showing the `errorText` if it rejects. Return
   * `false` to keep it open (a command that changes what the list shows).
   */
  onAction?: (value: string, details: CommandActionDetails) => unknown;
  /**
   * The words on the trigger. `null` draws no trigger: the page opens it (`open`), from its own
   * button, a Sidebar row or its shortcut. Given `open` and no `trigger`, there is none either.
   * @default "Search"
   */
  trigger?: string | null;
  /**
   * Whether it is open, when the page holds it (with `onOpenChange`): opened from anywhere, closed
   * by Escape, a press outside, or a command run.
   */
  open?: boolean;
  /** Called when it opens or closes: by its trigger, its shortcut, Escape, or a command run. */
  onOpenChange?: (open: boolean) => void;
  /**
   * The keys that open it from anywhere on the page: `mod` is Command on a Mac and Control
   * elsewhere. Pass `null` for none.
   * @default "mod+k"
   */
  shortcut?: string | null;
}

/** A command palette over the page: its trigger, and the Command in a dialog's panel. */
export const CommandDialog = ({
  children,
  onAction,
  "aria-label": ariaLabel,
  trigger,
  shortcut = "mod+k",
  open: openGiven,
  onOpenChange,
  ...passed
}: CommandDialogProps) => {
  const words = useI18n().command;
  const [openHere, setOpenHere] = useState(false);
  const open = openGiven ?? openHere;
  const setOpen = (next: boolean) => {
    setOpenHere(next);
    onOpenChange?.(next);
  };
  // No trigger of its own: when the page says so, or holds it open and names none.
  const triggerless =
    trigger === null || (openGiven !== undefined && trigger === undefined);
  // The shortcut opens it from anywhere on the page, through UI SDK's shortcuts: one without mod,
  // Ctrl or Alt waits while someone types in a field, and none opens it over a modal already open.
  // The trigger carries it when there is one, the page when there is none.
  useShortcut(triggerless ? shortcut : null, () => {
    setOpen(true);
  });
  // While a command works, nothing closes the palette: its outcome is shown where it ran.
  const pending = useRef(false);
  // Close once the command has run, unless it returned `false`; a failure keeps it open, showing
  // why (Command does that).
  const run = (value: string, details: CommandActionDetails) => {
    pending.current = true;
    return runAction(
      () => onAction?.(value, details),
      (reason) => {
        pending.current = false;
        throw reason;
      },
      (result) => {
        pending.current = false;
        if (result !== false) {
          setOpen(false);
        }
      }
    );
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next: boolean, details: DialogOpenChangeDetails) => {
        if (!next && pending.current) {
          details.cancel();
          return;
        }
        setOpen(next);
      }}
    >
      {triggerless ? null : (
        <DialogTrigger asChild shortcut={shortcut ?? undefined}>
          <Button variant="outline">
            <Icon icon={SearchIcon} />
            {trigger ?? words.dialogTrigger}
          </Button>
        </DialogTrigger>
      )}
      <DialogBackdrop {...stylex.props(dialogStyles.overlay, styles.fade)} />
      <DialogContentPrimitive
        ref={watchPalette}
        render={<div data-slot="command-dialog" />}
        {...stylex.props(
          dialogStyles.panel,
          dialogStyles.placed,
          styles.fade,
          styles.palette
        )}
      >
        <DialogTitle {...stylex.props(visuallyHidden)}>{ariaLabel}</DialogTitle>
        <CommandRoot
          {...passed}
          bare
          onAction={run}
          dialogLabel={ariaLabel}
          placeholder={words.dialogPlaceholder}
        >
          {children}
        </CommandRoot>
      </DialogContentPrimitive>
    </Dialog>
  );
};
