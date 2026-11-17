import type {
  SignInProvider,
  SignInSettings,
} from "@grasp-os/shared/org-settings";
import { isAdmin } from "@grasp-os/shared/roles";
import { useLingui } from "@lingui/react/macro";
import { useRouteContext } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { Alert } from "../grasp/alert/index.ts";
import { Badge } from "../grasp/badge/index.ts";
import { BrandIcon } from "../grasp/brand-icon/index.ts";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";
import { LoadingLines, SectionNotLoaded } from "./section.tsx";

// Settings › Workspace › Sign-in, for admins: how the organization's
// people sign in, as Grasp set it up for the deployment
// (`orgSettings.signIn`): Microsoft 365 or Google Workspace, each by its
// logo, whose accounts it takes (the organization's own tenant or
// Workspace), and, only when it is missing, that the sign-in page doesn't
// offer it yet (its secret isn't set).
// Nothing here changes it, and core never sends a secret, only whether
// one is set. The sign-in domains are on the Workspace section above,
// and Grasp staff's access has a section of its own. The section reads
// core itself, so the page's own read stays as it is.

/** Whose accounts a way to sign in takes, in words; nothing when core doesn't say. */
const usePinned = (
  { provider, tenantId, hostedDomain }: SignInProvider,
  organization: string
): string | undefined => {
  const { t } = useLingui();
  if (provider === "microsoft" && tenantId !== undefined) {
    return t`Only work accounts from ${organization}’s Microsoft 365.`;
  }
  if (provider === "google" && hostedDomain !== undefined) {
    return t`Only work accounts from ${organization}’s Google Workspace (${hostedDomain}).`;
  }
  return undefined;
};

/**
 * One way to sign in, as a row: its logo and name, whose accounts it
 * takes, and, only when something is wrong, that it isn't offered yet.
 */
const ProviderRow = ({
  provider,
  organization,
}: {
  provider: SignInProvider;
  organization: string;
}) => {
  const { t } = useLingui();
  const pinned = usePinned(provider, organization);
  const microsoft = provider.provider === "microsoft";
  return (
    <Item size="xs">
      <ItemMedia>
        <BrandIcon
          brand={microsoft ? "microsoft" : "google"}
          decorative
          size="xs"
        />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          {microsoft ? "Microsoft 365" : "Google Workspace"}
        </ItemTitle>
        {pinned === undefined ? null : (
          <ItemDescription>{pinned}</ItemDescription>
        )}
      </ItemContent>
      {/* Offered is how it should be, and needs no word; missing does. */}
      {provider.offered ? null : (
        <ItemActions>
          <Badge size="sm" tone="attention">
            {t`Not on the sign-in page yet`}
          </Badge>
        </ItemActions>
      )}
    </Item>
  );
};

/** How people sign in, as core answered an admin. */
export const SignInView = ({
  signIn,
  organization,
  onRetry,
}: {
  /** Undefined while it is read. */
  signIn: Loaded<SignInSettings> | undefined;
  /** The organization's name, to say whose accounts sign in. */
  organization: string;
  /** Reads it again, once it didn't load. */
  onRetry?: () => void;
}) => {
  const { t } = useLingui();
  const title = t`Sign-in`;
  if (
    signIn?.state === "ready" &&
    signIn.data.configured &&
    signIn.data.providers.length > 0
  ) {
    return (
      <SectionCard density="compact" flush title={title}>
        <ItemGroup aria-label={title} separated>
          {signIn.data.providers.map((provider) => (
            <ProviderRow
              key={provider.provider}
              organization={organization}
              provider={provider}
            />
          ))}
        </ItemGroup>
      </SectionCard>
    );
  }
  return (
    <SectionCard density="compact" title={title}>
      {signIn === undefined ? <LoadingLines lines={2} /> : null}
      {signIn !== undefined && signIn.state !== "ready" ? (
        <SectionNotLoaded
          page={signIn}
          {...(onRetry === undefined ? {} : { onRetry })}
        />
      ) : null}
      {signIn?.state === "ready" ? (
        // Nobody can sign in: someone should look.
        <Alert tone="attention">
          {t`Sign-in isn’t set up for this workspace yet, so nobody can sign in. Grasp sets it up.`}
        </Alert>
      ) : null}
    </SectionCard>
  );
};

/** Reads how people sign in once, as it mounts; `onRetry` mounts it anew. */
const SignInRead = ({
  organization,
  onRetry,
}: {
  organization: string;
  onRetry: () => void;
}) => {
  const core = useCore();
  const [signIn, setSignIn] = useState<Loaded<SignInSettings>>();
  useEffect(() => {
    const left = new AbortController();
    const read = async (): Promise<void> => {
      const loaded = await loadFromCore(
        core,
        async (session) => await session.orgSettings.signIn(),
        left.signal
      );
      if (!left.signal.aborted) {
        setSignIn(loaded);
      }
    };
    void read();
    return () => {
      left.abort();
    };
  }, [core]);
  return (
    <SignInView organization={organization} onRetry={onRetry} signIn={signIn} />
  );
};

/** The sign-in section, for admins only: core is asked only for them. */
export const SignInSection = ({ organization }: { organization: string }) => {
  const { identity } = useRouteContext({ from: "/_shell" });
  // Each try at reading it: Try again reads it anew.
  const [attempt, setAttempt] = useState(0);
  return isAdmin(identity.role) ? (
    <SignInRead
      key={attempt}
      organization={organization}
      onRetry={() => {
        setAttempt((now) => now + 1);
      }}
    />
  ) : null;
};
