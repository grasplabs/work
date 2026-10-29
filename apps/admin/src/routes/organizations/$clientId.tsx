import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense, useEffect } from "react";

import { readOrganization } from "../../admin/org-loads.ts";
import { freshMs } from "../../admin/org-reads.ts";
import type { OrgRead } from "../../admin/org-reads.ts";
import { OffboardedPage, OrganizationPage } from "../../admin/organization.tsx";
import { useSettled } from "../../admin/settled.tsx";
import type { Deferred } from "../../admin/settled.tsx";
import type { GridRow } from "../../clients/grid.ts";

/** The page once its core's answer is in, and while it is read again, the answer it has. */
const Settled = ({
  client,
  read,
}: {
  client: GridRow;
  read: Deferred<OrgRead>;
}) => {
  const shown = useSettled(read);
  const { reads } = Route.useRouteContext();
  // An answer read on the server, for the page this tab opened on, is
  // kept here too: read again, and not answering, the page keeps it.
  useEffect(() => {
    reads.remember(shown.admin);
  }, [reads, shown]);
  return <OrganizationPage client={client} read={shown} />;
};

const Organization = () => {
  const { client, read } = Route.useLoaderData();
  if (read === null) {
    return <OffboardedPage client={client} />;
  }
  // Keyed by the organization: another's answer never shows in its place.
  return (
    <Suspense
      fallback={
        <OrganizationPage client={client} key={client.id} read={null} />
      }
      key={client.id}
    >
      <Settled client={client} read={read} />
    </Suspense>
  );
};

/**
 * One organization in the admin: its column of sections beside the
 * section it is on (src/admin/organization.tsx), each section a route
 * under it. Its shell (its name, its column, its Setup) comes from what
 * the admin recorded, at once; what its core answers comes in after,
 * into the section, read once and reused while fresh: moving between its
 * sections asks its core nothing (src/admin/org-loads.ts). One the admin
 * doesn't know is a page that isn't there: a client is recorded as it's
 * added, before anything runs. One offboarded says so, and its core
 * isn't asked. Under organizations/, not beside the admin's sections: a
 * client may be named `platform`.
 */
export const Route = createFileRoute("/organizations/$clientId")({
  loader: async ({ params, parentMatchPromise, context, cause }) => {
    const { loaderData } = await parentMatchPromise;
    const client = loaderData?.clients.find(({ id }) => id === params.clientId);
    if (loaderData === undefined || client === undefined) {
      throw notFound();
    }
    if (client.status === "offboarded") {
      context.reads.forget(client.id);
      return { client, read: null };
    }
    const { read } = await readOrganization({
      reads: context.reads,
      client,
      admins: loaderData.admins,
      // Run again on the page it is on: its answer went stale, or staff asked anew.
      again: cause === "stay",
    });
    return { client, read };
  },
  staleTime: freshMs,
  head: ({ loaderData }) => ({
    meta: loaderData === undefined ? [] : [{ title: loaderData.client.name }],
  }),
  component: Organization,
});
