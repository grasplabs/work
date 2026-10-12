import type { Invitation } from "@grasp-os/shared/members";
import { roleSchema } from "@grasp-os/shared/roles";
import type { Role } from "@grasp-os/shared/roles";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { MailIcon, PlusIcon } from "lucide-react";
import { useId, useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDate } from "../format.ts";
import { roleLabel } from "../labels.ts";
import { useCoreAction } from "../use-core-action.ts";

// Invitations, as the prototype has them (`routes/settings/members.tsx`):
// an admin names someone's address and the role they get when they first
// sign in with the organization's account. Grasp sends no email, so the
// dialog says to tell them. Core checks the address, the role and the
// admin on every call.

const isRole = (value: unknown): value is Role =>
  roleSchema.safeParse(value).success;

/** The Invite button, and its dialog. */
export const InviteButton = () => {
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("user");
  const emailId = useId();
  const roleId = useId();
  const roles = roleSchema.options.map((value) => ({
    label: roleLabel(value),
    value,
  }));
  const close = (): void => {
    setOpen(false);
    setEmail("");
    setRole("user");
  };
  const invite = async (): Promise<void> => {
    const invited = await run(async (session) => {
      await changeThenRefresh(
        async () => await session.members.invite(email, role),
        async () => {
          await router.invalidate({ sync: true });
        }
      );
      return true;
    });
    if (invited === true) {
      close();
    }
  };
  return (
    <>
      <Button
        onClick={() => {
          setOpen(true);
        }}
        size="sm"
      >
        <PlusIcon data-icon="inline-start" />
        <Trans>Invite</Trans>
      </Button>
      <Dialog
        onOpenChange={(next) => {
          if (next) {
            setOpen(true);
          } else {
            close();
          }
        }}
        open={open}
      >
        <DialogContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void invite();
            }}
          >
            <DialogHeader>
              <DialogTitle>
                <Trans>Invite someone</Trans>
              </DialogTitle>
              <DialogDescription>
                <Trans>
                  They get this role when they first sign in with your
                  organization’s account. Grasp sends no email, so let them
                  know.
                </Trans>
              </DialogDescription>
            </DialogHeader>
            <Field data-invalid={failure === undefined ? undefined : true}>
              <FieldLabel htmlFor={emailId}>
                <Trans>Email</Trans>
              </FieldLabel>
              <Input
                aria-invalid={failure === undefined ? undefined : true}
                autoComplete="off"
                id={emailId}
                onChange={(event) => {
                  setEmail(event.target.value);
                }}
                type="email"
                value={email}
              />
              {failure === undefined ? null : (
                <FieldError>{failure}</FieldError>
              )}
            </Field>
            <Field>
              <FieldLabel htmlFor={roleId}>
                <Trans>Role</Trans>
              </FieldLabel>
              <Select
                items={roles}
                onValueChange={(value: unknown) => {
                  if (isRole(value)) {
                    setRole(value);
                  }
                }}
                value={role}
              >
                <SelectTrigger className="w-full" id={roleId}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {roles.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>
                <Trans>The roles above say what each may do.</Trans>
              </FieldDescription>
            </Field>
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" />}>
                <Trans>Cancel</Trans>
              </DialogClose>
              <Button disabled={busy || email.trim() === ""} type="submit">
                <Trans>Invite</Trans>
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
};

/** One invitation nobody has taken up yet, and a way to withdraw it. */
export const InvitationRow = ({ invitation }: { invitation: Invitation }) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const { email } = invitation;
  const date = formatDate(invitation.invitedAt);
  const role = roleLabel(invitation.role);
  const inviter = invitation.invitedBy;
  return (
    <div className="flex items-center gap-3 border-t px-5 py-3">
      <span
        aria-hidden="true"
        className="bg-muted flex size-8 flex-none items-center justify-center rounded-full"
      >
        <MailIcon className="text-muted-foreground size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{email}</span>
        <span className="text-muted-foreground truncate">
          <Trans>
            Invited as {role} by {inviter} on {date} · hasn’t signed in yet
          </Trans>
        </span>
      </div>
      <div className="flex flex-col items-end gap-1">
        <Button
          aria-label={t`Withdraw the invitation of ${email}`}
          disabled={busy}
          onClick={() => {
            void run(async (session) => {
              await changeThenRefresh(
                async () => {
                  await session.members.withdrawInvitation(invitation.id);
                },
                async () => {
                  await router.invalidate({ sync: true });
                }
              );
            });
          }}
          size="sm"
          variant="ghost"
        >
          <Trans>Withdraw</Trans>
        </Button>
        <ErrorText>{failure}</ErrorText>
      </div>
    </div>
  );
};
