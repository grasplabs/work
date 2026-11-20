import type { Organization } from "@grasp-os/shared/organization";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useId, useState } from "react";

import { formatList } from "../format.ts";
import { organizationRenamed } from "../frame/organization-name.tsx";
import { Alert } from "../grasp/alert/index.ts";
import {
  Dialog,
  DialogAction,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from "../grasp/dialog/index.ts";
import { Field, FieldLabel } from "../grasp/field/index.ts";
import { ImageWell } from "../grasp/file-upload/index.ts";
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
// the card. Edit opens the name in a Dialog, saved with Save; core's reason
// for refusing it shows there. Someone who is not one of the organization's
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
    <IdentityCard
      action={canChange ? <span {...stylex.props(waits.pencil)} /> : undefined}
      aria-label={t`Organization`}
      cover
      loading
      mark={<span {...stylex.props(waits.well)} />}
    />
  );
};

/** The organization's name in a Dialog, saved with Save; the sidebar hears it at once. */
const RenameOrganization = ({ name }: { name: string }) => {
  const { t } = useLingui();
  const router = useRouter();
  const { failure, run } = useCoreAction();
  const [draft, setDraft] = useState(name);
  const save = async (): Promise<void> => {
    const next = draft.trim();
    if (next === "" || next === name) {
      return;
    }
    const saved = await run(
      async (session) => await session.organization.update({ name: next })
    );
    if (saved === undefined) {
      // Core's reason shows in the dialog, which stays open with what was typed.
      throw new Error("The name was not saved.");
    }
    organizationRenamed(saved.name);
    await router.invalidate({ sync: true });
  };
  return (
    <Dialog
      onOpenChange={(open) => {
        if (open) {
          setDraft(name);
        }
      }}
    >
      <DialogTrigger
        aria-label={t`Edit the name`}
        icon={Edit}
        size="sm"
        variant="ghost"
      />
      <DialogContent closeLabel={t`Close`}>
        <DialogTitle>{t`Organization name`}</DialogTitle>
        <DialogBody>
          <div {...stylex.props(styles.stack)}>
            {failure === undefined ? null : (
              <Alert tone="danger">{failure}</Alert>
            )}
            <Field name="name">
              <FieldLabel>{t`Name`}</FieldLabel>
              <Input maxLength={80} onValueChange={setDraft} value={draft} />
            </Field>
          </div>
        </DialogBody>
        <DialogFooter>
          <DialogAction>{t`Cancel`}</DialogAction>
          <DialogAction
            action={save}
            failedLabel={t`Not saved`}
            variant="ink"
            workingLabel={t`Saving`}
          >
            {t`Save`}
          </DialogAction>
        </DialogFooter>
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
