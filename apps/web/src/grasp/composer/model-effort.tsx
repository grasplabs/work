"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { Popover, PopoverContent, PopoverTrigger } from "@ui-sdk/react/popover";
import { mergeProps } from "@ui-sdk/react/primitive";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { focus } from "../focus/focus";
import { visuallyHidden } from "../hidden/hidden";
import { ChevronDown, Icon } from "../icons";
import type { IconData } from "../icons";
import { simply } from "../motion/simply.stylex";
import { popoverStyles } from "../popover/styles";
import { grasp, media } from "../tokens/tokens.stylex";
import { popup } from "../tokens/tokens.values";
import { ChipTip } from "./chip-tip";
import { useComposerDisabled } from "./context";
import { controlStyles } from "./control";
import { ComposerEffort } from "./effort";
import { stopEscape } from "./escape";
import { ModelMenu } from "./model";
import type {
  ComposerModelMaker,
  ComposerModelOption,
  ModelMenuWords,
} from "./model";
import { LitEdge } from "./reasoning";
import type { ComposerReasoningOption } from "./reasoning";
import { rowMarker } from "./row.stylex";
import { tabOutTarget } from "./tab-out";
import { useComposerWords } from "./words";

/** One model, with the levels of effort it offers. */
export interface ComposerModelEffortOption extends ComposerModelOption {
  /** Its levels, from the least effort to the most. None, or one: it has no slider. */
  levels?: ComposerReasoningOption[];
}

/** Every prop a ComposerModelEffort takes. */
export interface ComposerModelEffortProps {
  /** The models, in the order to list them. */
  models: ComposerModelEffortOption[];
  /** The makers, for each model's mark. */
  makers?: ComposerModelMaker[];
  /** The chosen model's `value`. */
  model: string;
  /** Called with the model chosen. Keep the effort a level the new model has. */
  onModelChange: (value: string) => void;
  /** The chosen level's `value`. */
  effort: string;
  /** Called with the level chosen. */
  onEffortChange: (value: string) => void;
  /**
   * The control's name for a screen reader, before the model's name and its level.
   * @default "Model and effort"
   */
  "aria-label"?: string;
  /** @deprecated Use `aria-label`. */
  label?: string;
  /**
   * Not shown: the menu has no model row of its own since 18 November; it is named by `aria-label`.
   * Kept, with no effect, for hosts that still pass it (to be deprecated with a codemod later).
   */
  modelLabel?: string;
  /**
   * The Thinking row's word, and the name of its levels.
   * @default "Thinking"
   */
  thinkingLabel?: string;
  /** The Thinking row's word by its earlier name: `thinkingLabel` wins when both are given (to be deprecated with a codemod later). */
  effortLabel?: string;
  /**
   * Not shown: a model with one level has no Thinking row, so nothing is said in its place. Kept,
   * with no effect, for hosts that still pass it (to be deprecated with a codemod later).
   */
  noEffortLabel?: string;
  /** Models to list under the star at the top of the rail. Without them there is no star. */
  favourites?: string[];
  /** A row at the top of a maker's list, such as a Connect action for linking an account. */
  connect?: Record<string, ReactNode>;
  /**
   * The search field's name and placeholder.
   * @default "Search models"
   */
  searchLabel?: string;
  /**
   * The name of the rail of makers, for a screen reader.
   * @default "Makers"
   */
  makersLabel?: string;
  /**
   * The rail's name for favourites.
   * @default "Favourites"
   */
  favouritesLabel?: string;
  /**
   * What the list says when nothing matches.
   * @default "No models found"
   */
  emptyLabel?: string;
  /**
   * At the strongest level (a level's `top`), the working light round the chip. Off, the word
   * "Max" says it alone.
   * @default false
   */
  topLight?: boolean;
  /**
   * The chip says the model's name before its level, as it did before 18 November. Without it the
   * chip is the maker's mark and the level alone, the name in its tooltip; a model with one level
   * says its name, which is then its only word.
   * @default false
   */
  showName?: boolean;
}

const noMakers: ComposerModelMaker[] = [];
const noFavourites: string[] = [];
const noLevels: ComposerReasoningOption[] = [];

const styles = stylex.create({
  // The Thinking row's room: it opens and closes as a model with levels or with one is chosen, so
  // the menu's height eases rather than jumps (instant under reduced motion).
  fold: {
    display: "grid",
    gridTemplateRows: "0fr",
    transitionProperty: "grid-template-rows",
    transitionDuration: { default: simply.ui, [media.reduced]: "0s" },
    transitionTimingFunction: grasp.ease,
  },
  foldOpen: { gridTemplateRows: "1fr" },
  foldInner: { minHeight: 0, overflow: "hidden" },
  // The menu's foot: the Thinking row, under a hairline, on the menu's own inset.
  thinking: {
    paddingBlock: grasp.space2,
    paddingInline: grasp.space3,
    borderBlockStartWidth: grasp.hairline,
    borderBlockStartStyle: "solid",
    borderBlockStartColor: grasp.line,
  },
  // The surface's slot, with no box of its own: the menu lays out against the panel.
  surface: {
    display: "contents",
  },
  panel: {
    width: `min(${grasp.modelMenuWidth}, 100vw - 2 * ${grasp.popupGutter})`,
    maxHeight: `min(${grasp.popupHeight}, var(--available-height, ${grasp.popupHeight}))`,
    // The menu scrolls its own list; the panel itself never does.
    overflow: "hidden",
    transformOrigin: "var(--transform-origin)",
  },
  lit: {
    color: grasp.ink,
  },
  // The chip's mark, words and nothing else: they can shrink, so the chevron keeps its room.
  chipValue: {
    minWidth: 0,
    flexShrink: 1,
  },
  // The name and the level: one line tall, wrapping, so a level that no longer fits goes to a
  // second line that is never seen (it is still in the chip's name, its tooltip and the surface).
  // The name always stands first on the seen line. Never cut to one letter: the words keep 4ch,
  // three letters and the ellipsis.
  chipWords: {
    display: "flex",
    flexWrap: "wrap",
    alignContent: "flex-start",
    alignItems: "center",
    columnGap: grasp.space1,
    rowGap: 0,
    flexShrink: 1,
    height: grasp.textXsLine,
    overflow: "hidden",
  },
  // The words' floor: eight characters and the ellipsis (the whole name when shorter), so names
  // alike in their start ("gpt-6-luna", "gpt-6-mini") stay apart. Below it only when the footer has
  // nothing else to give (useChipRoom), and then never under three letters.
  chipFloor: (floor: string) => ({ minWidth: floor }),
  chipFloorLast: {
    minWidth: "4ch",
  },
  // At the last floor the chip takes the room its own inset wastes, beside the mark and the chevron.
  chipTight: {
    paddingInline: grasp.space1,
  },
  // The model's name, in ink. Short of room, the level leaves first: the line breaks on the whole
  // name (its basis), so the level wraps out of sight as soon as both do not fit. Then the name is
  // cut, down to the words' floor.
  chipName: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "auto",
    maxWidth: "max-content",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: grasp.ink,
  },
  // The level: quieter, never cut; it leaves the line whole when the name needs the room.
  chipLevel: {
    flexShrink: 0,
    whiteSpace: "nowrap",
    color: grasp.muted,
  },
  // Gone for want of room: the chip closes up on the name (useChipRoom).
  chipLevelGone: {
    display: "none",
  },
  // In a narrow one row (a phone), the level folds to the maker's mark, so the text keeps its room;
  // the tooltip and the chip's name still say both.
  effortFolds: {
    // And wherever the row says so (data-fold): with this row's controls the text would go under its least width.
    display: {
      default: "inline",
      "@container composer-row (width < 24rem)": "none",
      [stylex.when.ancestor(":is([data-fold])", rowMarker)]: "none",
    },
  },
  chipShrinks: {
    flexShrink: 1,
    maxWidth: "100%",
  },
});

/** The chip: the maker's mark, the model's name, its level in a word, and the chevron. */
/** A computed length in pixels ("8px"), or 0 for one that is not ("normal"). */
const pixels = (value: string) => Number(value.replace("px", "")) || 0;

/** The room the footer has left over: its width less its parts' and the gaps between them. */
const footerSpare = (footer: HTMLElement) => {
  const style = getComputedStyle(footer);
  const parts = [...footer.children].filter(
    (part) =>
      part.getClientRects().length > 0 &&
      getComputedStyle(part).position !== "absolute"
  );
  const used = parts.reduce(
    (sum, part) => sum + part.getBoundingClientRect().width,
    0
  );
  const gaps = (parts.length - 1) * pixels(style.columnGap);
  const inset =
    pixels(style.paddingInlineStart) + pixels(style.paddingInlineEnd);
  return footer.clientWidth - inset - used - gaps;
};

/**
 * What the chip's words may show, from the room they have (their width, less what runs past the
 * chip's own box, plus the footer's spare room): the level only beside the whole name (else it
 * leaves, and the chip closes up on the name); under the floor only when the footer has nothing
 * else to give. Read again as the chip or the footer changes size. The level's width and the floor
 * are read while they show, so leaving and coming back happen at the same width: nothing flickers.
 * Before this has read (the server's HTML), the level wraps out of sight by itself (chipWords).
 */
const useChipRoom = (chip: HTMLElement | null) => {
  const [room, setRoom] = useState<{
    last: boolean;
    levelGone: boolean;
    floor: number | null;
  }>({ last: false, levelGone: false, floor: null });
  const levelWidth = useRef(0);
  useEffect(() => {
    const footer = chip?.closest<HTMLElement>('[data-slot="composer-footer"]');
    const read = () => {
      // Found anew each time: a new choice draws the words anew (the value's key).
      const words = chip?.querySelector<HTMLElement>("[data-chip-words]");
      if (
        chip === null ||
        words === null ||
        words === undefined ||
        footer === null ||
        footer === undefined
      ) {
        return;
      }
      const name = words.querySelector<HTMLElement>(
        '[data-slot="composer-model-effort-name"]'
      );
      // The floor: eight characters and the ellipsis (nine of the font's figure width), never more
      // than the whole name, whose letters may be narrower than that.
      const whole = name?.scrollWidth ?? 0;
      const context = document.createElement("canvas").getContext("2d");
      if (context !== null && name !== null) {
        context.font = getComputedStyle(name).font;
      }
      const floor = Math.min(whole, (context?.measureText("0").width ?? 0) * 9);
      const level = words.querySelector<HTMLElement>(
        '[data-slot="composer-model-effort-level"]'
      );
      if (level !== null && level.getClientRects().length > 0) {
        levelWidth.current = level.getBoundingClientRect().width;
      }
      // What the words could have: their width, less what already runs past the chip's own box,
      // plus the footer's spare room.
      const value = words.parentElement ?? words;
      const past = Math.max(
        0,
        value.scrollWidth - value.clientWidth,
        chip.scrollWidth - chip.clientWidth
      );
      const have =
        words.getBoundingClientRect().width - past + footerSpare(footer) + 0.5;
      const gap = pixels(getComputedStyle(words).columnGap);
      setRoom({
        last: have < floor,
        levelGone: level !== null && have < whole + gap + levelWidth.current,
        floor,
      });
    };
    // Watched once the chip is on the page in its footer; before that, nothing to read.
    const observer = new ResizeObserver(read);
    if (chip !== null && footer !== null && footer !== undefined) {
      observer.observe(chip);
      observer.observe(footer);
    }
    return () => {
      observer.disconnect();
    };
  }, [chip]);
  return room;
};

const Chip = ({
  props,
  mark,
  name,
  level,
  lit,
  value,
}: {
  props: Record<string, unknown>;
  mark: IconData | undefined;
  name: string;
  level: string | undefined;
  lit: boolean;
  value: string;
}) => {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const { last, levelGone, floor } = useChipRoom(node);
  return (
    <button
      {...mergeProps(props, { ref: setNode })}
      type="button"
      data-slot="composer-model-effort"
      data-top={lit || undefined}
      {...stylex.props(
        controlStyles.control,
        styles.chipShrinks,
        focus.ring,
        lit && styles.lit,
        last && styles.chipTight
      )}
    >
      <span aria-hidden="true" {...stylex.props(controlStyles.reach)} />
      {lit ? <LitEdge /> : null}
      <span
        key={value}
        {...stylex.props(controlStyles.value, styles.chipValue)}
      >
        {mark === undefined ? null : <Icon icon={mark} />}
        <span
          data-chip-words={last ? "last" : ""}
          {...stylex.props(
            styles.chipWords,
            styles.chipFloor(
              floor === null ? `${Math.min(9, name.length)}ch` : `${floor}px`
            ),
            last && styles.chipFloorLast
          )}
        >
          <span
            data-slot="composer-model-effort-name"
            {...stylex.props(styles.chipName)}
          >
            {name}
          </span>
          {level === undefined ? null : (
            <span
              data-slot="composer-model-effort-level"
              data-gone={levelGone || undefined}
              {...stylex.props(
                styles.chipLevel,
                levelGone && styles.chipLevelGone
              )}
            >
              {level}
            </span>
          )}
        </span>
      </span>
      <Icon icon={ChevronDown} />
    </button>
  );
};

/** The chip at rest: the maker's mark, the level in a word, the chevron. The name is in its tooltip. */
const EffortChip = ({
  props,
  mark,
  level,
  lit,
  value,
}: {
  props: Record<string, unknown>;
  mark: IconData | undefined;
  level: string;
  lit: boolean;
  value: string;
}) => (
  <button
    {...props}
    type="button"
    data-slot="composer-model-effort"
    data-top={lit || undefined}
    {...stylex.props(
      controlStyles.control,
      styles.chipShrinks,
      focus.ring,
      lit && styles.lit
    )}
  >
    <span aria-hidden="true" {...stylex.props(controlStyles.reach)} />
    {lit ? <LitEdge /> : null}
    <span key={value} {...stylex.props(controlStyles.value, styles.chipValue)}>
      {mark === undefined ? null : <Icon icon={mark} />}
      <span
        data-slot="composer-model-effort-level"
        {...stylex.props(
          controlStyles.words,
          mark !== undefined && styles.effortFolds
        )}
      >
        {level}
      </span>
    </span>
    <Icon icon={ChevronDown} />
  </button>
);

/** What the chip and the surface show for the chosen model and level. */
const readChoice = (
  models: ComposerModelEffortOption[],
  makers: ComposerModelMaker[],
  model: string,
  effort: string
) => {
  const current = models.find((each) => each.value === model) ?? models[0];
  const name = current?.label ?? "";
  const levels = current?.levels ?? noLevels;
  const at = levels.findIndex((level) => level.value === effort);
  const level = levels[at];
  return {
    current,
    name,
    mark: makers.find((maker) => maker.value === current?.maker)?.icon,
    levels,
    at,
    lit: level?.top === true,
    level: levels.length > 1 ? level?.label : undefined,
    said:
      levels.length > 1 && level !== undefined
        ? `${name}, ${level.label}`
        : name,
  };
};

/** A model's levels as one key, so a new array with the same levels is the same row. */
const levelsKey = (levels: readonly ComposerReasoningOption[]) =>
  levels.map((level) => level.value).join("\u0000");

/**
 * The menu's foot: the chosen model's levels under "Thinking". A model with one level has none: the
 * row closes, its height easing, the last model's levels kept (and inert) until it has closed.
 */
const ThinkingRow = ({
  levels,
  value,
  onValueChange,
  label,
}: {
  levels: ComposerReasoningOption[];
  value: string;
  onValueChange: (value: string) => void;
  label: string;
}) => {
  const open = levels.length > 1;
  const [kept, setKept] = useState(levels);
  // The levels to show while the row closes: those of the last model that had any.
  if (open && levelsKey(kept) !== levelsKey(levels)) {
    setKept(levels);
  }
  const shown = open ? levels : kept;
  return (
    <div
      data-slot="composer-model-thinking-fold"
      data-open={open ? "" : undefined}
      inert={!open}
      // Closed: the kept levels go once the height has eased away.
      onTransitionEnd={(event) => {
        if (!open && event.target === event.currentTarget) {
          setKept(noLevels);
        }
      }}
      {...stylex.props(styles.fold, open && styles.foldOpen)}
    >
      <div {...stylex.props(styles.foldInner)}>
        {shown.length > 1 ? (
          <div
            data-slot="composer-model-thinking"
            {...stylex.props(styles.thinking)}
          >
            <ComposerEffort
              row
              levels={shown}
              value={value}
              onValueChange={onValueChange}
              label={label}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
};

export const ComposerModelEffort = ({
  models,
  makers = noMakers,
  model,
  onModelChange,
  effort,
  onEffortChange,
  label: labelDeprecated,
  "aria-label": labelGiven,
  thinkingLabel: thinkingGiven,
  effortLabel: effortDeprecated,
  favourites = noFavourites,
  connect,
  searchLabel: searchGiven,
  makersLabel: makersGiven,
  favouritesLabel: favouritesGiven,
  emptyLabel: emptyGiven,
  topLight = false,
  showName = false,
}: ComposerModelEffortProps) => {
  const disabled = useComposerDisabled();
  // Its words: the caller's where given, else the product's catalogue (GraspWords), else English.
  const words = useComposerWords("modelEffort");
  const modelWords = useComposerWords("model");
  const label = labelGiven ?? labelDeprecated ?? words.label;
  const thinkingLabel = thinkingGiven ?? effortDeprecated ?? words.thinking;
  const menuWords: ModelMenuWords = {
    label,
    search: searchGiven ?? modelWords.search,
    makers: makersGiven ?? modelWords.makers,
    favourites: favouritesGiven ?? modelWords.favourites,
    empty: emptyGiven ?? modelWords.empty,
  };
  const [open, setOpen] = useState(false);
  const {
    name,
    mark,
    levels,
    at,
    lit: top,
    level,
    said,
  } = readChoice(models, makers, model, effort);
  const lit = topLight && top;
  // The chosen level, said when it changes while the menu is open.
  const [levelSaid, setLevelSaid] = useState("");

  // Escape closes the menu, and no listener of the host's hears it. Tab from its last stop goes on
  // to the next stop after the chip, the menu closed.
  const keys = (event: KeyboardEvent<HTMLElement>) => {
    const out =
      event.key === "Tab"
        ? tabOutTarget(event.currentTarget, event.target, event.shiftKey)
        : undefined;
    if (out !== undefined) {
      event.preventDefault();
      setOpen(false);
      out.focus();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    }
    stopEscape(event);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next: boolean) => {
        setOpen(next);
        setLevelSaid("");
      }}
    >
      <PopoverTrigger
        disabled={disabled}
        aria-label={`${label}: ${said}`}
        // The name in the chip: too narrow for its words, it shows them whole in a tooltip. The level
        // alone: the tooltip always says the model and its level.
        render={(props: Record<string, unknown>) =>
          showName || level === undefined ? (
            <ChipTip
              label={said}
              render={(tip) => (
                <Chip
                  props={mergeProps(props, tip)}
                  mark={mark}
                  name={name}
                  level={level}
                  lit={lit}
                  value={`${model} ${effort}`}
                />
              )}
            />
          ) : (
            <ChipTip
              always
              label={said}
              render={(tip) => (
                <EffortChip
                  props={mergeProps(props, tip)}
                  mark={mark}
                  level={level}
                  lit={lit}
                  value={`${model} ${effort}`}
                />
              )}
            />
          )
        }
      />
      <PopoverContent
        onKeyDown={keys}
        side="top"
        align="start"
        sideOffset={popup.popoverGap}
        collisionPadding={popup.gutter}
        aria-label={label}
        {...stylex.props(
          popoverStyles.panel,
          popoverStyles.motion,
          styles.panel
        )}
      >
        <div
          data-slot="composer-model-effort-surface"
          {...stylex.props(styles.surface)}
        >
          {/* ComposerModel's own menu. Choosing a model keeps it open, so its level can be set next. */}
          <ModelMenu
            models={models}
            makers={makers}
            value={model}
            favourites={favourites}
            connect={connect}
            words={menuWords}
            onPick={onModelChange}
            foot={
              <ThinkingRow
                levels={levels}
                value={at === -1 ? (levels[0]?.value ?? "") : effort}
                onValueChange={(next) => {
                  onEffortChange(next);
                  setLevelSaid(
                    `${thinkingLabel}: ${levels.find((each) => each.value === next)?.label ?? ""}`
                  );
                }}
                label={thinkingLabel}
              />
            }
          />
          <p
            aria-live="polite"
            data-slot="composer-model-thinking-said"
            {...stylex.props(visuallyHidden)}
          >
            {levelSaid}
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
};
