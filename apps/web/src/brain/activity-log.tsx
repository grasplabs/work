import { Inspector } from "@grasp-os/ui/blocks/inspector-01/inspector-01";
import { Container } from "@grasp-os/ui/components/container";
import {
  Item,
  ItemContent,
  ItemDetail,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { PageHeader } from "@grasp-os/ui/components/page-header";
import { SidePanelSection } from "@grasp-os/ui/components/side-panel";
import { CircleAlertIcon, Icon, StickyNoteIcon } from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";
import { colors, size, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

// The brain's Activity, as the prototype's Brain activity page lays it out:
// the questions still waiting for an answer, then the brain's log by
// stretch of time, each a section of rows that open the line beside the
// page (ActivityInspector), on Damsko's side panel sections and items.

/** One thing that came in: a document, a connection's scan, a week of interviews, a question. */
export interface ActivityLine {
  id: string;
  /** Its kind's icon. */
  icon: IconData;
  name: string;
  /** Quiet, after its name: when it came in, or whom it waits on. */
  detail: string;
}

/** A stretch of the log, under its own label. */
export interface ActivityGroup {
  id: string;
  label: string;
  lines: readonly ActivityLine[];
}

/** A page of the brain a line changed. */
export interface ActivityPage {
  id: string;
  name: string;
}

const styles = stylex.create({
  sections: {
    display: "flex",
    flexDirection: "column",
    gap: space["6"],
    paddingBlockEnd: space["12"],
  },
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
  // A failure, as a failed message says one: the alert mark and the words, in the destructive colour.
  failed: {
    display: "inline-flex",
    alignItems: "center",
    gap: space["1"],
    color: colors.destructive,
  },
});

/** The pressable part of the nth row the page draws. */
const rowPress = (root: HTMLElement | null, index: number) =>
  root
    ?.querySelectorAll<HTMLElement>("[data-slot=item]")
    .item(index)
    ?.querySelector<HTMLElement>("button") ?? null;

/** A section of lines, each a row that opens beside the page. */
const Lines = ({
  label,
  lines,
  onOpen,
}: {
  label: string;
  lines: readonly ActivityLine[];
  onOpen: (id: string) => void;
}) => (
  <SidePanelSection level={2} title={label}>
    <ItemGroup aria-label={label}>
      {lines.map((line) => (
        <Item
          key={line.id}
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
              <ItemDetail>{line.detail}</ItemDetail>
            </ItemTitle>
          </ItemContent>
        </Item>
      ))}
    </ItemGroup>
  </SidePanelSection>
);

export const ActivityLog = ({
  waiting,
  groups,
  onOpen,
  open,
}: {
  /** Questions waiting for an answer, each with the role it waits on as its detail. */
  waiting: readonly ActivityLine[];
  /** The rest of the log, newest first. */
  groups: readonly ActivityGroup[];
  onOpen: (id: string) => void;
  /**
   * The line open beside the page, by id. When it goes back to none (closed), focus goes to that
   * line's row, so the reader is where they were.
   */
  open: string | undefined;
}) => {
  const { t } = useLingui();
  const root = useRef<HTMLDivElement>(null);
  const shown = groups.filter((group) => group.lines.length > 0);
  // Every line in the order the page draws them, so a row is found by its place.
  const order = [...waiting, ...shown.flatMap((group) => group.lines)].map(
    (line) => line.id
  );
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
    <div ref={root}>
      <Container size="lg">
        <PageHeader
          title={t({ message: "Activity", context: "the brain's log" })}
        />
        <div {...stylex.props(styles.sections)}>
          {waiting.length === 0 ? null : (
            <Lines
              label={t`Waiting for an answer`}
              lines={waiting}
              onOpen={onOpen}
            />
          )}
          {shown.map((group) => (
            <Lines
              key={group.id}
              label={group.label}
              lines={group.lines}
              onOpen={onOpen}
            />
          ))}
        </div>
      </Container>
    </div>
  );
};

/** The line in hand, beside the page. */
export const ActivityInspector = ({
  title,
  icon,
  meta,
  error,
  kept,
  changed,
  onOpenPage,
  actions,
  onClose,
}: {
  /** The line's name. */
  title: string;
  icon: IconData;
  /** Who gave it and how, and when. */
  meta: readonly string[];
  /** Why its action failed: said in the meta's place, after the alert mark, and read out at once. */
  error: string | undefined;
  /** What the brain kept of it, a sentence each. Without any (a question), the section is left out. */
  kept: readonly string[];
  /** The pages it changed. Without any, the section is left out. */
  changed: readonly ActivityPage[];
  onOpenPage: (id: string) => void;
  /** Its own actions in the bar: Open, or Ask for a question. */
  actions: ReactNode;
  onClose: () => void;
}) => {
  const { t } = useLingui();
  return (
    <Inspector
      actions={actions}
      aria-label={title}
      icon={icon}
      meta={
        error === undefined
          ? [...meta]
          : [
              <span key="error" role="alert" {...stylex.props(styles.failed)}>
                <Icon icon={CircleAlertIcon} />
                {error}
              </span>,
            ]
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
