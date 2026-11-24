import type { Organization } from "@grasp-os/shared/organization";
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
import { Field, FieldError, FieldLabel } from "@grasp-os/ui/components/field";
import { Form } from "@grasp-os/ui/components/form";
import { ImageUpload } from "@grasp-os/ui/components/image-upload";
import { Input } from "@grasp-os/ui/components/input";
import { GlobeIcon, Icon, MailIcon, PencilIcon } from "@grasp-os/ui/lib/icons";
import { radius, size, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useId, useState } from "react";

import { formatList } from "../format.ts";
import { organizationRenamed } from "../frame/organization-name.tsx";
import { initials } from "../frame/person-menu.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { IdentityCard } from "./identity-card.tsx";
import type { IdentityCardFact } from "./identity-card.tsx";
import { OwnWords } from "./section.tsx";
import { useOrganizationLogo } from "./workspace-name.tsx";

// The organization's card, at the head of Settings › Workspace, on the
// library's Identity card: a cover across the top, the logo over its lower
// edge, the name beside it in the serif with Edit after it, and the facts the
// deployment decides as small tags.
//
// The logo is the well itself: a press or a dropped picture saves it
// (workspace-name.tsx), and the well says what went wrong with it. Edit opens the name in a Dialog, saved with Save or Enter; core's
// reason for refusing it shows under the field. Someone who is not one of the organization's
// admins sees it all, and changes nothing.

// The card waiting (Workspace's pending page): the well and the pencil keep
// their room, so the card is as tall loading as loaded and nothing under it drops.
const waits = stylex.create({
  // The well's own empty frame: its size (96px), its corner and its edge.
  well: {
    boxSizing: "border-box",
    width: space["24"],
    height: space["24"],
    borderRadius: `min(${radius.base}, 28%)`,
    cornerShape: radius.shape,
    boxShadow: size.borderStrong,
  },
  // The pencil's room, kept for an admin: a small button's square.
  pencil: { display: "block", width: size.controlSm, height: size.controlSm },
});

/** The organization's card before it is read: the cover stands, the rest waits as frames. */
export const OrgCardLoading = ({ canChange }: { canChange: boolean }) => {
  const { t } = useLingui();
  return (
    <div aria-busy="true">
      <IdentityCard
        {...(canChange
          ? { action: <span {...stylex.props(waits.pencil)} /> }
          : {})}
        aria-label={t`Organization`}
        cover
        loading
        mark={<span {...stylex.props(waits.well)} />}
      />
    </div>
  );
};

/** The rename form, mounted with each opening, so it starts from the name core keeps and no old refusal. */
const RenameForm = ({ name, onDone }: { name: string; onDone: () => void }) => {
  const { t } = useLingui();
  const router = useRouter();
  const formId = useId();
  const { busy, failure, run } = useCoreAction();
  const [draft, setDraft] = useState(name);
  const save = async (): Promise<void> => {
    const next = draft.trim();
    if (next === "") {
      return;
    }
    if (next !== name) {
      const saved = await run(
        async (session) => await session.organization.update({ name: next })
      );
      if (saved === undefined) {
        // Core's reason shows under the field, which keeps what was typed.
        return;
      }
      organizationRenamed(saved.name);
      await router.invalidate({ sync: true });
    }
    onDone();
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>{t`Organization name`}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <Form
          aria-label={t`Organization name`}
          id={formId}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Field {...(failure === undefined ? {} : { "data-invalid": true })}>
            <FieldLabel>{t`Name`}</FieldLabel>
            <Input
              autoComplete="off"
              dir="auto"
              maxLength={80}
              onValueChange={setDraft}
              required
              value={draft}
            />
            <FieldError match="valueMissing">{t`Enter a name for the organization.`}</FieldError>
            {failure === undefined ? null : (
              <FieldError match>{failure}</FieldError>
            )}
          </Field>
        </Form>
      </DialogBody>
      <DialogFooter>
        <DialogClose>{t`Cancel`}</DialogClose>
        <Button disabled={busy} form={formId} type="submit">
          {t`Save`}
        </Button>
      </DialogFooter>
    </>
  );
};

/** Edit, and the organization's name in a Dialog, saved with Save or Enter; the sidebar hears it at once. */
const RenameOrganization = ({ name }: { name: string }) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>
        <Button aria-label={t`Edit the name`} size="icon-sm" variant="ghost">
          <Icon icon={PencilIcon} />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <RenameForm
          name={name}
          onDone={() => {
            setOpen(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
};

/** The organization's card: its cover, its logo, its name and the facts the deployment decides. */
export const OrgCard = ({
  organization,
  canChange,
}: {
  organization: Organization;
  canChange: boolean;
}) => {
  const { t } = useLingui();
  const { words, ...logo } = useOrganizationLogo(organization.logo);
  const domains = formatList(
    organization.signInDomains.map((domain) => `@${domain}`)
  );
  const facts: IdentityCardFact[] = [];
  // With the @ an address has, so a domain reads as where people sign in from.
  if (domains !== "") {
    facts.push({ id: "domains", icon: MailIcon, label: domains });
  }
  facts.push({ id: "region", icon: GlobeIcon, label: t`European Union` });
  return (
    <IdentityCard
      {...(canChange
        ? { action: <RenameOrganization name={organization.name} /> }
        : {})}
      aria-label={t`Organization`}
      cover
      facts={facts}
      mark={
        <OwnWords
          words={({ imageUpload }) => ({
            imageUpload: { ...imageUpload, ...words },
          })}
        >
          <ImageUpload
            {...logo}
            aria-label={t`Logo`}
            disabled={!canChange}
            fallback={initials(organization.name)}
            fit="contain"
            size="lg"
          />
        </OwnWords>
      }
      name={organization.name}
    />
  );
};
