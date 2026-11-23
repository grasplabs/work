// Accordion: a set of sections, each opened from its heading, in StyleX, built
// on UI SDK's Accordion: a quiet full-width trigger for each heading, 8px
// apart, its chevron at the end.
// Adapted from shadcn/ui (MIT), see THIRD_PARTY_NOTICES.md.
//
//   <Accordion>
//     <AccordionItem value="security">
//       <AccordionTrigger>How is our data kept safe?</AccordionTrigger>
//       <AccordionContent>…</AccordionContent>
//     </AccordionItem>
//   </Accordion>
//
// Each heading is a real heading (h3 unless `headingLevel` says otherwise) holding a button: Tab
// moves between them, Enter or Space opens one, and each open panel is a region named by its
// heading. One section is open at a time unless `multiple`. UI SDK names the parts' data-slot
// (accordion, accordion-item, accordion-header, accordion-trigger); the panel's is set here. Every
// value is a token.
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  Accordion as AccordionPrimitive,
  AccordionHeader,
  AccordionItem as AccordionItemPrimitive,
  AccordionPanel,
  AccordionTrigger as AccordionTriggerPrimitive,
} from "@ui-sdk/react/accordion";
import type { AccordionTriggerState } from "@ui-sdk/react/accordion";
import { createContext, createElement, use } from "react";
import type { ReactNode } from "react";

import { ChevronDownIcon, Icon } from "../lib/icons";
import { disclosureStyles, focusRing, tapTarget } from "../lib/styles";
import { colors, font, media, size, space } from "../lib/tokens.stylex";
import { className } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";

/** Every prop an Accordion takes. */
export interface AccordionProps {
  /** Its sections: an AccordionItem each, in order. */
  children: ReactNode;
  /** The open sections' values. Pass it with `onValueChange` to control them. */
  value?: string[];
  /** The sections open at first, when you do not control them. */
  defaultValue?: string[];
  /** Runs with the open sections' values when a heading is pressed. */
  onValueChange?: (value: string[]) => void;
  /**
   * Several sections can be open at once. Without it, opening one closes the other.
   * @default false
   */
  multiple?: boolean;
  /**
   * No section opens or closes; the headings stay focusable.
   * @default false
   */
  disabled?: boolean;
  /**
   * The headings' level, to fit the page's outline.
   * @default 3
   */
  headingLevel?: 2 | 3 | 4 | 5 | 6;
  /** Where it sits and how wide it is. */
  style?: LayoutStyle;
}

/** Every prop an AccordionItem takes: one section. */
export interface AccordionItemProps {
  /** Its AccordionTrigger, then its AccordionContent. */
  children: ReactNode;
  /** Names the section in the Accordion's `value` and `defaultValue`. */
  value: string;
  /**
   * The section cannot open or close; its heading stays focusable.
   * @default false
   */
  disabled?: boolean;
  /** Layout only: where it sits and how much room it takes. */
  style?: LayoutStyle;
}

/** Every prop an AccordionTrigger takes. */
export interface AccordionTriggerProps {
  /** The heading's words: a question, or what the section is about. */
  children: ReactNode;
  /** Layout only: where it sits and how much room it takes. */
  style?: LayoutStyle;
}

/** Every prop an AccordionContent takes. */
export interface AccordionContentProps {
  /** What opens under the heading. */
  children: ReactNode;
  /** Layout only: where it sits and how much room it takes. */
  style?: LayoutStyle;
}

const COARSE = media.pointerCoarse;

const styles = stylex.create({
  root: {
    display: "grid",
    // On a touch screen the headings stand apart, so their 44px press areas meet and never overlap.
    rowGap: {
      default: space["2"],
      [COARSE]: `calc(${size.tapTarget} - ${size.collapsibleTrigger})`,
    },
    width: "100%",
    minWidth: 0,
    fontFamily: font.sans,
  },
  item: {
    display: "grid",
    minWidth: 0,
  },
  // A grid, so the trigger (a button, which would shrink to its words) runs the full width.
  header: {
    display: "grid",
    margin: 0,
    fontSize: "inherit",
    fontWeight: "inherit",
  },
  // The words in an open panel. No frame: the heading above is enough to hold them. They start
  // where its title does, and stop where its chevron does.
  body: {
    color: colors.foreground,
    overflowWrap: "anywhere",
  },
});

type HeadingLevel = 2 | 3 | 4 | 5 | 6;
// The headings' level and whether every section is out of use, from the Accordion; whether a
// section is, from its item.
const LevelContext = createContext<HeadingLevel>(3);
const DisabledContext = createContext(false);

/** A set of sections, each opened from its heading. */
export const Accordion = ({
  children,
  value,
  defaultValue,
  onValueChange,
  multiple = false,
  disabled = false,
  headingLevel = 3,
  style,
}: AccordionProps) => (
  <AccordionPrimitive
    value={value}
    defaultValue={defaultValue}
    onValueChange={onValueChange}
    multiple={multiple}
    disabled={disabled}
    {...stylex.props(styles.root, style)}
  >
    <LevelContext value={headingLevel}>
      <DisabledContext value={disabled}>{children}</DisabledContext>
    </LevelContext>
  </AccordionPrimitive>
);

/** One section: its heading and what opens under it. */
export const AccordionItem = ({
  children,
  value,
  disabled = false,
  style,
}: AccordionItemProps) => {
  const allDisabled = use(DisabledContext);
  return (
    <AccordionItemPrimitive
      value={value}
      disabled={disabled}
      {...stylex.props(styles.item, style)}
    >
      <DisabledContext value={allDisabled || disabled}>
        {children}
      </DisabledContext>
    </AccordionItemPrimitive>
  );
};

/** The section's heading, a real heading holding the button that opens it. */
export const AccordionTrigger = ({
  children,
  style,
}: AccordionTriggerProps) => {
  const level = use(LevelContext);
  return (
    <AccordionHeader
      render={(props: Record<string, unknown>) =>
        createElement(`h${level}`, props)
      }
      {...stylex.props(styles.header, style)}
    >
      <AccordionTriggerPrimitive
        {...stylex.props(
          disclosureStyles.trigger,
          disclosureStyles.ghost,
          focusRing
        )}
      >
        {(state: AccordionTriggerState) => (
          <>
            <span aria-hidden="true" {...stylex.props(tapTarget)} />
            <span {...stylex.props(disclosureStyles.words)}>{children}</span>
            <span
              aria-hidden="true"
              {...stylex.props(
                disclosureStyles.chevron,
                state.open && disclosureStyles.chevronOpen
              )}
            >
              <Icon icon={ChevronDownIcon} />
            </span>
          </>
        )}
      </AccordionTriggerPrimitive>
    </AccordionHeader>
  );
};

/** What opens under the heading. The browser's find opens it when it holds the words found. */
export const AccordionContent = ({
  children,
  style,
}: AccordionContentProps) => {
  const disabled = use(DisabledContext);
  return (
    // The class only: UI SDK writes the panel's measured height as its own inline style.
    // The slot is set on the element drawn: UI SDK keeps a part's own data-slot over a prop.
    <AccordionPanel
      render={<div data-slot="accordion-content" />}
      hiddenUntilFound={!disabled}
      className={className(
        disclosureStyles.panel,
        disclosureStyles.quiet,
        style
      )}
    >
      <div {...stylex.props(disclosureStyles.body, styles.body)}>
        {children}
      </div>
    </AccordionPanel>
  );
};
