import type { ListedConnection } from "@grasp-os/shared/connect";
import { AutoHeight, FadeIn } from "@grasp-os/ui/components/auto-height";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import { SuccessMark } from "@grasp-os/ui/components/success-mark";
import { Trans, useLingui } from "@lingui/react/macro";

// What the connect dialog ends on, as the prototype's `Done` view
// (`components/connect-dialog.tsx`): the sign-in happens at the provider,
// which sends the person back to the page with `connection=<id>`, so the
// page opens this once it lists that connection. A success mark, that the
// app is connected (again, when the flow signed in again), what Grasp may
// do there, and what was chosen: who uses it and, for a Composio toolkit,
// the tools allowed.

/** The scope chosen, in the connect dialog's own words. */
const ScopeRow = ({ connection }: { connection: ListedConnection }) => (
  <li className="flex min-h-11 flex-col justify-center border-b px-3 py-2 last:border-b-0">
    {connection.scope === "shared" ? (
      <>
        <span>
          <Trans>For everyone</Trans>
        </span>
        <span className="text-muted-foreground">
          <Trans>
            Your organization uses it through the permissions you grant.
          </Trans>
        </span>
      </>
    ) : (
      <>
        <span>
          <Trans>Just for you</Trans>
        </span>
        <span className="text-muted-foreground">
          <Trans>Only you can use it.</Trans>
        </span>
      </>
    )}
  </li>
);

/** The dialog's content: what was connected and what was chosen. */
const Done = ({
  app,
  connection,
  again,
  onClose,
}: {
  app: string;
  connection: ListedConnection;
  again: boolean;
  onClose: () => void;
}) => {
  const { t } = useLingui();
  const tools = connection.tools ?? [];
  return (
    <FadeIn>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col items-center gap-4 pt-4 text-center">
          <SuccessMark />
          <div className="flex flex-col gap-1">
            <DialogTitle>
              {again ? t`${app} is connected again` : t`${app} is connected`}
            </DialogTitle>
            <DialogDescription>
              {connection.source === "composio"
                ? t`Grasp may use ${app} only through the tools you allowed.`
                : t`Grasp may read and write in ${app}, only for what you allow.`}
            </DialogDescription>
          </div>
        </div>
        <ul
          aria-label={t`What you chose`}
          className="flex max-h-64 flex-col overflow-y-auto rounded-lg border"
        >
          <ScopeRow connection={connection} />
          {tools.map((tool) => (
            <li
              className="flex min-h-11 items-center border-b px-3 py-2 last:border-b-0"
              key={tool}
            >
              <span className="truncate">{tool}</span>
            </li>
          ))}
        </ul>
        <Button className="self-start" onClick={onClose} variant="outline">
          <Trans>Close</Trans>
        </Button>
      </div>
    </FadeIn>
  );
};

/**
 * The success screen for `connection` of the app named `app`, open while
 * the page was just sent back with it.
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
}) => (
  <Dialog
    onOpenChange={(open) => {
      if (!open) {
        onClose();
      }
    }}
    open={connection !== undefined}
  >
    {/* Its own Close button ends it; no second one in the corner. */}
    <DialogContent
      className="max-h-svh overflow-y-auto sm:max-w-md"
      showCloseButton={false}
    >
      <AutoHeight>
        {connection === undefined ? null : (
          <Done
            again={again}
            app={app}
            connection={connection}
            onClose={onClose}
          />
        )}
      </AutoHeight>
    </DialogContent>
  </Dialog>
);
