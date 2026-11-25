import { Container } from "@grasp-os/ui/components/container";
import { PageHeader } from "@grasp-os/ui/components/page-header";
import { Skeleton } from "@grasp-os/ui/components/skeleton";
import { Icon, SearchIcon } from "@grasp-os/ui/lib/icons";
import {
  media,
  radius,
  size,
  space,
  colors,
} from "@grasp-os/ui/lib/tokens.stylex";
import { iconVars } from "@grasp-os/ui/lib/vars.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useMatchRoute } from "@tanstack/react-router";

import { useChatBarShown } from "../chat/global-chat.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import type { Crumb } from "../frame/site-header.tsx";
import { brainSections } from "./brain-sections.ts";
import { brainStyles } from "./brain-styles.ts";
import { groupLabel } from "./brain.ts";
import { PageSkeletonCards, PageSkeletonList } from "./page-skeletons.tsx";

// The Brain while its records are read on the way in (the layout's
// loader, which every page of it waits for), from the reference's frame
// (#2503's BrainPending in `frame/page-skeletons-b.tsx`): the page the
// address names, under its bar, each in its own column and the shape it
// will have, so nothing moves when it arrives. The map is a canvas: it
// waits blank.

const styles = stylex.create({
  // A pane of its own that scrolls, as the Brain's pages have.
  pane: { flexGrow: 1, minHeight: 0, overflowY: "auto" },
  // A note's page, in its reading column with room before it for a gutter.
  notePage: {
    boxSizing: "border-box",
    width: "100%",
    maxWidth: {
      default: `calc(44rem + ${space["16"]})`,
      [media.maxSm]: "44rem",
    },
    marginInline: "auto",
    paddingBlockStart: { default: space["8"], [media.maxSm]: space["2"] },
    paddingInlineStart: { default: space["16"], [media.maxSm]: 0 },
  },
  // Its text, as paragraphs of lines, the last line of each shorter.
  paragraphs: {
    display: "grid",
    gap: space["4"],
    maxWidth: "42rem",
    marginBlockStart: space["6"],
  },
  paragraph: { display: "grid" },
  last: { width: "60%" },
  // The page's tabs, under a hairline.
  tabs: {
    display: "flex",
    alignItems: "center",
    gap: space.tabGap,
    minHeight: size.controlLg,
    minWidth: 0,
    overflow: "hidden",
    boxShadow: `inset 0 -1px 0 ${colors.border}`,
  },
  w16: { width: "4rem" },
  w20: { width: "5rem" },
  w24: { width: "6rem" },
  // The search field, empty.
  search: {
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    display: "flex",
    alignItems: "center",
    boxSizing: "border-box",
    width: "100%",
    height: size.controlDefault,
    paddingInlineStart: space["3"],
    borderRadius: `min(${radius.base}, calc(${size.controlDefault} / 2))`,
    cornerShape: radius.shape,
    boxShadow: `inset 0 0 0 1px ${colors.input}`,
    color: colors.mutedForeground,
  },
});

/** Lines a paragraph of a note's text takes while it waits. */
const LINES = [3, 2];

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
 * to (`pending`), as the page shown is still the last one until the brain
 * is read.
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

/** A note's page before it arrives: its title, then its text. */
const NotePending = () => (
  <div {...stylex.props(styles.pane)}>
    <div aria-busy="true" {...stylex.props(styles.notePage)}>
      <PageHeader loading title="" />
      <div aria-hidden="true" {...stylex.props(styles.paragraphs)}>
        {LINES.map((lines, index) => (
          <div key={index} {...stylex.props(styles.paragraph)}>
            {Array.from({ length: lines }, (_, line) => (
              <Skeleton
                key={line}
                {...(line === lines - 1 ? { style: styles.last } : {})}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  </div>
);

/** The page's own placeholder, in its column; the map is a canvas, drawn when it comes. */
const BrainBody = ({ page }: { page: BrainPage }) => {
  if (page === "note") {
    return <NotePending />;
  }
  if (page === "map") {
    return null;
  }
  return (
    <div {...stylex.props(styles.pane)}>
      <Container size="lg">
        {page === "activity" ? (
          // What came in, as rows.
          <PageSkeletonList descriptionLines={1} rows={8} />
        ) : null}
        {page === "memory" || page === "opportunities" ? (
          // Its kinds of record as tabs under the title, its records as Items.
          <PageSkeletonList
            descriptionLines={1}
            rows={6}
            toolbar={
              <div aria-hidden="true" {...stylex.props(styles.tabs)}>
                <Skeleton style={styles.w20} />
                <Skeleton style={styles.w16} />
                <Skeleton style={styles.w24} />
              </div>
            }
            variant="items"
          />
        ) : null}
        {page === "sources" ? (
          // The search under the title, then the sources.
          <PageSkeletonList
            descriptionLines={0}
            rows={6}
            toolbar={
              <div aria-hidden="true" {...stylex.props(styles.search)}>
                <Icon icon={SearchIcon} />
              </div>
            }
          />
        ) : null}
        {page === "section" ? (
          // A part's notes as blocks, as the part's page has them.
          <PageSkeletonCards />
        ) : null}
      </Container>
    </div>
  );
};

/**
 * The Brain while its records are read on the way in: the page the
 * address names, under its bar. Its crumbs where the address alone says
 * them; a note's need its records, so they wait.
 */
export const BrainPending = () => {
  const { t, i18n } = useLingui();
  const chatBar = useChatBarShown();
  const { page, section } = useBrainPage();
  const brain = t`Brain`;
  const shown = brainSections.find((candidate) => candidate.slug === section);
  const crumbsOf: Record<BrainPage, Crumb[]> = {
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
    // A note's crumbs need its records: the bar waits with the Brain alone.
    note: [{ label: brain, to: "/brain" }],
  };
  return (
    <>
      <SiteHeader crumbs={crumbsOf[page]} />
      <div
        {...stylex.props(brainStyles.body, chatBar && brainStyles.underChatBar)}
      >
        <div {...stylex.props(brainStyles.page)}>
          <BrainBody page={page} />
        </div>
      </div>
    </>
  );
};
