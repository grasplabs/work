/**
 * A titled part of an admin page, straight on the page as Grasp Work sets
 * its parts (no card round it): its title as a group heading, a line on
 * what it holds, and beside them what can be done there (`action`); its
 * content under them. Named by its title, so it is a region of the page.
 */
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
} from "@grasp-os/ui/components/empty";
import { Section, SectionHeader } from "@grasp-os/ui/components/section-header";
import { Text } from "@grasp-os/ui/components/text";
import { useId } from "react";
import type { ReactNode } from "react";

export const PagePart = ({
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
}) => {
  const fallback = useId();
  const heading = id ?? fallback;
  return (
    <Section aria-labelledby={heading}>
      <SectionHeader
        actions={action}
        description={description}
        id={heading}
        size="sm"
        title={title}
        variant="group"
      />
      {children}
    </Section>
  );
};

/** A quiet line in a part: what it says when there is little to show. */
export const PartNote = ({ children }: { children: ReactNode }) => (
  <Text color="muted" size="sm">
    {children}
  </Text>
);

/** A part of a page with nothing to show yet: the product's empty state, the line that says so. */
export const EmptyPart = ({ children }: { children: ReactNode }) => (
  <Empty align="start" size="sm">
    <EmptyHeader>
      <EmptyDescription>{children}</EmptyDescription>
    </EmptyHeader>
  </Empty>
);
