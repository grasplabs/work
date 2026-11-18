import { failureText } from "@grasp-os/shared/errors";
import type { Invitation } from "@grasp-os/shared/members";
import { roleSchema } from "@grasp-os/shared/roles";
import type { Role } from "@grasp-os/shared/roles";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { copyText } from "../copy.ts";
import { formatList } from "../format.ts";
import {
  Dialog,
  DialogAction,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "../grasp/dialog/index.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../grasp/dropdown-menu/index.ts";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "../grasp/field/index.ts";
import { Copy, More, Plus, Trash } from "../grasp/icons/index.ts";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
} from "../grasp/select/index.ts";
import { TagInput } from "../grasp/tag-input/index.ts";
import { Text } from "../grasp/text/index.ts";
import { toast } from "../grasp/toast/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { roleLabel } from "../labels.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
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
  fields: { display: "grid", gap: grasp.space4 },
  // A row's last cell: what it says, then its menu, on one line.
  ends: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: grasp.space2,
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
      onOpenChange={(open) => {
        if (!open) {
          reset();
        }
      }}
    >
      <DialogTrigger icon={Plus} size="sm" variant="ink">
        {t`Invite`}
      </DialogTrigger>
      <DialogContent closeLabel={t`Close`}>
        <DialogTitle>{t`Invite people`}</DialogTitle>
        <DialogDescription>
          {t`Grasp sends no email, so let them know.`}
        </DialogDescription>
        <DialogBody>
          <div {...stylex.props(styles.fields)}>
            <Field invalid={problem !== ""} name="emails">
              <FieldLabel>{t`Email addresses`}</FieldLabel>
              <TagInput
                invalid={wrongness}
                messages={{
                  duplicate: (value) => t`${value} is already added.`,
                  empty: t`Press Enter to add it.`,
                  invalid: t`not valid`,
                }}
                onValueChange={setAddresses}
                placeholder={t`name@company.com`}
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
                <SelectTrigger layout={styles.full}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent />
              </Select>
            </Field>
          </div>
        </DialogBody>
        <DialogFooter>
          <DialogAction>{t`Cancel`}</DialogAction>
          <DialogAction
            action={send}
            failedLabel={t`Not sent`}
            variant="ink"
            workingLabel={t`Sending`}
          >
            {t`Send invites`}
          </DialogAction>
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
      <Text element="span" size="sm" tone="muted">
        {roleLabel(invitation.role)}
      </Text>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={t`Actions for ${email}`}
          disabled={busy}
          icon={More}
          size="xs"
          variant="ghost"
        />
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            icon={Copy}
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
          <DropdownMenuItem icon={Trash} onSelect={withdraw} variant="danger">
            {t`Withdraw invitation`}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
};
