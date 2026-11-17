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
import { SectionCard } from "../grasp/section-card/index.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";
import {
  FactRow,
  LoadingLines,
  SectionNotLoaded,
  SettingsRows,
} from "./section.tsx";

// Settings › Workspace › Sign-in, for admins: how the organization's
// people sign in, as Grasp set it up for the deployment
// (`orgSettings.signIn`): Microsoft 365 or Google Workspace, which tenant
// or Workspace each is pinned to, and whether the sign-in page offers it.
// Nothing here changes it, and core never sends a secret, only whether
// one is set. The sign-in domains are on the Workspace section above,
// and Grasp staff's access has a section of its own. The section reads
// core itself, so the page's own read stays as it is.

/** Whose accounts a way to sign in takes, in words; nothing when core doesn't say. */
const usePinned = ({
  provider,
  tenantId,
  hostedDomain,
}: SignInProvider): string | undefined => {
  const { t } = useLingui();
  if (provider === "microsoft" && tenantId !== undefined) {
    return t`Only accounts of the tenant ${tenantId}.`;
  }
  if (provider === "google" && hostedDomain !== undefined) {
    return t`Only accounts of the Google Workspace ${hostedDomain}.`;
  }
  return undefined;
};

/** One way to sign in, as a row: who it is pinned to, and whether it is offered. */
const ProviderRow = ({ provider }: { provider: SignInProvider }) => {
  const { t } = useLingui();
  const pinned = usePinned(provider);
  return (
    <FactRow
      {...(pinned === undefined ? {} : { help: pinned })}
      label={
        provider.provider === "microsoft" ? "Microsoft 365" : "Google Workspace"
      }
    >
      {provider.offered ? (
        <Badge tone="success">{t`On the sign-in page`}</Badge>
      ) : (
        <Badge tone="danger">{t`Not offered: its secret isn’t set`}</Badge>
      )}
    </FactRow>
  );
};

/** How people sign in, as core answered an admin. */
export const SignInView = ({
  signIn,
  onRetry,
}: {
  /** Undefined while it is read. */
  signIn: Loaded<SignInSettings> | undefined;
  /** Reads it again, once it didn't load. */
  onRetry?: () => void;
}) => {
  const { t } = useLingui();
  const description = t`Grasp sets this up; ask Grasp to change it.`;
  const title = t`Sign-in`;
  if (
    signIn?.state === "ready" &&
    signIn.data.configured &&
    signIn.data.providers.length > 0
  ) {
    return (
      <SectionCard description={description} flush title={title}>
        <SettingsRows>
          {signIn.data.providers.map((provider) => (
            <ProviderRow key={provider.provider} provider={provider} />
          ))}
        </SettingsRows>
      </SectionCard>
    );
  }
  return (
    <SectionCard description={description} title={title}>
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
const SignInRead = ({ onRetry }: { onRetry: () => void }) => {
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
  return <SignInView onRetry={onRetry} signIn={signIn} />;
};

/** The sign-in section, for admins only: core is asked only for them. */
export const SignInSection = () => {
  const { identity } = useRouteContext({ from: "/_shell" });
  // Each try at reading it: Try again reads it anew.
  const [attempt, setAttempt] = useState(0);
  return isAdmin(identity.role) ? (
    <SignInRead
      key={attempt}
      onRetry={() => {
        setAttempt((now) => now + 1);
      }}
    />
  ) : null;
};
