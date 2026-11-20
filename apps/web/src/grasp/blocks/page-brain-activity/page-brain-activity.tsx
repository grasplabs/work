"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

import { Button } from "../../button";
import { Alert, Icon, Note } from "../../icons";
import type { IconData } from "../../icons";
import { InspectorPanel } from "../../inspector-panel";
import { PageColumn } from "../../page-column";
import { PageHeader } from "../../page-header";
import { PanelSection } from "../../panel-section";
import { RowList, RowListItem } from "../../row-list";
import { grasp } from "../../tokens/tokens.stylex";

/** One thing that came in: a document, a connection's scan, a week of interviews, a question. */
export interface BrainActivityLine {
  id: string;
  /** Its kind's icon. */
  icon: IconData;
  name: string;
  /** Quiet, at the end: when it came in, or how. */
  detail?: string;
}

/** A stretch of the log, under its own label. */
export interface BrainActivityGroup {
  id: string;
  label: string;
  lines: readonly BrainActivityLine[];
  /** How many more lines the host has for it: "Show 12 more" stands under its rows, and calls `onMore` with its id. */
  more?: number;
}

export interface PageBrainActivityProps {
  /** One sentence under the title: when the reader last looked, and what came in since. */
  description?: string;
  /**
   * The activity could not load, or not all of it: said in the description's place, in the danger
   * colour after the Alert mark, and read out at once.
   */
  error?: string;
  /** New since the reader last looked. Without any, the section is left out. */
  fresh?: readonly BrainActivityLine[];
  /** Questions waiting for an answer, each with the role it waits on as its detail. Without any, the section is left out. */
  waiting?: readonly BrainActivityLine[];
  /** How many more new lines the host has: "Show 4 more" under them calls `onMore` with "fresh". */
  freshMore?: number;
  /** How many more waiting questions the host has: "Show 4 more" under them calls `onMore` with "waiting". */
  waitingMore?: number;
  /** The rest of the log, newest first. */
  groups: readonly BrainActivityGroup[];
  /** Opens a line: the host shows it in BrainActivityInspector. */
  onOpen: (id: string) => void;
  /**
   * The line open in the inspector, by id. When it goes back to none (the inspector closed), focus
   * goes to that line's row, so the reader is where they were.
   */
  open?: string;
  /**
   * "Show more" was pressed under a section: "fresh", "waiting" or a group's id. The host adds the
   * lines and lowers its count; focus goes to the first line it brought.
   */
  onMore?: (section: string) => void;
  /** The page's own words, in another language. */
  words?: Partial<PageBrainActivityWords>;
}

/** Every word the page and its inspector show beyond the host's own, so a product can translate them. */
export interface PageBrainActivityWords {
  title: string;
  fresh: string;
  waiting: string;
  kept: string;
  changed: string;
  /** Under a section the host has more of. */
  showMore: (count: number) => string;
}

export const pageBrainActivityWords: PageBrainActivityWords = {
  title: "Activity",
  fresh: "Since you last looked",
  waiting: "Waiting for an answer",
  kept: "What the brain kept",
  changed: "Pages it changed",
  showMore: (count) => `Show ${String(count)} more`,
};

const styles = stylex.create({
  page: { paddingBlock: grasp.space8 },
  kept: {
    display: "grid",
    gap: grasp.space2,
    margin: 0,
    paddingBlock: grasp.space3,
    paddingInline: grasp.inspectorInset,
    listStyle: "none",
    fontSize: grasp.inspectorText,
    lineHeight: grasp.inspectorTextLine,
    color: grasp.ink,
  },
  // A section's foot, only when the host has more of it: the quiet button at the start.
  more: { display: "flex", paddingBlockStart: grasp.space2 },
  // A failure, as a failed message says one: the Alert mark and the words, in the danger colour.
  failed: {
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space1,
    color: grasp.danger,
  },
});

/** A failure said in place of a description or a meta line. */
const Failed = ({ children }: { children: string }) => (
  <span role="alert" {...stylex.props(styles.failed)}>
    <Icon icon={Alert} />
    {children}
  </span>
);

/** The pressable part of the nth row in a list, by the rows the page draws. */
const rowPress = (root: HTMLElement | null, index: number) => {
  const rows = root?.querySelectorAll<HTMLElement>("[data-slot=row-list-item]");
  const row = rows?.item(index);
  return row?.querySelector<HTMLElement>("button") ?? null;
};

const none: readonly never[] = [];

export const PageBrainActivity = ({
  description,
  error,
  fresh = none,
  freshMore = 0,
  waiting = none,
  waitingMore = 0,
  groups,
  onOpen,
  open,
  onMore,
  words,
}: PageBrainActivityProps) => {
  const said = { ...pageBrainActivityWords, ...words };
  const root = useRef<HTMLDivElement>(null);
  const shown = groups.filter((group) => group.lines.length > 0);
  // Every line in the order the page draws them, so a row is found by its place.
  const order = [
    ...fresh,
    ...waiting,
    ...shown.flatMap((group) => group.lines),
  ].map((line) => line.id);
  const sections = [
    { id: "fresh", lines: fresh },
    { id: "waiting", lines: waiting },
    ...shown.map((group) => ({ id: group.id, lines: group.lines })),
  ];
  // Where a section's lines start, and how many it had when its "Show more" was pressed.
  const starts = new Map(
    sections.map((section, index) => [
      section.id,
      sections
        .slice(0, index)
        .reduce((sum, each) => sum + each.lines.length, 0),
    ])
  );
  const counts = new Map(
    sections.map((section) => [section.id, section.lines.length])
  );
  const asked = useRef<{ section: string; had: number } | null>(null);
  // Once the lines a "Show more" asked for are drawn, focus goes to the first one it brought.
  useEffect(() => {
    const want = asked.current;
    if (want === null) {
      return;
    }
    const now = counts.get(want.section) ?? 0;
    if (now <= want.had) {
      return;
    }
    asked.current = null;
    rowPress(root.current, (starts.get(want.section) ?? 0) + want.had)?.focus();
  });
  // When the inspector closes, focus goes back to the row of the line it held.
  const held = useRef(open);
  useEffect(() => {
    const was = held.current;
    held.current = open;
    if (was === undefined || open !== undefined) {
      return;
    }
    const index = order.indexOf(was);
    if (index !== -1) {
      rowPress(root.current, index)?.focus();
    }
  });
  const foot = (section: string, more: number, count: number) =>
    more > 0 && onMore !== undefined ? (
      <div {...stylex.props(styles.more)}>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            asked.current = { section, had: count };
            onMore(section);
          }}
        >
          {said.showMore(more)}
        </Button>
      </div>
    ) : null;
  const lines = (list: readonly BrainActivityLine[]) => (
    <RowList stack>
      {list.map((line) => (
        <RowListItem
          key={line.id}
          icon={line.icon}
          name={line.name}
          detail={line.detail}
          onPress={() => {
            onOpen(line.id);
          }}
        />
      ))}
    </RowList>
  );
  return (
    <div
      ref={root}
      data-slot="page-brain-activity"
      {...stylex.props(styles.page)}
    >
      <PageColumn>
        <PageHeader
          title={said.title}
          description={
            error === undefined ? description : <Failed>{error}</Failed>
          }
        />
        {fresh.length === 0 ? null : (
          <PanelSection label={said.fresh} headingLevel={2}>
            {lines(fresh)}
            {foot("fresh", freshMore, fresh.length)}
          </PanelSection>
        )}
        {waiting.length === 0 ? null : (
          <PanelSection label={said.waiting} headingLevel={2}>
            {lines(waiting)}
            {foot("waiting", waitingMore, waiting.length)}
          </PanelSection>
        )}
        {shown.map((group) => (
          <PanelSection key={group.id} label={group.label} headingLevel={2}>
            {lines(group.lines)}
            {foot(group.id, group.more ?? 0, group.lines.length)}
          </PanelSection>
        ))}
      </PageColumn>
    </div>
  );
};

/** A page of the brain a line changed. */
export interface BrainActivityPage {
  id: string;
  name: string;
}

export interface BrainActivityInspectorProps {
  /** The line's name. */
  title: string;
  icon: IconData;
  /** Who gave it and how, and when. */
  meta: readonly string[];
  /**
   * The line's details could not load: said in the meta's place, in the danger colour after the
   * Alert mark, and read out at once.
   */
  error?: string;
  /** What the brain kept of it, a sentence each. Without any (a question), the section is left out. */
  kept?: readonly string[];
  /** The pages it changed. Without any, the section is left out. */
  changed?: readonly BrainActivityPage[];
  /** Opens a page it changed. */
  onOpenPage?: (id: string) => void;
  /** Its own actions in the bar: "Open", or "Ask" for a question, each a ghost Button. */
  actions?: ReactNode;
  onClose: () => void;
  /** The panel's own words, in another language. */
  words?: Partial<PageBrainActivityWords>;
}

/** The line in hand, beside the page. */
export const BrainActivityInspector = ({
  title,
  icon,
  meta,
  error,
  kept = none,
  changed = none,
  onOpenPage,
  actions,
  onClose,
  words,
}: BrainActivityInspectorProps) => {
  const said = { ...pageBrainActivityWords, ...words };
  return (
    <InspectorPanel
      title={title}
      icon={icon}
      meta={
        error === undefined ? [...meta] : [<Failed key="error">{error}</Failed>]
      }
      actions={actions}
      onClose={onClose}
      sections={[
        ...(kept.length === 0
          ? []
          : [
              {
                id: "kept",
                label: said.kept,
                content: (
                  <ul {...stylex.props(styles.kept)}>
                    {kept.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                ),
              },
            ]),
        ...(changed.length === 0
          ? []
          : [
              {
                id: "changed",
                label: said.changed,
                rows: changed.map((page) => ({
                  id: page.id,
                  icon: Note,
                  name: page.name,
                  onPress:
                    onOpenPage === undefined
                      ? undefined
                      : () => {
                          onOpenPage(page.id);
                        },
                })),
              },
            ]),
      ]}
    />
  );
};
