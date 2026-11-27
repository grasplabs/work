import { Button } from "@grasp-os/ui/components/button";
import { Checkbox } from "@grasp-os/ui/components/checkbox";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import { Field, FieldLabel } from "@grasp-os/ui/components/field";
import { SectionHeader } from "@grasp-os/ui/components/section-header";
import { Text } from "@grasp-os/ui/components/text";
import { ArchiveIcon } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { PageLoading } from "../../admin/failure.tsx";
import { PlatformPage, platformCrumb } from "../../admin/platform-nav.tsx";
import { Actions, Failure, FormStack } from "../../admin/setup-parts.tsx";
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
  const name = `${client.name} (${client.clientId})`;
  const more =
    client.remaining > 0 || deleted !== null || client.emptying.length > 0;
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
  const heading = `offboarded-${client.clientId}`;
  return (
    <li aria-labelledby={heading} {...stylex.props(styles.client)}>
      <SectionHeader
        description={`Offboarded on ${formatTime(client.offboardedAt)} UTC from ${client.destinationId}. Its resources are kept until ${formatTime(client.deletableFrom)} UTC; ${client.remaining} are still there.`}
        id={heading}
        size="sm"
        title={name}
        variant="group"
      />
      {more ? (
        <FormStack>
          {client.remaining === 0 ? null : (
            <>
              <Field disabled={waits} orientation="horizontal">
                <Checkbox
                  checked={noExport}
                  onCheckedChange={(checked) => {
                    setNoExport(checked === true);
                  }}
                />
                <FieldLabel>
                  No export of it was made, and I delete its resources without
                  one
                </FieldLabel>
              </Field>
              <Actions>
                <Button
                  disabled={busy || waits || !noExport}
                  onClick={remove}
                  size="sm"
                  variant="destructive"
                >
                  Delete its resources
                </Button>
                {waits ? (
                  <Text color="muted" size="sm">
                    {`It can be deleted from ${formatTime(client.deletableFrom)} UTC, once its 30 days are over.`}
                  </Text>
                ) : null}
                <Failure failure={failure} />
              </Actions>
            </>
          )}
          {deleted === null ? null : (
            <output>
              <Text as="span" size="sm">
                {`Deleted ${deleted.deleted} of its resources.`}
              </Text>
            </output>
          )}
          {client.emptying.length === 0 ? null : (
            <ul {...stylex.props(styles.list)}>
              {client.emptying.map(({ physicalName, emptyBy }) => (
                <li key={physicalName}>
                  <Text size="sm">
                    {`${physicalName} still held objects, which expire by ${formatTime(emptyBy)} UTC: delete again after that to delete it.`}
                  </Text>
                </li>
              ))}
            </ul>
          )}
        </FormStack>
      ) : null}
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
    <PlatformPage
      description="Clients offboarded from a hosting destination. Their resources are kept for 30 days, then deleted here, one client at a time, by someone at Grasp."
      parents={[platformCrumb]}
      title="Offboarded"
    >
      {offboarded.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia icon={ArchiveIcon} />
            <EmptyTitle>No client is offboarded</EmptyTitle>
            <EmptyDescription>
              A client offboarded from its Setup shows here, until its resources
              are deleted.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul {...stylex.props(styles.list, styles.clients)}>
          {offboarded.map((client) => (
            <DeleteResources client={client} key={client.clientId} />
          ))}
        </ul>
      )}
    </PlatformPage>
  );
};

const styles = stylex.create({
  list: {
    display: "flex",
    flexDirection: "column",
    gap: space["1"],
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  // One client after another, a part's room apart.
  clients: { gap: space["8"] },
  // A client's name and facts, then deleting its resources.
  client: { display: "flex", flexDirection: "column", gap: space["4"] },
});

export const Route = createFileRoute("/platform/offboarded")({
  loader: async () => await fetchOffboardedClients(),
  head: () => ({ meta: [{ title: "Offboarded" }] }),
  component: OffboardedPage,
  pendingComponent: PageLoading,
});
