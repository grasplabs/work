/**
 * Keeping what was agreed before the first interview, from the organization's
 * Steps: the agreement on handling data, the company's look at the risks to
 * its people, and the works council. Saved in the company's Grasp as a
 * command (commands.tsx); once all three are in, the links that are due go
 * out. Once the team is told, it stays as it was agreed.
 */
import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import type { Agreements } from "@grasp-os/shared/onboarding";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import { Switch } from "@grasp-os/ui/components/switch";
import { PencilIcon } from "lucide-react";
import { useId, useState } from "react";

import { CommandFailure, useCommand } from "./commands.tsx";

/** The agreements as the snapshot has them; null before staff said anything. */
type AgreementsRead = AdminSnapshot["agreements"];

const nothingAgreed: Agreements = {
  processing: false,
  assessment: false,
  council: "waiting",
};

const councils = [
  { value: "waiting", label: "Still deciding" },
  { value: "agreed", label: "Said yes" },
  { value: "none", label: "No works council" },
] as const;

/** Today, as core keeps the day something was signed. */
const today = (): string => new Date().toISOString().slice(0, 10);

/** `agreements` with `change` made: each one in keeps its day, or is in from today. */
const withDay = (
  agreements: Agreements,
  change: Partial<Pick<Agreements, "processing" | "assessment" | "council">>
): Agreements => {
  const next = { ...agreements, ...change };
  return {
    ...next,
    processingOn: next.processing
      ? (agreements.processingOn ?? today())
      : undefined,
    assessmentOn: next.assessment
      ? (agreements.assessmentOn ?? today())
      : undefined,
    councilOn:
      next.council === "agreed" ? (agreements.councilOn ?? today()) : undefined,
  };
};

/** One agreement as a switch, with what it is. */
const AgreedSwitch = ({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) => {
  const id = useId();
  return (
    <Field orientation="horizontal">
      <Switch checked={checked} id={id} onCheckedChange={onChange} />
      <div className="flex flex-col gap-0.5">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <FieldDescription>{description}</FieldDescription>
      </div>
    </Field>
  );
};

/** The dialog that keeps what was agreed, opened on what holds now. */
const AgreementsDialog = ({
  clientId,
  agreements,
  onOpenChange,
}: {
  clientId: string;
  agreements: Agreements;
  onOpenChange: (open: boolean) => void;
}) => {
  const councilId = useId();
  const { busy, failure, give } = useCommand(clientId);
  const [draft, setDraft] = useState<Agreements>(agreements);
  const save = async (): Promise<void> => {
    const applied = await give({
      type: "onboarding.agreements",
      payload: { agreements: draft },
    });
    if (applied) {
      onOpenChange(false);
    }
  };
  return (
    <Dialog onOpenChange={onOpenChange} open>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>What was agreed</DialogTitle>
          <DialogDescription>
            Without all three, nobody is invited. Once they are in, the links
            that are due go out at once.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <AgreedSwitch
            checked={draft.processing}
            description="The data processing agreement between the company and Grasp."
            label="Agreement on handling data signed"
            onChange={(processing) => {
              setDraft(withDay(draft, { processing }));
            }}
          />
          <AgreedSwitch
            checked={draft.assessment}
            description="The data protection impact assessment, signed off by the company."
            label="The company’s look at the risks signed off"
            onChange={(assessment) => {
              setDraft(withDay(draft, { assessment }));
            }}
          />
          <Field>
            <FieldLabel htmlFor={councilId}>Works council</FieldLabel>
            <NativeSelect
              className="w-56"
              id={councilId}
              onChange={(event) => {
                const council = councils.find(
                  (each) => each.value === event.target.value
                )?.value;
                if (council !== undefined) {
                  setDraft(withDay(draft, { council }));
                }
              }}
              value={draft.council}
            >
              {councils.map((each) => (
                <NativeSelectOption key={each.value} value={each.value}>
                  {each.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <FieldDescription>
              Only the works council can agree to this, not the sponsor.
            </FieldDescription>
          </Field>
          <CommandFailure failure={failure} />
          <DialogFooter>
            <Button disabled={busy} type="submit">
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

/** Changing what was agreed, until the team is told. */
export const AgreementsAction = ({
  clientId,
  agreements,
  told,
}: {
  clientId: string;
  agreements: AgreementsRead;
  /** The team is told: what was agreed stays as it was. */
  told: boolean;
}) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        disabled={told}
        onClick={() => {
          setOpen(true);
        }}
        size="sm"
        variant="outline"
      >
        <PencilIcon data-icon="inline-start" />
        Change what was agreed
      </Button>
      {open ? (
        <AgreementsDialog
          agreements={agreements ?? nothingAgreed}
          clientId={clientId}
          onOpenChange={setOpen}
        />
      ) : null}
    </>
  );
};
