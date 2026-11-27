/**
 * Rows of facts in a part of an admin page, straight on the page: each
 * what it is, a line on it, and at its end its value or what can be done
 * there.
 */
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import type { ReactNode } from "react";

/** The rows, one under another, a line between them. */
export const PartRows = ({ children }: { children: ReactNode }) => (
  <ItemGroup separated>{children}</ItemGroup>
);

/** One row: its label, a line on it, and its value at its end. */
export const PartRow = ({
  label,
  description,
  children,
}: {
  label: string;
  description?: ReactNode;
  children: ReactNode;
}) => (
  <Item size="sm">
    <ItemContent>
      <ItemTitle>{label}</ItemTitle>
      {description === undefined ? null : (
        <ItemDescription>{description}</ItemDescription>
      )}
    </ItemContent>
    <ItemActions>{children}</ItemActions>
  </Item>
);
