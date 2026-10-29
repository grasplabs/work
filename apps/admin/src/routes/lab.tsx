import { createFileRoute } from "@tanstack/react-router";

import { WithAdmins } from "../admin/admins.tsx";
import { StephenLab } from "../admin/lab.tsx";
import { AdminPage } from "../admin/page.tsx";
import { organizationsOf } from "../admin/views.ts";

/** Stephen Lab: how Stephen and Claire do across every organization (src/admin/lab.tsx). */
const LabPage = () => (
  <AdminPage
    description="How Stephen and Claire do in every organization’s interviews, from each company’s own Grasp."
    title="Stephen Lab"
  >
    <WithAdmins>
      {(admins) => <StephenLab organizations={organizationsOf(admins)} />}
    </WithAdmins>
  </AdminPage>
);

export const Route = createFileRoute("/lab")({
  component: LabPage,
});
