/**
 * A titled part of an admin page on a card of its own: the kit's panel
 * card, as the workspace's settings draw theirs (apps/web/src/settings/
 * settings-parts.tsx, `SettingsSection`). Its title, a line on what it
 * holds, and beside them what can be done there (`action`); under them
 * its rows or body. Named by its title, so it is a region of the page.
 */
import {
  Card,
  CardAction,
  CardDescription,
  CardHeader,
  CardRow,
  CardRowControl,
  CardRowLabel,
  CardTitle,
} from "@grasp-os/ui/components/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
} from "@grasp-os/ui/components/empty";
import type { ReactNode } from "react";

export const Section = ({
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
  children?: ReactNode;
}) => (
  <Card aria-label={title} id={id} render={<section />} variant="panel">
    <CardHeader>
      <CardTitle>
        <h2>{title}</h2>
      </CardTitle>
      {description === undefined ? null : (
        <CardDescription>{description}</CardDescription>
      )}
      {action === undefined ? null : <CardAction>{action}</CardAction>}
    </CardHeader>
    {children}
  </Card>
);

/** One row of a section: what it is and why on the left, where it stands on the right. */
export const SectionRow = ({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: ReactNode;
}) => (
  <CardRow>
    <CardRowLabel>
      <span>{label}</span>
      {description === undefined ? null : (
        <p className="text-muted-foreground">{description}</p>
      )}
    </CardRowLabel>
    <CardRowControl>{children}</CardRowControl>
  </CardRow>
);

/**
 * A part of a page with nothing to show yet: the line that says so, as
 * the workspace's cards say it (the kit's small empty state on a panel).
 */
export const EmptySection = ({ children }: { children: ReactNode }) => (
  <Card variant="panel">
    <Empty size="sm">
      <EmptyHeader>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  </Card>
);
