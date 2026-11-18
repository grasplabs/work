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
import { formatDate, formatList } from "../format.ts";
import { Avatar, AvatarFallback } from "../grasp/avatar/index.ts";
import { Badge } from "../grasp/badge/index.ts";
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
import { Field, FieldError, FieldLabel } from "../grasp/field/index.ts";
import { Copy, More, Plus, Trash } from "../grasp/icons/index.ts";
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
import { TagInput } from "../grasp/tag-input/index.ts";
import { toast } from "../grasp/toast/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { roleLabel } from "../labels.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { roleItems } from "./roles.ts";
import { RowNote } from "./section.tsx";

// Invitations: an admin names someone's address and the role they get
// when they first sign in with the organization's account. Grasp sends no
// email, so the dialog says to tell them. Core checks the address, the
// role and the admin on every call.

const isRole = (value: unknown): value is Role =>
  roleSchema.safeParse(value).success;

/** An email address as a person types one: something, @, a domain with a dot. */
const addressPattern = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/u;

/** Whether `text` reads as an email address. */
const isAddress = (text: string): boolean => addressPattern.test(text);

const styles = stylex.create({
  fields: { display: "grid", gap: grasp.space4 },
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
  const reset = (): void => {
    setAddresses([]);
    setRole("user");
    setChecked(false);
    setFailed([]);
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
    problem = formatList(
      stillFailing.map(({ email, why }) => `${email}: ${why}`)
    );
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
              {problem === "" ? null : <FieldError match>{problem}</FieldError>}
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

/** One invitation nobody has taken up yet: its badge, and a menu to copy the address or withdraw it. */
export const InvitationRow = ({ invitation }: { invitation: Invitation }) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const { email } = invitation;
  const date = formatDate(invitation.invitedAt);
  const role = roleLabel(invitation.role);
  const inviter = invitation.invitedBy;
  const withdraw = (): void => {
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
  };
  return (
    <Item size="xs">
      <ItemMedia align="center">
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
        <Badge size="sm" tone="info">{t`Invited`}</Badge>
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
      </ItemActions>
    </Item>
  );
};
