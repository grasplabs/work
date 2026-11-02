import { Button } from "@grasp-os/ui/components/button";
import {
  createFileRoute,
  getRouteApi,
  rootRouteId,
} from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { AskChat } from "../admin/ask-chat.tsx";
import { documentOf } from "../admin/ask-document.ts";
import { AdminHeader } from "../admin/page.tsx";

/** Every organization, as the admin's layout read them. */
const adminRoute = getRouteApi(rootRouteId);

/** Today in the browser's own calendar, as the digest names it: YYYY-MM-DD. */
const localToday = (): string => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};

/**
 * Ask Grasp: a chat over every organization (src/admin/ask-chat.tsx), held
 * to the window as the platform's chat page is, so a tall box makes the
 * conversation shorter, never the page longer. "New chat" starts over.
 */
const AskPage = () => {
  const { admins } = adminRoute.useLoaderData();
  const { about } = Route.useSearch();
  const [chat, setChat] = useState(0);
  const name =
    about === undefined
      ? undefined
      : admins.find(({ client }) => client.id === about)?.client.name;
  return (
    <>
      <AdminHeader
        actions={
          <Button
            onClick={() => {
              setChat((each) => each + 1);
            }}
            size="sm"
            variant="outline"
          >
            <PlusIcon data-icon="inline-start" />
            New chat
          </Button>
        }
        page="Ask Grasp"
      />
      <div className="flex min-h-0 flex-1 flex-col text-sm">
        <h1 className="sr-only">Ask Grasp</h1>
        <AskChat
          about={name}
          document={() => documentOf(admins, localToday())}
          key={chat}
        />
      </div>
    </>
  );
};

/** The chat over every organization; `about` names the organization whose call it offers to prepare. */
export const Route = createFileRoute("/ask")({
  validateSearch: (search: Record<string, unknown>): { about?: string } =>
    typeof search.about === "string" ? { about: search.about } : {},
  component: AskPage,
});
