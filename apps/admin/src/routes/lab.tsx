import {
  createFileRoute,
  getRouteApi,
  rootRouteId,
} from "@tanstack/react-router";

import { StephenLab } from "../admin/lab.tsx";
import { AdminPage } from "../admin/page.tsx";
import { organizationsOf } from "../admin/views.ts";

/** Every organization, as the admin's layout read them. */
const adminRoute = getRouteApi(rootRouteId);

/** Stephen Lab: how Stephen and Claire do across every organization (src/admin/lab.tsx). */
const LabPage = () => {
  const organizations = organizationsOf(adminRoute.useLoaderData().admins);
  return (
    <AdminPage
      description="How Stephen and Claire do in every organization’s interviews, from each company’s own Grasp."
      title="Stephen Lab"
    >
      <StephenLab organizations={organizations} />
    </AdminPage>
  );
};

export const Route = createFileRoute("/lab")({
  component: LabPage,
});
