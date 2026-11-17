// ComposerModel: the model picker in a composer's footer (composer.tsx), after Capy's. A quiet
// control shows the current model's maker mark and name. It opens a menu with a search field, a
// narrow rail of makers down its start side (a star for favourites first), and the chosen maker's
// models as plain rows under its name, so a long list stays short and easy to scan. Typing searches
// every maker.
//
// The rail and the list share one step (a 28px row, touching as the rows do), so each row stands level
// with a mark, and the maker's name heads the list in the mark's place: the panel is as tall as the
// taller column, and with as many rows as marks the two end together, with no empty band under the
// rows.
//
//   <ComposerModel models={models} makers={makers} value={model} onValueChange={setModel} />
//
// Maker marks are other companies' logos: the caller passes each as an `icon` (the icons entry (`@/components/grasp/icons`) has the
// brand marks); nothing is drawn here. Every value is a token (src/tokens).
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@ui-sdk/react/command";
import { Popover, PopoverContent, PopoverTrigger } from "@ui-sdk/react/popover";
import { useId, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { focus } from "../focus/focus";
import { visuallyHidden } from "../hidden/hidden";
import { ChevronDown, Icon, Search, Star, Tick } from "../icons";
import type { IconData } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import { popoverStyles } from "../popover/styles";
import { grasp, media } from "../tokens/tokens.stylex";
import { popup } from "../tokens/tokens.values";
import { useComposerDisabled } from "./context";
import { controlStyles } from "./control";
import { stopEscape } from "./escape";
import { useComposerWords } from "./words";

/** One model a person can choose. */
export interface ComposerModelOption {
  /** What `onValueChange` receives. */
  value: string;
  /** Its name ("Opus 5.5"). */
  label: string;
  /** The `value` of its maker in `makers`. */
  maker: string;
  /** What it is good at, in one line: shown under a pointer and to a screen reader. */
  description?: string;
  /** Out of use, with why in `reason`. It shows, dimmed, and cannot be chosen. */
  disabled?: boolean;
  /** Why it is out of use ("Not on this plan"). */
  reason?: string;
}

/** One maker, for the rail. */
export interface ComposerModelMaker {
  /** Matches a model's `maker`. */
  value: string;
  /** Its name ("Anthropic"). */
  label: string;
  /** Its mark, from the icons entry (`@/components/grasp/icons`) (the brand marks). */
  icon?: IconData;
}

/** Every prop a ComposerModel takes. */
export interface ComposerModelProps {
  /** The models, in the order to show them within each maker. */
  models: ComposerModelOption[];
  /** The makers, in the rail's order. */
  makers: ComposerModelMaker[];
  /** The chosen model's `value`. */
  value: string;
  /** Called with the model chosen. */
  onValueChange: (value: string) => void;
  /** Models to list under the star at the top of the rail. Without them there is no star. */
  favourites?: string[];
  /**
   * The control's name for a screen reader, before the model's own name.
   * @default "Model"
   */
  "aria-label"?: string;
  /** @deprecated Use `aria-label`. */
  label?: string;
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
  /** A row at the top of a maker's list, such as a Connect action for linking an account. */
  connect?: Record<string, ReactNode>;
}

const FAVOURITES = "\u0000favourites";

const styles = stylex.create({
  panel: {
    width: `min(${grasp.modelMenuWidth}, 100vw - 2 * ${grasp.popupGutter})`,
    maxHeight: `min(${grasp.popupHeight}, var(--available-height, ${grasp.popupHeight}))`,
    overflow: "hidden",
    transformOrigin: "var(--transform-origin)",
  },
  command: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    display: "grid",
    gridTemplateRows: "auto minmax(0, 1fr)",
    minHeight: 0,
    maxHeight: "inherit",
  },
  search: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    paddingInline: grasp.space3,
    minHeight: grasp.controlMd,
    borderBlockEndWidth: grasp.hairline,
    borderBlockEndStyle: "solid",
    borderBlockEndColor: grasp.line,
    color: grasp.muted,
  },
  input: {
    flexGrow: 1,
    minWidth: 0,
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    outline: "none",
    color: grasp.ink,
    fontFamily: grasp.fontSans,
    fontSize: { default: grasp.textSm, [media.typing]: grasp.fieldTextTouch },
    lineHeight: grasp.textSmLine,
    "::placeholder": { color: grasp.muted, opacity: 1 },
  },
  body: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr)",
    minHeight: 0,
  },
  // The same step as the list's rows (28px, touching as the rows do), so each mark stands level with a row.
  rail: {
    display: "grid",
    alignContent: "start",
    gap: 0,
    padding: grasp.space1,
    borderInlineEndWidth: grasp.hairline,
    borderInlineEndStyle: "solid",
    borderInlineEndColor: grasp.line,
    overflowY: "auto",
  },
  maker: {
    position: "relative",
    display: "grid",
    placeItems: "center",
    width: grasp.controlXs,
    height: grasp.controlXs,
    margin: 0,
    padding: 0,
    borderWidth: 0,
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlXs} / 2))`,
    cornerShape: grasp.cornerShape,
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [media.hover]: grasp.ghostFillHover },
      ":is([aria-pressed=true])": grasp.itemFillHighlight,
    },
    color: { default: grasp.muted, ":is([aria-pressed=true])": grasp.ink },
    cursor: "pointer",
  },
  list: {
    display: "grid",
    alignContent: "start",
    gap: 0,
    padding: grasp.space1,
    overflowY: "auto",
    overscrollBehavior: "contain",
  },
  // The chosen maker's name, quiet, at the top of the list in the first mark's row.
  heading: {
    display: "flex",
    alignItems: "center",
    boxSizing: "border-box",
    minHeight: grasp.controlXs,
    paddingInline: grasp.space2,
    color: grasp.muted,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    userSelect: "none",
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    minHeight: { default: grasp.controlXs, [media.coarse]: grasp.tap },
    paddingInline: grasp.space2,
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlXs} / 2))`,
    cornerShape: grasp.cornerShape,
    color: grasp.ink,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    cursor: "pointer",
    backgroundColor: {
      default: "transparent",
      ":is([data-highlighted])": grasp.itemFillHighlight,
    },
    opacity: { default: 1, ":is([data-disabled])": grasp.dim },
  },
  rowWords: {
    display: "grid",
    flexGrow: 1,
    minWidth: 0,
  },
  rowName: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  rowWhy: {
    color: grasp.muted,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
  },
  tick: {
    display: "flex",
    flexShrink: 0,
  },
  // UI SDK keeps this status in the page and empties it while there are results: no room then.
  empty: {
    display: { default: "block", ":empty": "none" },
    padding: grasp.space3,
    color: grasp.muted,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
  },
  connect: {
    paddingBlock: grasp.space1,
    paddingInline: grasp.space2,
  },
});

const noFavourites: string[] = [];

/** The model picker: a quiet control in the footer and a menu with a rail of makers. */
/** What the list shows: searching looks through every maker; otherwise the rail's choice shows. */
const shownModels = (
  models: ComposerModelOption[],
  favourites: string[],
  rail: string,
  query: string
): ComposerModelOption[] => {
  if (query.trim()) {
    return models;
  }
  if (rail === FAVOURITES) {
    return models.filter((model) => favourites.includes(model.value));
  }
  return models.filter((model) => model.maker === rail);
};

/**
 * The top of the list: the rail's choice by name, and a maker's connect row under it. While
 * searching every maker shows, so neither; under favourites, no connect row.
 */
const listTop = (
  makers: ComposerModelMaker[],
  rail: string,
  query: string,
  favouritesLabel: string,
  connect: Record<string, ReactNode> | undefined
): { heading: string; connectRow: ReactNode } => {
  if (query.trim()) {
    return { heading: "", connectRow: undefined };
  }
  if (rail === FAVOURITES) {
    return { heading: favouritesLabel, connectRow: undefined };
  }
  return {
    heading: makers.find((maker) => maker.value === rail)?.label ?? "",
    connectRow: connect?.[rail],
  };
};

export const ComposerModel = ({
  models,
  makers,
  value,
  onValueChange,
  favourites = noFavourites,
  label: labelDeprecated,
  "aria-label": labelGiven,
  searchLabel: searchGiven,
  makersLabel: makersGiven,
  favouritesLabel: favouritesGiven,
  emptyLabel: emptyGiven,
  connect,
}: ComposerModelProps) => {
  const disabled = useComposerDisabled();
  // Its words: the caller's where given, else the product's catalogue (GraspWords), else English.
  const words = useComposerWords("model");
  const label = labelGiven ?? labelDeprecated ?? words.label;
  const searchLabel = searchGiven ?? words.search;
  const makersLabel = makersGiven ?? words.makers;
  const favouritesLabel = favouritesGiven ?? words.favourites;
  const emptyLabel = emptyGiven ?? words.empty;
  const current = models.find((model) => model.value === value);
  const currentMaker = makers.find((maker) => maker.value === current?.maker);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [rail, setRail] = useState<string>(
    current?.maker ?? makers[0]?.value ?? ""
  );

  // Searching looks through every maker; otherwise the rail's choice shows.
  const shown = shownModels(models, favourites, rail, query);

  const markOf = (maker: string) =>
    makers.find((entry) => entry.value === maker)?.icon;
  // The list's heading: the rail's choice by name. Searching looks through every maker, so none.
  const headingId = useId();
  const { heading, connectRow } = listTop(
    makers,
    rail,
    query,
    favouritesLabel,
    connect
  );

  return (
    <Popover
      open={open}
      onOpenChange={(next: boolean) => {
        setOpen(next);
        if (next) {
          setQuery("");
          setRail(current?.maker ?? makers[0]?.value ?? "");
        }
      }}
    >
      <PopoverTrigger
        disabled={disabled}
        aria-label={`${label}: ${current?.label ?? ""}`}
        render={(props: Record<string, unknown>) => (
          <button
            {...props}
            type="button"
            data-slot="composer-model"
            {...stylex.props(controlStyles.control, focus.ring)}
          >
            <span aria-hidden="true" {...stylex.props(controlStyles.reach)} />
            <span key={value} {...stylex.props(controlStyles.value)}>
              {currentMaker?.icon && <Icon icon={currentMaker.icon} />}
              <span
                {...stylex.props(
                  controlStyles.words,
                  controlStyles.narrowWords
                )}
              >
                {current?.label}
              </span>
            </span>
            <Icon icon={ChevronDown} />
          </button>
        )}
      />
      <PopoverContent
        onKeyDown={(event: KeyboardEvent<HTMLElement>) => {
          // The picker closes on Escape itself, so the Escape can stop here: no listener of the
          // host's on the document hears it and closes more (the product's row 52).
          if (event.key === "Escape") {
            setOpen(false);
          }
          stopEscape(event);
        }}
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
        <Command
          query={query}
          onQueryChange={(next: string) => {
            setQuery(next);
          }}
          onAction={(chosen: string) => {
            onValueChange(chosen);
            setOpen(false);
          }}
          {...stylex.props(styles.command)}
        >
          <div {...stylex.props(styles.search)}>
            <Icon icon={Search} />
            <CommandInput
              aria-label={searchLabel}
              placeholder={searchLabel}
              {...stylex.props(styles.input)}
            />
          </div>
          <div {...stylex.props(styles.body)}>
            <div
              // The comment stands on the line above the role, between the attributes, so a formatter cannot part them.
              // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a <fieldset> brings its own border, padding and min-width
              role="group"
              aria-label={makersLabel}
              {...stylex.props(styles.rail)}
            >
              {favourites.length > 0 && (
                <button
                  type="button"
                  aria-pressed={rail === FAVOURITES && !query.trim()}
                  aria-label={favouritesLabel}
                  onClick={() => {
                    setRail(FAVOURITES);
                    setQuery("");
                  }}
                  {...stylex.props(styles.maker, focus.ring)}
                >
                  <Icon icon={Star} />
                </button>
              )}
              {makers.map((maker) => (
                <button
                  key={maker.value}
                  type="button"
                  aria-pressed={rail === maker.value && !query.trim()}
                  aria-label={maker.label}
                  title={maker.label}
                  onClick={() => {
                    setRail(maker.value);
                    setQuery("");
                  }}
                  {...stylex.props(styles.maker, focus.ring)}
                >
                  {maker.icon === undefined ? (
                    maker.label.slice(0, 1)
                  ) : (
                    <Icon icon={maker.icon} />
                  )}
                </button>
              ))}
            </div>
            <div {...stylex.props(styles.list)}>
              {heading !== "" && (
                <div
                  id={headingId}
                  data-slot="composer-model-heading"
                  {...stylex.props(styles.heading)}
                >
                  {heading}
                </div>
              )}
              {connectRow !== undefined && (
                <div {...stylex.props(styles.connect)}>{connectRow}</div>
              )}
              <CommandEmpty {...stylex.props(styles.empty)}>
                {emptyLabel}
              </CommandEmpty>
              <CommandList
                aria-labelledby={heading === "" ? undefined : headingId}
              >
                {shown.map((model) => {
                  const mark = markOf(model.maker);
                  return (
                    <CommandItem
                      key={model.value}
                      value={model.value}
                      label={model.label}
                      disabled={model.disabled}
                      {...stylex.props(styles.row)}
                    >
                      {mark && <Icon icon={mark} />}
                      <span {...stylex.props(styles.rowWords)}>
                        <span {...stylex.props(styles.rowName)}>
                          {model.label}
                        </span>
                        {model.disabled === true &&
                          model.reason !== undefined &&
                          model.reason !== "" && (
                            <span {...stylex.props(styles.rowWhy)}>
                              {model.reason}
                            </span>
                          )}
                        {model.description !== undefined &&
                          model.description !== "" && (
                            <span {...stylex.props(visuallyHidden)}>
                              {model.description}
                            </span>
                          )}
                      </span>
                      {model.value === value && (
                        <span aria-hidden="true" {...stylex.props(styles.tick)}>
                          <Icon icon={Tick} />
                        </span>
                      )}
                    </CommandItem>
                  );
                })}
              </CommandList>
            </div>
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  );
};
