import { Badge } from "@grasp-os/ui/components/badge";
import { createFileRoute } from "@tanstack/react-router";

import { AdminPage } from "../../admin/page.tsx";
import { PlatformNav, platformCrumb } from "../../admin/platform-nav.tsx";
import { Quiet } from "../../admin/release-parts.tsx";
import { CapabilityChecklist } from "../../hosting/capability-checks.tsx";
import { fetchDestinations } from "../../hosting/functions.ts";
import type { DestinationOverview } from "../../hosting/placement.ts";
import { problemWords } from "../../hosting/words.ts";

const kindWords: Readonly<Record<DestinationOverview["kind"], string>> = {
  workers_for_platforms: "Shared (Workers for Platforms)",
  dedicated: "Dedicated",
  workerd: "workerd",
};

/** One destination: where it is, and where it stands under each policy. */
const Destination = ({ destination }: { destination: DestinationOverview }) => (
  <li className="flex flex-col gap-4 rounded-xl border p-4 text-sm">
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-mono font-medium">{destination.id}</span>
      <Badge variant="outline">{kindWords[destination.kind]}</Badge>
    </div>
    <p className="text-muted-foreground">
      {`Account ${destination.accountId ?? "none"}, namespace ${destination.namespace ?? "none"}. Serves ${destination.policies.length === 0 ? "no policy" : destination.policies.join(", ")}.`}
    </p>
    {destination.byPolicy.map((policy) => {
      const others = policy.problems.filter(
        (problem) => !("capability" in problem)
      );
      return (
        <section className="flex flex-col gap-2" key={policy.policyId}>
          <h2 className="font-medium">{policy.policyId}</h2>
          <p className="text-muted-foreground">{policy.description}</p>
          {others.length === 0 ? null : (
            <ul className="text-muted-foreground flex list-disc flex-col gap-1 pl-5">
              {others.map((problem) => (
                <li key={problem.kind}>{problemWords(problem)}</li>
              ))}
            </ul>
          )}
          <CapabilityChecklist
            checks={policy.checks}
            destinationId={destination.id}
          />
        </section>
      );
    })}
  </li>
);

/**
 * Platform's Destinations page: every hosting destination the admin
 * knows, its own stage's first recorded here if it wasn't yet, with what
 * each policy needs of it, who checked what, and the form to record a
 * check (src/hosting/placement.ts, `destinationsOverview`).
 */
const DestinationsPage = () => {
  const destinations = Route.useLoaderData();
  return (
    <AdminPage
      description="Where clients run, and what each hosting policy needs of each place. A client is placed only where every requirement of its policy is checked."
      parents={[platformCrumb]}
      title="Destinations"
    >
      <PlatformNav />
      {destinations.length === 0 ? (
        <Quiet>
          No destination yet: this admin&apos;s STAGE names no stage.
        </Quiet>
      ) : (
        <ul className="flex flex-col gap-4">
          {destinations.map((destination) => (
            <Destination destination={destination} key={destination.id} />
          ))}
        </ul>
      )}
    </AdminPage>
  );
};

export const Route = createFileRoute("/platform/destinations")({
  loader: async () => await fetchDestinations(),
  head: () => ({ meta: [{ title: "Destinations" }] }),
  component: DestinationsPage,
});
