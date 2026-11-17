import { aiProviders } from "@grasp-os/shared/ai-providers";
import type {
  AiProvidersListing,
  ProviderTrouble,
} from "@grasp-os/shared/ai-providers";
import { isMemberAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { readWithin } from "../core-connection.ts";
import type { CoreConnection } from "../core-connection.ts";
import { formatSince } from "../format.ts";
import { Alert } from "../grasp/alert/index.ts";
import { Link } from "../grasp/link/index.ts";
import { RouterLink } from "./router-link.tsx";

const styles = stylex.create({
  // Above the page's bar (App shell's `banner`), one banner for each provider.
  lines: {
    display: "flex",
    flexDirection: "column",
  },
});

// What the organization's own admins see over every page while one of its
// AI providers fails its calls, worded by what was seen, by HTTP class
// only, never a guess at why (`ProviderTrouble`, from the gateway's
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
 * when, as long as none worked since and the key wasn't replaced. None
 * while its AI runs on Grasp's AI: no call goes out on its own keys then,
 * so one that failed before keeps nothing from answering.
 */
export const failingProviders = (
  listing: AiProvidersListing
): FailingProvider[] =>
  listing.providers.flatMap(({ provider, label, status }) =>
    listing.source === "grasp" ||
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

/** What to do about a provider that isn't answering. */
const IfItLasts = ({ statusPage }: { statusPage: string | undefined }) => {
  const { t } = useLingui();
  if (statusPage === undefined) {
    return <Trans>If it lasts, switch provider.</Trans>;
  }
  const page = new URL(statusPage).host;
  return (
    <Trans>
      If it lasts, check{" "}
      <Link external externalLabel={t`opens in a new tab`} href={statusPage}>
        {page}
      </Link>{" "}
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
      <RouterLink to="/settings/ai-providers">
        <Trans>Check or replace it in Settings › AI providers.</Trans>
      </RouterLink>
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
    // Said when its words change, not over whatever the person is doing.
    // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- Alert's own prop, which sets its live role; not an element's role
    <Alert role="status" title={title} tone="attention" variant="banner">
      {description}
    </Alert>
  );
};

/** The organization's providers as core lists them, read over `core`. */
export const providersOf =
  (core: Pick<CoreConnection, "withSession">) =>
  async (): Promise<AiProvidersListing> =>
    await readWithin(core, async (session) => await session.aiProviders.list());

/**
 * The failing providers `identity` is shown, read before the page shows.
 * Unread (undefined), which leaves it to the banner, for anyone but the
 * organization's own admins (the banner reads at once should they become
 * one while on the page) and when core doesn't answer in time.
 */
export const failingUpFront = async (
  identity: Identity,
  providers: () => Promise<AiProvidersListing>
): Promise<FailingProvider[] | undefined> => {
  if (!isMemberAdmin(identity)) {
    return undefined;
  }
  try {
    return failingProviders(await providers());
  } catch {
    return undefined;
  }
};

/** What the banner reads: who it is for, core's listing, and what was read before the page showed. */
export interface BannerReads {
  identity: Identity;
  /** The organization's providers as core lists them (`aiProviders.list`). */
  providers: () => Promise<AiProvidersListing>;
  /**
   * The failing providers, read before the page showed (`failingUpFront`):
   * the banner then comes with the page, and never pushes it down under
   * the person's pointer as it arrives. Without it, read once mounted.
   * Only what it had as it mounted counts: after that it reads again
   * itself, every minute.
   */
  failing?: FailingProvider[];
}

/**
 * The providers failing now, for the organization's own admins (none for
 * anyone else): kept by the frame, which stays as pages come and go, so a
 * new page never reads again nor waits for the banner.
 */
export const useFailingProviders = ({
  identity,
  providers,
  failing: readBefore,
}: BannerReads): FailingProvider[] => {
  const [failing, setFailing] = useState<FailingProvider[]>(readBefore ?? []);
  const shown = isMemberAdmin(identity);
  // As it was mounted: the shell hands it over once, as it is entered.
  const readAtMount = useRef(readBefore !== undefined);
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
    if (!readAtMount.current) {
      void read();
    }
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
  return shown ? failing : [];
};

/** The banner: a line for each provider failing; nothing while none is. */
export const FailingBanner = ({
  failing,
}: {
  failing: readonly FailingProvider[];
}) =>
  failing.length === 0 ? null : (
    <div {...stylex.props(styles.lines)}>
      {failing.map((key) => (
        <FailingLine failing={key} key={key.label} />
      ))}
    </div>
  );
