import { createFileRoute, notFound } from "@tanstack/react-router";

import { readOrganization } from "../../admin/org-loads.ts";
import { freshMs } from "../../admin/org-reads.ts";
import { OffboardedPage, OrganizationPage } from "../../admin/organization.tsx";

const Organization = () => {
  const loaded = Route.useLoaderData();
  if (loaded.state === "offboarded") {
    return <OffboardedPage client={loaded.client} />;
  }
  // Keyed by the organization: another's answer never shows in its place.
  return (
    <OrganizationPage
      client={loaded.client}
      key={loaded.client.id}
      read={loaded.read}
    />
  );
};

/**
 * One organization in the admin: its column of sections beside the
 * section it is on (src/admin/organization.tsx), each section a route
 * under it. Its shell (its name, its column, its Setup) comes from what
 * the admin recorded, at once; what its core answers comes in after,
 * into the parts that need it, read once and reused while fresh: moving
 * between its sections asks its core nothing (src/admin/org-loads.ts).
 * Preloaded (a link pointed at), it asks its core nothing at all: that
 * read is audited as staff opening it, so it waits until they do. One
 * the admin doesn't know is a page that isn't there: a client is
 * recorded as it's added, before anything runs. One offboarded says so,
 * and its core isn't asked. Under organizations/, not beside the admin's
 * sections: a client may be named `platform`.
 */
export const Route = createFileRoute("/organizations/$clientId")({
  loader: async ({ params, parentMatchPromise, context, preload }) => {
    const { loaderData } = await parentMatchPromise;
    const client = loaderData?.clients.find(({ id }) => id === params.clientId);
    if (loaderData === undefined || client === undefined) {
      // Gone, as one deleted while its page was open: nothing of it is kept.
      context.reads.forget(params.clientId);
      throw notFound();
    }
    if (client.status === "offboarded") {
      context.reads.forget(client.id);
      return { state: "offboarded" as const, client };
    }
    const { read } = await readOrganization({
      reads: context.reads,
      client,
      // Loaded while the tab shows it: its core is asked anew.
      onIt: context.shown() === client.id,
      preload,
    });
    return { state: "open" as const, client, read };
  },
  staleTime: freshMs,
  // A preload holds its shell alone: opened, the page loads anew and asks its core.
  preloadStaleTime: 0,
  head: ({ loaderData }) => ({
    meta: loaderData === undefined ? [] : [{ title: loaderData.client.name }],
  }),
  component: Organization,
});
