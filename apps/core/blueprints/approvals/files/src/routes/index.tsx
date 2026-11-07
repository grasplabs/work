import {
  PageHeader,
  PageHeaderActions,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@grasp-os/ui/components/page-header";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@grasp-os/ui/components/tabs";
import { createFileRoute } from "@tanstack/react-router";

import { NewRequest } from "../components/new-request";
import { Requests } from "../components/requests";
import type { Status } from "../components/requests";

const tabs: readonly { status: Status; label: string }[] = [
  { status: "pending", label: "Pending" },
  { status: "approved", label: "Approved" },
  { status: "rejected", label: "Rejected" },
];

const Approvals = () => (
  <main className="flex flex-col gap-6 p-6">
    <PageHeader>
      <PageHeaderContent>
        <PageHeaderTitle>Approvals</PageHeaderTitle>
        <PageHeaderDescription>
          Your own requests, and every request if you approve them.
        </PageHeaderDescription>
      </PageHeaderContent>
      <PageHeaderActions>
        <NewRequest />
      </PageHeaderActions>
    </PageHeader>
    <Tabs defaultValue="pending">
      <TabsList>
        {tabs.map(({ status, label }) => (
          <TabsTrigger key={status} value={status}>
            {label}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map(({ status }) => (
        <TabsContent key={status} value={status}>
          <Requests status={status} />
        </TabsContent>
      ))}
    </Tabs>
  </main>
);

export const Route = createFileRoute("/")({ component: Approvals });
