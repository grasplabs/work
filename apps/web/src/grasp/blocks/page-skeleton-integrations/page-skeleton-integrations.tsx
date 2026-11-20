// Page skeleton, integrations: the Integrations page before its apps arrive (a route's first paint),
// and an app's panel before its account and tools arrive, built from the parts they will show:
//
//   <PageSkeletonIntegrations band runs={[{ tiles: 4, note: true }, 2, 4]} />
//                                                    with `band`, the slim hero's card at its size
//                                                    (its two lines, the connected marks' frame and
//                                                    their count) between the header and the runs
//   <PageSkeletonIntegrations runs={[2, 4, 4]} />    PageHeader's own `loading` with its search and
//                                                    Request app, then runs of tiles under their
//                                                    headings, in the real ItemGrid with Items in an
//                                                    app tile's shape (a mark, a name, one fact)
//   <PageSkeletonAppPanel />                         InspectorPanel's own `loading`: the head, then
//                                                    Account, What Grasp may do and Used by, as the
//                                                    app panel stands
//
// So nothing moves when the data arrives: the grid's columns and rows, the panel's sections.
import * as stylex from "@stylexjs/stylex";

import { InspectorPanel } from "../../inspector-panel";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGrid,
  ItemMedia,
  ItemTitle,
} from "../../item";
import { PageHeader } from "../../page-header";
import { RowList, RowListItem } from "../../row-list";
import { Skeleton } from "../../skeleton";
import { grasp, media } from "../../tokens/tokens.stylex";

const PHONE = "@container page-header (width < 40rem)";

const styles = stylex.create({
  // The header, then the runs, as the Integrations page lays them.
  page: { display: "grid", gap: grasp.space6, minWidth: 0 },
  run: { display: "grid", gap: grasp.space3, minWidth: 0 },
  // A run's heading: one line of small words.
  heading: { width: grasp.space24 },
  // A run's note under its heading, at the note's own line; on a phone it runs to two lines.
  head: { display: "grid", gap: grasp.space1 },
  note: { height: grasp.textXsLine, width: "min(100%, 24rem)" },
  noteMore: {
    display: { default: "none", [media.belowPhone]: "block" },
    height: grasp.textXsLine,
    width: "8rem",
  },
  // The header's actions: the search field and Request app, at their sizes. On a phone (the header
  // under 40rem) the row is the column's width, the field taking what Request app leaves, as the page's.
  actions: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: grasp.space2,
    width: { default: "auto", [PHONE]: "100cqi" },
  },
  searchBox: {
    display: "flex",
    width: { default: "16rem", [PHONE]: "auto" },
    flex: { default: "none", [PHONE]: "1 1 0" },
    minWidth: { default: null, [PHONE]: "9rem" },
  },
  search: { width: "100%", height: grasp.controlMd },
  request: { width: "8.5rem", flexShrink: 0, height: grasp.controlMd },
  // The slim hero's card: its frame and insets, its words, then the connected marks and their count.
  band: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: grasp.space4,
    paddingBlock: grasp.space5,
    paddingInline: { default: grasp.space6, [media.belowPhone]: grasp.space4 },
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    boxShadow: `inset 0 0 0 ${grasp.hairline} ${grasp.line}`,
    backgroundColor: grasp.raised,
  },
  // The words take the row; on a phone the title runs to two lines and the marks wrap under them.
  bandWords: {
    display: "grid",
    gap: grasp.space1,
    flexGrow: 1,
    flexBasis: { default: "auto", [media.belowPhone]: "100%" },
    minWidth: 0,
  },
  bandTitle: { width: "min(100%, 22rem)" },
  bandTitleMore: {
    display: { default: "none", [media.belowPhone]: "block" },
    width: "min(100%, 11rem)",
  },
  bandLead: { width: "min(100%, 15rem)" },
  bandStack: { display: "flex", alignItems: "center", gap: grasp.space2 },
  bandMarks: { width: grasp.space16, height: grasp.controlSm },
  bandCount: { width: "5rem" },
  // A tile's mark, as an app's 32px mark.
  mark: { width: grasp.controlSm, height: grasp.controlSm },
  // A tile's name and its one fact, as wide as a name and a short fact read.
  name: { width: "60%" },
  fact: { width: "40%" },
  // The panel's mark, as the app's 40px mark.
  panelMark: { width: grasp.space10, height: grasp.space10 },
  // What Grasp may do: the counts' line and the two-tone bar, at the panel's inset.
  balance: {
    display: "grid",
    gap: grasp.space2,
    paddingInline: grasp.inspectorInset,
    paddingBlock: grasp.space2,
  },
  counts: { width: "9rem" },
  // The bar's two buttons (Connect, or the state that manages it, and Settings), at their xs height.
  barActions: { display: "flex", alignItems: "center", gap: grasp.space2 },
  manage: { width: "5.5rem", height: grasp.controlXs },
  settings: { width: "4.5rem", height: grasp.controlXs },
  allTools: { width: "5.5rem" },
  bar: { height: grasp.space2 },
});

export interface PageSkeletonIntegrationsProps {
  /** How many tiles each run holds at first, in order: Connected, then the kinds of app. @default [2, 4, 4] */
  runs?: readonly (number | PageSkeletonRun)[];
  /** The slim hero's card waits too, between the header and the runs. @default false */
  band?: boolean;
  /** What the region says while it waits, for a screen reader. @default "Loading integrations" */
  label?: string;
}

/** A run with a note under its heading, as Recommended's "From your Microsoft 365, …". */
export interface PageSkeletonRun {
  /** How many tiles it holds at first. */
  tiles: number;
  /** A note stands under the heading. */
  note?: boolean;
}

/** The runs a page shows at first: Connected, then two kinds of app. */
const RUNS: readonly number[] = [2, 4, 4];

/** A tile as it waits: an app tile's mark, name and fact as quiet shapes. */
const WaitingTile = () => (
  <Item variant="outline" size="xs">
    <ItemMedia>
      <Skeleton variant="block" layout={styles.mark} />
    </ItemMedia>
    <ItemContent>
      <ItemTitle>
        <Skeleton text="sm" layout={styles.name} />
      </ItemTitle>
      <ItemDescription>
        <Skeleton text="sm" layout={styles.fact} />
      </ItemDescription>
    </ItemContent>
  </Item>
);

/** The Integrations page before it arrives: the header's placeholders and its actions, then the runs of tiles. */
export const PageSkeletonIntegrations = ({
  runs = RUNS,
  band = false,
  label = "Loading integrations",
}: PageSkeletonIntegrationsProps) => (
  <output
    data-slot="page-skeleton-integrations"
    aria-busy="true"
    aria-label={label}
    {...stylex.props(styles.page)}
  >
    <PageHeader
      title=""
      loadingLines={0}
      loading
      actions={
        <span {...stylex.props(styles.actions)}>
          <span {...stylex.props(styles.searchBox)}>
            <Skeleton variant="block" layout={styles.search} />
          </span>
          <Skeleton variant="block" layout={styles.request} />
        </span>
      }
    />
    {band ? (
      <div {...stylex.props(styles.band)}>
        <div {...stylex.props(styles.bandWords)}>
          <Skeleton text="lg" layout={styles.bandTitle} />
          <Skeleton text="lg" layout={styles.bandTitleMore} />
          <Skeleton text="sm" layout={styles.bandLead} />
        </div>
        <span {...stylex.props(styles.bandStack)}>
          <Skeleton variant="block" layout={styles.bandMarks} />
          <Skeleton text="sm" layout={styles.bandCount} />
        </span>
      </div>
    ) : null}
    {runs.map((entry, run) => {
      const { tiles: count, note = false } =
        typeof entry === "number" ? { tiles: entry } : entry;
      return (
        <div key={run} {...stylex.props(styles.run)}>
          {note ? (
            <div {...stylex.props(styles.head)}>
              <Skeleton text="sm" layout={styles.heading} />
              <Skeleton text="sm" layout={styles.note} />
              <Skeleton text="sm" layout={styles.noteMore} />
            </div>
          ) : (
            <Skeleton text="sm" layout={styles.heading} />
          )}
          <ItemGrid>
            {Array.from({ length: count }, (_, index) => (
              <WaitingTile key={index} />
            ))}
          </ItemGrid>
        </div>
      );
    })}
  </output>
);

export interface PageSkeletonAppPanelProps {
  /** The sections' names, as the app panel shows them. */
  words?: {
    account?: string;
    mayDo?: string;
    usedBy?: string;
    signedInAs?: string;
    forWhom?: string;
  };
  /** What the panel says while it waits, for a screen reader. @default "Loading the app" */
  label?: string;
  /** Closes the panel while it waits: its close stands where the loaded panel's does. */
  onClose?: () => void;
}

/** A row of a section as it waits: its name and its word as quiet lines. */
const waitingRows = (count: number, label: string) => (
  <RowList aria-label={label} noActions>
    {Array.from({ length: count }, (_, index) => (
      <RowListItem
        key={index}
        name=""
        detail={<Skeleton text="sm" layout={styles.counts} />}
      />
    ))}
  </RowList>
);

/**
 * An app's panel before its account and tools arrive: InspectorPanel's own loading head, then its
 * three sections with their values waiting. Put it where the AppPanel's InspectorPanel stands.
 */
/** No words given: the English ones. */
const NO_WORDS: NonNullable<PageSkeletonAppPanelProps["words"]> = {};

export const PageSkeletonAppPanel = ({
  words = NO_WORDS,
  label = "Loading the app",
  onClose,
}: PageSkeletonAppPanelProps) => (
  <InspectorPanel
    framed={false}
    aria-label={label}
    onClose={onClose}
    actions={
      <span {...stylex.props(styles.barActions)}>
        <Skeleton variant="block" layout={styles.manage} />
        <Skeleton variant="block" layout={styles.settings} />
      </span>
    }
    title=""
    description=""
    loading
    mark={<Skeleton variant="block" layout={styles.panelMark} />}
    sections={[
      {
        id: "account",
        label: words.account ?? "Account",
        facts: [
          { key: words.signedInAs ?? "Signed in as", value: "", pending: true },
          { key: words.forWhom ?? "For", value: "", pending: true },
        ],
      },
      {
        id: "can",
        label: words.mayDo ?? "What Grasp may do",
        action: <Skeleton text="sm" layout={styles.allTools} />,
        content: (
          <>
            <div {...stylex.props(styles.balance)}>
              <Skeleton text="sm" layout={styles.counts} />
              <Skeleton variant="block" layout={styles.bar} />
            </div>
            {waitingRows(3, words.mayDo ?? "What Grasp may do")}
          </>
        ),
      },
      {
        id: "used",
        label: words.usedBy ?? "Used by",
        content: waitingRows(2, words.usedBy ?? "Used by"),
      },
    ]}
  />
);
