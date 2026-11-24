import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { PageHeader } from "@grasp-os/ui/components/page-header";
import { Skeleton } from "@grasp-os/ui/components/skeleton";
import { colors, size, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { Fragment } from "react";
import type { ReactNode } from "react";

import { cardMarker } from "../apps/app-card/app-card.stylex.ts";
import { styles as cardStyles } from "../apps/app-card/styles.ts";

// The Brain's pages before their data, from the reference's library
// (#2503's `blocks/page-skeleton-list`): the header's placeholders, then
// quiet rows in the rows' own boxes, so nothing moves when the page
// arrives. Damsko has no page skeletons: the Brain's own, on Damsko's
// PageHeader, Item and Skeleton.

const styles = stylex.create({
  page: { display: "grid", gap: space["6"], minWidth: 0 },
  // A waiting card's frame: the reference's sea ground (its app card's tone when no drawn ground
  // is given), a glow from its top corner and the paper's grain over it. The card's own values,
  // as the App card keeps its own (apps/app-card/app-card.stylex.ts).
  sea: {
    backgroundImage: `radial-gradient(90% 70% at 18% 0%, light-dark(oklch(1 0 0 / 0.32), oklch(1 0 0 / 0.06)), transparent 70%), linear-gradient(155deg, light-dark(oklch(0.82 0.032 222), oklch(0.33 0.03 222)) 8%, light-dark(oklch(0.91 0.03 88), oklch(0.36 0.028 88)) 92%)`,
  },
  grain: {
    position: "absolute",
    inset: 0,
    zIndex: -1,
    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='g'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix values='1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 0 0 0 0 1'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url%28%23g%29'/%3E%3C/svg%3E")`,
    backgroundSize: "180px 180px",
    mixBlendMode: "overlay",
    opacity: 0.32,
    pointerEvents: "none",
  },
  windowWait: { position: "absolute", inset: 0, width: "100%", height: "100%" },
  headingWait: { width: "8rem", maxWidth: "100%", height: "1.5rem" },
  metaLine: { width: "10rem", maxWidth: "100%" },
  avatarWait: { flexShrink: 0, width: size.avatarXs, height: size.avatarXs },
  // A one-line row, as the reference's row list draws one: 44px, the
  // panel's inset, a hairline over every row but the first.
  rows: { display: "grid", margin: 0, padding: 0, listStyle: "none" },
  row: {
    display: "flex",
    alignItems: "center",
    gap: space["2"],
    boxSizing: "border-box",
    height: size.tapTarget,
    minWidth: 0,
    paddingInline: space.sidePanelPadding,
    borderBlockStartWidth: { default: 0, ":not(:first-child)": size.hairline },
    borderBlockStartStyle: "solid",
    borderBlockStartColor: colors.border,
  },
  icon: { flexShrink: 0, width: size.iconSm, height: size.iconSm },
  w40: { width: "6rem" },
  w48: { width: "8rem" },
  w56: { width: "10rem" },
  w64: { width: "7rem" },
  detail: { width: "4rem", marginInlineStart: "auto" },
});

/** A row's name while it waits: its width by its place, so the rows don't line up as one block. */
const NameLine = ({ index }: { index: number }) => {
  switch (index % 8) {
    case 0:
    case 4: {
      return <Skeleton size="sm" style={styles.w56} />;
    }
    case 1:
    case 5: {
      return <Skeleton size="sm" style={styles.w40} />;
    }
    case 2:
    case 7: {
      return <Skeleton size="sm" style={styles.w64} />;
    }
    default: {
      return <Skeleton size="sm" style={styles.w48} />;
    }
  }
};

/** A list page before its rows: the header's placeholders, then quiet rows in the rows' own boxes. */
export const PageSkeletonList = ({
  rows = 6,
  descriptionLines = 1,
  variant = "rows",
  header = true,
  toolbar,
}: {
  /** How many rows to hold room for: as many as the page shows at first. */
  rows?: number;
  /** How many lines the page's description takes, so the header keeps its height. */
  descriptionLines?: number;
  /** `rows`, one-line rows (44px); `items`, Items two lines high with an icon in its square. */
  variant?: "rows" | "items";
  /** The page's own header; `false` where the page draws its title already. */
  header?: boolean;
  /** Between the header and the rows: the page's tabs or search, as a placeholder of their kind. */
  toolbar?: ReactNode;
}) => (
  <div
    aria-busy="true"
    data-slot="page-skeleton-list"
    {...stylex.props(styles.page)}
  >
    {header ? (
      <PageHeader
        description={descriptionLines > 0 ? "" : undefined}
        loading
        loadingLines={descriptionLines}
        title=""
      />
    ) : null}
    {toolbar}
    <div aria-hidden="true">
      {variant === "items" ? (
        <ItemGroup>
          {Array.from({ length: rows }, (_, index) => (
            <Fragment key={index}>
              {index > 0 ? <ItemSeparator /> : null}
              <Item loading>
                <ItemMedia variant="icon" />
                <ItemContent>
                  <ItemTitle />
                  <ItemDescription />
                </ItemContent>
              </Item>
            </Fragment>
          ))}
        </ItemGroup>
      ) : (
        <ul {...stylex.props(styles.rows)}>
          {Array.from({ length: rows }, (_, index) => (
            <li key={index} {...stylex.props(styles.row)}>
              <Skeleton style={styles.icon} variant="rectangular" />
              <NameLine index={index} />
              <Skeleton size="sm" style={styles.detail} />
            </li>
          ))}
        </ul>
      )}
    </div>
  </div>
);

/**
 * A page of cards before them (the reference's page-skeleton-cards, of its
 * App cards' `loading`): the header's placeholder, then each card's frame
 * on its ground with its window waiting, its title's line, one line of
 * description and its meta.
 */
export const PageSkeletonCards = ({ cards = 6 }: { cards?: number }) => (
  <div data-slot="page-skeleton-cards" {...stylex.props(styles.page)}>
    <PageHeader loading loadingLines={0} title="" />
    <div {...stylex.props(cardStyles.room)}>
      <div {...stylex.props(cardStyles.grid)}>
        {Array.from({ length: cards }, (_, index) => (
          <article
            aria-busy="true"
            data-loading=""
            data-slot="app-card"
            key={index}
            {...stylex.props(cardStyles.card, cardMarker)}
          >
            <div {...stylex.props(cardStyles.frame, styles.sea)}>
              <span aria-hidden="true" {...stylex.props(styles.grain)} />
              <div {...stylex.props(cardStyles.window)}>
                <Skeleton style={styles.windowWait} variant="rectangular" />
              </div>
            </div>
            <div aria-hidden="true" {...stylex.props(cardStyles.words)}>
              <div {...stylex.props(cardStyles.titleRow)}>
                <Skeleton style={styles.headingWait} />
              </div>
              <div {...stylex.props(cardStyles.description)}>
                <Skeleton />
              </div>
              <p {...stylex.props(cardStyles.meta)}>
                <Skeleton style={styles.avatarWait} variant="circular" />
                <Skeleton style={styles.metaLine} />
              </p>
            </div>
          </article>
        ))}
      </div>
    </div>
  </div>
);
