import type { Permission } from "@grasp-os/shared/permissions";
import { Trans } from "@lingui/react/macro";

import { reviewedVersionText } from "../activity/pending.tsx";
import type { PendingRequests } from "../activity/pending.tsx";
import { formatTime, personName } from "../directory.ts";

/**
 * What has to be read of a permission request before deciding it: as
 * which binding, the version of its App the grant trusts, and who asked.
 */
export const RequestDetails = ({
  request,
  directory,
}: {
  request: Permission;
  directory: PendingRequests["directory"];
}) => {
  const { binding } = request;
  const version = reviewedVersionText(request, directory);
  const requester = personName(directory, request.requestedBy);
  const date = formatTime(request.requestedAt);
  return (
    <div className="text-muted-foreground flex flex-col gap-1">
      <p>
        <Trans>as {binding}</Trans>
      </p>
      {request.chat === null ? null : (
        <p>
          <Trans>In one chat only, for {requester}</Trans>
        </p>
      )}
      <p>
        <Trans>Version to review: {version}</Trans>
      </p>
      <p>
        <Trans>
          Asked by {requester} on {date}
        </Trans>
      </p>
      {request.requestedVia === null ? null : (
        <p>
          <Trans>asked for by the agent, in their chat</Trans>
        </p>
      )}
    </div>
  );
};
