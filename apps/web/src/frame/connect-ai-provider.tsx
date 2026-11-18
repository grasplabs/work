import { useLingui } from "@lingui/react/macro";
import { Link as RouterLink } from "@tanstack/react-router";

import { Button } from "../grasp/button/index.ts";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../grasp/empty/index.ts";
import { Lock } from "../grasp/icons/index.ts";
import { Link } from "../grasp/link/index.ts";
import { useMemberAdmin } from "../use-member-admin.ts";

// What an AI feature shows while the organization has no AI provider to
// call: every model call fails as `model.no_provider` until one of its
// admins connects a provider and chooses a model (Settings › AI
// providers). Never an error: a state with the way out. An admin who can
// connect one gets the link; anyone else, Grasp staff included (who may
// read but never change whose key pays), is told who can.

/** Empty's size for each of the sizes callers ask for. */
const emptySize = {
  default: "section",
  sm: "section",
  xs: "inline",
} as const;

/** The way to Settings › AI providers. */
const GoToAiProviders = () => {
  const { t } = useLingui();
  return (
    <Button render={<RouterLink to="/settings/ai-providers" />} size="sm">
      {t`Go to AI providers`}
    </Button>
  );
};

/**
 * Connect an AI provider: a link to Settings › AI providers for whoever can,
 * and who to ask for anyone else. `xs` in a thread or under the chat's own box.
 */
export const ConnectAiProvider = ({
  size = "sm",
}: {
  size?: "default" | "sm" | "xs";
}) => {
  const { t } = useLingui();
  const canConnect = useMemberAdmin();
  return (
    <Empty size={emptySize[size]}>
      <EmptyHeader>
        <EmptyMedia icon={Lock} />
        <EmptyTitle>{t`Connect an AI provider`}</EmptyTitle>
        <EmptyDescription>
          {canConnect
            ? t`Grasp's AI works with your organization's own AI provider key. Connect one and choose a model to start.`
            : t`Ask your admin to connect an AI provider.`}
        </EmptyDescription>
      </EmptyHeader>
      {canConnect ? (
        <EmptyContent>
          <GoToAiProviders />
        </EmptyContent>
      ) : null}
    </Empty>
  );
};

/**
 * Under a one-row box to ask in (the idle bar at a page's foot), while there
 * is no AI provider: one line, never a panel, so nothing covers the page.
 * The way to Settings › AI providers for whoever can connect one, and who
 * to ask for anyone else. The chat itself says more once it opens.
 */
export const ConnectAiProviderLine = () => {
  const { t } = useLingui();
  const canConnect = useMemberAdmin();
  return canConnect ? (
    <Link render={<RouterLink to="/settings/ai-providers" />}>
      {t`Connect an AI provider to start asking`}
    </Link>
  ) : (
    t`Ask your admin to connect an AI provider.`
  );
};
