// OwnerPicker: choose the person who owns something, a task, a report, a deal, by typing a few
// letters of their name. The product's own part, on UI SDK's Combobox and made of the finished
// ones: closed, it is the Combobox's Input with the owner's Avatar at its start; open, it is the
// popup the Combobox and Select share, each person with their avatar and a muted line (a role or
// an email) that a search also finds.
//
//   <Field>
//     <FieldLabel>Owner</FieldLabel>
//     <OwnerPicker people={team} defaultValue="amara" />
//   </Field>
//
// The people are data, so an agent can choose one by name, and is refused anyone not in the list.
// Every value is a token (src/tokens).
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import type { ChangeDetails } from "@ui-sdk/core";
import {
  Combobox as ComboboxPrimitive,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxList,
  ComboboxTrigger,
  ComboboxValueIcon,
} from "@ui-sdk/react/combobox";
import type {
  ComboboxInputState,
  ComboboxTriggerState,
  ComboboxQueryChangeReason,
  ComboboxValueChangeReason,
  ListData,
  ListItem,
} from "@ui-sdk/react/combobox";
import { useId, useRef, useState } from "react";

import { Avatar, AvatarImage, AvatarFallback } from "../avatar";
import { listStyles } from "../combobox/list.styles";
import { PersonOption } from "../combobox/person-option";
import { focus } from "../focus/focus";
import { ChevronDown, Icon, People } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import {
  inputStyles,
  isInvalid,
  sizeStyles,
  targetStyles,
} from "../input/input";
import type { InputLayoutStyle } from "../input/input";
import { originFrom, pressedJustNow } from "../motion/origin";
import { simply } from "../motion/simply.stylex";
import { scroll } from "../scroll/scroll";
import { grasp, media } from "../tokens/tokens.stylex";
import { popup } from "../tokens/tokens.values";
import { useWords, withGiven } from "../words/words";
import { ownerPickerNotices, ownerPickerWords } from "./words";
import type { OwnerPickerWords } from "./words";

/** One person who can own it. */
export interface Owner {
  /** A unique, lasting id: what the form sends ("amara"). */
  id: string;
  /** Their name, as the team knows it ("Amara Okafor"). Typing finds it. */
  name: string;
  /** A line under the name in the list: their role or email. Typing finds it too. */
  detail?: string;
  /** Their picture. Until it loads, and if it fails, their initials show. */
  src?: string;
}

/** Every prop an OwnerPicker takes. */
export interface OwnerPickerProps {
  /** Everyone who can own it, in the order the list shows them. */
  people: readonly Owner[];
  /** The owner's id at first. Leave it out for no owner. A form reset returns here. */
  defaultValue?: string | null;
  /** The owner's id, when you keep it in state. `null` is no owner. Pair it with `onValueChange`. */
  value?: string | null;
  /**
   * Called with the new owner's id, or `null` when the words are emptied, and why it changed.
   * `details.source` is `"agent"` when an agent chose.
   */
  onValueChange?: (
    id: string | null,
    details: ChangeDetails<ComboboxValueChangeReason>
  ) => void;
  /**
   * What it says while no one owns it.
   * @default "Choose an owner"
   */
  placeholder?: string;
  /**
   * What the list says when no one's name matches.
   * @default "No one has that name"
   */
  empty?: string;
  /** The name of the button that opens the list of people. @default "Show the people" */
  triggerLabel?: string;
  /**
   * This instance's own words, over the catalogue's (GraspWords), key by key (`{ trigger: "Show the team" }`). Any left out
   * are the catalogue's, else English. A flat text prop given beside it still wins until the
   * release's step 5.
   */
  words?: Partial<OwnerPickerWords>;
  /** The name the id is sent under in a form. Inside a Field, the Field's `name` serves. */
  name?: string;
  /** Needs an owner before the form is sent. @default false */
  required?: boolean;
  /** Shows the owner and is sent, but does not open. @default false */
  readOnly?: boolean;
  /** Out of use: not focusable, not sent, half strength. @default false */
  disabled?: boolean;
  /** Its name when no FieldLabel names it ("Owner"). */
  "aria-label"?: string;
  /** @deprecated Use `layout`. */
  style?: InputLayoutStyle;
  /** Layout only: margins, alignment and width. */
  layout?: InputLayoutStyle;
}

const HOVER = media.hover;
const COARSE = media.coarse;

const styles = stylex.create({
  // The words start after the avatar, and stop before the chevron.
  // The avatar and the name stand where the list's do under them: in by the list's own padding and
  // its rows' inset, so the field and its rows share one start edge.
  input: {
    paddingInlineStart: `calc(${grasp.popupPadding} + ${grasp.space2} + ${grasp.avatarXs} + ${grasp.space2})`,
    paddingInlineEnd: `calc(${grasp.space2} + ${grasp.iconSm} + ${grasp.space2})`,
  },
  // The owner's avatar, or a quiet icon while there is none, at the start of the input.
  start: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    position: "absolute",
    zIndex: 1,
    insetBlock: 0,
    insetInlineStart: `calc(${grasp.popupPadding} + ${grasp.space2})`,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: grasp.avatarXs,
    color: grasp.muted,
    pointerEvents: "none",
  },
  // UI SDK's value icon: the chosen person's avatar from the list, over the quiet icon, so it is
  // always the real owner, after a reset, Escape or an agent's change too.
  value: {
    position: "absolute",
    zIndex: 1,
    insetBlock: 0,
    insetInlineStart: `calc(${grasp.popupPadding} + ${grasp.space2})`,
    display: "flex",
    alignItems: "center",
    pointerEvents: "none",
  },
  valueSearching: { visibility: "hidden" },
  trigger: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    position: "absolute",
    zIndex: 1,
    insetBlock: 0,
    insetInlineEnd: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    width: `calc(${grasp.space2} * 2 + ${grasp.iconSm})`,
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: {
      default: grasp.muted,
      ":hover": { default: null, [HOVER]: grasp.ink },
    },
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
    touchAction: "manipulation",
    transitionProperty: "color",
    transitionDuration: grasp.durationHover,
    transitionTimingFunction: grasp.ease,
  },
  triggerTarget: {
    position: "absolute",
    insetBlock: {
      default: 0,
      [COARSE]: `min(0px, calc((100% - ${grasp.tap}) / 2))`,
    },
    insetInline: {
      default: 0,
      [COARSE]: `min(0px, calc((100% - ${grasp.tap}) / 2))`,
    },
  },
  triggerOff: { cursor: "default", pointerEvents: "none" },
  chevron: {
    display: "inline-flex",
    transitionProperty: "transform",
    // With reduced motion it simply turns.
    transitionDuration: simply.leave,
    transitionTimingFunction: grasp.ease,
  },
  chevronOpen: { transform: "rotate(0.5turn)", transitionDuration: simply.ui },
  content: { minWidth: "var(--anchor-width)" },
  // A person in the list: avatar, name over their line, the tick at the end.
});

const className = (...parts: (stylex.StyleXStyles | false)[]) =>
  stylex.props(...parts).className;

// Whether a person has a line about them to show and to search by.
const hasDetail = (person: Owner): person is Owner & { detail: string } =>
  person.detail !== undefined && person.detail !== "";

// The value of one entry in the list: every item here is a person's id.
const valueOf = (entry: unknown): string | undefined =>
  typeof entry === "object" &&
  entry !== null &&
  "value" in entry &&
  typeof entry.value === "string"
    ? entry.value
    : undefined;

/** Choose the person who owns something, by typing a few letters of their name. */
export const OwnerPicker = ({
  people,
  value: given,
  defaultValue = null,
  onValueChange,
  placeholder: placeholderGiven,
  empty: emptyGiven,
  triggerLabel: triggerLabelGiven,
  words,
  style: styleProp,
  layout,
  "aria-label": ariaLabel,
  ...options
}: OwnerPickerProps) => {
  // Opened by a press on the chevron, the list grows from that button; by typing, from the field.
  const chevron = useRef<HTMLButtonElement>(null);
  const pressedAt = useRef(0);
  const fromChevron = originFrom(() =>
    pressedJustNow(pressedAt.current) ? chevron.current : null
  );
  const {
    placeholder,
    empty,
    trigger: triggerLabel,
  } = withGiven(useWords("ownerPicker", ownerPickerWords, words), {
    placeholder: placeholderGiven,
    empty: emptyGiven,
    trigger: triggerLabelGiven,
  });
  // The React Compiler keeps these between renders while `people` stays the same.
  const byId = new Map(people.map((person) => [person.id, person]));
  const items: ListData = people.map((person): ListItem => ({
    value: person.id,
    label: person.name,
    keywords: hasDetail(person) ? [person.detail] : undefined,
  }));
  const ids = useId();
  // UI SDK's value icon fills in once the list has been open, so until then the owner's avatar is
  // drawn from a mirror of the value, under it. The mirror follows only changes that went through.
  const [mirror, setMirror] = useState<string | null>(defaultValue);
  const shown = given === undefined ? mirror : given;
  const owner = shown !== null && shown !== "" ? byId.get(shown) : undefined;
  // While the words typed are a search, not the owner's name, the owner's avatar steps aside for
  // the quiet icon: the picture never claims the words are theirs.
  const [searching, setSearching] = useState(false);

  const change = (
    next: string | null,
    details: ChangeDetails<ComboboxValueChangeReason>
  ) => {
    // Only someone in the list can own it: anyone else is refused, and an agent hears why.
    if (next !== null && !byId.has(next)) {
      details.cancel();
      if (details.source === "agent") {
        throw new Error(ownerPickerNotices.notOwner(next));
      }
      return;
    }
    onValueChange?.(next, details);
    if (!details.canceled) {
      setMirror(next);
    }
  };

  return (
    <ComboboxPrimitive
      items={items}
      autoHighlight="always"
      {...options}
      {...(given === undefined ? { defaultValue } : { value: given })}
      onValueChange={change}
      onQueryChange={(
        query: string,
        details: ChangeDetails<ComboboxQueryChangeReason>
      ) => {
        setSearching(
          details.reason === "input-change" &&
            query !== "" &&
            query !== owner?.name
        );
      }}
    >
      <div {...stylex.props(inputStyles.box, layout ?? styleProp)}>
        <span
          aria-hidden="true"
          {...stylex.props(inputStyles.target, targetStyles.md)}
        />
        <span aria-hidden="true" {...stylex.props(styles.start)}>
          {owner && !searching ? (
            <Avatar name={owner.name} size="xs" decorative>
              <AvatarImage src={owner.src} />
              <AvatarFallback />
            </Avatar>
          ) : (
            <Icon icon={People} />
          )}
        </span>
        <ComboboxValueIcon
          aria-hidden="true"
          {...stylex.props(styles.value, searching && styles.valueSearching)}
        />
        <ComboboxInput
          aria-label={ariaLabel}
          placeholder={placeholder}
          render={(
            props: Record<string, unknown>,
            state: ComboboxInputState
          ) => (
            <input
              {...props}
              {...stylex.props(
                inputStyles.input,
                sizeStyles.md,
                styles.input,
                !(state.disabled || state.readOnly) && inputStyles.live,
                state.readOnly && inputStyles.readOnly,
                state.disabled && inputStyles.disabled,
                isInvalid(props["aria-invalid"]) && inputStyles.invalid,
                focus.field
              )}
            />
          )}
        />
        <ComboboxTrigger
          ref={chevron}
          onPointerDown={(event) => {
            pressedAt.current =
              Date.now() - (performance.now() - event.timeStamp);
          }}
          aria-label={triggerLabel}
          className={(state: ComboboxTriggerState) =>
            className(
              styles.trigger,
              (state.disabled || state.readOnly) && styles.triggerOff
            )
          }
        >
          {(state: ComboboxTriggerState) => (
            <>
              <span
                aria-hidden="true"
                {...stylex.props(styles.triggerTarget)}
              />
              <span
                aria-hidden="true"
                {...stylex.props(
                  styles.chevron,
                  state.open && styles.chevronOpen
                )}
              >
                <Icon icon={ChevronDown} />
              </span>
            </>
          )}
        </ComboboxTrigger>
      </div>
      <ComboboxContent
        ref={fromChevron}
        sideOffset={popup.gap}
        collisionPadding={popup.gutter}
        {...stylex.props(listStyles.popup, styles.content, scroll.bar)}
      >
        <ComboboxEmpty {...stylex.props(listStyles.empty)}>
          {empty}
        </ComboboxEmpty>
        <ComboboxList>
          {(state: { items: ListData<unknown> }) =>
            state.items.map((entry) => {
              const id = valueOf(entry);
              const person = id === undefined ? undefined : byId.get(id);
              if (!person) {
                return null;
              }
              return (
                <PersonOption
                  key={person.id}
                  value={person.id}
                  name={person.name}
                  src={person.src}
                  line={person.detail}
                  lineId={`${ids}-${person.id}`}
                  keywords={hasDetail(person) ? [person.detail] : undefined}
                />
              );
            })
          }
        </ComboboxList>
      </ComboboxContent>
    </ComboboxPrimitive>
  );
};
