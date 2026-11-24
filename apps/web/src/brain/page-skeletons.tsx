import {
  Item,
  ItemContent,
  ItemDescription,
  ItemDetail,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { PageHeader } from "@grasp-os/ui/components/page-header";
import { Skeleton } from "@grasp-os/ui/components/skeleton";
import { size, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { Fragment } from "react";
import type { ReactNode } from "react";

// The Brain's pages before their data, from the reference's library
// (#2503's `blocks/page-skeleton-list`): the header's placeholders, then
// quiet rows in the rows' own boxes, so nothing moves when the page
// arrives. Damsko has no page skeletons: the Brain's own, on Damsko's
// PageHeader, Item and Skeleton.

const styles = stylex.create({
  page: { display: "grid", gap: space["6"], minWidth: 0 },
  lead: {
    display: "flex",
    alignItems: "center",
    gap: space["2"],
  },
  icon: { flexShrink: 0, width: size.iconSm, height: size.iconSm },
  w40: { width: "6rem" },
  w48: { width: "8rem" },
  w56: { width: "10rem" },
  w64: { width: "7rem" },
  detail: { width: "4rem" },
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
      <ItemGroup>
        {Array.from({ length: rows }, (_, index) => (
          <Fragment key={index}>
            {index > 0 ? <ItemSeparator /> : null}
            {variant === "items" ? (
              <Item loading>
                <ItemMedia variant="icon" />
                <ItemContent>
                  <ItemTitle />
                  <ItemDescription />
                </ItemContent>
              </Item>
            ) : (
              <Item size="xs">
                <ItemContent>
                  <ItemTitle>
                    <span {...stylex.props(styles.lead)}>
                      <Skeleton style={styles.icon} variant="rectangular" />
                      <NameLine index={index} />
                    </span>
                    <ItemDetail>
                      <Skeleton size="sm" style={styles.detail} />
                    </ItemDetail>
                  </ItemTitle>
                </ItemContent>
              </Item>
            )}
          </Fragment>
        ))}
      </ItemGroup>
    </div>
  </div>
);
