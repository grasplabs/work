// #2503's library skeleton for Integrations (page-skeleton-integrations), on Damsko's parts: the Integrations page before its apps arrive (a route's first paint),
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
//   <PageSkeletonAppPanel />                         SidePanelHeader's own `loading`: the head, then
//                                                    Account, What Grasp may do and Used by, as the
//                                                    app panel stands
//   <PageSkeletonAppPage accounts={2} offer />       an app's own page (AppPage): its 40rem column,
//                                                    the head card (with `offer`, the offered switch's
//                                                    frame), a row for each account, then What Grasp
//                                                    may do with its search and its groups
//
// So nothing moves when the data arrives: the grid's columns and rows, the panel's sections.
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemDetail,
  ItemGrid,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { KeyValueList } from "@grasp-os/ui/components/key-value";
import { PageHeader } from "@grasp-os/ui/components/page-header";
import {
  SidePanel,
  SidePanelContent,
  SidePanelHeader,
  SidePanelSection,
} from "@grasp-os/ui/components/side-panel";
import { Skeleton } from "@grasp-os/ui/components/skeleton";
import {
  colors,
  font,
  media,
  radius,
  size as sizes,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { Fragment } from "react";

import { SectionCard } from "../section-card.tsx";
import { RowFrame } from "./rows.tsx";

const PHONE = "@container page-header (width < 40rem)";

const styles = stylex.create({
  // The header, then the runs, as the Integrations page lays them.
  page: { display: "grid", gap: space["6"], minWidth: 0 },
  run: { display: "grid", gap: space["3"], minWidth: 0 },
  // A run's heading: one line of small words.
  heading: { width: space["24"] },
  // A run's note under its heading, at the note's own line; on a phone it runs to two lines.
  head: { display: "grid", gap: space["1"] },
  note: { height: font.textXsLine, width: "min(100%, 24rem)" },
  noteMore: {
    display: { default: "none", [media.maxSm]: "block" },
    height: font.textXsLine,
    width: "8rem",
  },
  // The header's actions: the search field and Request app, at their sizes. On a phone (the header
  // under 40rem) the row is the column's width, the field taking what Request app leaves, as the page's.
  actions: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space["2"],
    width: { default: "auto", [PHONE]: "100cqi" },
  },
  searchBox: {
    display: "flex",
    width: { default: "16rem", [PHONE]: "auto" },
    flex: { default: "none", [PHONE]: "1 1 0" },
    minWidth: { default: null, [PHONE]: "9rem" },
  },
  search: { width: "100%", height: sizes.controlDefault },
  request: { width: "8.5rem", flexShrink: 0, height: sizes.controlDefault },
  // The slim hero's card: its frame and insets, its words, then the connected marks and their count.
  band: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space["4"],
    paddingBlock: space["5"],
    paddingInline: { default: space["6"], [media.maxSm]: space["4"] },
    borderRadius: radius.base,
    cornerShape: radius.shape,
    boxShadow: `inset 0 0 0 ${sizes.hairline} ${colors.border}`,
    backgroundColor: colors.card,
  },
  // The words take the row; on a phone the title runs to two lines and the marks wrap under them.
  bandWords: {
    display: "grid",
    gap: space["1"],
    flexGrow: 1,
    flexBasis: { default: "auto", [media.maxSm]: "100%" },
    minWidth: 0,
  },
  bandTitle: { width: "min(100%, 22rem)" },
  bandTitleMore: {
    display: { default: "none", [media.maxSm]: "block" },
    width: "min(100%, 11rem)",
  },
  bandLead: { width: "min(100%, 15rem)" },
  bandStack: { display: "flex", alignItems: "center", gap: space["2"] },
  bandMarks: { width: space["16"], height: sizes.controlSm },
  bandCount: { width: "5rem" },
  // A tile's mark, as an app's 32px mark.
  mark: { width: sizes.controlSm, height: sizes.controlSm },
  // A tile's name and its one fact, as wide as a name and a short fact read.
  name: { width: "60%" },
  fact: { width: "40%" },
  // The panel's mark, as the app's 40px mark.
  panelMark: { width: space["10"], height: space["10"] },
  // What Grasp may do: the counts' line and the two-tone bar, at the panel's inset.
  // The facts at the inset of the rows' words, as the Inspector's.
  facts: { paddingInline: space.sidePanelPadding },
  balance: {
    display: "grid",
    gap: space["2"],
    paddingInline: space.sidePanelPadding,
    paddingBlock: space["2"],
  },
  counts: { width: "9rem" },
  // The bar's two buttons (Connect, or the state that manages it, and Settings), at their xs height.
  barActions: { display: "flex", alignItems: "center", gap: space["2"] },
  manage: { width: "5.5rem", height: sizes.controlXs },
  settings: { width: "4.5rem", height: sizes.controlXs },
  allTools: { width: "5.5rem" },
  bar: { height: space["2"] },
  // An app's own page, as AppPage lays it (app-integration/page.tsx): one centred 40rem column.
  appPage: {
    display: "grid",
    gap: space["8"],
    width: "100%",
    maxWidth: "40rem",
    marginInline: "auto",
    minWidth: 0,
  },
  // Its head card: the mark, the words, and the action at the line's end (under the words on a phone).
  headCard: {
    display: "grid",
    gridTemplateColumns: {
      default: "auto minmax(0, 1fr) auto",
      [media.maxSm]: "auto minmax(0, 1fr)",
    },
    columnGap: space["4"],
    rowGap: space["4"],
    alignItems: "start",
    padding: space["6"],
    borderRadius: radius.base,
    cornerShape: radius.shape,
    boxShadow: `inset 0 0 0 ${sizes.hairline} ${colors.border}`,
    backgroundColor: colors.card,
  },
  headMark: { width: sizes.avatarLg, height: sizes.avatarLg },
  headWords: { display: "grid", gap: space["1"], minWidth: 0 },
  headName: { width: "8rem" },
  headLine: { width: "min(100%, 24rem)" },
  headLineShort: { width: "min(100%, 16rem)" },
  headAction: {
    width: "7.5rem",
    height: sizes.controlSm,
    gridColumn: { default: "auto", [media.maxSm]: "2" },
  },
  // Whether it is offered: the switch's frame and its one line, under the words.
  headOffer: {
    gridColumn: "2 / -1",
    display: "flex",
    alignItems: "center",
    gap: space["2"],
    minWidth: 0,
  },
  headSwitch: {
    width: sizes.switchWidth,
    height: sizes.switchHeight,
    flexShrink: 0,
  },
  headOfferLine: { width: "min(100%, 13rem)" },
  // An account's row: its words, its state, then its actions, which wrap under the words on a phone.
  accounts: { margin: 0, padding: 0, listStyle: "none" },
  accountItem: {
    borderBlockStartWidth: { default: sizes.hairline, ":first-child": 0 },
    borderBlockStartStyle: "solid",
    borderBlockStartColor: colors.border,
  },
  account: {
    display: "grid",
    gridTemplateColumns: {
      default: "minmax(0, 1fr) auto auto",
      "@container (width < 28rem)": "minmax(0, 1fr) auto",
    },
    alignItems: "center",
    columnGap: space["4"],
    rowGap: space["2"],
  },
  accountWords: { display: "grid", minWidth: 0 },
  accountName: { width: "min(100%, 11rem)" },
  accountWhen: { width: "min(100%, 7rem)" },
  accountState: { width: "5.5rem", alignSelf: "start" },
  accountActions: {
    display: "flex",
    gap: space["2"],
    gridColumn: { default: "auto", "@container (width < 28rem)": "1 / -1" },
  },
  accountAction: { width: "6.5rem", height: sizes.controlSm },
  // What Grasp may do: the search in the card's head, then a group a row, its name and counts.
  toolsSearch: {
    width: { default: "14rem", "@container (width < 28rem)": "100cqi" },
    height: sizes.controlSm,
  },
  group: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    alignItems: "center",
    columnGap: space["4"],
    paddingInlineStart: `calc(${sizes.iconSm} + ${space["2"]})`,
  },
  groupName: { width: "6rem" },
  groupCounts: { width: "7rem" },
  groupChoice: { width: "3.5rem" },
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
    <ItemMedia align="center">
      <Skeleton variant="rectangular" style={styles.mark} />
    </ItemMedia>
    <ItemContent>
      <ItemTitle>
        <Skeleton size="sm" style={styles.name} />
      </ItemTitle>
      <ItemDescription>
        <Skeleton size="sm" style={styles.fact} />
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
            <Skeleton variant="rectangular" style={styles.search} />
          </span>
          <Skeleton variant="rectangular" style={styles.request} />
        </span>
      }
    />
    {band ? (
      <div {...stylex.props(styles.band)}>
        <div {...stylex.props(styles.bandWords)}>
          <Skeleton size="lg" style={styles.bandTitle} />
          <Skeleton size="lg" style={styles.bandTitleMore} />
          <Skeleton size="sm" style={styles.bandLead} />
        </div>
        <span {...stylex.props(styles.bandStack)}>
          <Skeleton variant="rectangular" style={styles.bandMarks} />
          <Skeleton size="sm" style={styles.bandCount} />
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
              <Skeleton size="sm" style={styles.heading} />
              <Skeleton size="sm" style={styles.note} />
              <Skeleton size="sm" style={styles.noteMore} />
            </div>
          ) : (
            <Skeleton size="sm" style={styles.heading} />
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
  <ItemGroup aria-label={label}>
    {Array.from({ length: count }, (_, index) => (
      <Fragment key={index}>
        {index > 0 && <ItemSeparator />}
        <Item size="xs">
          <ItemContent>
            <ItemTitle>
              <ItemDetail>
                <Skeleton size="sm" style={styles.counts} />
              </ItemDetail>
            </ItemTitle>
          </ItemContent>
        </Item>
      </Fragment>
    ))}
  </ItemGroup>
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
  <SidePanel aria-label={label} framed={false}>
    <SidePanelHeader
      actions={
        <span {...stylex.props(styles.barActions)}>
          <Skeleton style={styles.manage} variant="rectangular" />
          <Skeleton style={styles.settings} variant="rectangular" />
        </span>
      }
      description=""
      icon={<Skeleton style={styles.panelMark} variant="rectangular" />}
      loading
      {...(onClose === undefined ? {} : { onClose })}
      title=""
    />
    <SidePanelContent>
      <SidePanelSection title={words.account ?? "Account"}>
        <div {...stylex.props(styles.facts)}>
          <KeyValueList
            divided
            items={[
              {
                id: "signed-in-as",
                label: words.signedInAs ?? "Signed in as",
                value: "",
                loading: true,
              },
              {
                id: "for-whom",
                label: words.forWhom ?? "For",
                value: "",
                loading: true,
              },
            ]}
            orientation="horizontal"
          />
        </div>
      </SidePanelSection>
      <SidePanelSection
        action={<Skeleton size="sm" style={styles.allTools} />}
        title={words.mayDo ?? "What Grasp may do"}
      >
        <div {...stylex.props(styles.balance)}>
          <Skeleton size="sm" style={styles.counts} />
          <Skeleton style={styles.bar} variant="rectangular" />
        </div>
        {waitingRows(3, words.mayDo ?? "What Grasp may do")}
      </SidePanelSection>
      <SidePanelSection title={words.usedBy ?? "Used by"}>
        {waitingRows(2, words.usedBy ?? "Used by")}
      </SidePanelSection>
    </SidePanelContent>
  </SidePanel>
);

export interface PageSkeletonAppPageProps {
  /** How many accounts wait, a row each. @default 1 */
  accounts?: number;
  /** Whether it is offered waits too, under the head's words, as an admin's page shows it. @default false */
  offer?: boolean;
  /** How many groups of tools wait under What Grasp may do. @default 4 */
  groups?: number;
  /** The tools card's name, as the page shows it. @default "What Grasp may do" */
  mayDo?: string;
  /** The accounts card's name for a screen reader, as the page's. @default "Connection" */
  connection?: string;
  /** What the region says while it waits, for a screen reader. @default "Loading the app" */
  label?: string;
}

/**
 * An app's own page before it arrives, as AppPage stands: the head card in the centred column, a
 * row for each account (its words, its state, its actions' frames), then What Grasp may do with its
 * search's frame and its groups. Put it where the AppPage will stand.
 */
export const PageSkeletonAppPage = ({
  accounts = 1,
  offer = false,
  groups = 4,
  mayDo = "What Grasp may do",
  connection = "Connection",
  label = "Loading the app",
}: PageSkeletonAppPageProps) => (
  <output
    data-slot="page-skeleton-app-page"
    aria-busy="true"
    aria-label={label}
    {...stylex.props(styles.appPage)}
  >
    <div {...stylex.props(styles.headCard)}>
      <Skeleton variant="rectangular" style={styles.headMark} />
      <div {...stylex.props(styles.headWords)}>
        <Skeleton size="lg" style={styles.headName} />
        <Skeleton size="sm" style={styles.headLine} />
        <Skeleton size="sm" style={styles.headLineShort} />
      </div>
      <Skeleton variant="rectangular" style={styles.headAction} />
      {offer ? (
        <span {...stylex.props(styles.headOffer)}>
          <Skeleton variant="rectangular" style={styles.headSwitch} />
          <Skeleton size="sm" style={styles.headOfferLine} />
        </span>
      ) : null}
    </div>
    {accounts === 0 ? null : (
      <SectionCard aria-label={connection} flush>
        <ul {...stylex.props(styles.accounts)}>
          {Array.from({ length: accounts }, (_, index) => (
            <li key={index} {...stylex.props(styles.accountItem)}>
              <RowFrame inner={[styles.account]}>
                <span {...stylex.props(styles.accountWords)}>
                  <Skeleton size="sm" style={styles.accountName} />
                  <Skeleton size="sm" style={styles.accountWhen} />
                </span>
                <Skeleton size="sm" style={styles.accountState} />
                <span {...stylex.props(styles.accountActions)}>
                  <Skeleton
                    variant="rectangular"
                    style={styles.accountAction}
                  />
                </span>
              </RowFrame>
            </li>
          ))}
        </ul>
      </SectionCard>
    )}
    <SectionCard
      flush
      title={mayDo}
      variant="grouped"
      actions={<Skeleton variant="rectangular" style={styles.toolsSearch} />}
    >
      <div>
        {Array.from({ length: groups }, (_, index) => (
          <RowFrame inner={[styles.group]} key={index}>
            <span {...stylex.props(styles.accountWords)}>
              <Skeleton size="sm" style={styles.groupName} />
              <Skeleton size="sm" style={styles.groupCounts} />
            </span>
            <Skeleton size="sm" style={styles.groupChoice} />
          </RowFrame>
        ))}
      </div>
    </SectionCard>
  </output>
);
