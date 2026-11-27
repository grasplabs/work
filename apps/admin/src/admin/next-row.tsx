/**
 * The row a page leads with when one thing comes next: what it is, who it
 * waits on and for how long, and the page's one primary action, which
 * goes where it is settled. An organization's overview leads with it; a
 * section that has one thing to do next does too.
 */
import { Badge } from "@grasp-os/ui/components/badge";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Section, SectionHeader } from "@grasp-os/ui/components/section-header";
import { Icon } from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

const styles = stylex.create({
  // Who it waits on, then how long: one line that wraps on a phone.
  waits: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: space["2"],
    rowGap: space["1"],
  },
});

/** Who it waits on, as a Badge (amber for Grasp, quiet for the company), then the rest of the line. */
export const WaitsOn = ({
  grasp,
  words,
  children,
}: {
  /** It waits on Grasp: the amber of what needs someone here. */
  grasp: boolean;
  words: string;
  children?: ReactNode;
}) => (
  <span {...stylex.props(styles.waits)}>
    <Badge variant={grasp ? "warning" : "default"}>{words}</Badge>
    {children === undefined ? null : <span>{children}</span>}
  </span>
);

/** A page's Next: one row, its icon, what comes next, a line under it, and its one action. */
export const NextRow = ({
  icon,
  title,
  description,
  action,
}: {
  icon: IconData;
  title: ReactNode;
  description: ReactNode;
  /** The page's primary Button: there is none while nothing waits. */
  action?: ReactNode;
}) => (
  <Section aria-labelledby="next">
    <SectionHeader id="next" size="sm" title="Next" variant="group" />
    <Item variant="outline">
      <ItemMedia variant="icon">
        <Icon icon={icon} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{title}</ItemTitle>
        <ItemDescription>{description}</ItemDescription>
      </ItemContent>
      {action === undefined ? null : <ItemActions>{action}</ItemActions>}
    </Item>
  </Section>
);
