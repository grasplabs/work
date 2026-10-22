import type { AppContents } from "@grasp-os/shared/apps";
import type { SurfaceSummary } from "@grasp-os/shared/screens";
import { buttonVariants } from "@grasp-os/ui/components/button";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { LayoutGridIcon, PlusIcon } from "lucide-react";

// A domain's apps (core's screens), as the prototype's app cards
// (grasplabs/prototype `components/apps/app-card.tsx`): each app's title
// and what the domain is for, and, for someone who builds, a New app card
// that opens the start page. Who an app is for and the tools it reaches
// wait on core (GRA-532).

/** A screen's title: that of the first surface that opens it, or its name. */
const titleOf = (screen: string, surfaces: readonly SurfaceSummary[]): string =>
  surfaces.find((surface) => surface.screen === screen)?.title ?? screen;

/** One app of the domain: the whole card opens it in the frame. */
const AppCard = ({
  engine,
  screen,
  title,
  description,
}: {
  engine: string;
  screen: string;
  title: string;
  description: string;
}) => (
  <li className="bg-card hover:border-faint relative flex min-w-0 flex-col gap-3 rounded-xl border p-4 transition-colors">
    <div className="flex min-w-0 items-center gap-3">
      <span
        aria-hidden="true"
        className="bg-muted text-foreground inline-flex size-9 flex-none items-center justify-center rounded-lg"
      >
        <LayoutGridIcon className="size-4" />
      </span>
      <Link
        className="min-w-0 flex-1 truncate font-medium outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:underline"
        params={{ engine, screen }}
        to="/domains/$engine/apps/$screen"
      >
        {title}
      </Link>
    </div>
    {description === "" ? null : (
      <p className="text-muted-foreground line-clamp-2">{description}</p>
    )}
  </li>
);

/** The card that opens the New app page, after the apps there are. */
const NewAppCard = () => (
  <li className="hover:border-faint text-muted-foreground hover:text-foreground relative flex min-h-24 items-center justify-center gap-2 rounded-xl border border-dashed p-4 transition-colors">
    <PlusIcon aria-hidden="true" className="size-4" />
    <Link
      className="font-medium outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:underline"
      to="/apps/new"
    >
      <Trans>New app</Trans>
    </Link>
  </li>
);

/**
 * The domain's apps, titled from its `surfaces`, or why there are none;
 * for someone who builds (`builds`), with the way to make a new one.
 */
export const EngineApps = ({
  engine,
  description,
  contents,
  surfaces,
  builds,
}: {
  engine: string;
  /** What the domain is for, which each of its apps shows. */
  description: string;
  contents: AppContents;
  surfaces: readonly SurfaceSummary[];
  builds: boolean;
}) => {
  const { t } = useLingui();
  if (contents.version === null || contents.screens.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed p-6">
        <span
          aria-hidden="true"
          className="bg-tile flex size-7 items-center justify-center rounded-md border"
        >
          <LayoutGridIcon className="size-4" />
        </span>
        <div className="flex max-w-prose flex-col gap-1">
          <span className="font-medium">
            <Trans>No apps yet</Trans>
          </span>
          <p className="text-muted-foreground">
            {contents.version === null ? (
              <Trans>This domain has no version to run yet.</Trans>
            ) : (
              <Trans>
                An app is what this domain&apos;s team works in, standing on its
                workflows and integrations.
              </Trans>
            )}
          </p>
        </div>
        {builds ? (
          <Link className={buttonVariants({ size: "sm" })} to="/apps/new">
            <PlusIcon data-icon="inline-start" />
            <Trans>New app</Trans>
          </Link>
        ) : null}
      </div>
    );
  }
  return (
    <ul
      aria-label={t`Apps`}
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
    >
      {contents.screens.map((screen) => (
        <AppCard
          description={description}
          engine={engine}
          key={screen}
          screen={screen}
          title={titleOf(screen, surfaces)}
        />
      ))}
      {builds ? <NewAppCard /> : null}
    </ul>
  );
};
