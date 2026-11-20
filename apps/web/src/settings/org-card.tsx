import type { Organization } from "@grasp-os/shared/organization";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useId, useState } from "react";

import { formatList } from "../format.ts";
import { organizationRenamed } from "../frame/organization-name.tsx";
import { Button } from "../grasp/button/index.ts";
import {
  Dialog,
  DialogAction,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from "../grasp/dialog/index.ts";
import { Field, FieldError, FieldLabel } from "../grasp/field/index.ts";
import { ImageWell } from "../grasp/file-upload/index.ts";
import { Form } from "../grasp/form/index.ts";
import { visuallyHidden } from "../grasp/hidden/hidden.ts";
import { Edit, Globe, Mail } from "../grasp/icons/index.ts";
import { IdentityCard } from "../grasp/identity-card/index.ts";
import type { IdentityCardFact } from "../grasp/identity-card/index.ts";
import { Input } from "../grasp/input/index.ts";
import { RowProblem } from "../grasp/setting-row/line-context.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useOrganizationLogo } from "./workspace-name.tsx";

// The organization's card, at the head of Settings › Workspace, on the
// library's Identity card: a cover across the top, the logo over its lower
// edge, the name beside it in the serif with Edit after it, and the facts the
// deployment decides as small tags.
//
// The logo is the well itself: a press or a dropped picture saves it
// (workspace-name.tsx), and what went wrong with it is said in one line under
// the card. Edit opens the name in a Dialog, saved with Save or Enter; core's
// reason for refusing it shows under the field. Someone who is not one of the organization's
// admins sees it all, and changes nothing.

const styles = stylex.create({
  stack: { display: "grid", gap: grasp.space2 },
  problem: {
    margin: 0,
    color: grasp.danger,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
  },
});

// The card waiting (Workspace's pending page): the well and the pencil keep
// their room, so the card is as tall loading as loaded and nothing under it drops.
const waits = stylex.create({
  // The well's own empty frame: its size (96px), its corner and its edge.
  well: {
    boxSizing: "border-box",
    width: grasp.space24,
    height: grasp.space24,
    borderRadius: `min(${grasp.corner}, 28%)`,
    cornerShape: grasp.cornerShape,
    boxShadow: grasp.edge,
  },
  // The pencil's room, kept for an admin: a small button's square.
  pencil: { display: "block", width: grasp.controlSm, height: grasp.controlSm },
});

/** The organization's card before it is read: the cover stands, the rest waits as frames. */
export const OrgCardLoading = ({ canChange }: { canChange: boolean }) => {
  const { t } = useLingui();
  return (
    <div aria-busy="true">
      <IdentityCard
        action={
          canChange ? <span {...stylex.props(waits.pencil)} /> : undefined
        }
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
      <DialogTitle>{t`Organization name`}</DialogTitle>
      <DialogBody>
        <Form
          aria-label={t`Organization name`}
          id={formId}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Field invalid={failure !== undefined}>
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
        <DialogAction>{t`Cancel`}</DialogAction>
        <Button disabled={busy} form={formId} type="submit" variant="ink">
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
      <DialogTrigger
        aria-label={t`Edit the name`}
        icon={Edit}
        size="sm"
        variant="ghost"
      />
      <DialogContent closeLabel={t`Close`}>
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
  const logo = useOrganizationLogo(organization.logo);
  // What the well says of a logo it refused or could not save, for the line under the card.
  const [problem, setProblem] = useState("");
  const problemId = useId();
  const domains = formatList(
    organization.signInDomains.map((domain) => `@${domain}`)
  );
  const facts: IdentityCardFact[] = [];
  // With the @ an address has, so a domain reads as where people sign in from.
  if (domains !== "") {
    facts.push({ id: "domains", icon: Mail, label: domains });
  }
  facts.push({ id: "region", icon: Globe, label: t`European Union` });
  return (
    <div {...stylex.props(styles.stack)}>
      <IdentityCard
        action={
          canChange ? (
            <RenameOrganization name={organization.name} />
          ) : undefined
        }
        aria-label={t`Organization`}
        cover
        facts={facts}
        mark={
          <RowProblem value={setProblem}>
            <ImageWell
              {...logo}
              aria-label={t`Logo`}
              disabled={!canChange}
              fit="contain"
              initials={organization.name}
              size="lg"
              {...(problem === "" ? {} : { "aria-describedby": problemId })}
            />
          </RowProblem>
        }
        name={organization.name}
      />
      {problem === "" ? null : (
        <p aria-hidden="true" {...stylex.props(styles.problem)}>
          <bdi>{problem}</bdi>
        </p>
      )}
      <output id={problemId} {...stylex.props(visuallyHidden)}>
        {problem}
      </output>
    </div>
  );
};
