import { Button } from "@grasp-os/ui/components/button";
import { DataTable } from "@grasp-os/ui/components/data-table";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@grasp-os/ui/components/dialog";
import { Input } from "@grasp-os/ui/components/input";
import { createFileRoute, notFound } from "@tanstack/react-router";

import { AdminPage } from "../admin/page.tsx";

// Local proof that the admin's own build draws Damsko's components
// (packages/ui) beside the kit's: its frame and page header are the kit's,
// what stands in the page is Damsko's. Not product UI: like apps/web's
// /kit/damsko, a build in production mode answers not found.
// e2e/admin/damsko.e2e.ts holds each part to its own styles, light and
// dark.

interface Release {
  id: string;
  channel: string;
  clients: number;
}

const releases: Release[] = [
  { id: "26.11.4", channel: "Edge", clients: 2 },
  { id: "26.11.3", channel: "Beta", clients: 5 },
  { id: "26.10.9", channel: "Stable", clients: 14 },
];

const DamskoPage = () => (
  <AdminPage
    description="Damsko's components, drawn by the admin's own build beside the kit's."
    title="Damsko"
  >
    <div className="flex max-w-3xl flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <Input aria-label="Organization name" placeholder="Acme" />
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="outline">Rename</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Rename the organization</DialogTitle>
              <DialogDescription>Staff see the new name.</DialogDescription>
            </DialogHeader>
            <DialogBody>Its address stays the same.</DialogBody>
          </DialogContent>
        </Dialog>
        <Button>Save changes</Button>
      </div>
      <DataTable
        aria-label="Releases"
        columns={[
          { id: "id", header: "Release", value: (release) => release.id },
          {
            id: "channel",
            header: "Channel",
            value: (release) => release.channel,
          },
          {
            id: "clients",
            header: "Clients",
            value: (release) => release.clients,
          },
        ]}
        getRowId={(release) => release.id}
        rows={releases}
        unit={{ one: "release", other: "releases" }}
      />
    </div>
  </AdminPage>
);

export const Route = createFileRoute("/damsko")({
  beforeLoad: () => {
    if (import.meta.env.MODE === "production") {
      throw notFound();
    }
  },
  head: () => ({ meta: [{ title: "Damsko" }] }),
  component: DamskoPage,
});
