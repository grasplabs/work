import type { Guest } from "@grasp-os/shared/members";
import { Button } from "@grasp-os/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import {
  CopyIcon,
  EllipsisIcon,
  Icon,
  TrashIcon,
} from "@grasp-os/ui/lib/icons";
import { useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { useCore } from "../use-core.ts";
import { ConfirmAction } from "./confirm-action.tsx";
import { copyEmail } from "./invitations.tsx";

// A guest's menu in the people's table (Settings › Members and roles): a
// guest is someone outside the company invited by address, who reaches
// nothing but what is shared with them. Their email to copy, and a way to
// remove them, which signs them out everywhere.

export const GuestActions = ({ guest }: { guest: Guest }) => {
  const { t } = useLingui();
  const core = useCore();
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const { email } = guest;
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
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={t`Actions for ${email}`}
            size="icon-sm"
            variant="ghost"
          >
            <Icon icon={EllipsisIcon} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            icon={CopyIcon}
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
            icon={TrashIcon}
            onSelect={() => {
              setAsking(true);
            }}
            variant="destructive"
          >
            {t`Remove`}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmAction
        action={remove}
        description={t`They are signed out everywhere and cannot sign in again.`}
        errorText={t`Not removed`}
        label={t`Remove`}
        onOpenChange={setAsking}
        open={asking}
        title={t`Remove ${email}?`}
      />
    </>
  );
};
