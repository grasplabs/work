import type { BillingSettings } from "@grasp-os/shared/org-settings";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@grasp-os/ui/components/dialog";
import { Field, FieldLabel } from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import { Textarea } from "@grasp-os/ui/components/textarea";
import {
  HouseIcon,
  Icon,
  MailIcon,
  PencilIcon,
  TagIcon,
} from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { useCoreAction } from "../use-core-action.ts";
import { IdentityCard } from "./identity-card.tsx";
import type { IdentityFact } from "./identity-card.tsx";
import { Failure } from "./section.tsx";

// The billing details' card, at the head of Settings › Billing
// (settings/identity-card.tsx): who is billed in the serif, and the
// address, the VAT number and the billing email as small badges, each only
// when there is one; with nothing on file, one quiet line. Its one button
// opens the details as a form in a Dialog, saved whole through core
// (`orgSettings.updateBilling`) with Save. Grasp staff read the card and
// change nothing, so they have no button. No cover: on this card it would
// only decorate.

const styles = stylex.create({
  fields: { display: "grid", gap: space[4] },
});

/** What a field holds, as core keeps it: nothing for an empty one. */
const keptAs = (text: string): string | null => {
  const trimmed = text.trim();
  return trimmed === "" ? null : trimmed;
};

/** The longest each detail may be, as core takes them (`billingSettingsSchema`). */
const longest = { email: 254, company: 120, address: 500, vatNumber: 14 };

/** The billing details as a form in a Dialog, saved whole with Save. */
const EditBilling = ({ billing }: { billing: BillingSettings }) => {
  const { t } = useLingui();
  const router = useRouter();
  const { failure, run } = useCoreAction();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState(billing.email ?? "");
  const [company, setCompany] = useState(billing.company ?? "");
  const [address, setAddress] = useState(billing.address ?? "");
  const [vatNumber, setVatNumber] = useState(billing.vatNumber ?? "");
  // Each opening starts from what core keeps.
  const reset = (): void => {
    setEmail(billing.email ?? "");
    setCompany(billing.company ?? "");
    setAddress(billing.address ?? "");
    setVatNumber(billing.vatNumber ?? "");
  };
  const save = async (): Promise<void> => {
    const done = await run(async (session) => {
      await session.orgSettings.updateBilling({
        ...billing,
        email: keptAs(email),
        company: keptAs(company),
        address: keptAs(address),
        vatNumber: keptAs(vatNumber),
      });
      return true;
    });
    if (done === undefined) {
      // Core's reason shows in the dialog, which stays open with what was typed.
      throw new Error("The billing details were not saved.");
    }
    await router.invalidate({ sync: true });
    setOpen(false);
  };
  return (
    <Dialog
      onOpenChange={(next) => {
        if (next) {
          reset();
        }
        setOpen(next);
      }}
      open={open}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Icon icon={PencilIcon} />
          {t`Edit billing information`}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t`Billing information`}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div {...stylex.props(styles.fields)}>
            <Failure>{failure}</Failure>
            <Field name="company">
              <FieldLabel>{t`Company`}</FieldLabel>
              <Input
                maxLength={longest.company}
                onValueChange={setCompany}
                value={company}
              />
            </Field>
            <Field name="address">
              <FieldLabel>{t`Address`}</FieldLabel>
              <Textarea
                autoResize
                maxLength={longest.address}
                onValueChange={setAddress}
                rows={3}
                value={address}
              />
            </Field>
            <Field name="vatNumber">
              <FieldLabel>{t`VAT number`}</FieldLabel>
              <Input
                maxLength={longest.vatNumber}
                onValueChange={setVatNumber}
                value={vatNumber}
              />
            </Field>
            <Field name="email">
              <FieldLabel>{t`Billing email`}</FieldLabel>
              <Input
                maxLength={longest.email}
                onValueChange={setEmail}
                type="email"
                value={email}
              />
            </Field>
          </div>
        </DialogBody>
        <DialogFooter>
          <DialogClose>{t`Cancel`}</DialogClose>
          <Button
            errorText={t`Not saved`}
            loadingText={t`Saving`}
            onClick={save}
            size="sm"
          >
            {t`Save`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** The billing details' card: who is billed, where, and how to reach them; for an admin, Edit. */
export const BillingCard = ({
  billing,
  canChange,
}: {
  billing: BillingSettings;
  canChange: boolean;
}) => {
  const { t } = useLingui();
  // The address on one line: its lines joined as an envelope's are read aloud.
  const address = billing.address?.split("\n").join(", ") ?? null;
  const facts: IdentityFact[] = [];
  if (address !== null) {
    facts.push({ id: "address", icon: HouseIcon, label: address });
  }
  if (billing.vatNumber !== null) {
    facts.push({ id: "vat", icon: TagIcon, label: billing.vatNumber });
  }
  if (billing.email !== null) {
    facts.push({ id: "email", icon: MailIcon, label: billing.email });
  }
  return (
    <IdentityCard
      {...(canChange ? { action: <EditBilling billing={billing} /> } : {})}
      aria-label={t`Billing information`}
      empty={t`No billing details yet`}
      facts={facts}
      name={billing.company ?? undefined}
    />
  );
};
