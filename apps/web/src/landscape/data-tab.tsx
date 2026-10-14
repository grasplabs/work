import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import { Separator } from "@grasp-os/ui/components/separator";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useLocation } from "@tanstack/react-router";
import { useEffect } from "react";

import { dataSection } from "./landscape-overview.ts";
import type { LandscapeApp } from "./landscape.ts";
import { Section } from "./section.tsx";

// An app's Data tab, as the prototype lays it out
// (`components/landscape/data/`): the data the app touches and the teams
// that use it, where the vendor keeps the data, and the permissions it
// holds. Grasp classifies no app's data, reads no vendor's residency and
// syncs no identity provider's grants yet, so each section is the
// prototype's empty state.

/** The data categories an app touches, and its users by team. */
const DataExposure = ({ users }: { users: number }) => {
  const { t } = useLingui();
  return (
    <Section
      description={t`The data this app touches and the teams that use it.`}
      title={t`Data exposure`}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-0.5">
            <h3 className="font-medium">
              <Trans>Data categories</Trans>
            </h3>
            <p className="text-muted-foreground">
              <Trans>
                From the permissions people granted and how the app is
                classified.
              </Trans>
            </p>
          </div>
          <p className="text-muted-foreground">
            <Trans>None found.</Trans>
          </p>
        </div>
        <Separator />
        <div className="flex flex-col gap-2">
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-0.5">
              <h3 className="font-medium">
                <Trans>Users by team</Trans>
              </h3>
              <p className="text-muted-foreground">
                <Trans>
                  Teams with at least one grant. Open a team to see its usage.
                </Trans>
              </p>
            </div>
            <span className="text-muted-foreground shrink-0 tabular-nums">
              {t`${plural(users, { one: "# user", other: "# users" })}`}
            </span>
          </div>
          <p className="text-muted-foreground">
            <Trans>No usage found.</Trans>
          </p>
        </div>
      </div>
    </Section>
  );
};

/** Where the vendor stores and processes data. */
const DataResidency = () => {
  const { t } = useLingui();
  return (
    <Section
      description={t`Where the vendor says data is stored and processed, and any transfers to other countries.`}
      id={dataSection.residency}
      title={t`Data residency`}
    >
      <Empty size="xs">
        <EmptyHeader>
          <EmptyTitle>
            <Trans>No residency disclosed</Trans>
          </EmptyTitle>
          <EmptyDescription>
            <Trans>
              Ask the vendor where data is stored and processed before sign-off.
            </Trans>
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </Section>
  );
};

/** The permissions granted to the app through sign-in. */
const PermissionsSection = ({ appName }: { appName: string }) => {
  const { t } = useLingui();
  return (
    <Section
      description={t`What your identity provider granted ${appName}.`}
      id={dataSection.permissions}
      title={t`Permissions`}
    >
      <Empty size="xs">
        <EmptyHeader>
          <EmptyTitle>
            <Trans>No permissions synced</Trans>
          </EmptyTitle>
          <EmptyDescription>
            <Trans>
              They show here once Grasp reads your identity provider&apos;s
              grants.
            </Trans>
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </Section>
  );
};

/** The Data tab: the data an app touches, where it lives, and the permissions it holds. */
export const DataTab = ({ app }: { app: LandscapeApp }) => {
  const target = useLocation({
    select: (location) => location.hash.replace(/^#/u, ""),
  });
  // Arriving on a section link (#data-section-…): scroll to it once it is on the page.
  useEffect(() => {
    const frame =
      target === ""
        ? null
        : requestAnimationFrame(() =>
            document
              .querySelector(`#${CSS.escape(target)}`)
              ?.scrollIntoView({ behavior: "smooth", block: "start" })
          );
    return () => {
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
    };
  }, [target]);
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-6 xl:grid-cols-2">
        <DataExposure users={app.users} />
        <DataResidency />
      </div>
      <PermissionsSection appName={app.name} />
    </div>
  );
};
