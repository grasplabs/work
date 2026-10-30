/**
 * A titled part of an admin page on a card of its own: the kit's panel,
 * as the workspace's settings draw theirs (apps/web/src/settings/
 * settings-parts.tsx, `SettingsSection`). Its title, a line on what it
 * holds, and beside them what can be done there (`action`); under them
 * its rows or body. Named by its title, so it is a region of the page.
 */
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
} from "@grasp-os/ui/components/empty";
import {
  Panel,
  PanelDescription,
  PanelHeader,
  PanelHeading,
  PanelRow,
  PanelRowControl,
  PanelRowLabel,
  PanelTitle,
} from "@grasp-os/ui/components/panel";
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
  <Panel aria-label={title} id={id}>
    <PanelHeader>
      <PanelHeading>
        <PanelTitle>{title}</PanelTitle>
        {description === undefined ? null : (
          <PanelDescription>{description}</PanelDescription>
        )}
      </PanelHeading>
      {action}
    </PanelHeader>
    {children}
  </Panel>
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
  <PanelRow>
    <PanelRowLabel>
      <span>{label}</span>
      {description === undefined ? null : (
        <p className="text-muted-foreground">{description}</p>
      )}
    </PanelRowLabel>
    <PanelRowControl>{children}</PanelRowControl>
  </PanelRow>
);

/**
 * A part of a page with nothing to show yet: the line that says so, as
 * the workspace's cards say it (the kit's small empty state on a panel).
 */
export const EmptySection = ({ children }: { children: ReactNode }) => (
  <Panel>
    <Empty size="sm">
      <EmptyHeader>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  </Panel>
);
