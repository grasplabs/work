import type { AppRequest } from "@grasp-os/shared/connect";
import { Badge } from "@grasp-os/ui/components/badge";
import { Trans, useLingui } from "@lingui/react/macro";
import { ClockIcon } from "lucide-react";

import { formatDayMonth } from "../format.ts";
import type { Loaded } from "../load-from-core.tsx";
import { AppLogo } from "./app-logo.tsx";

// The apps people asked Grasp to add, until Grasp adds them, as in the
// prototype (`routes/integrations/index.tsx`, `Requested`): who asked,
// what for, and since when. Core lists them for everyone in the
// organization (catalog-requests.ts), latest first.

const RequestedRow = ({ request }: { request: AppRequest }) => {
  const { t } = useLingui();
  const asker = request.requestedBy.name;
  // Without the year: requests are recent.
  const date = formatDayMonth(request.requestedAt);
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

/** The apps asked for, under the catalog; nothing when nobody asked. */
export const RequestedApps = ({
  requests,
}: {
  /** As the page read them; any failure shows nothing here. */
  requests: Loaded<AppRequest[]>;
}) => {
  if (requests.state !== "ready" || requests.data.length === 0) {
    return null;
  }
  return (
    <section
      aria-labelledby="integrations-requested"
      className="flex flex-col gap-1"
    >
      <h2 className="text-muted-foreground" id="integrations-requested">
        <Trans context="apps someone asked for">Requested</Trans>
      </h2>
      <ul className="grid grid-cols-1 gap-x-10 gap-y-1 @2xl:grid-cols-2">
        {requests.data.map((request) => (
          <RequestedRow key={request.id} request={request} />
        ))}
      </ul>
    </section>
  );
};
