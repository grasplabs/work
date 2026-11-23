import type {
  SignInProvider,
  SignInSettings,
} from "@grasp-os/shared/org-settings";
import { isAdmin } from "@grasp-os/shared/roles";
import { Alert, AlertDescription } from "@grasp-os/ui/components/alert";
import { Button } from "@grasp-os/ui/components/button";
import { Input } from "@grasp-os/ui/components/input";
import { Icon, RefreshCwIcon } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouteContext } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { formatList } from "../format.ts";
import { loadFromCore, notLoadedText } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";
import { SettingRow } from "./section.tsx";

// Settings › Workspace › Sign-in, for admins: how the organization's
// people sign in, as Grasp set it up for the deployment
// (`orgSettings.signIn`), as one row of the Settings card. Microsoft 365
// or Google Workspace stands in a field that only reads, whose accounts it
// takes (the organization's own tenant or Workspace) under its name, and,
// only when it is missing, that the sign-in page doesn't offer it yet (its
// secret isn't set). Nothing here changes it, and core never sends a
// secret, only whether one is set. The row reads core itself, so the
// page's own read stays as it is.

const styles = stylex.create({
  // A note across the rows, in their inset.
  note: { marginBlock: space[2], marginInline: space.tableCellInline },
});

/** A note about the rows, across them: something someone should look at. */
const RowNote = ({ children }: { children: ReactNode }) => (
  <Alert appearance="subtle" style={styles.note} variant="warning">
    <AlertDescription>{children}</AlertDescription>
  </Alert>
);

/** Whose accounts a way to sign in takes, in words; nothing when core doesn't say. */
const pinnedOf = ({
  provider,
  tenantId,
  hostedDomain,
}: SignInProvider): MessageDescriptor | undefined => {
  if (provider === "microsoft" && tenantId !== undefined) {
    return msg`your organization’s work accounts`;
  }
  if (provider === "google" && hostedDomain !== undefined) {
    return msg`work accounts at ${hostedDomain}`;
  }
  return undefined;
};

/** A way to sign in by its product's name, as its maker names it. */
const providerName = ({ provider }: SignInProvider): string =>
  provider === "microsoft" ? "Microsoft 365" : "Google Workspace";

/** How people sign in, as core answered an admin, as a row. */
const SignInView = ({
  signIn,
  onRetry,
}: {
  /** Undefined while it is read. */
  signIn: Loaded<SignInSettings> | undefined;
  /** Reads it again, once it didn't load. */
  onRetry: () => void;
}) => {
  const { t, i18n } = useLingui();
  const label = t`Sign-in`;
  if (signIn !== undefined && signIn.state !== "ready") {
    return (
      <SettingRow error={notLoadedText(signIn, i18n)} label={label}>
        <Button onClick={onRetry} size="sm" variant="outline">
          <Icon icon={RefreshCwIcon} />
          {t`Try again`}
        </Button>
      </SettingRow>
    );
  }
  const providers =
    signIn?.data.configured === true ? signIn.data.providers : [];
  if (signIn !== undefined && providers.length === 0) {
    // Nobody can sign in: someone should look.
    return (
      <RowNote>
        {t`Sign-in isn’t set up for this workspace yet, so nobody can sign in. Grasp sets it up.`}
      </RowNote>
    );
  }
  const pinned = providers.flatMap((provider) => {
    const words = pinnedOf(provider);
    return words === undefined ? [] : [i18n._(words)];
  });
  const accounts = formatList(pinned);
  return (
    <>
      <SettingRow
        help={
          pinned.length === 0 ? t`How your people sign in` : t`Only ${accounts}`
        }
        label={label}
      >
        <Input
          readOnly
          size="sm"
          value={formatList(providers.map(providerName))}
        />
      </SettingRow>
      {/* Offered is how it should be, and needs no word; missing does. */}
      {providers
        .filter((provider) => !provider.offered)
        .map((provider) => {
          const name = providerName(provider);
          return (
            <RowNote key={provider.provider}>
              {t`${name} isn’t on the sign-in page yet.`}
            </RowNote>
          );
        })}
    </>
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

/** The sign-in row, for admins only: core is asked only for them. */
export const SignInRow = () => {
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
