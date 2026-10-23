import { newClientIdSchema } from "@grasp-os/shared/router";
import {
  createFileRoute,
  getRouteApi,
  notFound,
  redirect,
  rootRouteId,
} from "@tanstack/react-router";

import { OrganizationPage } from "../../admin/organization.tsx";
import { fetchProvisioning } from "../../provision/functions.ts";

/** Every organization, as the admin's layout read them. */
const adminRoute = getRouteApi(rootRouteId);

const Organization = () => {
  const { clientId } = Route.useParams();
  const admin = adminRoute
    .useLoaderData()
    .admins.find(({ client }) => client.id === clientId);
  // The loader has made sure it is there.
  return admin === undefined ? null : <OrganizationPage admin={admin} />;
};

/**
 * One organization in the admin: its column of sections beside the
 * section it is on (src/admin/organization.tsx), each section a route
 * under it. One the admin doesn't know (or has offboarded) is a page
 * that isn't there; one whose run hasn't recorded it yet is followed where
 * it was added. Under organizations/, not beside the admin's sections: a
 * client may be named `platform`.
 */
export const Route = createFileRoute("/organizations/$clientId")({
  loader: async ({ params, parentMatchPromise }) => {
    const { loaderData } = await parentMatchPromise;
    const admin = loaderData?.admins.find(
      ({ client }) => client.id === params.clientId
    );
    if (admin === undefined) {
      // Being set up, and not recorded yet: followed where it was added.
      const run = newClientIdSchema.safeParse(params.clientId).success
        ? await fetchProvisioning({ data: { clientId: params.clientId } })
        : null;
      if (run !== null && run.client === null) {
        // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
        throw redirect({
          to: "/new-organization",
          search: { following: params.clientId },
        });
      }
      throw notFound();
    }
    return { name: admin.client.name };
  },
  head: ({ loaderData }) => ({
    meta: loaderData === undefined ? [] : [{ title: loaderData.name }],
  }),
  component: Organization,
});
