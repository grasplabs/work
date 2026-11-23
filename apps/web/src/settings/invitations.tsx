import { failureText } from "@grasp-os/shared/errors";
import type { Invitation } from "@grasp-os/shared/members";
import { roleSchema } from "@grasp-os/shared/roles";
import type { Role } from "@grasp-os/shared/roles";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@grasp-os/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { TagsInput } from "@grasp-os/ui/components/tags-input";
import {
  CopyIcon,
  EllipsisIcon,
  Icon,
  PlusIcon,
  TrashIcon,
} from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { copyText } from "../copy.ts";
import { formatList } from "../format.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { roleItems } from "./roles.ts";
import { settingsToast } from "./settings-toast.ts";

// Invitations: an admin names someone's address and the role they get
// when they first sign in with the organization's account. Grasp sends no
// email, so the dialog says to tell them. Core checks the address, the
// role and the admin on every call.

const isRole = (value: unknown): value is Role =>
  roleSchema.safeParse(value).success;

/** An email address as a person types one: something, @, a domain with a dot. */
const addressPattern = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/u;

/** A sentence's own full stop, left out where it stands in brackets within another. */
const endingStop = /\.$/u;

/** Whether `text` reads as an email address. */
const isAddress = (text: string): boolean => addressPattern.test(text);

const styles = stylex.create({
  fields: { display: "grid", gap: space[4] },
});

/** What sending invitations to `addresses` came to: who got one, and who didn't, with why. */
const inviteEach = async (
  core: ReturnType<typeof useCore>,
  addresses: readonly string[],
  role: Role
): Promise<{ sent: string[]; failed: { email: string; why: string }[] }> => {
  const outcomes = await Promise.all(
    addresses.map(async (email) => {
      try {
        await core.withSession(
          async (session) => await session.members.invite(email, role)
        );
        return { email, why: undefined };
      } catch (error) {
        return { email, why: failureText(error) };
      }
    })
  );
  return {
    sent: outcomes.flatMap(({ email, why }) =>
      why === undefined ? [email] : []
    ),
    failed: outcomes.flatMap(({ email, why }) =>
      why === undefined ? [] : [{ email, why }]
    ),
  };
};

/**
 * Invite, from the members' card: the addresses as tags (several pasted at
 * once; one that isn't an address is refused as it is added), the role
 * they get with its line, and Send invites. When only some went, those
 * leave the field, the rest stay with why, and the dialog stays open.
 * Grasp sends no email: the one sentence says so, as a person would
 * otherwise wait for one.
 */
export const InviteButton = () => {
  const { t } = useLingui();
  const core = useCore();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [addresses, setAddresses] = useState<string[]>([]);
  const [role, setRole] = useState<Role>("user");
  const [checked, setChecked] = useState(false);
  const [failed, setFailed] = useState<{ email: string; why: string }[]>([]);
  // How many of the last send went: said beside who did not.
  const [sent, setSent] = useState(0);
  const reset = (): void => {
    setAddresses([]);
    setRole("user");
    setChecked(false);
    setFailed([]);
    setSent(0);
  };
  const stillFailing = failed.filter(({ email }) => addresses.includes(email));
  let problem = "";
  if (checked && addresses.length === 0) {
    problem = t`Enter the email of at least one person to invite.`;
  } else if (stillFailing.length > 0) {
    // A send that went in part says who was invited and who was not, never done nor failed.
    const notInvited = formatList(
      stillFailing.map(
        ({ email, why }) => `${email} (${why.replace(endingStop, "")})`
      )
    );
    problem =
      sent === 0
        ? t`Not invited: ${notInvited}.`
        : t`Not invited: ${notInvited}. ${plural(sent, { one: "The other invitation went.", other: "The other # invitations went." })}`;
  }
  const send = async (): Promise<void> => {
    setChecked(true);
    if (addresses.length === 0) {
      throw new Error("No address to invite.");
    }
    const result = await inviteEach(core, addresses, role);
    if (result.sent.length > 0) {
      await router.invalidate({ sync: true });
    }
    if (result.failed.length > 0) {
      setAddresses(result.failed.map(({ email }) => email));
      setFailed(result.failed);
      setSent(result.sent.length);
      throw new Error("Some invitations were not made.");
    }
    setOpen(false);
    reset();
  };
  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) {
          reset();
        }
        setOpen(next);
      }}
      open={open}
    >
      <DialogTrigger asChild>
        <Button size="xs" variant="secondary">
          <Icon icon={PlusIcon} />
          {t`Invite`}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t`Invite people`}</DialogTitle>
          <DialogDescription>
            {t`Grasp sends no email, so let them know.`}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div {...stylex.props(styles.fields)}>
            <Field data-invalid={problem !== ""} name="emails">
              <FieldLabel>{t`Email addresses`}</FieldLabel>
              <TagsInput
                onValueChange={setAddresses}
                placeholder={t`name@company.com`}
                validate={(value) =>
                  isAddress(value) || t`This is not an email address.`
                }
                value={addresses}
              />
              {problem === "" ? (
                <FieldDescription>
                  {t`Paste several at once, split by commas or lines.`}
                </FieldDescription>
              ) : (
                <FieldError match>{problem}</FieldError>
              )}
            </Field>
            <Field name="role">
              <FieldLabel>{t`Role`}</FieldLabel>
              <Select
                items={roleItems()}
                onValueChange={(value) => {
                  if (isRole(value)) {
                    setRole(value);
                  }
                }}
                value={role}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent />
              </Select>
            </Field>
          </div>
        </DialogBody>
        <DialogFooter>
          <DialogClose>{t`Cancel`}</DialogClose>
          <Button
            errorText={t`Not sent`}
            loadingText={t`Sending`}
            onClick={send}
            size="sm"
          >
            {t`Send invites`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** Copies `email`, and says so; a refused clipboard says that instead. */
export const copyEmail = async (
  email: string,
  words: { copied: string; failed: string }
): Promise<void> => {
  const done = await copyText(email);
  if (done) {
    settingsToast.success(words.copied, { description: email });
  } else {
    settingsToast.error(words.failed);
  }
};

/**
 * What can be done to an invitation nobody has taken up yet, in the people
 * table's last column: a menu to copy the address or withdraw it. Why a
 * withdrawal failed is said in a toast, seen whatever the row's room.
 */
export const InvitationActions = ({
  invitation,
}: {
  invitation: Invitation;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, run } = useCoreAction();
  const { email } = invitation;
  const withdraw = (): void => {
    void run(
      async (session) => {
        await changeThenRefresh(
          async () => {
            await session.members.withdrawInvitation(invitation.id);
          },
          async () => {
            await router.invalidate({ sync: true });
          }
        );
      },
      (failure) => {
        settingsToast.error(failure);
      }
    );
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={t`Actions for ${email}`}
          disabled={busy}
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
              failed: t`Not copied`,
            });
          }}
        >
          {t`Copy email`}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          icon={TrashIcon}
          onSelect={withdraw}
          variant="destructive"
        >
          {t`Withdraw invitation`}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
