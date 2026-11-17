// ComposerModelEffort: the model and how hard it thinks, as one quiet control in a composer's
// footer (composer.tsx). The chip shows the model's mark and name, and its effort as a scale of
// dots. It opens one surface, effort first: the model as a row at its top, which opens the list
// of models in its place, and under it the effort, a slider of the model's own levels. A model with
// fewer levels has fewer stops; a model with none says so instead of a slider. At the strongest
// level (a level's `top`) the light runs round the chip, as ComposerReasoning's does.
//
//   <ComposerModelEffort models={models} makers={makers} model={model} onModelChange={setModel}
//     effort={effort} onEffortChange={setEffort} />
//
// ComposerModel and ComposerReasoning stay for a host that wants them apart: a long list of makers
// to search, or effort that is not the model's. Every value is a token (src/tokens).
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { Popover, PopoverContent, PopoverTrigger } from "@ui-sdk/react/popover";
import { useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

import { focus } from "../focus/focus";
import { ChevronDown, ChevronRight, Icon, Tick } from "../icons";
import type { IconData } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import { popoverStyles } from "../popover/styles";
import { grasp, media } from "../tokens/tokens.stylex";
import { popup } from "../tokens/tokens.values";
import { useComposerDisabled } from "./context";
import { controlStyles } from "./control";
import { ComposerEffort } from "./effort";
import { stopEscape } from "./escape";
import type { ComposerModelMaker, ComposerModelOption } from "./model";
import { LitEdge, Scale } from "./reasoning";
import type { ComposerReasoningOption } from "./reasoning";

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
  effort: {
    display: "grid",
    minWidth: 0,
    paddingInline: grasp.space2,
    paddingBlockStart: grasp.space1,
    borderBlockStartWidth: grasp.hairline,
    borderBlockStartStyle: "solid",
    borderBlockStartColor: grasp.line,
  },
  none: {
    margin: 0,
    paddingBlock: grasp.space2,
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

/** The chip: the model's mark and name, its effort's scale, and the light round it at the top level. */
const Chip = ({
  props,
  mark,
  name,
  at,
  count,
  lit,
  value,
}: {
  props: Record<string, unknown>;
  mark: IconData | undefined;
  name: string;
  at: number;
  count: number;
  lit: boolean;
  value: string;
}) => (
  <button
    {...props}
    type="button"
    data-slot="composer-model-effort"
    data-top={lit || undefined}
    {...stylex.props(controlStyles.control, focus.ring, lit && styles.lit)}
  >
    <span aria-hidden="true" {...stylex.props(controlStyles.reach)} />
    {lit ? <LitEdge /> : null}
    <span key={value} {...stylex.props(controlStyles.value)}>
      {mark === undefined ? null : <Icon icon={mark} />}
      <span {...stylex.props(controlStyles.words, controlStyles.narrowWords)}>
        {name}
      </span>
      {count > 1 && at !== -1 ? <Scale at={at} count={count} /> : null}
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
    said:
      levels.length > 1 && level !== undefined
        ? `${name}, ${level.label}`
        : name,
  };
};

/** The effort: its slider, or, for a model with one level, a line that says so. */
const EffortPart = ({
  levels,
  value,
  onValueChange,
  label,
  noneLabel,
}: {
  levels: ComposerReasoningOption[];
  value: string;
  onValueChange: (value: string) => void;
  label: string;
  noneLabel: string;
}) => (
  <div {...stylex.props(styles.effort)}>
    {levels.length > 1 ? (
      <ComposerEffort
        levels={levels}
        value={value}
        onValueChange={onValueChange}
        label={label}
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
  "aria-label": label = labelDeprecated ?? "Model and effort",
  modelLabel = "Model",
  effortLabel = "Effort",
  noEffortLabel = "This model has one level of effort.",
}: ComposerModelEffortProps) => {
  const disabled = useComposerDisabled();
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState(false);
  const header = useRef<HTMLButtonElement | null>(null);
  const listId = useId();
  const { current, name, mark, levels, at, lit, said } = readChoice(
    models,
    makers,
    model,
    effort
  );

  const back = () => {
    setListing(false);
    header.current?.focus();
  };

  // One Escape does one thing: with the list open it goes back to the effort; otherwise it closes
  // the surface. Either way no listener of the host's hears it.
  const keys = (event: KeyboardEvent<HTMLElement>) => {
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
        render={(props: Record<string, unknown>) => (
          <Chip
            props={props}
            mark={mark}
            name={name}
            at={at}
            count={levels.length}
            lit={lit}
            value={`${model} ${effort}`}
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
            />
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
};
