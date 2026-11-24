import { Card, CardContent, CardHeader } from "@grasp-os/ui/components/card";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { PageHeader } from "@grasp-os/ui/components/page-header";
import { SectionHeader } from "@grasp-os/ui/components/section-header";
import { colors, radius, size, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";

import { SeparatedItems } from "../workflows/separated-items.tsx";

// The Projects pages before what they read arrives, as #2503's library drew
// them (its page skeletons, list and record, which the rename map moves to
// the product): the page's header waiting, then quiet Items in the rows'
// own boxes, so nothing moves when it comes.

const styles = stylex.create({
  page: { display: "grid", gap: space[6], minWidth: 0 },
  // A head action's own empty frame: a small button's height and corner, a
  // short word's width, its hairline edge and no fill, standing still.
  action: {
    boxSizing: "border-box",
    width: "4.5rem",
    height: size.controlSm,
    borderRadius: `min(${radius.base}, calc(${size.controlSm} / 2))`,
    cornerShape: radius.shape,
    boxShadow: `inset 0 0 0 1px ${colors.input}`,
  },
});

/** A row waiting: a two-line Item with its icon's square. */
const QuietRow = () => (
  <Item loading size="sm">
    <ItemMedia variant="icon" />
    <ItemContent>
      <ItemTitle />
      <ItemDescription />
    </ItemContent>
  </Item>
);

/** Quiet rows, a hairline between. */
const Rows = ({ rows }: { rows: number }) => {
  const quiet = Array.from({ length: rows }, (_, index) => ({
    key: String(index),
    row: <QuietRow />,
  }));
  return <SeparatedItems rows={quiet} />;
};

/** Projects waiting: its header (it has no description), then a screen of rows. */
export const ProjectsSkeleton = ({ rows }: { rows: number }) => (
  <div aria-busy="true" {...stylex.props(styles.page)}>
    <PageHeader loading loadingLines={0} title="" />
    <div aria-hidden="true">
      <Rows rows={rows} />
    </div>
  </div>
);

/** A project waiting: its header and goal, then a card of rows with its head's action. */
export const ProjectSkeleton = ({ rows }: { rows: number }) => (
  <div {...stylex.props(styles.page)}>
    <PageHeader description="" loading loadingLines={1} size="sm" title="" />
    <Card aria-hidden="true" padding="none">
      <CardHeader>
        <SectionHeader
          actions={<span {...stylex.props(styles.action)} />}
          loading
          size="sm"
          title=""
        />
      </CardHeader>
      <CardContent>
        <Rows rows={rows} />
      </CardContent>
    </Card>
  </div>
);
