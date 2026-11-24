// Inspector: a side panel that inspects one record, built from data: a head (its icon, its title,
// who and when, its actions), its views as tabs, then sections of rows, facts or words. Built of
// SidePanel, SidePanelSection, IconTile, KeyValueList, Item and Empty, so every measure is theirs.
//
//   <Inspector
//     aria-label="Agent details"
//     icon={UserSparklesIcon}
//     title="Monday briefing"
//     sections={[
//       { id: "triggers", title: "Triggers", onAdd: addTrigger,
//         rows: [{ id: "t1", icon: ClockIcon, name: "Every Monday at 08:00", detail: "Schedule", onRemove: remove }] },
//       { id: "owner", title: "Details", facts: [{ id: "owner", label: "Owner", value: "Mara Jensen" }] },
//     ]}
//   />
//
// A block: install it and edit it. For a layout it cannot say, compose SidePanel yourself.
"use client";

import * as stylex from "@stylexjs/stylex";
import { Fragment, isValidElement } from "react";
import type { ReactElement, ReactNode } from "react";

import { Button } from "../../components/button";
import { Empty, EmptyDescription, EmptyHeader } from "../../components/empty";
import { IconTile } from "../../components/icon-tile";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDetail,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from "../../components/item";
import { KeyValueList } from "../../components/key-value";
import type { KeyValueItem } from "../../components/key-value";
import {
  SidePanel,
  SidePanelContent,
  SidePanelHeader,
  SidePanelSection,
  SidePanelSectionAdd,
  SidePanelText,
} from "../../components/side-panel";
import type { SidePanelView } from "../../components/side-panel";
import { Icon, LockIcon, PlusIcon, TrashIcon } from "../../lib/icons";
import type { IconData } from "../../lib/icons";
import { visuallyHidden } from "../../lib/styles";
import { colors, space } from "../../lib/tokens.stylex";
import type { LayoutStyle } from "../../lib/utils";

/** The words an Inspector says itself: English here; pass the product's as `labels`. */
export interface InspectorLabels {
  /** The button that adds a section's first row. */
  add: string;
  /** An empty section's words, from its title ("Add triggers"). */
  addTo: (label: string) => string;
  /** A fact with no value, for a screen reader. */
  none: string;
  /** A row's remove button, from its name. */
  remove: (name: string) => string;
  /** A long text's open button, from its section's title. */
  showAll: (label: string) => string;
  /** The name of the views' tabs. */
  views: string;
}

const LABELS: InspectorLabels = {
  add: "Add",
  addTo: (label) => `Add ${label.toLowerCase()}`,
  none: "Not set",
  remove: (name) => `Remove ${name}`,
  showAll: (label) => `Show all the ${label.toLowerCase()}`,
  views: "Views",
};

/** One row of a section: a thing of some kind, by name. */
export interface InspectorRow {
  /** A unique, lasting key for the row. */
  id: string;
  /** Its name, on one line ("Every Monday at 08:00"). */
  name: string;
  /** Its kind's icon, from lib/icons. */
  icon?: IconData;
  /** A quiet word or two after its name: its kind, its state ("Schedule"). */
  detail?: ReactNode;
  /** It cannot be changed or removed: why, said by a small lock at its end. It then has no bin and does not open. */
  locked?: string;
  /** Opens it: the whole row is then one button. Not on a locked row. */
  onClick?: () => void;
  /** Removes it: a bin at the row's end. Not on a locked row. */
  onRemove?: () => void;
}

/** One section: a quiet title, one action at its end, one card under it. */
export interface InspectorSection {
  /** A unique, lasting key for the section. */
  id: string;
  /** Its title, a word or two ("Triggers"). */
  title: string;
  /** What the section is for, in a tooltip on the title. */
  description?: string;
  /** The view it stands in, by the view's `value`, when the panel has `views`. */
  view?: string;
  /** Its rows. With none (and no facts, text or content) the card is one row that adds the first. */
  rows?: readonly InspectorRow[];
  /** Facts about the record, a label and a value each; a missing value shows a quiet dash. */
  facts?: readonly KeyValueItem[];
  /** Long words, folded with a fade and a button that opens them. */
  text?: ReactNode;
  /** Anything else in its card: a small form, a chart. */
  content?: ReactNode;
  /** Adds to it: "Add" at the title's end, and the empty card's one row. */
  onAdd?: () => void;
  /** The empty card's words, where "Add" and the title read badly ("Add a trigger"). */
  emptyText?: string;
  /** Another action at the title's end, in place of "Add": a switch, a menu. */
  action?: ReactNode;
}

/** Every prop an Inspector takes. */
export interface InspectorProps {
  /** What the panel is about, as a screen reader names the landmark ("Agent details"). */
  "aria-label": string;
  /** The record's name: the panel's heading. */
  title: string;
  /** One line about it, under its name. */
  description?: ReactNode;
  /**
   * The record's own icon at the head: an icon from lib/icons, drawn on a tinted IconTile, or the
   * element itself (`<IconTile icon={ChartColumnIcon} variant="gradient" />` for the one record a
   * page is about).
   */
  icon?: IconData | ReactElement;
  /** Who and when, a dot between them ("By Amara Okafor", "Updated 18h ago"). */
  meta?: ReactNode[];
  /** The bar's buttons, `sm`, the main one first. */
  actions?: ReactNode;
  /** Shows a close button in the bar, and runs when it is pressed. */
  onClose?: () => void;
  /** Its views, as tabs under the head; each section names its own with `view`. */
  views?: SidePanelView[];
  /** The view shown at first, by its `value`. @default the first view */
  defaultView?: string;
  /** The sections, in order. */
  sections: readonly InspectorSection[];
  /** What the panel says when it has no sections at all ("Nothing is set up yet"). */
  empty?: ReactNode;
  /** On the high lift with the panel's corner. Off inside a Sheet. @default true */
  framed?: boolean;
  /** Its words in the product's language; each one left out keeps its English. */
  labels?: Partial<InspectorLabels>;
  /** Layout only: where it sits and how wide and tall it is. */
  style?: LayoutStyle;
}

const styles = stylex.create({
  root: { display: "flex", flexDirection: "column", minWidth: 0 },
  // The facts at the inset of the rows' words.
  facts: { paddingInline: space.sidePanelPadding },
  none: { color: colors.mutedForeground },
  // The lock after a name: quiet, beside the words.
  mark: { display: "inline-flex", color: colors.subtleForeground },
});

/** A missing value: null, undefined, false or empty words. */
const missing = (value: ReactNode) =>
  value === null || value === undefined || value === false || value === "";

/** The facts, a hairline between them; a missing value a quiet dash that says "Not set". */
const Facts = ({
  facts,
  words,
}: {
  facts: readonly KeyValueItem[];
  words: InspectorLabels;
}) => (
  <div data-slot="inspector-facts" {...stylex.props(styles.facts)}>
    <KeyValueList
      orientation="horizontal"
      divided
      items={facts.map((fact) =>
        missing(fact.value) && fact.loading !== true
          ? {
              ...fact,
              value: (
                <>
                  <span aria-hidden="true" {...stylex.props(styles.none)}>
                    —
                  </span>
                  <span {...stylex.props(visuallyHidden)}>{words.none}</span>
                </>
              ),
            }
          : fact
      )}
    />
  </div>
);

/** One row: its kind's icon, its name, a lock after it where it cannot change, else its bin. */
const Row = ({ row, words }: { row: InspectorRow; words: InspectorLabels }) => {
  // A locked row cannot be changed or taken away: it neither opens nor has a bin.
  const locked = row.locked !== undefined;
  const handleClick = locked ? undefined : row.onClick;
  const handleRemove = locked ? undefined : row.onRemove;
  return (
    <Item size="xs" onClick={handleClick}>
      {row.icon !== undefined && (
        <ItemMedia>
          <Icon icon={row.icon} />
        </ItemMedia>
      )}
      <ItemContent>
        <ItemTitle>
          {row.name}
          {row.locked !== undefined && (
            <span {...stylex.props(styles.mark)}>
              <Icon icon={LockIcon} label={row.locked} />
            </span>
          )}
          <ItemDetail>{row.detail}</ItemDetail>
        </ItemTitle>
      </ItemContent>
      {handleRemove !== undefined && (
        <ItemActions showOnHover>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={words.remove(row.name)}
            onClick={handleRemove}
          >
            <Icon icon={TrashIcon} />
          </Button>
        </ItemActions>
      )}
    </Item>
  );
};

/** A section's rows, as one list named by its title. */
const Rows = ({
  section,
  words,
}: {
  section: InspectorSection;
  words: InspectorLabels;
}) => (
  <ItemGroup aria-label={section.title}>
    {(section.rows ?? []).map((row, index) => (
      <Fragment key={row.id}>
        {index > 0 && <ItemSeparator />}
        <Row row={row} words={words} />
      </Fragment>
    ))}
  </ItemGroup>
);

/** One section: its rows, facts, words or content; empty, one row that adds the first. */
const Section = ({
  section,
  words,
}: {
  section: InspectorSection;
  words: InspectorLabels;
}) => {
  const { rows = [], facts = [], text, content, onAdd: handleAdd } = section;
  if (
    rows.length === 0 &&
    facts.length === 0 &&
    text === undefined &&
    content === undefined
  ) {
    return (
      <SidePanelSection title={section.title} description={section.description}>
        <SidePanelSectionAdd onClick={handleAdd}>
          {section.emptyText ?? words.addTo(section.title)}
        </SidePanelSectionAdd>
      </SidePanelSection>
    );
  }
  const add = handleAdd !== undefined && (
    <Button variant="ghost" size="xs" onClick={handleAdd}>
      <Icon icon={PlusIcon} />
      {words.add}
    </Button>
  );
  return (
    <SidePanelSection
      title={section.title}
      description={section.description}
      action={section.action ?? add}
    >
      {rows.length > 0 && <Rows section={section} words={words} />}
      {rows.length === 0 && facts.length > 0 && (
        <Facts facts={facts} words={words} />
      )}
      {rows.length === 0 && facts.length === 0 && text !== undefined && (
        <SidePanelText aria-label={words.showAll(section.title)}>
          {text}
        </SidePanelText>
      )}
      {rows.length === 0 && facts.length === 0 && text === undefined && content}
    </SidePanelSection>
  );
};

/** The sections of one view, or the whole panel's; with none, the empty state. */
const Sections = ({
  sections,
  empty,
  words,
}: {
  sections: readonly InspectorSection[];
  empty: ReactNode;
  words: InspectorLabels;
}) => {
  if (sections.length === 0) {
    return empty === undefined ? null : (
      <Empty size="sm">
        <EmptyHeader>
          <EmptyDescription>{empty}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return sections.map((section) => (
    <Section key={section.id} section={section} words={words} />
  ));
};

/** A side panel that inspects one record: head, views, sections of rows and facts. */
export const Inspector = ({
  "aria-label": label,
  title,
  description,
  icon,
  meta,
  actions,
  onClose,
  views,
  defaultView,
  sections,
  empty,
  framed,
  labels,
  style,
}: InspectorProps) => {
  const words = { ...LABELS, ...labels };
  const tabs = views ?? [];
  // With nothing under the head and nothing to say about it, the head stands alone.
  const body = sections.length > 0 || empty !== undefined;
  return (
    <div data-slot="inspector" {...stylex.props(styles.root, style)}>
      <SidePanel
        aria-label={label}
        defaultValue={defaultView ?? tabs[0]?.value}
        framed={framed}
      >
        <SidePanelHeader
          icon={
            icon === undefined || isValidElement(icon) ? (
              icon
            ) : (
              <IconTile icon={icon} variant="tinted" />
            )
          }
          title={title}
          description={description}
          meta={meta}
          actions={actions}
          onClose={onClose}
          views={views}
          viewsLabel={words.views}
        />
        {tabs.length > 0
          ? tabs.map((view) => (
              <SidePanelContent key={view.value} value={view.value}>
                <Sections
                  sections={sections.filter(
                    (section) => section.view === view.value
                  )}
                  empty={empty}
                  words={words}
                />
              </SidePanelContent>
            ))
          : body && (
              <SidePanelContent>
                <Sections sections={sections} empty={empty} words={words} />
              </SidePanelContent>
            )}
      </SidePanel>
    </div>
  );
};
