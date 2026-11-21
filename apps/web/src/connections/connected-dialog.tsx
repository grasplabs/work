import type { ListedConnection } from "@grasp-os/shared/connect";
import { useLingui } from "@lingui/react/macro";

import {
  Dialog,
  DialogAction,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../grasp/dialog/index.ts";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "../grasp/item/index.ts";

// What the connect dialog ends on, as the prototype's `Done` view
// (`components/connect-dialog.tsx`): the sign-in happens at the provider,
// which sends the person back to the page with `connection=<id>`, so the
// page opens this once it lists that connection: that the
// app is connected (again, when the flow signed in again), what Grasp may
// do there, and what was chosen: who uses it and, for a Composio toolkit,
// the tools allowed. A library Dialog: Grasp UI has no success mark, and
// its title says it.

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
      <DialogContent closeLabel={t`Close`}>
        {connection === undefined ? null : (
          <>
            <DialogTitle>
              {again ? t`${app} is connected again` : t`${app} is connected`}
            </DialogTitle>
            <DialogDescription>
              {connection.source === "composio"
                ? t`Grasp may use ${app} only through the tools you allowed.`
                : t`Grasp may read and write in ${app}, only for what you allow.`}
            </DialogDescription>
            <DialogBody>
              <ItemGroup aria-label={t`What you chose`} separated>
                <ScopeRow connection={connection} />
                {tools.map((tool) => (
                  <Item key={tool} size="xs">
                    <ItemContent>
                      <ItemTitle>{tool}</ItemTitle>
                    </ItemContent>
                  </Item>
                ))}
              </ItemGroup>
            </DialogBody>
            <DialogFooter>
              <DialogAction>{t`Close`}</DialogAction>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};
