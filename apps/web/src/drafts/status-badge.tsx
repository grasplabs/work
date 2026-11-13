import { Badge } from "@grasp-os/ui/components/badge";
import { Trans } from "@lingui/react/macro";

import { formatList } from "../format.ts";

// Where an App or a workflow stands, in its bar and on its cards, in the
// same plain words for both: "Only you see this" until a version is live
// and shared with someone, then who uses it; "Archived" for an App put
// away.

/** Who uses it, as a whole sentence: one name, several, or the team. */
const UsedBy = ({ who }: { who: readonly string[] | undefined }) => {
  const [only] = who ?? [];
  if (who === undefined || only === undefined) {
    return <Trans>Your team uses it</Trans>;
  }
  if (who.length === 1) {
    return <Trans>{only} uses it</Trans>;
  }
  const names = formatList(who);
  return <Trans>{names} use it</Trans>;
};

/**
 * Where it stands, in words anyone reads: "Only you see this" until a
 * version is live (`live`) and shared with someone; then who uses it, by
 * name (`who`), or "Your team" where the page doesn't read whom it is
 * shared with (a card on the Apps page).
 */
export const StatusBadge = ({
  live,
  archived = false,
  who,
}: {
  /** Its live version; null before the first. */
  live: number | null;
  /** Whether a builder archived it (an App). */
  archived?: boolean;
  /** Whom it is shared with, by name; none where the page doesn't read it. */
  who?: readonly string[];
}) => {
  if (archived) {
    return (
      <Badge variant="outline">
        <Trans context="an App put away">Archived</Trans>
      </Badge>
    );
  }
  if (live === null || who?.length === 0) {
    return (
      <Badge variant="attention">
        <Trans>Only you see this</Trans>
      </Badge>
    );
  }
  return (
    <Badge variant="passed">
      <UsedBy who={who} />
    </Badge>
  );
};
