"use client";

import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { Note } from "../../icons";
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
}

export interface PageBrainActivityProps {
  /** One sentence under the title: when the reader last looked, and what came in since. */
  description?: string;
  /** New since the reader last looked. Without any, the section is left out. */
  fresh?: readonly BrainActivityLine[];
  /** Questions waiting for an answer, each with the role it waits on as its detail. Without any, the section is left out. */
  waiting?: readonly BrainActivityLine[];
  /** The rest of the log, newest first. */
  groups: readonly BrainActivityGroup[];
  /** Opens a line: the host shows it in BrainActivityInspector. */
  onOpen: (id: string) => void;
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
}

export const pageBrainActivityWords: PageBrainActivityWords = {
  title: "Activity",
  fresh: "Since you last looked",
  waiting: "Waiting for an answer",
  kept: "What the brain kept",
  changed: "Pages it changed",
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
});

const none: readonly never[] = [];

export const PageBrainActivity = ({
  description,
  fresh = none,
  waiting = none,
  groups,
  onOpen,
  words,
}: PageBrainActivityProps) => {
  const said = { ...pageBrainActivityWords, ...words };
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
    <div data-slot="page-brain-activity" {...stylex.props(styles.page)}>
      <PageColumn>
        <PageHeader title={said.title} description={description} />
        {fresh.length === 0 ? null : (
          <PanelSection label={said.fresh} headingLevel={2}>
            {lines(fresh)}
          </PanelSection>
        )}
        {waiting.length === 0 ? null : (
          <PanelSection label={said.waiting} headingLevel={2}>
            {lines(waiting)}
          </PanelSection>
        )}
        {groups
          .filter((group) => group.lines.length > 0)
          .map((group) => (
            <PanelSection key={group.id} label={group.label} headingLevel={2}>
              {lines(group.lines)}
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
      meta={[...meta]}
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
