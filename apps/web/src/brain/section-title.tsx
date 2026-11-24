import { Heading } from "@grasp-os/ui/components/heading";
import { Text } from "@grasp-os/ui/components/text";
import type { ReactNode } from "react";

/**
 * A section title inside one of the Brain's pages; with `count`, how many it
 * holds beside it, small and quiet. The reference's frame has it
 * (#2503's `frame/page.tsx`); the frame here still draws the old kit's.
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
  <Heading level={2} size="xs" {...(id === undefined ? {} : { id })}>
    {children}
    {count === undefined ? null : (
      <>
        {" "}
        <Text as="span" color="muted" size="xs">
          {count}
        </Text>
      </>
    )}
  </Heading>
);
