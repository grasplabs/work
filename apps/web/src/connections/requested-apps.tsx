import type { AppRequest } from "@grasp-os/shared/connect";
import { useLingui } from "@lingui/react/macro";
import { Await } from "@tanstack/react-router";

import { formatDate, formatDayMonth } from "../format.ts";
import { Badge } from "../grasp/badge/index.ts";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import type { Loaded } from "../load-from-core.tsx";
import { IntegrationsSection } from "./integrations-section.tsx";
import { ProviderMark } from "./provider-mark.tsx";

// The apps people asked Grasp to add, until Grasp adds them, as in the
// prototype (`routes/integrations/index.tsx`, `Requested`): who asked,
// what for, and since when. Core lists them for everyone in the
// organization (catalog-requests.ts), latest first.

const RequestedRow = ({ request }: { request: AppRequest }) => {
  const { t } = useLingui();
  const asker = request.requestedBy.name;
  // Without the year while it is this year's, so recent ones stay short.
  const sameYear =
    new Date(request.requestedAt).getFullYear() === new Date().getFullYear();
  const date = sameYear
    ? formatDayMonth(request.requestedAt)
    : formatDate(request.requestedAt);
  const askedBy =
    asker === null ? t`Asked by a former member` : t`Asked by ${asker}`;
  const about = request.why ?? askedBy;
  return (
    <Item size="sm">
      <ItemMedia>
        <ProviderMark id={request.name} logo={null} name={request.name} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{request.name}</ItemTitle>
        <ItemDescription>{about}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <Badge>{t`Requested ${date}`}</Badge>
      </ItemActions>
    </Item>
  );
};

const RequestedList = ({
  requests,
  search,
}: {
  requests: Loaded<AppRequest[]>;
  search: string | undefined;
}) => {
  const { t } = useLingui();
  const needle = (search ?? "").trim().toLocaleLowerCase();
  const shown =
    requests.state === "ready"
      ? requests.data.filter(({ name }) =>
          name.toLocaleLowerCase().includes(needle)
        )
      : [];
  return (
    <IntegrationsSection
      count={shown.length}
      title={t({ message: "Requested", context: "apps someone asked for" })}
    >
      {shown.map((request) => (
        <RequestedRow key={request.id} request={request} />
      ))}
    </IntegrationsSection>
  );
};

/**
 * The apps asked for whose name holds what was searched; nothing while
 * they load, when nobody asked, or when the read failed.
 */
export const RequestedApps = ({
  requests,
  search,
}: {
  /** Read on its own, so the catalog never waits for it. */
  requests: Promise<Loaded<AppRequest[]>>;
  search: string | undefined;
}) => (
  <Await fallback={null} promise={requests}>
    {(loaded) => <RequestedList requests={loaded} search={search} />}
  </Await>
);
