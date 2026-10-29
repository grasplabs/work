import { Button } from "@grasp-os/ui/components/button";
import { Checkbox } from "@grasp-os/ui/components/checkbox";
import { Field, FieldLabel } from "@grasp-os/ui/components/field";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { AdminPage } from "../../admin/page.tsx";
import { PlatformNav, platformCrumb } from "../../admin/platform-nav.tsx";
import { Quiet } from "../../admin/release-parts.tsx";
import {
  deletePlacedClientFn,
  fetchOffboardedClients,
} from "../../hosting/functions.ts";
import type { OffboardResult } from "../../hosting/functions.ts";
import type { OffboardedClient } from "../../hosting/offboarding.ts";
import { offboardRefusals } from "../../hosting/words.ts";
import { formatTime } from "../../releases/format.ts";
import { thenRefresh, useAction } from "../../use-action.ts";

/**
 * Deleting one offboarded client's resources: once their retention is
 * over, with staff confirming that no export of it was made, until the
 * export exists (GRA-413). Before then the button is off, saying from
 * when. A bucket still holding objects expires them, and deleting again
 * after deletes it: said from what was recorded, so it stays on reload.
 */
const DeleteResources = ({ client }: { client: OffboardedClient }) => {
  const router = useRouter();
  const { busy, failure, run } = useAction(offboardRefusals);
  const [noExport, setNoExport] = useState(false);
  const [deleted, setDeleted] = useState<OffboardResult["deletion"]>(null);
  const waits = !client.deletable;
  const id = `no-export-${client.clientId}`;
  const remove = () => {
    void run(async () => {
      const result = await thenRefresh(
        async () =>
          await deletePlacedClientFn({
            data: { clientId: client.clientId, exportConfirmed: noExport },
          }),
        async () => {
          await router.invalidate({ sync: true });
        }
      );
      setDeleted(result.deletion);
      return result;
    });
  };
  return (
    <li className="flex flex-col gap-3 rounded-xl border p-4 text-sm">
      <p className="font-medium">{`${client.name} (${client.clientId})`}</p>
      <p className="text-muted-foreground">
        {`Offboarded on ${formatTime(client.offboardedAt)} UTC from ${client.destinationId}. Its resources are kept until ${formatTime(client.deletableFrom)} UTC; ${client.remaining} are still there.`}
      </p>
      {client.remaining === 0 ? null : (
        <>
          <Field orientation="horizontal">
            <Checkbox
              checked={noExport}
              disabled={waits}
              id={id}
              onCheckedChange={setNoExport}
            />
            <FieldLabel htmlFor={id}>
              No export of it was made, and I delete its resources without one
            </FieldLabel>
          </Field>
          <div className="flex flex-wrap items-center gap-4">
            <Button
              disabled={busy || waits || !noExport}
              onClick={remove}
              variant="destructive"
            >
              Delete its resources
            </Button>
            {waits ? (
              <p className="text-muted-foreground">
                {`It can be deleted from ${formatTime(client.deletableFrom)} UTC, once its 30 days are over.`}
              </p>
            ) : null}
            {failure === null ? null : (
              <p className="text-destructive" role="alert">
                {failure}
              </p>
            )}
          </div>
        </>
      )}
      {deleted === null ? null : (
        <output>{`Deleted ${deleted.deleted} of its resources.`}</output>
      )}
      {client.emptying.length === 0 ? null : (
        <ul className="flex flex-col gap-1">
          {client.emptying.map(({ physicalName, emptyBy }) => (
            <li key={physicalName}>
              {`${physicalName} still held objects, which expire by ${formatTime(emptyBy)} UTC: delete again after that to delete it.`}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
};

/**
 * Platform's Offboarded page: every client staff offboarded from a
 * hosting destination, when, and deleting its resources once their
 * retention is over (src/hosting/offboarding.ts). An offboarded client has
 * no page among the organizations.
 */
const OffboardedPage = () => {
  const offboarded = Route.useLoaderData();
  return (
    <AdminPage
      description="Clients offboarded from a hosting destination. Their resources are kept for 30 days, then deleted here, one client at a time, by someone at Grasp."
      parents={[platformCrumb]}
      title="Offboarded"
    >
      <PlatformNav />
      {offboarded.length === 0 ? (
        <Quiet>No client is offboarded.</Quiet>
      ) : (
        <ul className="flex flex-col gap-4">
          {offboarded.map((client) => (
            <DeleteResources client={client} key={client.clientId} />
          ))}
        </ul>
      )}
    </AdminPage>
  );
};

export const Route = createFileRoute("/platform/offboarded")({
  loader: async () => await fetchOffboardedClients(),
  head: () => ({ meta: [{ title: "Offboarded" }] }),
  component: OffboardedPage,
});
