import type { Guest } from "@grasp-os/shared/members";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { UserIcon } from "lucide-react";
import { useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDate } from "../format.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { useCoreAction } from "../use-core-action.ts";

// The organization's guests, for its admins (Settings › Members): people
// outside the company invited by address, who reach nothing but what is
// shared with them. Never members, so listed apart, each with a way to
// remove them, which signs them out everywhere.

const GuestRow = ({ guest }: { guest: Guest }) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const [confirming, setConfirming] = useState(false);
  const { email } = guest;
  const date = formatDate(guest.invitedAt);
  const remove = (): void => {
    setConfirming(false);
    void run(async (session) => {
      await changeThenRefresh(
        async () => {
          await session.members.remove(guest.userId);
        },
        async () => {
          await router.invalidate({ sync: true });
        }
      );
    });
  };
  return (
    <div className="flex items-center gap-3 border-t px-5 py-3">
      <span
        aria-hidden="true"
        className="bg-muted flex size-8 flex-none items-center justify-center rounded-full"
      >
        <UserIcon className="text-muted-foreground size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2">
          <span className="truncate">{email}</span>
          <Badge variant="outline">
            <Trans>Guest</Trans>
          </Badge>
        </span>
        <span className="text-muted-foreground truncate">
          <Trans>Invited on {date}</Trans>
        </span>
      </div>
      <div className="flex flex-col items-end gap-1">
        <Button
          aria-label={t`Remove the guest ${email}`}
          disabled={busy}
          onClick={() => {
            setConfirming(true);
          }}
          size="sm"
          variant="ghost"
        >
          <Trans>Remove</Trans>
        </Button>
        <ErrorText>{failure}</ErrorText>
      </div>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              <Trans>Remove {email}?</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>
                They are signed out everywhere and cannot sign in again.
              </Trans>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter showCloseButton>
            <Button disabled={busy} onClick={remove} variant="destructive">
              <Trans>Remove</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

/** The guests, when there are any. */
export const Guests = ({ guests }: { guests: Guest[] }) => {
  const { t } = useLingui();
  if (guests.length === 0) {
    return null;
  }
  return (
    <SectionCard
      density="compact"
      variant="grouped"
      description={t`People outside your organization, invited to what is shared with them. They reach nothing else.`}
      title={t`Guests`}
    >
      {guests.map((guest) => (
        <GuestRow guest={guest} key={guest.userId} />
      ))}
    </SectionCard>
  );
};
