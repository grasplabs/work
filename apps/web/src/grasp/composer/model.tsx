// ComposerModel: the model picker in a composer's footer (composer.tsx), after Capy's. A quiet
// control shows the current model's maker mark and name. It opens a menu with a search field, a
// narrow rail of makers down its start side (a star for favourites first), and the chosen maker's
// models as plain rows, so a long list stays short and easy to scan. Typing searches every maker.
//
//   <ComposerModel models={models} makers={makers} value={model} onValueChange={setModel} />
//
// Maker marks are other companies' logos: the caller passes each as an `icon` (src/icons has the
// brand marks); nothing is drawn here. Every value is a token (src/tokens).
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@ui-sdk/react/command";
import { Popover, PopoverContent, PopoverTrigger } from "@ui-sdk/react/popover";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";

import { focus } from "../focus/focus";
import { ChevronDown, Icon, Search, Star, Tick } from "../icons";
import type { IconData } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import { popoverStyles } from "../popover/styles";
import { grasp, media } from "../tokens/tokens.stylex";
import { popup } from "../tokens/tokens.values";
import { useComposerDisabled } from "./context";
import { controlStyles } from "./control";

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
  /** Its mark, from src/icons (the brand marks). */
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
  label?: string;
  /**
   * The search field's name and placeholder.
   * @default "Search models"
   */
  searchLabel?: string;
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
    fontSize: { default: grasp.textSm, [media.coarse]: grasp.fieldTextTouch },
    lineHeight: grasp.textSmLine,
    "::placeholder": { color: grasp.muted, opacity: 1 },
  },
  body: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr)",
    minHeight: 0,
  },
  rail: {
    display: "grid",
    alignContent: "start",
    gap: grasp.space1,
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
    gap: grasp.hairline,
    padding: grasp.space1,
    overflowY: "auto",
    overscrollBehavior: "contain",
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
  unseen: {
    position: "absolute",
    width: grasp.hairline,
    height: grasp.hairline,
    margin: 0,
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
  },
});

const noFavourites: string[] = [];

/** The model picker: a quiet control in the footer and a menu with a rail of makers. */
export const ComposerModel = ({
  models,
  makers,
  value,
  onValueChange,
  favourites = noFavourites,
  label = "Model",
  searchLabel = "Search models",
  favouritesLabel = "Favourites",
  emptyLabel = "No models found",
  connect,
}: ComposerModelProps) => {
  const disabled = useComposerDisabled();
  const current = models.find((model) => model.value === value);
  const currentMaker = makers.find((maker) => maker.value === current?.maker);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [rail, setRail] = useState<string>(
    current?.maker ?? makers[0]?.value ?? ""
  );

  // Searching looks through every maker; otherwise the rail's choice shows.
  const shown = useMemo(() => {
    if (query.trim()) {
      return models;
    }
    if (rail === FAVOURITES) {
      return models.filter((model) => favourites.includes(model.value));
    }
    return models.filter((model) => model.maker === rail);
  }, [models, favourites, rail, query]);

  const markOf = (maker: string) =>
    makers.find((entry) => entry.value === maker)?.icon;

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
              // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a <fieldset> brings its own border, padding and min-width
              role="group"
              aria-label="Makers"
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
              {!query.trim() &&
                rail !== FAVOURITES &&
                connect?.[rail] !== undefined && (
                  <div {...stylex.props(styles.connect)}>{connect[rail]}</div>
                )}
              <CommandEmpty {...stylex.props(styles.empty)}>
                {emptyLabel}
              </CommandEmpty>
              <CommandList>
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
                            <span {...stylex.props(styles.unseen)}>
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
