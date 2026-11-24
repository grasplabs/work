import { aiProviders } from "@grasp-os/shared/ai-providers";
import type {
  AiProvidersListing,
  ProviderTrouble,
} from "@grasp-os/shared/ai-providers";
import { isMemberAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { Link } from "@grasp-os/ui/components/link";
import { Icon, TriangleAlertIcon } from "@grasp-os/ui/lib/icons";
import {
  colors,
  font,
  media,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { iconVars } from "@grasp-os/ui/lib/vars.stylex";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link as RouterLink } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { readWithin } from "../core-connection.ts";
import type { CoreConnection } from "../core-connection.ts";
import { formatSince } from "../format.ts";

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

const styles = stylex.create({
  // Across the top of the page's card, one under the other.
  banners: { display: "flex", flexDirection: "column", flexShrink: 0 },
  // A band, as the reference's banner in the shell's banner row (#2503's
  // grasp/alert/banner.tsx): no corners of its own, so it takes the card's
  // at its top and meets the bar under it square; 12px all round, the
  // system's soft edge, the warning's tint. Damsko's Alert as a banner is
  // a rounded card with more room at its sides (registry gap of 24 Nov
  // 2026), so the band is drawn here on its tokens.
  band: {
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr)",
    alignItems: "start",
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    padding: space["3"],
    boxShadow: size.borderStrong,
    borderWidth: { default: 0, [media.forcedColors]: 1 },
    borderStyle: "solid",
    borderColor: "CanvasText",
    backgroundColor: colors.warningSubtle,
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.bodyForeground,
    overflowWrap: "anywhere",
  },
  // Level with the title's line, however many lines the message takes.
  icon: {
    display: "inline-flex",
    flexShrink: 0,
    alignSelf: "flex-start",
    marginInlineEnd: space["2"],
    marginBlockStart: `calc(${space["1"]} + (${font.textSmLine} - ${size.iconSm}) / 2)`,
    color: colors.warning,
  },
  // The title on the first line, the message under it.
  words: {
    display: "grid",
    rowGap: space["1"],
    minWidth: 0,
    margin: 0,
    paddingBlock: space["1"],
    textWrap: "pretty",
  },
  title: { fontWeight: font.weightMedium, color: colors.foreground },
});

/** What to do about a provider that isn't answering. */
const IfItLasts = ({ statusPage }: { statusPage: string | undefined }) => {
  if (statusPage === undefined) {
    return <Trans>If it lasts, switch provider.</Trans>;
  }
  const page = new URL(statusPage).host;
  return (
    <Trans>
      If it lasts, check{" "}
      <Link external href={statusPage}>
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
      <Link asChild>
        <RouterLink to="/settings/ai-providers">
          <Trans>Check or replace it in Settings › AI providers.</Trans>
        </RouterLink>
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
    <output data-slot="banner" {...stylex.props(styles.band)}>
      <span aria-hidden="true" {...stylex.props(styles.icon)}>
        <Icon icon={TriangleAlertIcon} />
      </span>
      <div {...stylex.props(styles.words)}>
        <span {...stylex.props(styles.title)}>{title}</span>
        {description === null ? null : <span>{description}</span>}
      </div>
    </output>
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

/**
 * A banner across the top of the page's card (Damsko's Alert, as a
 * banner), for each AI provider whose calls fail,
 * for the organization's own admins; nothing for anyone else, or while
 * every key works.
 */
export const AiKeyBanner = ({
  identity,
  providers,
  failing: readBefore,
}: {
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
}) => {
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
  if (!shown || failing.length === 0) {
    return null;
  }
  return (
    <div {...stylex.props(styles.banners)}>
      {failing.map((key) => (
        <FailingLine failing={key} key={key.label} />
      ))}
    </div>
  );
};
