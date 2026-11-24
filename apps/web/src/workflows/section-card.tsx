import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import { Heading } from "@grasp-os/ui/components/heading";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { useId } from "react";
import type { ReactNode } from "react";

import { InfoTip } from "./info-tip.tsx";

// One part of a workflow's page on a dense card, a landmark of its own:
// its title (with more about it behind an info mark, where it says more),
// what it holds, and a footer row. Composed from Damsko's Card, as the
// old library's section card was a card of these parts.

const styles = stylex.create({
  // The title and its info mark on one line, the mark outside the heading
  // so the card's name stays its title alone.
  titled: { display: "flex", alignItems: "center", gap: space["1"] },
  // A card that is its heading alone: the title and its actions on one row.
  row: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space["4"],
  },
  actions: { display: "flex", alignItems: "center", gap: space["2"] },
});

export const SectionCard = ({
  title,
  description,
  info,
  actions,
  flush = false,
  footer,
  level = 2,
  children,
  "aria-label": label,
}: {
  /** What the part is, as its heading; or `aria-label` alone, with no heading. */
  title?: string;
  /** A sentence under the title. */
  description?: string;
  /** More about it, behind an info mark beside its title. */
  info?: string;
  /** What it does, at the end of its heading. */
  actions?: ReactNode;
  /** What it holds runs edge to edge under a hairline: a table, a list. */
  flush?: boolean;
  footer?: ReactNode;
  level?: 2 | 3;
  children?: ReactNode;
  "aria-label"?: string;
}) => {
  const titleId = useId();
  const hasActions = actions !== undefined && actions !== null;
  const bare = children === undefined || children === null;
  // A heading alone: Damsko's dense card sizes its title by what follows
  // it, so this row draws itself, the title at the dense card's size, as
  // the old section card did.
  if (bare && title !== undefined && footer === undefined) {
    return (
      <Card aria-labelledby={titleId} asChild size="sm">
        <section>
          <CardContent>
            <div {...stylex.props(styles.row)}>
              <div {...stylex.props(styles.titled)}>
                <Heading id={titleId} level={level} size="2xs">
                  {title}
                </Heading>
                {info === undefined ? null : (
                  <InfoTip about="section">{info}</InfoTip>
                )}
              </div>
              {hasActions ? (
                <div {...stylex.props(styles.actions)}>{actions}</div>
              ) : null}
            </div>
          </CardContent>
        </section>
      </Card>
    );
  }
  return (
    <Card
      asChild
      size="sm"
      {...(label === undefined ? {} : { "aria-label": label })}
    >
      <section>
        {title === undefined && !hasActions ? null : (
          <CardHeader>
            {title === undefined ? null : (
              <div {...stylex.props(styles.titled)}>
                <CardTitle level={level}>{title}</CardTitle>
                {info === undefined ? null : (
                  <InfoTip about="section">{info}</InfoTip>
                )}
              </div>
            )}
            {description === undefined ? null : (
              <CardDescription>{description}</CardDescription>
            )}
            {hasActions ? <CardAction>{actions}</CardAction> : null}
          </CardHeader>
        )}
        {bare ? null : <CardContent flush={flush}>{children}</CardContent>}
        {footer === undefined ? null : <CardFooter>{footer}</CardFooter>}
      </section>
    </Card>
  );
};
