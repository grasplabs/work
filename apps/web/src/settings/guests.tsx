import type { Guest } from "@grasp-os/shared/members";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "../grasp/alert-dialog/index.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../grasp/dropdown-menu/index.ts";
import { Copy, More, Trash } from "../grasp/icons/index.ts";
import { useCore } from "../use-core.ts";
import { copyEmail } from "./invitations.tsx";

// A guest's menu in the people's table (Settings › Members and roles): a
// guest is someone outside the company invited by address, who reaches
// nothing but what is shared with them. Their email to copy, and a way to
// remove them, which signs them out everywhere.

const styles = stylex.create({
  // The dialog is drawn inside the row's end-aligned cell and would inherit
  // its alignment: its words start where they should.
  dialog: { display: "contents", textAlign: "start" },
});

export const GuestActions = ({ guest }: { guest: Guest }) => {
  const { t } = useLingui();
  const core = useCore();
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const { email } = guest;
  const who = email;
  // A refusal throws, so the dialog stays open and its button says so.
  const remove = async (): Promise<void> => {
    await changeThenRefresh(
      async () => {
        await core.withSession(
          async (session) => await session.members.remove(guest.userId)
        );
      },
      async () => {
        await router.invalidate({ sync: true });
      }
    );
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={t`Actions for ${who}`}
          icon={More}
          size="sm"
          variant="ghost"
        />
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            icon={Copy}
            onSelect={() => {
              void copyEmail(email, {
                copied: t`Copied`,
                failed: t`Copying didn't work`,
              });
            }}
          >
            {t`Copy email`}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            icon={Trash}
            onSelect={() => {
              setAsking(true);
            }}
            variant="danger"
          >
            {t`Remove`}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <div {...stylex.props(styles.dialog)}>
        <AlertDialog onOpenChange={setAsking} open={asking}>
          <AlertDialogContent>
            <AlertDialogTitle>{t`Remove ${email}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {t`They are signed out everywhere and cannot sign in again.`}
            </AlertDialogDescription>
            <AlertDialogFooter>
              <AlertDialogAction>{t`Cancel`}</AlertDialogAction>
              <AlertDialogAction
                action={remove}
                failedLabel={t`Not removed`}
                variant="danger"
              >
                {t`Remove`}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </>
  );
};
