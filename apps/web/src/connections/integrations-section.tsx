import type { ReactNode } from "react";

import { formatNumber } from "../format.ts";
import { ItemGroup } from "../grasp/item/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { Text } from "../grasp/text/index.ts";

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
        <Text element="span" size="sm" tone="muted">
          {formatNumber(count)}
        </Text>
      }
      density="compact"
      {...(about === undefined ? {} : { description: about })}
      flush
      title={title}
    >
      {count === 0 ? null : (
        <ItemGroup aria-label={title} separated>
          {children}
        </ItemGroup>
      )}
    </SectionCard>
  );
};
