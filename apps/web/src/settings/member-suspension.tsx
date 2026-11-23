import type { DirectoryAccount, Member } from "@grasp-os/shared/members";
import { Badge } from "@grasp-os/ui/components/badge";
import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { Trans } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import type { ReactElement } from "react";

import { formatDate } from "../format.ts";

// A member the directory's daily read suspended (GRA-2056; core's
// directory-suspensions.ts): what their row in Settings › Members says.
// Only the directory lifts a suspension (GRA-2141): someone it turned off
// or deleted signs in through it too, so Grasp offers nothing to click,
// and says where the way out is instead.

const styles = stylex.create({
  // The badge and each sentence on a line of their own: every row the
  // same shape, however long the reason.
  suspension: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: space[1],
    paddingBlockStart: space[1],
  },
});

/**
 * Why `member` is suspended, as the directory has their account now. One
 * sentence each, typed by every state there is: a state this page doesn't
 * know fails the build, and is never shown as it came.
 */
const SuspensionReason = ({
  reason,
  since,
}: {
  reason: DirectoryAccount;
  since: string;
}) => {
  const date = formatDate(since);
  const said: Record<DirectoryAccount, ReactElement> = {
    disabled: (
      <Trans>Since {date}: the directory turned their account off.</Trans>
    ),
    deleted: (
      <Trans>Since {date}: their account was deleted in the directory.</Trans>
    ),
    unlisted: (
      <Trans>Since {date}: their account is no longer in the directory.</Trans>
    ),
    enabled: (
      <Trans>
        Since {date}. The directory has turned their account on again, so its
        next daily read lifts this.
      </Trans>
    ),
  };
  return said[reason];
};

/**
 * Where the way out of a suspension is, true for its reason: the directory
 * for an account it still holds, and removal otherwise. An account the
 * directory turned on again needs none: its next read lifts the suspension.
 */
const WayOut = ({
  reason,
}: {
  reason: Exclude<DirectoryAccount, "enabled">;
}) => {
  const said: Record<Exclude<DirectoryAccount, "enabled">, ReactElement> = {
    disabled: (
      <Trans>
        Turn the account back on in the directory, and Grasp lifts the
        suspension at its next daily read. To end their access for good, remove
        them.
      </Trans>
    ),
    deleted: (
      <Trans>
        Restore the account in the directory, and Grasp lifts the suspension at
        its next daily read. To end their access for good, remove them.
      </Trans>
    ),
    // Not listed may be purged, or deleted and still restorable when the
    // read went without the deleted accounts: say only what is known.
    unlisted: (
      <Trans>
        The account is no longer listed in the directory. If it was deleted and
        can still be restored there, restoring it lets Grasp lift the suspension
        at its next daily read. Otherwise, to end their access for good, remove
        them.
      </Trans>
    ),
  };
  return said[reason];
};

/** That `member` is suspended, since when, why, and where the way out is; nothing while they aren't. */
export const MemberSuspension = ({ member }: { member: Member }) => {
  const { suspension } = member;
  if (suspension === null) {
    return null;
  }
  return (
    <span {...stylex.props(styles.suspension)}>
      <Badge size="sm" variant="warning">
        <Trans>Suspended</Trans>
      </Badge>
      <Text as="span" color="muted" size="sm">
        <SuspensionReason reason={suspension.reason} since={suspension.since} />
      </Text>
      {suspension.reason === "enabled" ? null : (
        <Text as="span" color="muted" size="sm">
          <WayOut reason={suspension.reason} />
        </Text>
      )}
    </span>
  );
};
