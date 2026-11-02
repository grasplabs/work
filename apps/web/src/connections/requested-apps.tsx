import type { AppRequest } from "@grasp-os/shared/connect";
import { Badge } from "@grasp-os/ui/components/badge";
import { Trans, useLingui } from "@lingui/react/macro";
import { Await } from "@tanstack/react-router";
import { ClockIcon } from "lucide-react";

import { formatDate, formatDayMonth } from "../format.ts";
import type { Loaded } from "../load-from-core.tsx";
import { AppLogo } from "./app-logo.tsx";
import { IntegrationsSection } from "./integrations-section.tsx";

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
    <li className="flex h-14 items-center gap-3">
      <AppLogo logo={null} name={request.name} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate font-medium">{request.name}</span>
        <span className="text-muted-foreground truncate">{about}</span>
      </div>
      <Badge variant="outline">
        <ClockIcon data-icon="inline-start" />
        <Trans>Requested {date}</Trans>
      </Badge>
    </li>
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
      id="requested"
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
