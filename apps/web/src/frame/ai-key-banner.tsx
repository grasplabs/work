import { aiProviders } from "@grasp-os/shared/ai-providers";
import type {
  AiProvidersListing,
  ProviderTrouble,
} from "@grasp-os/shared/ai-providers";
import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@grasp-os/ui/components/alert";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useMatch } from "@tanstack/react-router";
import { KeyRoundIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { formatSince } from "../format.ts";

// What the organization's own admins see over every page while one of its
// AI providers fails its calls, worded by what was seen, by HTTP class
// only, never a guess at why (`ProviderTrouble`, from the model ledger's
// provider health through `aiProviders.list`): it refuses the key, it
// isn't answering (an outage, most often), or it is limiting requests. No
// call has worked since. Chats fall back to the organization's backup
// model where it has one; workflow runs wait. The banner goes once a call
// works again, or the key is replaced. Members and Grasp staff never see
// it: only the organization's admins can change a key or a provider.

/** How often the banner asks again how the providers fare, in ms. */
const refreshMs = 60_000;

/** A connected provider whose calls fail, as the banner names it. */
export interface FailingProvider {
  label: string;
  since: number;
  trouble: ProviderTrouble;
  /** Where the provider says how its service is doing, if it has a page. */
  statusPage: string | undefined;
}

/**
 * The organization's providers whose calls fail: what they show and since
 * when, as long as none worked since and the key wasn't replaced.
 */
export const failingProviders = (
  listing: AiProvidersListing
): FailingProvider[] =>
  listing.providers.flatMap(({ provider, label, status }) =>
    status === null ||
    status.failingSince === null ||
    status.failingClass === null
      ? []
      : [
          {
            label,
            since: status.failingSince,
            trouble: status.failingClass,
            statusPage: aiProviders[provider].statusPage,
          },
        ]
  );

/** Whether `identity` is one of the organization's own admins. */
const ownAdmin = (identity: Identity | undefined): boolean =>
  identity !== undefined && isAdmin(identity.role) && !identity.staff;

/** Whether the signed-in person can replace a key: the organization's own admins. */
export const useCanReplaceKey = (): boolean => {
  const shell = useMatch({ from: "/_shell", shouldThrow: false });
  return ownAdmin(shell?.context.identity);
};

/** What to do about a provider that isn't answering. */
const IfItLasts = ({ statusPage }: { statusPage: string | undefined }) => {
  if (statusPage === undefined) {
    return <Trans>If it lasts, switch provider.</Trans>;
  }
  const page = new URL(statusPage).host;
  return (
    <Trans>
      If it lasts, check{" "}
      <a href={statusPage} rel="noreferrer" target="_blank">
        {page}
      </a>{" "}
      or switch provider.
    </Trans>
  );
};

/** One failing provider, in a line, by what it shows. */
const FailingLine = ({ failing }: { failing: FailingProvider }) => {
  const { t } = useLingui();
  const since = formatSince(failing.since);
  const { label } = failing;
  let title = t`${label} is limiting requests since ${since} (rate or spending limit at ${label}).`;
  let description: ReactNode = null;
  if (failing.trouble === "refused") {
    title = t`${label} is refusing your key since ${since}.`;
    description = (
      <Link to="/settings/ai-providers">
        <Trans>Check or replace it in Settings › AI providers.</Trans>
      </Link>
    );
  } else if (failing.trouble === "not_answering") {
    title = t`${label} isn't answering since ${since}.`;
    description = (
      <>
        <Trans>
          This is usually an outage on their side; Grasp keeps retrying.
        </Trans>{" "}
        <IfItLasts statusPage={failing.statusPage} />
      </>
    );
  }
  return (
    <Alert live="polite" variant="attention">
      <KeyRoundIcon aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      {description === null ? null : (
        <AlertDescription>
          <p>{description}</p>
        </AlertDescription>
      )}
    </Alert>
  );
};

/**
 * A banner over the page for each AI provider whose calls fail,
 * for the organization's own admins; nothing for anyone else, or while
 * every key works.
 */
export const AiKeyBanner = ({
  identity,
  providers,
}: {
  identity: Identity;
  /** The organization's providers as core lists them (`aiProviders.list`). */
  providers: () => Promise<AiProvidersListing>;
}) => {
  const [failing, setFailing] = useState<FailingProvider[]>([]);
  const shown = ownAdmin(identity);
  useEffect(() => {
    let live = true;
    const read = async () => {
      if (!shown) {
        return;
      }
      try {
        const listing = await providers();
        if (live) {
          setFailing(failingProviders(listing));
        }
      } catch {
        // Not read just now: the banner stays as it was until the next read.
      }
    };
    void read();
    const timer = shown
      ? setInterval(() => {
          void read();
        }, refreshMs)
      : undefined;
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [providers, shown]);
  if (!shown || failing.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-col gap-2 px-4 pt-4">
      {failing.map((key) => (
        <FailingLine failing={key} key={key.label} />
      ))}
    </div>
  );
};
