import { useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { formatNumber } from "../format.ts";
import { Avatar, AvatarFallback } from "../grasp/avatar/index.ts";
import { Badge } from "../grasp/badge/index.ts";
import { BrandIcon } from "../grasp/brand-icon/index.ts";
import { Button } from "../grasp/button/index.ts";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { Text } from "../grasp/text/index.ts";
import { groupLabel } from "./groups.ts";
import type { Integration } from "./integrations.ts";
import { brandOf } from "./provider-mark.tsx";

// The Integrations overview as a card per topic, each title on the canvas
// over its card (Ruben's pick, 18 Nov 2026): what needs someone to sign in
// again, each with its one fix; what is connected, each opening the app
// beside the list; and every app that can still be added, with Connect.
// Every row opens the app beside the list (`?app=`), where its sign-in,
// its facts and what Grasp may do in it are.

/**
 * An app's mark, one size everywhere on the page: the library's Brand
 * icon on its tile where it has the brand, else its fallback for a
 * picture it lacks, an Avatar with the app's initials, the same size.
 */
export const AppMark = ({ integration }: { integration: Integration }) => {
  const brand = brandOf(integration.id, integration.name);
  return brand === undefined ? (
    <Avatar decorative name={integration.name} size="sm">
      <AvatarFallback />
    </Avatar>
  ) : (
    <BrandIcon brand={brand} decorative size="sm" />
  );
};

/**
 * The router's link that opens `integration` beside the list, as an
 * element a row or a button draws itself as (their `render`), so it takes
 * their words, label and look.
 */
const openLink = (integration: Integration) => (
  <Link
    from="/integrations/"
    resetScroll={false}
    search={(last) => ({ ...last, app: integration.key })}
    to="/integrations"
  />
);

/** What needs someone to sign in again: each with its one fix. */
export const NeedsYou = ({
  lapsed,
}: {
  /** Something relies on a connection whose access ran out. */
  lapsed: readonly Integration[];
}) => {
  const { t } = useLingui();
  if (lapsed.length === 0) {
    return null;
  }
  const title = t`Needs you`;
  return (
    <SectionCard density="compact" flush title={title} variant="grouped">
      <ItemGroup aria-label={title} separated>
        {lapsed.map((integration) => {
          const { name } = integration;
          return (
            <Item key={integration.key} size="xs">
              <ItemMedia>
                <AppMark integration={integration} />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{name}</ItemTitle>
                <ItemDescription>
                  {t`Needs sign-in. What uses it waits until then.`}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button
                  aria-label={t`Sign in to ${name} again`}
                  render={openLink(integration)}
                  size="sm"
                  variant="quiet"
                >
                  {t`Sign in again`}
                </Button>
              </ItemActions>
            </Item>
          );
        })}
      </ItemGroup>
    </SectionCard>
  );
};

/** What is connected and works: for whom, each opening the app beside the list. */
export const ConnectedList = ({
  connected,
}: {
  connected: readonly Integration[];
}) => {
  const { t } = useLingui();
  if (connected.length === 0) {
    return null;
  }
  const title = t({ message: "Connected", context: "apps that are connected" });
  return (
    <SectionCard
      aside={
        <Text element="span" size="sm" tone="muted">
          {formatNumber(connected.length)}
        </Text>
      }
      density="compact"
      flush
      title={title}
      variant="grouped"
    >
      <ItemGroup aria-label={title} separated>
        {connected.map((integration) => (
          <Item key={integration.key} render={openLink(integration)} size="xs">
            <ItemMedia>
              <AppMark integration={integration} />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{integration.name}</ItemTitle>
              <ItemDescription>
                {integration.connections.some(({ scope }) => scope === "shared")
                  ? t`Whole company`
                  : t`Only you`}
              </ItemDescription>
            </ItemContent>
          </Item>
        ))}
      </ItemGroup>
    </SectionCard>
  );
};

/** Every app that can still be added, with the search at the title's end. */
export const AddApps = ({
  others,
  canConnect,
  search,
}: {
  others: readonly Integration[];
  /** Whether this person may connect an app here, or only look at one. */
  canConnect: (integration: Integration) => boolean;
  search: ReactNode;
}) => {
  const { t, i18n } = useLingui();
  const title = t({
    message: "Add an app",
    context: "apps that can still be connected",
  });
  return (
    <SectionCard
      actions={search}
      density="compact"
      flush
      title={title}
      variant="grouped"
    >
      <ItemGroup aria-label={title} separated>
        {others.map((integration) => {
          const { name } = integration;
          const connects = canConnect(integration);
          return (
            <Item key={integration.key} size="xs">
              <ItemMedia>
                <AppMark integration={integration} />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{name}</ItemTitle>
                <ItemDescription>
                  {integration.description ??
                    i18n._(groupLabel[integration.group])}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                {integration.offered ? (
                  <Button
                    aria-label={connects ? t`Connect ${name}` : t`Open ${name}`}
                    render={openLink(integration)}
                    size="sm"
                    variant="quiet"
                  >
                    {connects ? t`Connect` : t`Open`}
                  </Button>
                ) : (
                  <Badge size="sm">{t`Not offered`}</Badge>
                )}
              </ItemActions>
            </Item>
          );
        })}
      </ItemGroup>
    </SectionCard>
  );
};
