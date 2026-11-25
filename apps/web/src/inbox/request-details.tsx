import type { Permission } from "@grasp-os/shared/permissions";
import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { Trans } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import {
  requestNextRun,
  reviewedVersionText,
  noVersion,
  triggerStartOf,
} from "../activity/pending.tsx";
import type { PendingRequests } from "../activity/pending.tsx";
import { formatTime, personName } from "../directory.ts";

// What a permission request asks, in full, under an Inbox approval's
// Details, or on a trigger's ask to start its workflow: who asks, for
// what, on what, and since when.

const styles = stylex.create({
  details: {
    display: "flex",
    flexDirection: "column",
    gap: space["1"],
  },
});

/**
 * What has to be read of a permission request before deciding it: as
 * which binding its code asks, when a schedule next runs, the version of
 * its App the grant trusts, and who asked. A line with nothing to say is
 * left out, and a trigger's name in code ("START") on its ask to start its
 * workflow with it, as #2503 has it: its title says it starts the workflow.
 */
export const RequestDetails = ({
  request,
  directory,
}: {
  request: Permission;
  directory: PendingRequests["directory"];
}) => {
  const { binding } = request;
  const nextRun = requestNextRun(request);
  const version = reviewedVersionText(request, directory);
  const requester = personName(directory, request.requestedBy);
  const date = formatTime(request.requestedAt);
  return (
    <div {...stylex.props(styles.details)}>
      {triggerStartOf(request) === undefined ? (
        <Text size="sm" color="muted">
          <Trans>as {binding}</Trans>
        </Text>
      ) : null}
      {nextRun === undefined ? null : (
        <Text size="sm" color="muted">
          {nextRun}
        </Text>
      )}
      {request.chat === null ? null : (
        <Text size="sm" color="muted">
          <Trans>In one chat only, for {requester}</Trans>
        </Text>
      )}
      {version === noVersion ? null : (
        <Text size="sm" color="muted">
          <Trans>Version to review: {version}</Trans>
        </Text>
      )}
      <Text size="sm" color="muted">
        <Trans>
          Asked by {requester} on {date}
        </Trans>
      </Text>
      {request.requestedVia === null ? null : (
        <Text size="sm" color="muted">
          <Trans>asked for by the agent, in their chat</Trans>
        </Text>
      )}
    </div>
  );
};
