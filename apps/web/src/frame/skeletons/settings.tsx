import { Card, CardContent } from "@grasp-os/ui/components/card";
import { Field, FieldContent, FieldGroup } from "@grasp-os/ui/components/field";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { SectionHeader } from "@grasp-os/ui/components/section-header";
import { Skeleton } from "@grasp-os/ui/components/skeleton";
import { colors, radius, size, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { Fragment } from "react";

// A settings section's pending state (a route's first paint, before its
// values), built from the parts the section will show, so nothing moves
// when it arrives: a group per part, its title a placeholder over its card
// (as settings/section.tsx's SettingsGroup), each holding rows whose
// name's and help's lines are quiet, with a small control's empty frame in
// the control's place. Under the Settings layout, which draws the page's
// title. The old library's settings page skeleton; Damsko has none (page
// skeletons are the product's, the rename map's
// "page-skeleton-settings → apps/web/src/frame/skeletons/settings.tsx").
//
//   <PageSkeletonSettings sections={[3, 2]} />
//   <PageSkeletonSettings help={false} sections={[{ rows: 2, title: false }, 3]} />
//   <PageSkeletonSettings sections={[2, { rows: 3, variant: "items" }]} />   a card listing things (devices)

/** The level lines a chart draws (its y axis's ticks), the lowest its baseline. */
const LINES = 5;
/** Where a chart draws inside its box (Damsko's chart's own room). */
const inset = { top: 8, right: 8 } as const;
const axisRoom = { x: 30, y: 36 } as const;

const styles = stylex.create({
  // The sections, a section's gap apart, as the loaded settings page lays them.
  page: { display: "grid", gap: space.sectionHeaderGap, minWidth: 0 },
  group: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    rowGap: space["2"],
    minWidth: 0,
  },
  head: { paddingInline: space["4"] },
  // A small control's own empty frame (an Input or a Select at size sm),
  // across the control's column: its height, its corner and its hairline
  // edge, with no fill and nothing in it.
  control: {
    boxSizing: "border-box",
    width: "100%",
    height: size.controlSm,
    borderRadius: `min(${radius.base}, calc(${size.controlSm} / 2))`,
    cornerShape: radius.shape,
    boxShadow: `inset 0 0 0 1px ${colors.input}`,
  },
  name: { width: "9rem", maxWidth: "100%" },
  help: { width: "16rem", maxWidth: "100%" },
  // The chart's frame while it waits: its level lines where the chart
  // draws them, dotted 2 on 2 as its grid's, and nothing filled.
  frame: (height: number) => ({ position: "relative", width: "100%", height }),
  level: (top: number) => ({
    position: "absolute",
    top,
    left: axisRoom.y,
    right: inset.right,
    height: 1,
    backgroundImage: `repeating-linear-gradient(to right, ${colors.border} 0 2px, transparent 2px 4px)`,
  }),
});

/** A section given in full: its rows, and whether a title stands over it. */
interface SkeletonSection {
  /** How many settings it holds (none for a chart's card). @default 0 */
  rows?: number;
  /** A title over the card. @default true */
  title?: boolean;
  /**
   * `settings`, rows with a control; `items`, two-line Items at the
   * setting rows' size, for a list of things (Security's devices);
   * `chart`, a chart's own frame at 240px (AI and spend). @default "settings"
   */
  variant?: "settings" | "items" | "chart";
}

/** The rows of a card waiting: names and helps quiet, a small control's box in each one's place. */
const Rows = ({ rows, help }: { rows: number; help: boolean }) => (
  <FieldGroup>
    {Array.from({ length: rows }, (_, row) => (
      <Field key={row} orientation="responsive">
        <FieldContent>
          <Skeleton size="sm" style={styles.name} />
          {help ? <Skeleton size="sm" style={styles.help} /> : null}
        </FieldContent>
        <span {...stylex.props(styles.control)} />
      </Field>
    ))}
  </FieldGroup>
);

/** A list of things in a settings card waiting: two-line Items at the setting rows' size. */
const ItemRows = ({ rows }: { rows: number }) => (
  <ItemGroup>
    {Array.from({ length: rows }, (_, row) => (
      <Fragment key={row}>
        {row === 0 ? null : <ItemSeparator />}
        <Item loading size="xs">
          <ItemMedia />
          <ItemContent>
            <ItemTitle />
            <ItemDescription />
          </ItemContent>
        </Item>
      </Fragment>
    ))}
  </ItemGroup>
);

/** A chart's level lines at their places, with no marks. */
const ChartFrame = ({ height }: { height: number }) => {
  const plot = height - inset.top - axisRoom.x;
  return (
    <div aria-hidden="true" {...stylex.props(styles.frame(height))}>
      {Array.from({ length: LINES }, (_, index) => (
        <span
          key={index}
          {...stylex.props(
            styles.level(inset.top + (plot * index) / (LINES - 1))
          )}
        />
      ))}
    </div>
  );
};

/** One section's rows: setting rows, a list of things, or a chart's frame. */
const SectionRows = ({
  section,
  help,
}: {
  section: SkeletonSection;
  help: boolean;
}) => {
  const rows = section.rows ?? 0;
  if (section.variant === "chart") {
    return <ChartFrame height={240} />;
  }
  return section.variant === "items" ? (
    <ItemRows rows={rows} />
  ) : (
    <Rows help={help} rows={rows} />
  );
};

/** One section waiting: its title's placeholder over its card, or the card alone. */
const Section = ({
  section,
  help,
}: {
  section: SkeletonSection;
  help: boolean;
}) => {
  // A chart stands inside the card's inset; rows run to its edges.
  const card = (
    <Card size="sm">
      <CardContent flush={section.variant !== "chart"}>
        <SectionRows help={help} section={section} />
      </CardContent>
    </Card>
  );
  if (section.title === false) {
    return <div aria-hidden="true">{card}</div>;
  }
  return (
    <div {...stylex.props(styles.group)}>
      <div {...stylex.props(styles.head)}>
        <SectionHeader loading title="" variant="group" />
      </div>
      {card}
    </div>
  );
};

const twoSections = [3, 2] as const;

/** A settings section before its values: each part's quiet rows under its title's placeholder. */
export const PageSkeletonSettings = ({
  sections = twoSections,
  help = true,
}: {
  /** Each part, top to bottom: how many settings it holds, or the part in full. @default [3, 2] */
  sections?: readonly (number | SkeletonSection)[];
  /** Each row has a help line under its name. `false` where it sits behind an info mark. @default true */
  help?: boolean;
}) => (
  <div aria-busy="true" {...stylex.props(styles.page)}>
    {sections.map((section, index) => (
      <Section
        key={index}
        help={help}
        section={typeof section === "number" ? { rows: section } : section}
      />
    ))}
  </div>
);
