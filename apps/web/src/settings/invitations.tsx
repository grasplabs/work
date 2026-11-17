import { failureText } from "@grasp-os/shared/errors";
import type { Invitation } from "@grasp-os/shared/members";
import { roleSchema } from "@grasp-os/shared/roles";
import type { Role } from "@grasp-os/shared/roles";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useId, useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { formatDate } from "../format.ts";
import { Avatar, AvatarFallback } from "../grasp/avatar/index.ts";
import { Button, useAction } from "../grasp/button/index.ts";
import {
  Dialog,
  DialogAction,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogContent,
  DialogTitle,
} from "../grasp/dialog/index.ts";
import { Field, FieldError, FieldLabel } from "../grasp/field/index.ts";
import { Form } from "../grasp/form/index.ts";
import { Plus } from "../grasp/icons/index.ts";
import { Input } from "../grasp/input/index.ts";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
  ItemActions,
} from "../grasp/item/index.ts";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
} from "../grasp/select/index.ts";
import { roleLabel } from "../labels.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { RowNote } from "./section.tsx";

// Invitations: an admin names someone's address and the role they get
// when they first sign in with the organization's account. Grasp sends no
// email, so the dialog says to tell them. Core checks the address, the
// role and the admin on every call.

const isRole = (value: unknown): value is Role =>
  roleSchema.safeParse(value).success;

/** The Invite button, and its dialog. */
const styles = stylex.create({
  // The role's choice as wide as the address over it.
  full: { width: "100%" },
});

export const InviteButton = () => {
  const { t } = useLingui();
  const core = useCore();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("user");
  const [refused, setRefused] = useState<string>();
  const formId = useId();
  const close = (): void => {
    setOpen(false);
    setEmail("");
    setRole("user");
    setRefused(undefined);
  };
  const invite = useAction(
    async () => {
      setRefused(undefined);
      await changeThenRefresh(
        async () =>
          await core.withSession(
            async (session) => await session.members.invite(email, role)
          ),
        async () => {
          await router.invalidate({ sync: true });
        }
      );
      close();
    },
    {
      working: t`Inviting`,
      done: t`Invited`,
      failed: t`Could not invite`,
      onError: (error) => {
        setRefused(failureText(error));
      },
    }
  );
  return (
    <>
      <Button
        icon={Plus}
        onClick={() => {
          setOpen(true);
        }}
        size="sm"
        variant="ink"
      >
        {t`Invite`}
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
        <DialogContent closeLabel={t`Close`}>
          <DialogTitle>{t`Invite someone`}</DialogTitle>
          <DialogDescription>
            {t`Grasp sends no email, so let them know.`}
          </DialogDescription>
          <DialogBody>
            <Form
              aria-label={t`Invite someone`}
              id={formId}
              onSubmit={(event) => {
                // Sent only once every field is right; sent here, not by the browser.
                event.preventDefault();
                void invite.run();
              }}
            >
              <Field invalid={refused !== undefined}>
                <FieldLabel>{t`Email`}</FieldLabel>
                <Input
                  autoComplete="off"
                  onValueChange={setEmail}
                  required
                  type="email"
                  value={email}
                />
                <FieldError match="valueMissing">
                  {t`Enter the email of the person to invite.`}
                </FieldError>
                <FieldError match="typeMismatch">
                  {t`Enter an email address, such as name@company.com.`}
                </FieldError>
                {refused === undefined ? null : (
                  <FieldError match>{refused}</FieldError>
                )}
              </Field>
              <Field>
                <FieldLabel>{t`Role`}</FieldLabel>
                <Select
                  items={roleSchema.options.map((value) => ({
                    label: roleLabel(value),
                    value,
                  }))}
                  onValueChange={(value) => {
                    if (isRole(value)) {
                      setRole(value);
                    }
                  }}
                  value={role}
                >
                  {/* As wide as the address above it. */}
                  <SelectTrigger layout={styles.full}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent />
                </Select>
              </Field>
            </Form>
          </DialogBody>
          <DialogFooter>
            <DialogAction>{t`Cancel`}</DialogAction>
            <Button
              form={formId}
              type="submit"
              variant="ink"
              {...invite.status}
            >
              {t`Invite`}
            </Button>
          </DialogFooter>
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
    <Item size="xs">
      <ItemMedia>
        <Avatar decorative name={email} size="xs">
          <AvatarFallback />
        </Avatar>
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{email}</ItemTitle>
        <ItemDescription>
          <RowNote failure={failure}>
            {t`Invited as ${role} by ${inviter} on ${date}`}
          </RowNote>
        </ItemDescription>
      </ItemContent>
      <ItemActions>
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
          {t`Withdraw`}
        </Button>
      </ItemActions>
    </Item>
  );
};
