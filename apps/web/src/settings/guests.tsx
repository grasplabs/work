import type { Guest } from "@grasp-os/shared/members";
import { useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { formatDate } from "../format.ts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../grasp/alert-dialog/index.ts";
import { Person } from "../grasp/icons/index.ts";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { useCore } from "../use-core.ts";

// The organization's guests, for its admins (Settings › Members): people
// outside the company invited by address, who reach nothing but what is
// shared with them. Never members, so listed apart, each with a way to
// remove them, which signs them out everywhere.

const GuestRow = ({ guest }: { guest: Guest }) => {
  const { t } = useLingui();
  const core = useCore();
  const router = useRouter();
  const { email } = guest;
  const date = formatDate(guest.invitedAt);
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
    <Item size="sm">
      <ItemMedia icon={Person} />
      <ItemContent>
        <ItemTitle>{email}</ItemTitle>
        <ItemDescription>{t`Invited on ${date}`}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <AlertDialog>
          <AlertDialogTrigger
            aria-label={t`Remove the guest ${email}`}
            size="sm"
            variant="ghost"
          >
            {t`Remove`}
          </AlertDialogTrigger>
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
      </ItemActions>
    </Item>
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
      <ItemGroup separated>
        {guests.map((guest) => (
          <GuestRow guest={guest} key={guest.userId} />
        ))}
      </ItemGroup>
    </SectionCard>
  );
};
