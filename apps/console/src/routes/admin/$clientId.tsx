import { createFileRoute, notFound } from "@tanstack/react-router";

import { AdminPage } from "../../admin/page.tsx";

const Organization = () => <AdminPage title={Route.useLoaderData().name} />;

/**
 * One organization in the admin: only its name until its own page, with
 * its column of sections, is ported. One the console doesn't know (or has
 * offboarded) is a page that isn't there.
 */
export const Route = createFileRoute("/admin/$clientId")({
  loader: async ({ params, parentMatchPromise }) => {
    const { loaderData } = await parentMatchPromise;
    const admin = loaderData?.find(
      ({ client }) => client.id === params.clientId
    );
    if (admin === undefined) {
      throw notFound();
    }
    return { name: admin.client.name };
  },
  head: ({ loaderData }) => ({
    meta: loaderData === undefined ? [] : [{ title: loaderData.name }],
  }),
  component: Organization,
});
