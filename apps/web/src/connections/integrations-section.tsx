import { ItemGroup } from "@grasp-os/ui/components/item";
import { Text } from "@grasp-os/ui/components/text";
import type { ReactNode } from "react";

import { formatNumber } from "../format.ts";
import { SectionCard } from "./section-card.tsx";

// One list on the Integrations page: a compact Section card of Settings'
// rhythm, its name with how many apps it holds, a line about them where
// one helps, and its rows (IntegrationItem). Nothing at all when empty.

/** A list of apps under its name and count; nothing at all when it is empty. */
export const IntegrationsSection = ({
  title,
  count,
  about,
  actions,
  children,
}: {
  title: string;
  count: number;
  about?: string;
  /** Its own buttons, at the card's head (Add HTTP connection). */
  actions?: ReactNode;
  children: ReactNode;
}) => {
  if (count === 0 && actions === undefined) {
    return null;
  }
  return (
    <SectionCard
      actions={actions}
      aside={
        <Text as="span" color="muted" size="sm">
          {formatNumber(count)}
        </Text>
      }
      {...(about === undefined ? {} : { description: about })}
      flush
      title={title}
    >
      {count === 0 ? null : (
        <ItemGroup aria-label={title}>{children}</ItemGroup>
      )}
    </SectionCard>
  );
};
