/**
 * A titled part of an admin page on a card of its own, drawn with
 * Damsko's Card: its title, a line on what it holds, and beside them what
 * can be done there (`action`); under them its card parts (a CardContent,
 * edge to edge as `flush` for a table or a list, and a CardFooter). Named
 * by its title, so it is a region of the page. The Damsko counterpart of
 * section.tsx's `Section`, which the pages still on the kit keep until
 * their area moves.
 */
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
} from "@grasp-os/ui/components/empty";
import { Text } from "@grasp-os/ui/components/text";
import type { ReactNode } from "react";

export const Panel = ({
  id,
  title,
  description,
  action,
  children,
}: {
  /** Where a link on the page leads to it. */
  id?: string;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  /** Its card parts. */
  children?: ReactNode;
}) => (
  <Card aria-label={title} asChild size="sm">
    <section id={id}>
      <CardHeader>
        <CardTitle level={2}>{title}</CardTitle>
        {description === undefined ? null : (
          <CardDescription>{description}</CardDescription>
        )}
        {action === undefined ? null : <CardAction>{action}</CardAction>}
      </CardHeader>
      {children}
    </section>
  </Card>
);

/** A line in a panel saying there is nothing to show. */
export const PanelNote = ({ children }: { children: ReactNode }) => (
  <CardContent>
    <Text color="muted" size="sm">
      {children}
    </Text>
  </CardContent>
);

/**
 * A part of a page with nothing to show yet: the line that says so, on a
 * card of its own.
 */
export const EmptyPanel = ({ children }: { children: ReactNode }) => (
  <Card size="sm">
    <Empty size="sm">
      <EmptyHeader>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  </Card>
);
