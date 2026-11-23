import type { Permission } from "@grasp-os/shared/permissions";
import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { Trans } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import {
  requestNextRun,
  reviewedVersionText,
  noVersion,
} from "../activity/pending.tsx";
import type { PendingRequests } from "../activity/pending.tsx";
import { formatTime, personName } from "../directory.ts";

// What a permission request asks, in full, under an Inbox approval's
// Details: who asks, for what, on what, and since when.

const styles = stylex.create({
  details: {
    display: "flex",
    flexDirection: "column",
    gap: space["1"],
  },
});

/**
 * What has to be read of a permission request before deciding it: when a
 * schedule next runs, the name its code asks under, the version of its App
 * the grant trusts, and who asked. A line with nothing to say is left out,
 * and a schedule's name in code ("START") with it: its title says it
 * starts the workflow.
 */
export const RequestDetails = ({
  request,
  directory,
}: {
  request: Permission;
  directory: PendingRequests["directory"];
}) => {
  const nextRun = requestNextRun(request);
  const version = reviewedVersionText(request, directory);
  const requester = personName(directory, request.requestedBy);
  const date = formatTime(request.requestedAt);
  return (
    <div {...stylex.props(styles.details)}>
      {/* A binding's name in code says nothing to a person: only a schedule's next run. */}
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
