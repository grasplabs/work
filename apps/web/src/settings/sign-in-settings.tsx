import type {
  SignInProvider,
  SignInSettings,
} from "@grasp-os/shared/org-settings";
import { isAdmin } from "@grasp-os/shared/roles";
import { useLingui } from "@lingui/react/macro";
import { useRouteContext } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { formatList } from "../format.ts";
import { Button } from "../grasp/button/index.ts";
import { Retry } from "../grasp/icons/index.ts";
import { Input } from "../grasp/input/index.ts";
import { RowAlert, SettingRow } from "../grasp/setting-row/index.ts";
import { loadFromCore, notLoadedText } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";
import { controlStyles } from "./workspace-name.tsx";

// Settings › Workspace › Sign-in, for admins: how the organization's
// people sign in, as Grasp set it up for the deployment
// (`orgSettings.signIn`), as one row of the Organization card. Microsoft
// 365 or Google Workspace stands in a field that only reads, whose
// accounts it takes (the organization's own tenant or Workspace) behind
// the row's info mark, and, only when it is missing, that the sign-in page
// doesn't offer it yet (its secret isn't set). Nothing here changes it,
// and core never sends a secret, only whether one is set. The row reads
// core itself, so the page's own read stays as it is.

/** Whose accounts a way to sign in takes, in words; nothing when core doesn't say. */
const pinnedOf = (
  { provider, tenantId, hostedDomain }: SignInProvider,
  t: ReturnType<typeof useLingui>["t"]
): string | undefined => {
  if (provider === "microsoft" && tenantId !== undefined) {
    return t`Only your organization’s work accounts.`;
  }
  if (provider === "google" && hostedDomain !== undefined) {
    return t`Only work accounts at ${hostedDomain}.`;
  }
  return undefined;
};

/** A way to sign in by its product's name, as its maker names it. */
const providerName = ({ provider }: SignInProvider): string =>
  provider === "microsoft" ? "Microsoft 365" : "Google Workspace";

/** How people sign in, as core answered an admin, as a row. */
export const SignInView = ({
  signIn,
  onRetry,
}: {
  /** Undefined while it is read. */
  signIn: Loaded<SignInSettings> | undefined;
  /** Reads it again, once it didn't load. */
  onRetry?: () => void;
}) => {
  const { t, i18n } = useLingui();
  const label = t`Sign-in`;
  if (signIn !== undefined && signIn.state !== "ready") {
    return (
      <SettingRow error={notLoadedText(signIn, i18n)} label={label}>
        <Button
          disabled={onRetry === undefined}
          icon={Retry}
          onClick={onRetry}
          size="sm"
        >
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
      <RowAlert variant="attention">
        {t`Sign-in isn’t set up for this workspace yet, so nobody can sign in. Grasp sets it up.`}
      </RowAlert>
    );
  }
  const pinned = providers.flatMap((provider) => {
    const words = pinnedOf(provider, t);
    return words === undefined ? [] : [words];
  });
  return (
    <>
      <SettingRow
        {...(pinned.length === 0 ? {} : { info: pinned.join(" ") })}
        label={label}
      >
        {(field) => (
          <Input
            {...field}
            layout={controlStyles.fill}
            readOnly
            size="sm"
            value={formatList(providers.map(providerName))}
          />
        )}
      </SettingRow>
      {/* Offered is how it should be, and needs no word; missing does. */}
      {providers
        .filter((provider) => !provider.offered)
        .map((provider) => {
          const name = providerName(provider);
          return (
            <RowAlert key={provider.provider} variant="attention">
              {t`${name} isn’t on the sign-in page yet.`}
            </RowAlert>
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
