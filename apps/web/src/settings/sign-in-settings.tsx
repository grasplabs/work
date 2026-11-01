import type {
  SignInProvider,
  SignInSettings,
} from "@grasp-os/shared/org-settings";
import { isAdmin } from "@grasp-os/shared/roles";
import { Badge } from "@grasp-os/ui/components/badge";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouteContext } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { LoadingLines } from "../frame/page-states.tsx";
import { loadFromCore, NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";
import {
  SettingsBody,
  SettingsRow,
  SettingsSection,
} from "./settings-parts.tsx";

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

/** One way to sign in: who it is pinned to, and whether it is offered. */
const ProviderRow = ({ provider }: { provider: SignInProvider }) => {
  const pinned = usePinned(provider);
  return (
    <SettingsRow
      description={pinned}
      label={
        provider.provider === "microsoft" ? "Microsoft 365" : "Google Workspace"
      }
    >
      {provider.offered ? (
        <Badge variant="secondary">
          <Trans>On the sign-in page</Trans>
        </Badge>
      ) : (
        <Badge variant="destructive">
          <Trans>Not offered: its secret isn’t set</Trans>
        </Badge>
      )}
    </SettingsRow>
  );
};

/** How people sign in, as core answered an admin. */
export const SignInView = ({
  signIn,
}: {
  /** Undefined while it is read. */
  signIn: Loaded<SignInSettings> | undefined;
}) => {
  const { t } = useLingui();
  const body = (() => {
    if (signIn === undefined) {
      return (
        <SettingsBody>
          <LoadingLines lines={2} />
        </SettingsBody>
      );
    }
    if (signIn.state !== "ready") {
      return (
        <SettingsBody>
          <NotLoaded page={signIn} />
        </SettingsBody>
      );
    }
    const { configured, providers } = signIn.data;
    if (!configured || providers.length === 0) {
      return (
        <p className="text-muted-foreground border-t px-5 py-4">
          <Trans>
            Sign-in isn’t set up for this workspace yet, so nobody can sign in.
            Grasp sets it up.
          </Trans>
        </p>
      );
    }
    return providers.map((provider) => (
      <ProviderRow key={provider.provider} provider={provider} />
    ));
  })();
  return (
    <SettingsSection
      description={t`The accounts people sign in to Grasp with. Grasp sets this up for your workspace: ask Grasp to change it.`}
      title={t`Sign-in`}
    >
      {body}
    </SettingsSection>
  );
};

/** The sign-in section, for admins only: core is asked only for them. */
export const SignInSection = () => {
  const core = useCore();
  const { identity } = useRouteContext({ from: "/_shell" });
  const admin = isAdmin(identity.role);
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
    if (admin) {
      void read();
    }
    return () => {
      left.abort();
    };
  }, [admin, core]);
  return admin ? <SignInView signIn={signIn} /> : null;
};
