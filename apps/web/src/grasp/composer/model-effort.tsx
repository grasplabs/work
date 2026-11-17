"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { Popover, PopoverContent, PopoverTrigger } from "@ui-sdk/react/popover";
import { mergeProps } from "@ui-sdk/react/primitive";
import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

import { focus } from "../focus/focus";
import { ChevronDown, ChevronRight, Icon, Tick } from "../icons";
import type { IconData } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import { popoverStyles } from "../popover/styles";
import { grasp, media } from "../tokens/tokens.stylex";
import { popup } from "../tokens/tokens.values";
import { ChipTip } from "./chip-tip";
import { useComposerDisabled } from "./context";
import { controlStyles } from "./control";
import { ComposerEffort } from "./effort";
import type { ComposerEffortLook } from "./effort";
import { stopEscape } from "./escape";
import type { ComposerModelMaker, ComposerModelOption } from "./model";
import { LitEdge } from "./reasoning";
import type { ComposerReasoningOption } from "./reasoning";
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
   * The list of models' name.
   * @default "Model"
   */
  modelLabel?: string;
  /**
   * The effort's heading and the slider's name.
   * @default "Effort"
   */
  effortLabel?: string;
  /**
   * Said in the effort's place when the model has one level.
   * @default "This model has one level of effort."
   */
  noEffortLabel?: string;
  /**
   * How the surface shows the levels: a list of rows (each name, its note, a tick on the chosen),
   * or one segmented control with every level's name.
   * @default "rows"
   */
  effortLook?: ComposerEffortLook;
  /**
   * At the strongest level (a level's `top`), the working light round the chip. Off, the word
   * "Max" says it alone.
   * @default false
   */
  topLight?: boolean;
}

const noMakers: ComposerModelMaker[] = [];
const noLevels: ComposerReasoningOption[] = [];

const styles = stylex.create({
  panel: {
    width: `min(${grasp.modelMenuWidth}, 100vw - 2 * ${grasp.popupGutter})`,
    maxHeight: `min(${grasp.popupHeight}, var(--available-height, ${grasp.popupHeight}))`,
    overflowY: "auto",
    transformOrigin: "var(--transform-origin)",
  },
  surface: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    display: "grid",
    gap: grasp.space2,
    padding: grasp.space2,
  },
  // The model, as a row at the top: it opens the list in the effort's place.
  header: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    width: "100%",
    boxSizing: "border-box",
    minHeight: { default: grasp.controlSm, [media.coarse]: grasp.tap },
    margin: 0,
    paddingInline: grasp.space2,
    borderWidth: 0,
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlSm} / 2))`,
    cornerShape: grasp.cornerShape,
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [media.hover]: grasp.itemFillHighlight },
      ":is([aria-expanded=true])": grasp.itemFillHighlight,
    },
    color: grasp.ink,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
    textAlign: "start",
    cursor: "pointer",
  },
  headerName: {
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  headerMark: {
    display: "flex",
    flexShrink: 0,
    color: grasp.muted,
  },
  // No inset of its own: its heading, its levels' names and its note stand on the model row's
  // mark, its tick under the model row's chevron, and its rows' fill spans as the model row's does.
  effort: {
    display: "grid",
    minWidth: 0,
    paddingBlockStart: grasp.space1,
    borderBlockStartWidth: grasp.hairline,
    borderBlockStartStyle: "solid",
    borderBlockStartColor: grasp.line,
  },
  none: {
    margin: 0,
    paddingBlock: grasp.space2,
    paddingInline: grasp.space2,
    color: grasp.muted,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
  },
  list: {
    display: "grid",
    gap: 0,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    width: "100%",
    boxSizing: "border-box",
    minHeight: { default: grasp.controlSm, [media.coarse]: grasp.tap },
    margin: 0,
    paddingBlock: grasp.space1,
    paddingInline: grasp.space2,
    borderWidth: 0,
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlSm} / 2))`,
    cornerShape: grasp.cornerShape,
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [media.hover]: grasp.itemFillHighlight },
    },
    color: grasp.ink,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    textAlign: "start",
    cursor: { default: "pointer", ":is([aria-disabled=true])": "default" },
    opacity: { default: 1, ":is([aria-disabled=true])": grasp.dim },
  },
  rowWords: {
    display: "grid",
    flexGrow: 1,
    minWidth: 0,
  },
  rowWhy: {
    color: grasp.muted,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
  },
  tick: {
    display: "flex",
    flexShrink: 0,
    width: grasp.iconSm,
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
  chipShrinks: {
    flexShrink: 1,
    maxWidth: "100%",
  },
});

/** Moves the focus among the list's rows with the arrow keys, Home and End. */
const moveAmongRows = (event: KeyboardEvent<HTMLButtonElement>) => {
  const next = { ArrowDown: 1, ArrowUp: -1 }[event.key];
  const list = event.currentTarget.closest("ul");
  if (
    list === null ||
    (next === undefined && event.key !== "Home" && event.key !== "End")
  ) {
    return;
  }
  const rows = [...list.querySelectorAll("button")];
  let to = rows.indexOf(event.currentTarget) + (next ?? 0);
  if (event.key === "Home") {
    to = 0;
  } else if (event.key === "End") {
    to = rows.length - 1;
  }
  event.preventDefault();
  rows[(to + rows.length) % rows.length]?.focus();
};

/** The models, the chosen one ticked and where the keys arrive. */
const ModelList = ({
  id,
  models,
  makers,
  chosen,
  label,
  onPick,
}: {
  id: string;
  models: ComposerModelEffortOption[];
  makers: ComposerModelMaker[];
  chosen: string | undefined;
  label: string;
  onPick: (value: string) => void;
}) => (
  <ul
    id={id}
    aria-label={label}
    data-slot="composer-model-effort-list"
    {...stylex.props(styles.list)}
  >
    {models.map((option) => {
      const on = option.value === chosen;
      const off = option.disabled === true;
      const own = makers.find((maker) => maker.value === option.maker)?.icon;
      return (
        <li key={option.value}>
          <button
            type="button"
            aria-current={on || undefined}
            aria-disabled={off || undefined}
            // The list opens from its header, and the keys go to the chosen model.
            autoFocus={on}
            title={option.description}
            onKeyDown={moveAmongRows}
            onClick={() => {
              if (!off) {
                onPick(option.value);
              }
            }}
            {...stylex.props(styles.row, focus.ring)}
          >
            <span aria-hidden="true" {...stylex.props(styles.tick)}>
              {on ? <Icon icon={Tick} /> : null}
            </span>
            {own === undefined ? null : <Icon icon={own} />}
            <span {...stylex.props(styles.rowWords)}>
              <span>{option.label}</span>
              {off && option.reason !== undefined && option.reason !== "" ? (
                <span {...stylex.props(styles.rowWhy)}>{option.reason}</span>
              ) : null}
            </span>
          </button>
        </li>
      );
    })}
  </ul>
);

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

/** The effort: every level by name, as rows or segments, or for a model with one level a line that says so. */
const EffortPart = ({
  levels,
  value,
  onValueChange,
  label,
  noneLabel,
  look,
}: {
  levels: ComposerReasoningOption[];
  value: string;
  onValueChange: (value: string) => void;
  label: string;
  noneLabel: string;
  look: ComposerEffortLook;
}) => (
  <div {...stylex.props(styles.effort)}>
    {levels.length > 1 ? (
      <ComposerEffort
        levels={levels}
        value={value}
        onValueChange={onValueChange}
        label={label}
        look={look}
      />
    ) : (
      <p {...stylex.props(styles.none)}>{noneLabel}</p>
    )}
  </div>
);

/** The model and its effort, as one control: a chip, and a surface with the effort first. */
export const ComposerModelEffort = ({
  models,
  makers = noMakers,
  model,
  onModelChange,
  effort,
  onEffortChange,
  label: labelDeprecated,
  "aria-label": labelGiven,
  modelLabel: modelGiven,
  effortLabel: effortGiven,
  noEffortLabel: noEffortGiven,
  effortLook = "rows",
  topLight = false,
}: ComposerModelEffortProps) => {
  const disabled = useComposerDisabled();
  // Its words: the caller's where given, else the product's catalogue (GraspWords), else English.
  const words = useComposerWords("modelEffort");
  const label = labelGiven ?? labelDeprecated ?? words.label;
  const modelLabel = modelGiven ?? words.model;
  const effortLabel = effortGiven ?? words.effort;
  const noEffortLabel = noEffortGiven ?? words.none;
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState(false);
  const header = useRef<HTMLButtonElement | null>(null);
  const listId = useId();
  const {
    current,
    name,
    mark,
    levels,
    at,
    lit: top,
    level,
    said,
  } = readChoice(models, makers, model, effort);
  const lit = topLight && top;

  const back = () => {
    setListing(false);
    header.current?.focus();
  };

  // One Escape does one thing: with the list open it goes back to the effort; otherwise it closes
  // the surface. Either way no listener of the host's hears it.
  const keys = (event: KeyboardEvent<HTMLElement>) => {
    // Tab from the surface's last stop: on to the next stop after the chip, the surface closed.
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
      if (listing) {
        back();
      } else {
        setOpen(false);
      }
    }
    stopEscape(event);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next: boolean) => {
        setOpen(next);
        setListing(false);
      }}
    >
      <PopoverTrigger
        disabled={disabled}
        aria-label={`${label}: ${said}`}
        // Too narrow for its words, the chip shows them whole in a tooltip.
        render={(props: Record<string, unknown>) => (
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
        )}
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
          <button
            ref={header}
            type="button"
            aria-expanded={listing}
            aria-controls={listing ? listId : undefined}
            aria-label={`${modelLabel}: ${name}`}
            onClick={() => {
              setListing(!listing);
            }}
            data-slot="composer-model-effort-model"
            {...stylex.props(styles.header, focus.ring)}
          >
            {mark === undefined ? null : (
              <span aria-hidden="true" {...stylex.props(styles.headerMark)}>
                <Icon icon={mark} />
              </span>
            )}
            <span {...stylex.props(styles.headerName)}>{name}</span>
            <Icon icon={listing ? ChevronDown : ChevronRight} />
          </button>
          {listing ? (
            <ModelList
              id={listId}
              models={models}
              makers={makers}
              chosen={current?.value}
              label={modelLabel}
              onPick={(value) => {
                onModelChange(value);
                back();
              }}
            />
          ) : (
            <EffortPart
              levels={levels}
              value={at === -1 ? (levels[0]?.value ?? "") : effort}
              onValueChange={onEffortChange}
              label={effortLabel}
              noneLabel={noEffortLabel}
              look={effortLook}
            />
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
};
