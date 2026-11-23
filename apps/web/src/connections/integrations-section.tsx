import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import { ItemGroup } from "@grasp-os/ui/components/item";
import { Text } from "@grasp-os/ui/components/text";
import type { ReactNode } from "react";

import { formatNumber } from "../format.ts";

// One list on the Integrations page: a compact card of Settings' rhythm, its name with how many apps it holds, a line about them where
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
    <Card asChild size="sm">
      <section aria-label={title}>
        <CardHeader>
          <CardTitle level={2}>{title}</CardTitle>
          {about === undefined ? null : (
            <CardDescription>{about}</CardDescription>
          )}
          <CardAction>
            <Text as="span" color="muted" size="sm">
              {formatNumber(count)}
            </Text>
            {actions}
          </CardAction>
        </CardHeader>
        {count === 0 ? null : (
          <CardContent flush>
            <ItemGroup aria-label={title}>{children}</ItemGroup>
          </CardContent>
        )}
      </section>
    </Card>
  );
};
