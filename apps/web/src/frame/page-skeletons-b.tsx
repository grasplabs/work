import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useMatchRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { brainSections } from "../brain/brain-sections.ts";
import { groupLabel } from "../brain/brain.ts";
import { AppShellBar } from "../grasp/app-shell/index.ts";
import { PageSkeletonBand } from "../grasp/blocks/page-skeleton-band/page-skeleton-band.tsx";
import { PageSkeletonCards } from "../grasp/blocks/page-skeleton-cards/page-skeleton-cards.tsx";
import { PageSkeletonList } from "../grasp/blocks/page-skeleton-list/page-skeleton-list.tsx";
import { PageSkeletonSettings } from "../grasp/blocks/page-skeleton-settings/page-skeleton-settings.tsx";
import { PageSkeletonToolbar } from "../grasp/blocks/page-skeleton-toolbar/page-skeleton-toolbar.tsx";
import { PageColumn } from "../grasp/page-column/index.ts";
import { PageHeader } from "../grasp/page-header/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import { SiteHeader } from "./site-header.tsx";
import type { Crumb } from "./site-header.tsx";

// The pending pages (a route's `pendingComponent`, its first paint before
// its loader's data) of the Apps, Chat, Brain and Workflows: each the
// library's whole-page skeleton block for the page's shape, in the page's
// own column, under the bar the page will have, so nothing moves when it
// arrives. Only the layout around a block is drawn here (the column a
// page stands in), never a skeleton of our own: where no block has a
// page's shape, the closest one stands in.

const styles = stylex.create({
  // A page that fills the card (frame/page-fill.ts): what is under the bar.
  fill: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: 0,
    minHeight: 0,
  },
  // A pane of its own that scrolls, as the Brain's pages and settings have.
  pane: { flexGrow: 1, minHeight: 0, overflowY: "auto" },
  // A note's page, as the route lays out the library's page-brain: its inset, then page-brain's
  // reading column with its gutter's room before it on a wider window.
  brainPagePane: {
    paddingInline: { default: grasp.space6, [media.fromTablet]: grasp.space12 },
  },
  brainPage: {
    boxSizing: "border-box",
    width: "100%",
    maxWidth: {
      default: `calc(44rem + ${grasp.space16})`,
      [media.belowPhone]: "44rem",
    },
    marginInline: "auto",
    paddingBlockStart: {
      default: grasp.space8,
      [media.belowPhone]: grasp.space2,
    },
    paddingInlineStart: { default: grasp.space16, [media.belowPhone]: 0 },
  },
  // An App's or a workflow's settings column (app-settings.tsx,
  // workflow-settings.tsx): their measure, in the middle.
  settingsColumn: {
    boxSizing: "border-box",
    width: "100%",
    maxWidth: "56rem",
    marginInline: "auto",
    paddingBlock: grasp.space6,
    paddingInline: grasp.space4,
  },
});

/** The bar while what it names is still coming: its crumbs a placeholder. */
export const LoadingBar = () => {
  const { t } = useLingui();
  return <AppShellBar loading words={{ breadcrumb: t`Breadcrumb` }} />;
};

/** What fills the card under the bar, for a page that fills it. */
export const Fill = ({ children }: { children: ReactNode }) => (
  <div {...stylex.props(styles.fill)}>{children}</div>
);

/** An App's General (app-settings.tsx): About's facts, its owner, its copies. */
export const APP_GENERAL = [5, 1, 1] as const;

/** A workflow's General (workflow-settings.tsx): About's facts, then deleting it. */
export const WORKFLOW_GENERAL = [3, 1] as const;

/**
 * A settings section of an App or a workflow before its values, General's
 * cards: `sections`, how many settings each holds, as that General has them.
 */
export const SettingsPending = ({
  sections,
}: {
  sections: readonly number[];
}) => (
  <div {...stylex.props(styles.pane)}>
    <div {...stylex.props(styles.settingsColumn)}>
      {/* No header: the cards stand at the column's top, under the App's or workflow's own bar. */}
      <PageSkeletonSettings header={false} sections={sections} />
    </div>
  </div>
);

/**
 * A note's page before it arrives, as its Brain page stands (the library's page-brain): its title,
 * then its text, in page-brain's column. No block has a Brain page's shape yet: a page header's
 * own loading and the band's text, without its band, stand in.
 */
export const NotePending = () => (
  <div {...stylex.props(styles.pane, styles.brainPagePane)}>
    <div {...stylex.props(styles.brainPage)}>
      <PageHeader loading title="" />
      <PageSkeletonBand header={false} paragraphs={2} />
    </div>
  </div>
);

/** The Brain's page the address names, as the layout lays it out. */
type BrainPage =
  | "map"
  | "activity"
  | "memory"
  | "opportunities"
  | "sources"
  | "section"
  | "note";

/**
 * Which of the Brain's pages the address names: the address being gone
 * to (`pending`), as the page shown is still the last one until the
 * brain is read.
 */
const useBrainPage = (): { page: BrainPage; section: string | undefined } => {
  const matchRoute = useMatchRoute();
  const at = (to: string) => matchRoute({ to, pending: true }) !== false;
  if (at("/brain/activity")) {
    return { page: "activity", section: undefined };
  }
  // Memories and Skills: each a list of records under its title.
  if (at("/brain/memories") || at("/brain/skills")) {
    return { page: "memory", section: undefined };
  }
  if (at("/brain/opportunities")) {
    return { page: "opportunities", section: undefined };
  }
  if (at("/brain/sources")) {
    return { page: "sources", section: undefined };
  }
  const section = matchRoute({
    to: "/brain/sections/$sectionId",
    pending: true,
  });
  if (section !== false) {
    return { page: "section", section: section.sectionId };
  }
  return { page: at("/brain") ? "map" : "note", section: undefined };
};

/** The page's own skeleton, in its column; the map is a canvas no block draws. */
const BrainBody = ({ page }: { page: BrainPage }) => {
  if (page === "note") {
    return <NotePending />;
  }
  if (page === "map") {
    return null;
  }
  return (
    <div {...stylex.props(styles.pane)}>
      {/* Every Brain page's column: the library's, as wide as a page. */}
      <PageColumn measure="page">
        {page === "activity" ? (
          // What came in since the last look, as a list of rows.
          <PageSkeletonList descriptionLines={1} rows={8} />
        ) : null}
        {page === "memory" || page === "opportunities" ? (
          // Its kinds of record as tabs under the title, its records as Items.
          <PageSkeletonList
            descriptionLines={1}
            rows={6}
            toolbar={<PageSkeletonToolbar variant="tabs" />}
            variant="items"
          />
        ) : null}
        {page === "sources" ? (
          // The search under the title, then the sources.
          <PageSkeletonList
            descriptionLines={0}
            rows={6}
            toolbar={<PageSkeletonToolbar icon={false} variant="search" />}
          />
        ) : null}
        {page === "section" ? (
          // A part's notes as blocks, three to a row as the part's page has them.
          <PageSkeletonCards
            cardLines={1}
            cards={6}
            density="dense"
            descriptionLines={0}
          />
        ) : null}
      </PageColumn>
    </div>
  );
};

/**
 * The Brain while its records are read on the way in (the layout's
 * loader, which every page of it waits for): the page the address names,
 * under its bar. Its crumbs where the address alone says them; a note's
 * need its records, so they wait.
 */
export const BrainPending = () => {
  const { t, i18n } = useLingui();
  const { page, section } = useBrainPage();
  const brain = t`Brain`;
  const shown = brainSections.find((candidate) => candidate.slug === section);
  const crumbsOf: Record<Exclude<BrainPage, "note">, Crumb[]> = {
    map: [{ label: brain }],
    activity: [
      { label: brain, to: "/brain" },
      { label: t({ message: "Activity", context: "the brain's log" }) },
    ],
    // As the layout says them while they show: the Brain alone.
    memory: [{ label: brain }],
    opportunities: [
      { label: brain, to: "/brain" },
      {
        label: t({
          message: "Opportunities",
          context: "the Brain's opportunities page",
        }),
      },
    ],
    sources: [
      { label: brain, to: "/brain" },
      { label: t({ message: "Sources", context: "the Brain's sources page" }) },
    ],
    section:
      shown === undefined
        ? [{ label: brain, to: "/brain" }]
        : [
            { label: brain, to: "/brain" },
            { label: i18n._(groupLabel[shown.group]) },
          ],
  };
  return (
    <>
      {page === "note" ? (
        <LoadingBar />
      ) : (
        <SiteHeader crumbs={crumbsOf[page]} />
      )}
      <Fill>
        <BrainBody page={page} />
      </Fill>
    </>
  );
};
