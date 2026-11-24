import { Inspector } from "@grasp-os/ui/blocks/inspector-01/inspector-01";
import { Container } from "@grasp-os/ui/components/container";
import {
  Item,
  ItemContent,
  ItemDetail,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { PageHeader } from "@grasp-os/ui/components/page-header";
import { SidePanelSection } from "@grasp-os/ui/components/side-panel";
import { CircleAlertIcon, Icon, StickyNoteIcon } from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";
import { colors, size, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Fragment, useEffect, useRef } from "react";
import type { ReactNode } from "react";

// The Brain's Activity page and the line in hand beside it, from the
// reference's library (#2503's `blocks/page-brain-activity`): what came in
// since the reader last looked, the questions waiting for an answer, then
// the log by stretch, each a section of rows; a row opens the line in the
// Inspector. Damsko has no block for it, so it is the Brain's own, on
// Damsko's Container, PageHeader, SidePanelSection, Item and Inspector.

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
interface BrainActivityGroup {
  id: string;
  label: string;
  lines: readonly BrainActivityLine[];
}

/** A page of the brain a line changed. */
export interface BrainActivityPage {
  id: string;
  name: string;
}

const styles = stylex.create({
  kept: {
    display: "grid",
    gap: space["2"],
    margin: 0,
    paddingBlock: space["3"],
    paddingInline: space.sidePanelPadding,
    listStyle: "none",
    fontSize: size.sidePanelText,
    lineHeight: size.sidePanelTextLine,
    color: colors.foreground,
  },
  // A failure, as a failed message says one: the alert mark and the words, in the danger colour.
  failed: {
    display: "inline-flex",
    alignItems: "center",
    gap: space["1"],
    color: colors.destructive,
  },
});

/** A failure said in place of a description or a meta line. */
const Failed = ({ children }: { children: string }) => (
  <span role="alert" {...stylex.props(styles.failed)}>
    <Icon icon={CircleAlertIcon} />
    {children}
  </span>
);

/** The pressable part of the nth row the page draws. */
const rowPress = (root: HTMLElement | null, index: number) =>
  root
    ?.querySelectorAll<HTMLElement>("[data-slot=item]")
    .item(index)
    ?.querySelector<HTMLElement>("button") ?? null;

const none: readonly never[] = [];

/** A section's lines, a row each that opens it. */
const Lines = ({
  lines,
  onOpen,
}: {
  lines: readonly BrainActivityLine[];
  onOpen: (id: string) => void;
}) => (
  <ItemGroup>
    {lines.map((line, index) => (
      <Fragment key={line.id}>
        {index > 0 ? <ItemSeparator /> : null}
        <Item
          onClick={() => {
            onOpen(line.id);
          }}
          size="xs"
        >
          <ItemMedia>
            <Icon icon={line.icon} />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>
              {line.name}
              {line.detail === undefined ? null : (
                <ItemDetail>{line.detail}</ItemDetail>
              )}
            </ItemTitle>
          </ItemContent>
        </Item>
      </Fragment>
    ))}
  </ItemGroup>
);

export const PageBrainActivity = ({
  title,
  waiting = none,
  waitingLabel,
  groups,
  onOpen,
  open,
}: {
  title: string;
  /** Questions waiting for an answer, each with the role it waits on as its detail. */
  waiting?: readonly BrainActivityLine[];
  waitingLabel: string;
  /** The rest of the log, newest first. */
  groups: readonly BrainActivityGroup[];
  /** Opens a line: the host shows it in BrainActivityInspector. */
  onOpen: (id: string) => void;
  /**
   * The line open in the inspector, by id. When it goes back to none (the inspector closed), focus
   * goes to that line's row, so the reader is where they were.
   */
  open?: string | undefined;
}) => {
  const root = useRef<HTMLDivElement>(null);
  const shown = groups.filter((group) => group.lines.length > 0);
  // Every line in the order the page draws them, so a row is found by its place.
  const order = [...waiting, ...shown.flatMap((group) => group.lines)].map(
    (line) => line.id
  );
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
  return (
    <div data-slot="page-brain-activity" ref={root}>
      <Container size="lg">
        <PageHeader title={title} />
        {waiting.length === 0 ? null : (
          <SidePanelSection level={2} title={waitingLabel}>
            <Lines lines={waiting} onOpen={onOpen} />
          </SidePanelSection>
        )}
        {shown.map((group) => (
          <SidePanelSection key={group.id} level={2} title={group.label}>
            <Lines lines={group.lines} onOpen={onOpen} />
          </SidePanelSection>
        ))}
      </Container>
    </div>
  );
};

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
}: {
  /** The line's name. */
  title: string;
  icon: IconData;
  /** Who gave it and how, and when. */
  meta: readonly string[];
  /** The line's details could not load: said in the meta's place. */
  error?: string | undefined;
  /** What the brain kept of it, a sentence each. Without any (a question), the section is left out. */
  kept?: readonly string[] | undefined;
  /** The pages it changed. Without any, the section is left out. */
  changed?: readonly BrainActivityPage[] | undefined;
  /** Opens a page it changed. */
  onOpenPage: (id: string) => void;
  /** Its own actions in the bar: "Open", or "Ask" for a question, each a ghost Button. */
  actions?: ReactNode;
  onClose: () => void;
}) => {
  const { t } = useLingui();
  return (
    <Inspector
      actions={actions}
      aria-label={title}
      icon={icon}
      meta={
        error === undefined ? [...meta] : [<Failed key="error">{error}</Failed>]
      }
      onClose={onClose}
      sections={[
        ...(kept.length === 0
          ? []
          : [
              {
                id: "kept",
                title: t`What the brain kept`,
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
                title: t`Pages it changed`,
                rows: changed.map((page) => ({
                  id: page.id,
                  icon: StickyNoteIcon,
                  name: page.name,
                  onClick: () => {
                    onOpenPage(page.id);
                  },
                })),
              },
            ]),
      ]}
      title={title}
    />
  );
};
