import type { ListedConnection } from "@grasp-os/shared/connect";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemSeparator,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { useLingui } from "@lingui/react/macro";
import { Fragment } from "react";

import { takesPlaceOf } from "./connection-list.tsx";

// What the connect dialog ends on, as the prototype's `Done` view
// (`components/connect-dialog.tsx`): the sign-in happens at the provider,
// which sends the person back to the page with `connection=<id>`, so the
// page opens this once it lists that connection: that the
// app is connected (again, where it took the place of one of its
// connections that stopped working, `returnedOf`), what Grasp may do
// there, and what was chosen: who uses it, where one reached through the
// company network goes and, for a Composio toolkit, the tools allowed. A Damsko Dialog: it has no success mark, and its title
// says it.

/**
 * What a flow came back with, from what the page lists, never from the
 * address alone: the connection named `id`, only where it is listed and
 * works (anyone can put an ID in a link), and whether it connected the app
 * again: it took the place of one that stopped working (`takesPlaceOf`, a
 * Composio toolkit connected again, app-actions.tsx). Another account
 * beside one that stopped is not "again".
 */
export const returnedOf = (
  connections: readonly ListedConnection[],
  id: string | undefined
): { connection: ListedConnection | undefined; again: boolean } => {
  const connection =
    id === undefined
      ? undefined
      : connections.find((each) => each.id === id && each.status === "active");
  return {
    connection,
    again:
      connection !== undefined &&
      connections.some((each) => takesPlaceOf(connection, each)),
  };
};

/** Where a connection reached through the company network goes, at `address`. */
const CompanyNetworkRow = ({ address }: { address: string }) => {
  const { t } = useLingui();
  return (
    <Item size="xs">
      <ItemContent>
        <ItemTitle>{t`Reached through your company network`}</ItemTitle>
        <ItemDescription>
          {t`Grasp reaches it at ${address}, inside your network.`}
        </ItemDescription>
      </ItemContent>
    </Item>
  );
};

/** The scope chosen, in the connect dialog's own words. */
const ScopeRow = ({ connection }: { connection: ListedConnection }) => {
  const { t } = useLingui();
  const shared = connection.scope === "shared";
  return (
    <Item size="xs">
      <ItemContent>
        <ItemTitle>{shared ? t`For everyone` : t`Just for you`}</ItemTitle>
        <ItemDescription>
          {shared
            ? t`Your organization uses it through the permissions you grant.`
            : t`Only you can use it.`}
        </ItemDescription>
      </ItemContent>
    </Item>
  );
};

/**
 * The success page for `connection` of the app named `app`, open while
 * the page was just sent back with it: that it is connected (again), what
 * Grasp may do there, and what was chosen, as rows.
 */
export const ConnectedDialog = ({
  app,
  connection,
  again,
  onClose,
}: {
  app: string;
  connection: ListedConnection | undefined;
  again: boolean;
  onClose: () => void;
}) => {
  const { t } = useLingui();
  const tools = connection?.tools ?? [];
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open={connection !== undefined}
    >
      <DialogContent>
        {connection === undefined ? null : (
          <>
            <DialogHeader>
              <DialogTitle>
                {again ? t`${app} is connected again` : t`${app} is connected`}
              </DialogTitle>
              <DialogDescription>
                {connection.source === "composio"
                  ? t`Grasp may use ${app} only through the tools you allowed.`
                  : t`Grasp may read and write in ${app}, only for what you allow.`}
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              <ItemGroup aria-label={t`What you chose`}>
                <ScopeRow connection={connection} />
                {connection.companyNetwork === undefined ? null : (
                  <>
                    <ItemSeparator />
                    <CompanyNetworkRow address={connection.companyNetwork} />
                  </>
                )}
                {tools.map((tool) => (
                  <Fragment key={tool}>
                    <ItemSeparator />
                    <Item size="xs">
                      <ItemContent>
                        <ItemTitle>{tool}</ItemTitle>
                      </ItemContent>
                    </Item>
                  </Fragment>
                ))}
              </ItemGroup>
            </DialogBody>
            <DialogFooter>
              <DialogClose>{t`Close`}</DialogClose>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};
