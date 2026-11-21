import { Badge } from "@grasp-os/app-kit/components/badge";
import type { CatalogSource } from "@grasp-os/shared/connect";
import { Trans } from "@lingui/react/macro";

/**
 * Who holds a connection's tokens: our own connector (Native), or Composio's
 * cloud, a third party (Via Composio). Shown wherever a connector is, so
 * people can tell before and after they connect it.
 */
export const SourceBadge = ({ source }: { source: CatalogSource }) =>
  source === "native" ? (
    <Badge variant="secondary">
      <Trans>Native</Trans>
    </Badge>
  ) : (
    <Badge variant="outline">
      <Trans>Via Composio</Trans>
    </Badge>
  );
