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
import { toast } from "@grasp-os/ui/components/toast";
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
import { useHeldDialog } from "../workflows/held-dialog.ts";
import { roleItems } from "./roles.ts";

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
  fields: { display: "grid", gap: space["4"] },
  // A row's last cell: what it says, then its menu, on one line.
  ends: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: space["2"],
  },
  // The role's choice as wide as the addresses over it.
  full: { width: "100%" },
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
 * once; a wrong one is marked once Send is pressed), the role they get with
 * its line, and Send invites. When only some went, those leave the field,
 * the rest stay marked with why, and the dialog stays open. Grasp sends no
 * email: the one sentence says so, as a person would otherwise wait for one.
 */
export const InviteButton = () => {
  const { t } = useLingui();
  const core = useCore();
  const router = useRouter();
  const dialog = useHeldDialog();
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
  const bad = checked ? addresses.filter((each) => !isAddress(each)) : [];
  const stillFailing = failed.filter(({ email }) => addresses.includes(email));
  let problem = "";
  if (checked && addresses.length === 0) {
    problem = t`Enter the email of at least one person to invite.`;
  } else if (bad.length > 0) {
    const count = bad.length;
    const listed = formatList(bad);
    problem = t`${plural(count, { one: "This is not an email address:", other: "These are not email addresses:" })} ${listed}`;
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
  const wrongness = (each: string): string | false => {
    if (checked && !isAddress(each)) {
      return t`not an email address`;
    }
    return stillFailing.some(({ email }) => email === each)
      ? t`not invited`
      : false;
  };
  const send = async (): Promise<void> => {
    setChecked(true);
    if (addresses.length === 0 || addresses.some((each) => !isAddress(each))) {
      throw new Error("The addresses need correcting.");
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
  };
  return (
    <Dialog
      onOpenChange={(open, details) => {
        // Cleared only once it really closes: a close refused while the
        // invitations are sent keeps what was chosen.
        let refused = false;
        dialog.handleOpenChange(open, {
          cancel: () => {
            refused = true;
            details.cancel();
          },
        });
        if (!open && !refused) {
          reset();
        }
      }}
      open={dialog.open}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
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
                labels={{
                  duplicate: (value) => t`${value} is already added.`,
                }}
                onValueChange={setAddresses}
                placeholder={t`name@company.com`}
                validate={(each) => {
                  const wrong = wrongness(each);
                  return wrong === false ? true : wrong;
                }}
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
                <SelectTrigger style={styles.full}>
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
            onClick={async () => {
              await dialog.hold(send);
              reset();
            }}
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
    toast.success(words.copied, { description: email });
  } else {
    toast.error(words.failed);
  }
};

/**
 * What can be done to an invitation nobody has taken up yet, in the people
 * table's last column: the role they would join as, and a menu to copy the
 * address or withdraw it. Why a withdrawal failed is said beside it.
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
      // Why it failed, said where it is seen whatever the row's room.
      (failure) => {
        toast.error(failure);
      }
    );
  };
  return (
    <span {...stylex.props(styles.ends)}>
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
    </span>
  );
};
