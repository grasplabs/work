import {
  createFileRoute,
  getRouteApi,
  notFound,
  rootRouteId,
} from "@tanstack/react-router";

import { OrganizationPage } from "../../admin/organization.tsx";

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
 * that isn't there: a client is recorded as it's added, before anything
 * runs. Under organizations/, not beside the admin's sections: a
 * client may be named `platform`.
 */
export const Route = createFileRoute("/organizations/$clientId")({
  loader: async ({ params, parentMatchPromise }) => {
    const { loaderData } = await parentMatchPromise;
    const admin = loaderData?.admins.find(
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
