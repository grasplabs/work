// ModelSelector: the model an assistant answers with, and how hard it thinks, as one quiet chip that
// opens one panel. The parts and their names are shadcn's Model Selector (apps/v4/content/docs/
// ai-elements/base/model-selector.mdx); the look and the way it works are the original design's
// model and effort picker: a search field across the top; down its start side a column of the
// makers' logos, a star for favourites first; the chosen maker's models as plain 28px rows beside
// it, each level with a logo, so the panel is as tall as the taller column; and at its foot the
// effort as segments. Picking a model keeps the panel open while there is an effort to set, so both
// are chosen in one opening. Typing searches every maker.
// Adapted from shadcn/ui (MIT), see THIRD_PARTY_NOTICES.md.
//
//   <ModelSelector value={model} onValueChange={setModel} favorites={favorites}
//     onFavoritesChange={setFavorites} effort={effort} onEffortChange={setEffort}>
//     <ModelSelectorTrigger tooltip="Model A, Medium">
//       <ModelSelectorLogo logo={makerLogo} />
//       <ModelSelectorName>Medium</ModelSelectorName>
//     </ModelSelectorTrigger>
//     <ModelSelectorContent>
//       <ModelSelectorInput />
//       <ModelSelectorMakers>
//         <ModelSelectorMaker value="maker" label="Maker" logo={makerLogo} />
//       </ModelSelectorMakers>
//       <ModelSelectorList>
//         <ModelSelectorEmpty />
//         <ModelSelectorGroup value="maker" heading="Maker">
//           <ModelSelectorItem value="model-a" description="Careful work">
//             <ModelSelectorLogo logo={makerLogo} />
//             <ModelSelectorName>Model A</ModelSelectorName>
//             <ModelSelectorFavorite />
//           </ModelSelectorItem>
//         </ModelSelectorGroup>
//       </ModelSelectorList>
//       <ModelSelectorEffort levels={levels} />
//     </ModelSelectorContent>
//   </ModelSelector>
//
// Built on Popover, UI SDK's Command (the search field over the models, a combobox over a listbox:
// the field keeps focus while the arrows move) and UI SDK's Listbox (the makers, one tab stop, the
// arrows choosing). Damsko's Command and InputGroup each draw a look of their own (a 40px search,
// a field's box) that is not this panel's, so the panel takes their primitives and the shared list
// styles. The effort is Toggle group's segments. Every model, maker, logo, favourite and level is
// the caller's: nothing here knows one. Every value is a token. A caller may set layout only.
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  Command as CommandPrimitive,
  CommandEmpty as EmptyPrimitive,
  CommandGroup as GroupPrimitive,
  CommandGroupLabel,
  CommandInput as InputPrimitive,
  CommandItem as ItemPrimitive,
  CommandList as ListPrimitive,
} from "@ui-sdk/react/command";
import type { CommandItemState } from "@ui-sdk/react/command";
import { Listbox, ListboxItem } from "@ui-sdk/react/listbox";
import type { ListboxItemState } from "@ui-sdk/react/listbox";
import { PopoverContent as PopoverContentPrimitive } from "@ui-sdk/react/popover";
import {
  createContext,
  isValidElement,
  use,
  useId,
  useLayoutEffect,
  useState,
} from "react";
import type { KeyboardEvent, MouseEvent, PointerEvent, ReactNode } from "react";

import { useI18n } from "../lib/i18n";
import {
  CheckIcon,
  ChevronDownIcon,
  Icon,
  SearchIcon,
  StarIcon,
} from "../lib/icons";
import type { IconData } from "../lib/icons";
import {
  focusRing,
  listStyles,
  scrollbarHidden,
  visuallyHidden,
} from "../lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  size,
  space,
} from "../lib/tokens.stylex";
import { popup } from "../lib/tokens.values";
import { announce, className, listOf, nothing, textOf } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { motionVars } from "../lib/vars.stylex";
import { BrandIcon } from "./brand-icon";
import { Button } from "./button";
import { buttonMarker } from "./button.stylex";
import { Popover, PopoverTrigger } from "./popover";
import { ToggleGroup, ToggleGroupItem } from "./toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

/** Every prop a ModelSelector takes. */
export interface ModelSelectorProps {
  /** Its ModelSelectorTrigger, then its ModelSelectorContent. */
  children: ReactNode;
  /** The chosen model's value: its row is ticked and said as current. Pass it with `onValueChange` to hold it yourself. */
  value?: string;
  /** The model chosen at first, when the selector holds its own. */
  defaultValue?: string;
  /**
   * Runs with the model picked. The panel closes, unless it holds an effort to set next
   * (`onEffortChange`), when it stays open and says the model chosen.
   */
  onValueChange?: (value: string) => void;
  /**
   * The favourite models' values. Given, the makers' column starts with a star that lists them.
   * Leave it out for a product without favourites.
   */
  favorites?: readonly string[];
  /** The favourites at first, when the selector holds its own; given, the star and the rows' stars show. */
  defaultFavorites?: readonly string[];
  /** Runs with the favourites after a row's star adds or removes one. Without it, or `defaultFavorites`, the stars do not show. */
  onFavoritesChange?: (favorites: string[]) => void;
  /** The chosen effort level's value, for ModelSelectorEffort. */
  effort?: string;
  /** The effort level chosen at first, when the selector holds its own. */
  defaultEffort?: string;
  /**
   * Runs with the level chosen in ModelSelectorEffort. Given (or `effort`, `defaultEffort`), picking a model keeps the panel
   * open, so its effort can be set in the same opening.
   */
  onEffortChange?: (effort: string) => void;
  /** Open now. Pass it with `onOpenChange` to open and close it yourself. */
  open?: boolean;
  /**
   * Open when the page loads.
   * @default false
   */
  defaultOpen?: boolean;
  /** Runs when it opens or closes: the trigger, a pick, Escape, a press outside or Tab out. */
  onOpenChange?: (open: boolean) => void;
}

/** Every prop a ModelSelectorTrigger takes. */
export interface ModelSelectorTriggerProps {
  /**
   * What the chip shows: the maker's ModelSelectorLogo and a ModelSelectorName (the model, or its
   * effort level in a word). With `asChild`, the one element drawn as the trigger.
   */
  children: ReactNode;
  /**
   * The model and its level in words ("Model A, Medium"), shown in a tooltip over the chip, for a
   * chip that shows less than that (the level alone). It also names the trigger.
   */
  tooltip?: string;
  /**
   * Its name, when neither its words nor its tooltip say the model.
   * @default "Model: " and the tooltip, else the words it shows (`modelSelector.triggerWith`)
   */
  "aria-label"?: string;
  /**
   * Draw the one element given as the child (a Button of your own) as the trigger.
   * @default false
   */
  asChild?: boolean;
  /**
   * Out of use: it does not open. Say why near it.
   * @default false
   */
  disabled?: boolean;
  /** Layout only: where it sits and how much room it takes. */
  style?: LayoutStyle;
}

/** Every prop a ModelSelectorContent takes. */
export interface ModelSelectorContentProps {
  /** Its ModelSelectorInput, ModelSelectorMakers, ModelSelectorList and ModelSelectorEffort, in that order. */
  children: ReactNode;
  /**
   * The side of the trigger it opens on. It flips when there is no room. `top` for a trigger at
   * the foot of a prompt input.
   * @default "bottom"
   */
  side?: "top" | "bottom" | "left" | "right";
  /**
   * How it lines up with the trigger; `start` and `end` follow the reading direction.
   * @default "start"
   */
  align?: "start" | "center" | "end";
  /** Layout only: its width. */
  style?: LayoutStyle;
}

/** Every prop a ModelSelectorInput takes. */
export interface ModelSelectorInputProps {
  /**
   * The search field's name.
   * @default "Search models" (`modelSelector.search`)
   */
  "aria-label"?: string;
  /**
   * What the empty field says.
   * @default "Search models" (`modelSelector.search`)
   */
  placeholder?: string;
}

/** Every prop a ModelSelectorMakers takes. */
export interface ModelSelectorMakersProps {
  /** Its ModelSelectorMaker parts, in the column's order. The star comes first by itself, with `favorites`. */
  children: ReactNode;
  /**
   * The column's name, for a screen reader.
   * @default "Makers" (`modelSelector.makers`)
   */
  "aria-label"?: string;
}

/** Every prop a ModelSelectorMaker takes. */
export interface ModelSelectorMakerProps {
  /** Matches the `value` of the ModelSelectorGroup holding its models. */
  value: string;
  /** The maker's name ("Maker"): the option's name and its tooltip. */
  label: string;
  /** The maker's logo, from the product's own (an IconData made with lib/icons' `filledMark`). Left out, its first letter. */
  logo?: IconData;
}

/** Every prop a ModelSelectorList takes. */
export interface ModelSelectorListProps {
  /** A ModelSelectorEmpty, then ModelSelectorGroup parts (one per maker), or ModelSelectorItem parts straight in it. */
  children: ReactNode;
}

/** Every prop a ModelSelectorEmpty takes. */
export interface ModelSelectorEmptyProps {
  /**
   * What the list says when no model matches.
   * @default "No models found", under the star "No favourites yet" (`modelSelector.empty`, `modelSelector.noFavorites`)
   */
  children?: ReactNode;
}

/** Every prop a ModelSelectorGroup takes. */
export interface ModelSelectorGroupProps {
  /** The maker it holds, the `value` of its ModelSelectorMaker: it shows while that maker is chosen. */
  value?: string;
  /** The maker's name, small and quiet over its models. */
  heading?: string;
  /** Its ModelSelectorItem parts. */
  children: ReactNode;
}

/** Every prop a ModelSelectorItem takes. */
export interface ModelSelectorItemProps {
  /** What `onValueChange` receives when it is picked. Unique in the list. */
  value: string;
  /** Its ModelSelectorLogo, its ModelSelectorName and a ModelSelectorFavorite. */
  children: ReactNode;
  /**
   * The words typing matches and the row is named by.
   * @default the words of its children
   */
  label?: string;
  /** Other words typing finds it by (its maker, an older name). */
  keywords?: string[];
  /**
   * One line on what it is good at, said by a screen reader. Shown under its name while it is
   * `disabled`, where it says why.
   */
  description?: string;
  /**
   * Out of use: the keys and the pointer pass it. Say why in its `description`.
   * @default false
   */
  disabled?: boolean;
}

/** Every prop a ModelSelectorFavorite takes. */
export interface ModelSelectorFavoriteProps {
  /**
   * Its name.
   * @default "Add … to favourites", or "Remove … from favourites" (`modelSelector.addFavorite`, `modelSelector.removeFavorite`)
   */
  "aria-label"?: string;
}

/** Every prop a ModelSelectorEffort takes. */
export interface ModelSelectorEffortProps {
  /**
   * The chosen model's levels, from the least effort to the most ({ value, label }). With one
   * level or none the row folds away.
   */
  levels: readonly { value: string; label: string }[];
  /**
   * Its heading, and the name of its segments.
   * @default "Thinking" (`modelSelector.effort`)
   */
  label?: string;
}

/** Every prop a ModelSelectorLogo takes. */
export interface ModelSelectorLogoProps {
  /** The maker's logo, from the product's own (an IconData made with lib/icons' `filledMark`). */
  logo: IconData;
  /**
   * The maker's name, when the logo stands without it in words beside it. Left out, the logo is
   * decoration.
   */
  label?: string;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a ModelSelectorName takes. */
export interface ModelSelectorNameProps {
  /** The model's name, as its maker writes it, or its level in a word. Cut with an ellipsis where there is no room. */
  children: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

// The star's place in the makers' column: a value no caller's maker is.
const FAVORITES = "\u0000favorites";

// The star, filled: the outline's own path filled in the ink, for a model that is a favourite.
const StarFilledIcon: IconData = StarIcon.map(([tag, attrs]) => [
  tag,
  { ...attrs, fill: "currentColor" },
]);

// One step for the makers and the rows (28px, 44 on a touch screen), so each logo stands level with
// a row; the corner nests in the panel's, capped at half the step.
const STEP = size.controlXs;
const STEP_CORNER = `min(${radius.base}, calc(${size.controlXs} / 2))`;
const COARSE = media.pointerCoarse;
const FORCED = media.forcedColors;
const HOVER = media.hover;

const styles = stylex.create({
  root: { display: "contents" },
  // The chip's mark, words and chevron, a step apart and a size down from the Button's. The words
  // are quiet at rest and in ink under the pointer, through the Button's own marker. The span lies
  // over the whole Button (its padding taken back), so while the panel is open it carries the
  // press's fill in the chip's corner: the original's chip keeps that fill; Button's ghost does not.
  chip: {
    display: "inline-flex",
    alignItems: "center",
    columnGap: space["1"],
    minWidth: 0,
    marginBlock: `calc((${font.textSmLine} - ${size.controlXs}) / 2)`,
    marginInline: `calc(-1 * ${space["2"]})`,
    paddingBlock: `calc((${size.controlXs} - ${font.textSmLine}) / 2)`,
    paddingInline: space["2"],
    borderRadius: STEP_CORNER,
    cornerShape: radius.shape,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    color: {
      default: colors.mutedForeground,
      [stylex.when.ancestor(":hover", buttonMarker)]: {
        default: null,
        [HOVER]: colors.foreground,
      },
      [FORCED]: "inherit",
    },
    backgroundColor: {
      default: "transparent",
      [stylex.when.ancestor("[aria-expanded=true]", buttonMarker)]: {
        default: colors.accentActive,
        [FORCED]: "transparent",
      },
    },
  },
  chevron: { display: "inline-flex", flexShrink: 0 },
  // The panel: the popup's surface, the popover's width, never wider than the window less the
  // gutter. It never scrolls itself: each column scrolls its own.
  panel: {
    width: `min(${size.popoverWidth}, 100vw - 2 * ${space.popupGutter})`,
    maxWidth: "none",
    padding: 0,
    overflow: "hidden",
  },
  // The search across, the makers and the models side by side under it, the effort at the foot.
  grid: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr)",
    gridTemplateRows: "auto minmax(0, 1fr) auto",
    minHeight: 0,
    maxHeight: "inherit",
  },
  search: {
    gridColumn: "1 / -1",
    display: "flex",
    alignItems: "center",
    columnGap: space["2"],
    minHeight: size.controlDefault,
    paddingInline: space["3"],
    borderBlockEndWidth: size.hairline,
    borderBlockEndStyle: "solid",
    borderBlockEndColor: { default: colors.border, [FORCED]: "CanvasText" },
    color: colors.mutedForeground,
  },
  input: {
    flexGrow: 1,
    minWidth: 0,
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: colors.foreground,
    caretColor: colors.foreground,
    fontFamily: font.sans,
    fontSize: {
      default: font.textSm,
      [media.maxSmOrCoarse]: size.inputTextTouch,
    },
    lineHeight: font.textSmLine,
    // A finger's height on a touch screen; the row grows with it.
    minHeight: { default: 0, [COARSE]: size.tapTarget },
    outline: "none",
    "::placeholder": { color: colors.mutedForeground, opacity: 1 },
  },
  makers: {
    gridColumn: "1",
    gridRow: "2",
    display: "grid",
    alignContent: "start",
    padding: space["1"],
    borderInlineEndWidth: size.hairline,
    borderInlineEndStyle: "solid",
    borderInlineEndColor: { default: colors.border, [FORCED]: "CanvasText" },
    overflowY: "auto",
    overscrollBehavior: "contain",
    outline: "none",
  },
  maker: {
    display: "grid",
    placeItems: "center",
    width: STEP,
    height: { default: STEP, [COARSE]: size.tapTarget },
    borderRadius: STEP_CORNER,
    cornerShape: radius.shape,
    color: colors.mutedForeground,
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [HOVER]: colors.accent },
    },
    cursor: "pointer",
    transitionProperty: "background-color, color",
    transitionDuration: motionVars.hover,
  },
  makerChosen: {
    color: { default: colors.foreground, [FORCED]: "HighlightText" },
    backgroundColor: { default: colors.accentHighlight, [FORCED]: "Highlight" },
  },
  list: {
    gridColumn: "2",
    gridRow: "2",
    display: "grid",
    alignContent: "start",
    minHeight: 0,
    padding: space["1"],
    overflowY: "auto",
    overscrollBehavior: "contain",
  },
  // The chosen maker's name, or the star's word, quiet, in the first logo's row.
  heading: {
    display: "flex",
    alignItems: "center",
    boxSizing: "border-box",
    minHeight: STEP,
    paddingInline: space["2"],
    color: { default: colors.mutedForeground, [FORCED]: "CanvasText" },
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    userSelect: "none",
  },
  row: {
    display: "flex",
    alignItems: "center",
    columnGap: space["2"],
    boxSizing: "border-box",
    minHeight: { default: STEP, [COARSE]: size.tapTarget },
    paddingInline: space["2"],
    borderRadius: STEP_CORNER,
    cornerShape: radius.shape,
    color: colors.foreground,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    cursor: "pointer",
    userSelect: "none",
    outline: "none",
  },
  // The chosen model: a hairline in forced colours, where the tick alone may not show.
  rowChosen: {
    outlineStyle: { default: "none", [FORCED]: "solid" },
    outlineWidth: { default: null, [FORCED]: size.hairline },
    outlineOffset: { default: null, [FORCED]: `calc(-1 * ${size.hairline})` },
  },
  rowWords: {
    display: "grid",
    flexGrow: 1,
    minWidth: 0,
  },
  why: {
    color: colors.mutedForeground,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
  },
  tick: {
    display: "inline-flex",
    flexShrink: 0,
    color: colors.foreground,
  },
  // A row's star: shown on the row under the pointer or the keys, always for a favourite, and
  // always on a touch screen, where nothing hovers.
  star: {
    display: "inline-flex",
    flexShrink: 0,
    marginBlock: `calc(-1 * ${space["1"]})`,
    marginInlineEnd: `calc(-1 * ${space["1"]})`,
    color: colors.mutedForeground,
    opacity: { default: 0, [COARSE]: 1 },
  },
  starShown: { opacity: 1 },
  starOn: { color: colors.foreground },
  empty: {
    display: { default: "none", ":is([data-empty])": "block" },
    paddingBlock: `calc((${STEP} - ${font.textSmLine}) / 2)`,
    paddingInline: space["2"],
    color: colors.mutedForeground,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
  },
  // The effort's room: it opens and closes as a model with levels or without is chosen, so the
  // panel's height eases rather than jumps (at once with reduced motion).
  fold: {
    gridColumn: "1 / -1",
    gridRow: "3",
    display: "grid",
    gridTemplateRows: "0fr",
    // Closed, it is gone for the eye as for the keys, once its height has eased away: visibility
    // changes at the end of a transition that hides it, at once with reduced motion.
    visibility: "hidden",
    transitionProperty: "grid-template-rows, visibility",
    transitionDuration: motionVars.ui,
    transitionTimingFunction: duration.ease,
  },
  foldOpen: { gridTemplateRows: "1fr", visibility: "visible" },
  foldInner: { minHeight: 0, overflow: "hidden" },
  effort: {
    display: "grid",
    rowGap: space["2"],
    paddingBlock: space["2"],
    paddingInline: space["3"],
    borderBlockStartWidth: size.hairline,
    borderBlockStartStyle: "solid",
    borderBlockStartColor: { default: colors.border, [FORCED]: "CanvasText" },
  },
  effortHeading: {
    margin: 0,
    color: colors.mutedForeground,
    fontFamily: font.sans,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
  },
  name: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  logo: { display: "inline-flex", flexShrink: 0 },
});

/** What the selector holds: the choices the caller keeps, and what changes them. */
interface Root {
  value: string | undefined;
  pick: (value: string, label: string) => void;
  favorites: readonly string[] | undefined;
  toggleFavorite: ((value: string, label: string) => void) | undefined;
  effort: string | undefined;
  onEffortChange: (effort: string) => void;
  close: () => void;
}

const RootContext = createContext<Root | null>(null);

/** What one opening of the panel holds: the search, the column's choice, and who is on the page. */
interface Panel {
  searching: boolean;
  /** The column's choice: a maker, the star, or null while there is no column. */
  rail: string | null;
  chooseRail: (rail: string) => void;
  registerMaker: (value: string) => () => void;
  registerModel: (value: string, maker: string | undefined) => () => void;
}

const PanelContext = createContext<Panel | null>(null);

// The maker of the group an item stands in.
const GroupContext = createContext<string | undefined>(undefined);

/** The row a star stands in. */
interface Row {
  value: string;
  name: string;
  favorite: boolean;
  highlighted: boolean;
}

const RowContext = createContext<Row | null>(null);

const useRoot = (part: string): Root => {
  const root = use(RootContext);
  if (root === null) {
    throw new Error(`${part} must be inside a ModelSelector.`);
  }
  return root;
};

const usePanel = (part: string): Panel => {
  const panel = use(PanelContext);
  if (panel === null) {
    throw new Error(`${part} must be inside a ModelSelectorContent.`);
  }
  return panel;
};

/** The model picker: its chip and its panel, open or closed, and the choices it shows. */
export const ModelSelector = ({
  children,
  value: valueGiven,
  defaultValue,
  onValueChange,
  favorites: favoritesGiven,
  defaultFavorites,
  onFavoritesChange,
  effort: effortGiven,
  defaultEffort,
  onEffortChange,
  open,
  defaultOpen = false,
  onOpenChange,
}: ModelSelectorProps) => {
  const words = useI18n().modelSelector;
  const [openHere, setOpenHere] = useState(defaultOpen);
  const [valueHere, setValueHere] = useState(defaultValue);
  const [favoritesHere, setFavoritesHere] = useState(defaultFavorites);
  const [effortHere, setEffortHere] = useState(defaultEffort);
  const shown = open ?? openHere;
  const value = valueGiven ?? valueHere;
  const favorites = favoritesGiven ?? favoritesHere;
  const effort = effortGiven ?? effortHere;
  // Said once for each change: a close asked for twice (Escape, then the Popover) is one close.
  const change = (next: boolean) => {
    if (next === shown) {
      return;
    }
    setOpenHere(next);
    onOpenChange?.(next);
  };
  // With an effort to set, picking a model keeps the panel open for it, and says the model chosen,
  // since focus stays in the search.
  const staysOpen =
    onEffortChange !== undefined ||
    effortGiven !== undefined ||
    defaultEffort !== undefined;
  // Starring changes the favourites the page holds (with onFavoritesChange) or its own.
  const keepsFavorites =
    onFavoritesChange !== undefined ||
    (favoritesGiven === undefined && defaultFavorites !== undefined);
  const root: Root = {
    value,
    pick: (picked, label) => {
      setValueHere(picked);
      onValueChange?.(picked);
      if (!staysOpen) {
        change(false);
      } else if (picked !== value) {
        announce(words.chosen(label));
      }
    },
    favorites,
    toggleFavorite:
      favorites === undefined || !keepsFavorites
        ? undefined
        : (model, label) => {
            const starred = favorites.includes(model);
            const next = starred
              ? favorites.filter((each) => each !== model)
              : [...favorites, model];
            setFavoritesHere(next);
            onFavoritesChange?.(next);
            announce(starred ? words.removed(label) : words.added(label));
          },
    effort,
    onEffortChange: (next) => {
      setEffortHere(next);
      onEffortChange?.(next);
    },
    close: () => {
      change(false);
    },
  };
  return (
    <span data-slot="model-selector" {...stylex.props(styles.root)}>
      <Popover
        open={shown}
        onOpenChange={(next: boolean) => {
          change(next);
        }}
      >
        {/* oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled */}
        <RootContext value={root}>{children}</RootContext>
      </Popover>
    </span>
  );
};

/**
 * The chip that opens the panel: a ghost Button, the logo and the words a size down, a chevron. It is
 * named by the selector's word and the model; a tooltip says the model in full when the chip does not.
 */
export const ModelSelectorTrigger = ({
  children,
  tooltip,
  "aria-label": named,
  asChild = false,
  disabled,
  style,
}: ModelSelectorTriggerProps) => {
  const words = useI18n().modelSelector;
  const shows = tooltip ?? textOf(children).trim();
  const label =
    named ??
    (shows === "" ? words.trigger : words.triggerWith(words.trigger, shows));
  const chip = asChild ? (
    children
  ) : (
    <Button variant="ghost" size="xs" style={style}>
      <span {...stylex.props(styles.chip)}>
        {children}
        <span aria-hidden="true" {...stylex.props(styles.chevron)}>
          <Icon icon={ChevronDownIcon} />
        </span>
      </span>
    </Button>
  );
  // One tree whether or not there is a tooltip, so the chip is never drawn anew while it is open.
  const tip = tooltip !== undefined && tooltip !== "";
  return (
    <Tooltip disabled={!tip}>
      <PopoverTrigger asChild aria-label={label} disabled={disabled}>
        <TooltipTrigger asChild>{chip}</TooltipTrigger>
      </PopoverTrigger>
      {tip ? <TooltipContent>{tooltip}</TooltipContent> : null}
    </Tooltip>
  );
};

/** One opening of the panel: the search empty, the column on the chosen model's maker. */
const PanelState = ({ children }: { children: ReactNode }) => {
  const root = useRoot("ModelSelectorContent");
  const [query, setQuery] = useState("");
  const [rail, setRail] = useState<string | null>(null);
  // Who is on the page: the makers in the column's order, and each model's maker, so the column
  // opens on the chosen model's. Read before the first paint.
  const [makers, setMakers] = useState<readonly string[]>([]);
  const [makerOf, setMakerOf] = useState<ReadonlyMap<string, string>>(
    () => new Map()
  );
  const chosenMaker =
    root.value === undefined ? undefined : makerOf.get(root.value);
  const starred = rail === FAVORITES && root.favorites !== undefined;
  const opensOn = starred ? FAVORITES : (rail ?? chosenMaker ?? makers[0]);
  const panel: Panel = {
    searching: query.trim() !== "",
    rail: makers.length === 0 ? null : (opensOn ?? null),
    chooseRail: (next) => {
      setRail(next);
      setQuery("");
    },
    registerMaker: (maker) => {
      setMakers((all) => (all.includes(maker) ? all : [...all, maker]));
      return () => {
        setMakers((all) => all.filter((each) => each !== maker));
      };
    },
    registerModel: (model, maker) => {
      if (maker === undefined) {
        return nothing;
      }
      setMakerOf((all) => {
        if (all.get(model) === maker) {
          return all;
        }
        return new Map([...all, [model, maker]]);
      });
      return () => {
        setMakerOf((all) => {
          if (all.get(model) !== maker) {
            return all;
          }
          const next = new Map(all);
          next.delete(model);
          return next;
        });
      };
    },
  };
  return (
    // oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled
    <PanelContext value={panel}>
      <CommandPrimitive
        query={query}
        onQueryChange={(next: string) => {
          setQuery(next);
        }}
        autoHighlight
        loop
        {...stylex.props(styles.grid)}
      >
        {children}
      </CommandPrimitive>
    </PanelContext>
  );
};

/**
 * The panel beside the chip. Escape closes it, focus goes back to the chip, and no listener of the
 * page hears that Escape and closes more.
 */
export const ModelSelectorContent = ({
  children,
  side = "bottom",
  align = "start",
  style,
}: ModelSelectorContentProps) => {
  const root = useRoot("ModelSelectorContent");
  const words = useI18n().modelSelector;
  const keys = (event: KeyboardEvent<HTMLElement>) => {
    // Escape closes the panel and stops here, so the page does not hear it (and the Popover, which
    // listens on the page, does not close it a second time).
    if (event.key === "Escape") {
      event.stopPropagation();
      root.close();
    }
    // Tab from the last stop goes on to the stop after the chip, which closes the panel; with none
    // after it (a Send that is off while the message is empty), focus would fall to the page: the
    // panel closes and focus goes back to the chip instead.
    if (event.key === "Tab" && !event.shiftKey) {
      const { ownerDocument } = event.currentTarget;
      setTimeout(() => {
        const held = ownerDocument.activeElement;
        if (held === null || held === ownerDocument.body) {
          root.close();
        }
      }, 0);
    }
  };
  return (
    <PopoverContentPrimitive
      render={<div data-slot="model-selector-content" />}
      aria-label={words.trigger}
      side={side}
      align={align}
      sideOffset={popup.popoverGap}
      collisionPadding={popup.gutter}
      onKeyDown={keys}
      {...stylex.props(listStyles.popup, styles.panel, style)}
    >
      <PanelState>{children}</PanelState>
    </PopoverContentPrimitive>
  );
};

/** Whether the arrow pressed is the one toward the line's end, which follows the reading direction. */
const towardEnd = (event: KeyboardEvent<HTMLInputElement>) =>
  event.key ===
  (getComputedStyle(event.currentTarget).direction === "rtl"
    ? "ArrowLeft"
    : "ArrowRight");

/**
 * The search across the panel's top, with its icon; it takes focus as the panel opens. At the end
 * of its words, the arrow toward the line's end stars or unstars the highlighted model.
 */
export const ModelSelectorInput = ({
  "aria-label": named,
  placeholder,
}: ModelSelectorInputProps) => {
  const root = useRoot("ModelSelectorInput");
  const words = useI18n().modelSelector;
  const hint = useId();
  const toggle = root.toggleFavorite;
  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const atEnd =
      input.selectionStart === input.value.length &&
      input.selectionEnd === input.value.length;
    if (toggle === undefined || !atEnd || !towardEnd(event)) {
      return;
    }
    const row = input
      .closest("[data-slot=model-selector-content]")
      ?.querySelector<HTMLElement>("[data-model-value][data-highlighted]");
    const model = row?.dataset.modelValue;
    if (row === null || row === undefined || model === undefined) {
      return;
    }
    event.preventDefault();
    toggle(model, row.dataset.modelLabel ?? model);
  };
  return (
    <div data-slot="model-selector-input" {...stylex.props(styles.search)}>
      <Icon icon={SearchIcon} />
      <InputPrimitive
        aria-label={named ?? words.search}
        aria-describedby={toggle === undefined ? undefined : hint}
        placeholder={placeholder ?? words.search}
        onKeyDown={keys}
        {...stylex.props(styles.input)}
      />
      {toggle === undefined ? null : (
        <span id={hint} hidden>
          {words.favoriteKeys}
        </span>
      )}
    </div>
  );
};

/** One entry of the makers' column: a logo, or the star. */
const Rail = ({
  value,
  label,
  children,
}: {
  value: string;
  label: string;
  children: ReactNode;
}) => (
  // The maker's name under the pointer only: reached by the keys, the list's heading already says it,
  // and a tooltip would stand over that heading.
  <Tooltip
    onOpenChange={(open, details) => {
      if (open && details.reason === "trigger-focus") {
        details.cancel();
      }
    }}
  >
    <TooltipTrigger asChild>
      <ListboxItem
        value={value}
        label={label}
        aria-label={label}
        className={(state: ListboxItemState) =>
          className(
            styles.maker,
            state.selected && styles.makerChosen,
            focusRing
          ) ?? ""
        }
      >
        {children}
      </ListboxItem>
    </TooltipTrigger>
    <TooltipContent side="right">{label}</TooltipContent>
  </Tooltip>
);

/**
 * The makers' column down the panel's start side: one tab stop, the arrows and the first letters
 * moving the choice, which shows that maker's models. With `favorites`, a star comes first.
 */
export const ModelSelectorMakers = ({
  children,
  "aria-label": named,
}: ModelSelectorMakersProps) => {
  const root = useRoot("ModelSelectorMakers");
  const panel = usePanel("ModelSelectorMakers");
  const words = useI18n().modelSelector;
  return (
    <Listbox
      data-slot="model-selector-makers"
      aria-label={named ?? words.makers}
      value={panel.searching ? null : panel.rail}
      onValueChange={(next: string | null) => {
        if (next !== null) {
          panel.chooseRail(next);
        }
      }}
      activation="automatic"
      deselectable={false}
      {...stylex.props(styles.makers, scrollbarHidden)}
    >
      {root.favorites === undefined ? null : (
        <Rail value={FAVORITES} label={words.favorites}>
          <Icon icon={StarIcon} />
        </Rail>
      )}
      {children}
    </Listbox>
  );
};

/** A maker in the column: its logo, named by the maker. */
export const ModelSelectorMaker = ({
  value,
  label,
  logo,
}: ModelSelectorMakerProps) => {
  const { registerMaker } = usePanel("ModelSelectorMaker");
  useLayoutEffect(() => registerMaker(value), [registerMaker, value]);
  return (
    <Rail value={value} label={label}>
      <BrandIcon logo={logo} label={label} size="sm" decorative tile={false} />
    </Rail>
  );
};

/**
 * What the list says when no model matches the search, or no model is a favourite yet. A maker
 * whose models are taken away while the panel is open says nothing: no search has failed.
 */
export const ModelSelectorEmpty = ({ children }: ModelSelectorEmptyProps) => {
  const panel = usePanel("ModelSelectorEmpty");
  const words = useI18n().modelSelector;
  const starred = panel.rail === FAVORITES && !panel.searching;
  return (
    <EmptyPrimitive
      data-slot="model-selector-empty"
      {...stylex.props(styles.empty)}
    >
      {panel.searching || starred
        ? (children ?? (starred ? words.noFavorites : words.empty))
        : null}
    </EmptyPrimitive>
  );
};

/** Whether a child is the list's empty message, which stands outside the listbox. */
const isEmpty = (child: ReactNode) =>
  isValidElement(child) && child.type === ModelSelectorEmpty;

/**
 * The models beside the column: the chosen maker's under its name, the favourites under the star,
 * or every maker's that matches while searching. It scrolls past the panel's height.
 */
export const ModelSelectorList = ({ children }: ModelSelectorListProps) => {
  const panel = usePanel("ModelSelectorList");
  const words = useI18n().modelSelector;
  const heading = useId();
  const all = listOf(children);
  const starred = panel.rail === FAVORITES && !panel.searching;
  return (
    <div
      data-slot="model-selector-list"
      {...stylex.props(styles.list, scrollbarHidden)}
    >
      {starred ? (
        <div id={heading} {...stylex.props(styles.heading)}>
          {words.favorites}
        </div>
      ) : null}
      {all.filter(isEmpty)}
      <ListPrimitive
        aria-labelledby={starred ? heading : undefined}
        aria-label={starred ? undefined : words.trigger}
      >
        {all.filter((child) => !isEmpty(child))}
      </ListPrimitive>
    </div>
  );
};

/**
 * One maker's models. With a column of makers it shows while its maker is chosen, its name heading
 * the list; while searching, its models that match show without it.
 */
export const ModelSelectorGroup = ({
  value,
  heading,
  children,
}: ModelSelectorGroupProps) => {
  const panel = usePanel("ModelSelectorGroup");
  const shows =
    heading !== undefined &&
    heading !== "" &&
    !panel.searching &&
    (panel.rail === null || panel.rail === value);
  return (
    <GroupContext value={value}>
      <GroupPrimitive aria-label={shows ? undefined : heading}>
        {shows ? (
          <CommandGroupLabel {...stylex.props(styles.heading)}>
            {heading}
          </CommandGroupLabel>
        ) : null}
        {children}
      </GroupPrimitive>
    </GroupContext>
  );
};

/** A maker's logo, beside the model's name, at the icon's size. */
export const ModelSelectorLogo = ({
  logo,
  label,
  style,
}: ModelSelectorLogoProps) => (
  <span data-slot="model-selector-logo" {...stylex.props(styles.logo, style)}>
    <BrandIcon
      logo={logo}
      label={label ?? ""}
      size="sm"
      decorative={label === undefined}
      tile={false}
    />
  </span>
);

/** The model's name, or its level in a word. */
export const ModelSelectorName = ({
  children,
  style,
}: ModelSelectorNameProps) => (
  <span data-slot="model-selector-name" {...stylex.props(styles.name, style)}>
    {children}
  </span>
);

/**
 * A row's star: adds the model to the favourites or takes it out, without picking it. The keys reach
 * it from the search (ModelSelectorInput); the change is said.
 */
export const ModelSelectorFavorite = ({
  "aria-label": named,
}: ModelSelectorFavoriteProps) => {
  const root = useRoot("ModelSelectorFavorite");
  const row = use(RowContext);
  const words = useI18n().modelSelector;
  const toggle = root.toggleFavorite;
  if (toggle === undefined || row === null) {
    return null;
  }
  return (
    <span
      data-slot="model-selector-favorite"
      {...stylex.props(
        styles.star,
        (row.favorite || row.highlighted) && styles.starShown,
        row.favorite && styles.starOn
      )}
    >
      <Button
        variant="ghost"
        size="icon-xs"
        tabIndex={-1}
        aria-label={
          named ??
          (row.favorite
            ? words.removeFavorite(row.name)
            : words.addFavorite(row.name))
        }
        // The press stays on the star: the row under it is not picked.
        onPointerDown={(event: PointerEvent) => {
          event.stopPropagation();
        }}
        onClick={(event: MouseEvent) => {
          event.stopPropagation();
          toggle(row.value, row.name);
        }}
      >
        <Icon icon={row.favorite ? StarFilledIcon : StarIcon} />
      </Button>
    </span>
  );
};

/** A row's look, by whether it is the chosen model and where the keys or the pointer are. */
const rowClass = (chosen: boolean, state: CommandItemState) =>
  className(
    styles.row,
    chosen && styles.rowChosen,
    state.highlighted && listStyles.itemHighlighted,
    state.disabled && listStyles.itemDisabled
  ) ?? "";

/** Whether a child is a logo, which stands before the words. */
const isLogo = (child: ReactNode) =>
  isValidElement(child) && child.type === ModelSelectorLogo;

/** Whether a child is the row's star, which stands at its end. */
const isStar = (child: ReactNode) =>
  isValidElement(child) && child.type === ModelSelectorFavorite;

/**
 * One model: Enter or a press picks it. The chosen one is ticked and said as current; one out of use
 * says why under its name.
 */
export const ModelSelectorItem = ({
  value,
  children,
  label,
  keywords,
  description,
  disabled = false,
}: ModelSelectorItemProps) => {
  const root = useRoot("ModelSelectorItem");
  const panel = usePanel("ModelSelectorItem");
  const maker = use(GroupContext);
  const { registerModel } = panel;
  useLayoutEffect(
    () => registerModel(value, maker),
    [registerModel, value, maker]
  );
  const described = useId();
  const name = label ?? textOf(children).trim();
  const favorites = root.favorites ?? [];
  const favorite = favorites.includes(value);
  // With a column and nothing typed, only the column's choice shows: its maker's, or the favourites.
  const filtered = panel.rail !== null && !panel.searching;
  const elsewhere =
    panel.rail === FAVORITES
      ? !favorite
      : maker !== undefined && maker !== panel.rail;
  if (filtered && elsewhere) {
    return null;
  }
  const chosen = root.value === value;
  const all = listOf(children);
  const said = description !== undefined && description !== "";
  return (
    <ItemPrimitive
      value={value}
      label={name}
      keywords={keywords}
      disabled={disabled}
      aria-label={name}
      aria-describedby={said ? described : undefined}
      aria-current={chosen ? "true" : undefined}
      data-model-value={value}
      data-model-label={name}
      onSelect={() => {
        root.pick(value, name);
      }}
      className={(state: CommandItemState) => rowClass(chosen, state)}
    >
      {(state: CommandItemState) => (
        <RowContext
          // oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled
          value={{ value, name, favorite, highlighted: state.highlighted }}
        >
          {all.filter(isLogo)}
          <span {...stylex.props(styles.rowWords)}>
            {all.filter((child) => !isLogo(child) && !isStar(child))}
            {said ? (
              <span
                id={described}
                {...stylex.props(disabled ? styles.why : visuallyHidden)}
              >
                {description}
              </span>
            ) : null}
          </span>
          {all.filter(isStar)}
          {chosen ? (
            <span aria-hidden="true" {...stylex.props(styles.tick)}>
              <Icon icon={CheckIcon} />
            </span>
          ) : null}
        </RowContext>
      )}
    </ItemPrimitive>
  );
};

/** A model's levels as one key, so a new array with the same levels is the same row. */
const levelsKey = (levels: readonly { value: string }[]) =>
  levels.map((level) => level.value).join("\u0000");

const NO_LEVELS: readonly { value: string; label: string }[] = [];

/**
 * The effort at the panel's foot: its heading, and every level by name as one row of segments,
 * the chosen one raised. A model with one level or none has no row: it folds away, its height
 * easing, the last levels kept (and inert) until it has.
 */
export const ModelSelectorEffort = ({
  levels,
  label,
}: ModelSelectorEffortProps) => {
  const root = useRoot("ModelSelectorEffort");
  const words = useI18n().modelSelector;
  const named = label ?? words.effort;
  const open = levels.length > 1;
  const [kept, setKept] = useState(levels);
  if (open && levelsKey(kept) !== levelsKey(levels)) {
    setKept(levels);
  }
  const shown = open ? levels : kept;
  const chosen = shown.some((level) => level.value === root.effort)
    ? root.effort
    : undefined;
  return (
    <div
      data-slot="model-selector-effort"
      inert={!open}
      onTransitionEnd={(event) => {
        if (!open && event.target === event.currentTarget) {
          setKept(NO_LEVELS);
        }
      }}
      {...stylex.props(styles.fold, open && styles.foldOpen)}
    >
      <div {...stylex.props(styles.foldInner)}>
        {shown.length > 1 ? (
          <div {...stylex.props(styles.effort)}>
            <p aria-hidden="true" {...stylex.props(styles.effortHeading)}>
              {named}
            </p>
            <ToggleGroup
              aria-label={named}
              size="default"
              fullWidth
              value={chosen === undefined ? [] : [chosen]}
              deselectable={false}
              onValueChange={(next: string[]) => {
                const [first] = next;
                if (first !== undefined) {
                  root.onEffortChange(first);
                }
              }}
            >
              {shown.map((level) => (
                <ToggleGroupItem key={level.value} value={level.value}>
                  {level.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        ) : null}
      </div>
    </div>
  );
};
