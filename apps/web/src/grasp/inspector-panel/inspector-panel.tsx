"use client";

import { IconTile } from "../icon-tile";
/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import { Icon, Lock, Plus, Trash } from "../icons";
import { Panel, PanelHeader, PanelText, PanelView } from "../panel";
import { PanelSection } from "../panel-section";
import { RowList, RowListAction, RowListItem } from "../row-list";
import { useWords, withGiven } from "../words/words";
import type {
  InspectorPanelProps,
  InspectorPanelWords,
  InspectorRow,
  InspectorSection,
} from "./types";
import { englishWords } from "./words";

export { englishWords } from "./words";

const noSections: readonly InspectorSection[] = [];
const noRows: readonly InspectorRow[] = [];

/** One row: its kind's icon, its name, a lock where it cannot change, and its bin. */
const Row = ({
  row,
  words,
}: {
  row: InspectorRow;
  words: InspectorPanelWords;
}) => {
  const { onPress: handlePress, onRemove: handleRemove } = row;
  return (
    <RowListItem
      icon={row.icon}
      name={row.name}
      detail={row.detail}
      fresh={row.fresh}
      onPress={handlePress}
      mark={
        row.locked === undefined ? undefined : (
          <Icon icon={Lock} label={row.locked} />
        )
      }
      actions={
        handleRemove === undefined ? undefined : (
          <RowListAction
            icon={Trash}
            aria-label={words.remove(row.name)}
            onPress={handleRemove}
          />
        )
      }
    />
  );
};

/** Whether a section's card holds anything: rows, long words, or what the caller gave. */
const holds = (section: InspectorSection) =>
  (section.rows !== undefined && section.rows.length > 0) ||
  section.text !== undefined ||
  section.content !== undefined;

/** A section's rows, as one list named for the section. */
const Rows = ({
  section,
  words,
}: {
  section: InspectorSection;
  words: InspectorPanelWords;
}) => (
  <RowList aria-label={section.label}>
    {(section.rows ?? noRows).map((row) => (
      <Row key={row.id} row={row} words={words} />
    ))}
  </RowList>
);

/** One section: with something in its card, or empty as one row that adds the first. */
const Section = ({
  section,
  words,
}: {
  section: InspectorSection;
  words: InspectorPanelWords;
}) => {
  const { onAdd: handleAdd } = section;
  if (!holds(section)) {
    return (
      <PanelSection
        label={section.label}
        hint={section.hint}
        empty={section.addLabel ?? words.addTo(section.label)}
        onAdd={handleAdd}
      />
    );
  }
  const hasRows = section.rows !== undefined && section.rows.length > 0;
  // Long words fold with a fade and an expand button; anything else stands in the card as given.
  const other =
    section.text === undefined ? (
      section.content
    ) : (
      <PanelText openLabel={words.showAll(section.label)}>
        {section.text}
      </PanelText>
    );
  const add =
    handleAdd === undefined ? undefined : (
      <RowListAction icon={Plus} onPress={handleAdd}>
        {words.add}
      </RowListAction>
    );
  return (
    <PanelSection
      label={section.label}
      hint={section.hint}
      action={section.action ?? add}
    >
      {hasRows ? <Rows section={section} words={words} /> : other}
    </PanelSection>
  );
};

const Sections = ({
  sections,
  words,
}: {
  sections: readonly InspectorSection[];
  words: InspectorPanelWords;
}) =>
  sections.map((section) => (
    <Section key={section.id} section={section} words={words} />
  ));

/** Its name by its new name, else its deprecated old one (the breaking release's step 1). */
const nameOf = (props: { "aria-label"?: string; label?: string }) =>
  props["aria-label"] ?? props.label ?? "";

/** The panel beside a page that says what a thing is and what it is made of. */
export const InspectorPanel = (props: InspectorPanelProps) => {
  const { title, icon, views, sections, framed = true } = props;
  const label = nameOf(props);
  // Its words: the product's, by its catalogue, else English; the caller's `words` still win.
  const words = withGiven(
    useWords("inspectorPanel", englishWords),
    props.words ?? {}
  );
  const tile =
    icon === undefined ? undefined : (
      <IconTile
        icon={icon}
        variant={props.iconLook ?? "tint"}
        running={props.running === true}
      />
    );
  return (
    <Panel
      aria-label={label}
      defaultView={props.defaultView ?? views?.[0]?.value}
      view={props.view}
      onViewChange={props.onViewChange}
      framed={framed}
      layout={props.layout ?? props.style}
    >
      <PanelHeader
        icon={tile}
        title={title}
        description={props.description}
        meta={props.meta}
        actions={props.actions}
        onClose={props.onClose}
        closeLabel={words.close}
        views={views?.map(({ value, label: name, icon: mark }) => ({
          value,
          label: name,
          icon: mark,
        }))}
        viewsLabel={words.views}
        texture={props.texture === true}
      />
      {views === undefined ? (
        <PanelView>
          <Sections sections={sections ?? noSections} words={words} />
          {props.foot}
        </PanelView>
      ) : (
        views.map((view) => (
          <PanelView key={view.value} value={view.value}>
            <Sections sections={view.sections} words={words} />
            {view.foot}
          </PanelView>
        ))
      )}
    </Panel>
  );
};
