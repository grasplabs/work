import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { Card } from "../grasp/card/index.ts";
import { Empty, EmptyHeader, EmptyDescription } from "../grasp/empty/index.ts";
import { Heading } from "../grasp/heading/index.ts";
import { PageHeader } from "../grasp/page-header/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";

// A page's body and heading. App shell gives the page its side room, the
// room under its bar and the room over the chat's bar at its foot; the
// page keeps its column to a readable width in the middle of the card.

// How wide a page's column grows: most pages, and those that lay out a
// grid (`wide`). Grasp UI has no token for a page's measure yet.
const PAGE_MEASURE = "64rem";
const WIDE_MEASURE = "80rem";

const styles = stylex.create({
  page: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space6,
    width: "100%",
    maxWidth: PAGE_MEASURE,
    marginInline: "auto",
  },
  wide: {
    maxWidth: WIDE_MEASURE,
  },
});

/** The page body: a column in the middle of the card. */
export const Page = ({
  children,
  wide = false,
}: {
  children: ReactNode;
  wide?: boolean;
}) => <div {...stylex.props(styles.page, wide && styles.wide)}>{children}</div>;

/**
 * Every page's heading, the one way to head a page: Grasp UI's PageHeader,
 * with the page's title, one quiet line under it, and the page's actions
 * at the end of the title row; `clamp` keeps a description someone wrote
 * to two lines.
 */
export const PageHeading = ({
  title,
  description,
  clamp = false,
  meta,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** At most two lines of `description`, for a description someone wrote. */
  clamp?: boolean;
  /** Beside the title: a mark that says where its subject stands, such as a status. */
  meta?: ReactNode;
  action?: ReactNode;
}) => (
  <PageHeader
    title={title}
    {...(description === undefined ? {} : { description })}
    descriptionLines={clamp ? 2 : "all"}
    {...(meta === undefined ? {} : { aside: meta })}
    {...(action === undefined ? {} : { actions: action })}
  />
);

/** A list with nothing in it: one quiet sentence in a card, where the list would be. */
export const EmptyCard = ({ children }: { children: ReactNode }) => (
  <Card>
    <Empty size="sm">
      <EmptyHeader>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  </Card>
);

/**
 * A section title inside a page, in Grasp UI's smallest heading; with
 * `count`, how many it holds beside it, small and quiet, inside the
 * heading so a list it names (`aria-labelledby`) is named with it.
 */
export const SectionTitle = ({
  children,
  count,
  id,
}: {
  children: ReactNode;
  count?: string;
  id?: string;
}) => (
  <Heading level={2} size="ui" {...(id === undefined ? {} : { id })}>
    {children}
    {count === undefined ? null : (
      <>
        {" "}
        <Text element="span" size="xs" tone="muted">
          {count}
        </Text>
      </>
    )}
  </Heading>
);
