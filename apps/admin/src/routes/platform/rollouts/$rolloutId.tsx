import { Badge } from "@grasp-os/ui/components/badge";
import { buttonVariants } from "@grasp-os/ui/components/button";
import {
  createFileRoute,
  Link,
  notFound,
  useRouter,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";

import { AdminPage } from "../../../admin/page.tsx";
import { Panel } from "../../../admin/panel.tsx";
import {
  PlatformNav,
  platformCrumb,
  rolloutsCrumb,
  useCompanyNames,
} from "../../../admin/platform-nav.tsx";
import { RingSteps } from "../../../admin/platform-parts.tsx";
import { ringsOf } from "../../../admin/platform.ts";
import { Facts } from "../../../admin/release-parts.tsx";
import {
  Controls,
  Revocation,
  rolloutStateWords,
  Targets,
  totalCostWords,
} from "../../../admin/rollout-parts.tsx";
import { formatTime } from "../../../releases/format.ts";
import { versionWords } from "../../../releases/version.ts";
import type { RolloutCost } from "../../../rollout/cost.ts";
import { fetchRollout, fetchRolloutCost } from "../../../rollout/functions.ts";
import type { RolloutView } from "../../../rollout/queries.ts";

/** How often the page reads the rollout again while it's going. */
const refreshMs = 5000;

/** Rollout `rolloutId`'s clients' cost, or `failed` when it couldn't be read. Never throws. */
const readCost = async (rolloutId: string): Promise<RolloutCost | "failed"> => {
  try {
    return await fetchRolloutCost({ data: { rolloutId } });
  } catch {
    return "failed";
  }
};

/** What the rollout takes out, as its page's title says it. */
const titleOf = (rollout: RolloutView): string =>
  rollout.kind === "secrets"
    ? "Rollout of new secrets"
    : `Rollout of ${(rollout.release === null ? null : versionWords(rollout.release)) ?? rollout.releaseId ?? ""}`;

/**
 * One rollout: where it stands ring by ring, what staff can do to it
 * (approve, retry, pause, resume, cancel), each company in it with its
 * rollback, and for a secrets rollout whether the old secrets can go. It
 * reads itself again every few seconds while it goes. The admin's
 * rollout page, under Platform.
 */
const RolloutPage = () => {
  const rollout = Route.useLoaderData();
  const router = useRouter();
  const names = useCompanyNames();
  const going = rollout.status === "running" || rollout.status === "waiting";
  useEffect(() => {
    // Only the rollout is read again: the admin's frame reads every
    // company's core, whose audit log records it (src/routes/admin.tsx).
    const timer = going
      ? setInterval(() => {
          void router.invalidate({
            filter: ({ routeId }) => routeId === Route.id,
          });
        }, refreshMs)
      : undefined;
    return () => {
      clearInterval(timer);
    };
  }, [going, router]);
  // Read once the page shows, from the clients' accounts, and not again
  // as the page refreshes: a month's cost doesn't move in seconds. An
  // answer is the rollout's it was read for, so another rollout's page
  // shows its own as reading until it comes.
  const [costRead, setCostRead] = useState<{
    rolloutId: string;
    cost: RolloutCost | "failed";
  } | null>(null);
  useEffect(() => {
    let current = true;
    void (async () => {
      const cost = await readCost(rollout.id);
      // A page left before its answer came doesn't take it.
      if (current) {
        setCostRead({ rolloutId: rollout.id, cost });
      }
    })();
    return () => {
      current = false;
    };
  }, [rollout.id]);
  const cost = costRead?.rolloutId === rollout.id ? costRead.cost : null;
  const state = rolloutStateWords(rollout);
  return (
    <AdminPage
      action={
        <Badge
          variant={rollout.status === "failed" ? "destructive" : "secondary"}
        >
          {state}
        </Badge>
      }
      description={`Started by ${rollout.startedBy}.`}
      parents={[platformCrumb, rolloutsCrumb]}
      title={titleOf(rollout)}
    >
      <PlatformNav />
      <div className="flex flex-col gap-6 text-sm">
        <Panel title="Where it stands">
          <div className="border-t px-5 py-4">
            <RingSteps
              label="The rollout, ring by ring"
              steps={ringsOf(rollout, rollout.targets).map((ring) => ({
                ring: ring.ring,
                about: `${ring.done} of ${ring.targets.length} on it`,
                state: ring.state,
              }))}
            />
          </div>
          <Facts
            rows={[
              rollout.kind === "secrets"
                ? {
                    label: "Release",
                    value: "Secrets only, on each client's own release",
                  }
                : {
                    label: "Release",
                    value: (
                      <Link
                        className="underline-offset-4 hover:underline"
                        params={{ releaseId: rollout.releaseId ?? "" }}
                        to="/platform/releases/$releaseId"
                      >
                        {rollout.releaseId ?? ""}
                      </Link>
                    ),
                    mono: true,
                  },
              { label: "Started by", value: rollout.startedBy },
              { label: "Started (UTC)", value: formatTime(rollout.createdAt) },
              {
                label: "Its clients' cost this month",
                value: totalCostWords(cost),
              },
            ]}
          />
          <Controls rollout={rollout} />
        </Panel>
        {rollout.kind === "secrets" ? (
          <Revocation rolloutId={rollout.id} />
        ) : null}
        <Targets cost={cost} names={names} rollout={rollout} />
        <p className="text-muted-foreground">
          Cost is each client&apos;s for the calendar month so far, estimated as
          on the client grid and read from its account after the page shows:
          what the client costs, not what this rollout did.
        </p>
      </div>
    </AdminPage>
  );
};

/** A rollout id that names no rollout. */
const NoSuchRollout = () => (
  <AdminPage
    action={
      <Link
        className={buttonVariants({ variant: "ghost", size: "sm" })}
        to="/platform/rollouts"
      >
        Back to rollouts
      </Link>
    }
    description="The admin has no rollout by that id."
    parents={[platformCrumb, rolloutsCrumb]}
    title="No such rollout"
  />
);

export const Route = createFileRoute("/platform/rollouts/$rolloutId")({
  loader: async ({ params }) => {
    if (!z.uuid().safeParse(params.rolloutId).success) {
      throw notFound();
    }
    const rollout = await fetchRollout({
      data: { rolloutId: params.rolloutId },
    });
    if (rollout === null) {
      throw notFound();
    }
    return rollout;
  },
  component: RolloutPage,
  notFoundComponent: NoSuchRollout,
});
