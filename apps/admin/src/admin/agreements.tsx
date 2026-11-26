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
import { DatePicker } from "@grasp-os/ui/components/date-picker";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import { Switch } from "@grasp-os/ui/components/switch";
import { Icon, PencilIcon } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { CommandFailure, useCommand } from "./commands.tsx";

const styles = stylex.create({
  form: { display: "flex", flexDirection: "column", gap: space["5"] },
  // A day's field, as wide as a date.
  day: { width: "12rem" },
  council: { width: "14rem" },
});

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

/** Today on the staff member's own calendar, as core keeps the day something was signed. */
const today = (): string => {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
};

/** `agreements` with the data agreement in or not, signed today when it comes in, until staff say the day. */
const withProcessing = (agreements: Agreements, on: boolean): Agreements => {
  const { processingOn: _, ...rest } = agreements;
  return on
    ? {
        ...rest,
        processing: true,
        processingOn: agreements.processingOn ?? today(),
      }
    : { ...rest, processing: false };
};

/** `agreements` with the look at the risks signed off or not, as with the data agreement. */
const withAssessment = (agreements: Agreements, on: boolean): Agreements => {
  const { assessmentOn: _, ...rest } = agreements;
  return on
    ? {
        ...rest,
        assessment: true,
        assessmentOn: agreements.assessmentOn ?? today(),
      }
    : { ...rest, assessment: false };
};

/** `agreements` with the works council's answer: a day once it said yes or there is none. */
const withCouncil = (
  agreements: Agreements,
  council: Agreements["council"]
): Agreements => {
  const { councilOn: _, ...rest } = agreements;
  return council === "waiting"
    ? { ...rest, council }
    : { ...rest, council, councilOn: agreements.councilOn ?? today() };
};

type DayKey = "processingOn" | "assessmentOn" | "councilOn";

/** `agreements` with `key`'s day set, or without one when it is emptied. */
const withDay = (
  agreements: Agreements,
  key: DayKey,
  day: string
): Agreements => {
  const { [key]: _, ...rest } = agreements;
  return day === "" ? rest : { ...rest, [key]: day };
};

/** The days staff give, by what each is the day of. */
const dayKeys = ["processingOn", "assessmentOn", "councilOn"] as const;

/** The days in `agreements` after today: nothing is agreed on a day still to come. */
const lateDays = (agreements: Agreements): DayKey[] => {
  const now = today();
  return dayKeys.filter((key) => (agreements[key] ?? "") > now);
};

/**
 * The day one agreement was made, once it is in; `late` when it is after
 * today, which Save refuses, saying so under it. Damsko's DatePicker takes
 * no latest day (as the native field's `max` did), so it is checked here.
 */
const AgreedDay = ({
  label,
  value,
  late,
  onChange,
}: {
  label: string;
  value: string | undefined;
  late: boolean;
  onChange: (day: string) => void;
}) => (
  <Field data-invalid={late}>
    <DatePicker
      aria-label={label}
      onValueChange={(day) => {
        onChange(typeof day === "string" ? day : "");
      }}
      required
      style={styles.day}
      value={value ?? null}
    />
    {late ? <FieldError match>The day can’t be after today.</FieldError> : null}
  </Field>
);

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
}) => (
  <Field orientation="horizontal">
    <FieldContent>
      <FieldLabel>{label}</FieldLabel>
      <FieldDescription>{description}</FieldDescription>
    </FieldContent>
    <Switch
      checked={checked}
      onCheckedChange={(next) => {
        onChange(next);
      }}
    />
  </Field>
);

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
  const { busy, failure, give } = useCommand(clientId);
  const [draft, setDraft] = useState<Agreements>(agreements);
  // The days found after today when Save was last pressed: said until changed.
  const [late, setLate] = useState<readonly DayKey[]>([]);
  const change = (next: Agreements): void => {
    setDraft(next);
    setLate([]);
  };
  const save = async (): Promise<void> => {
    const after = lateDays(draft);
    setLate(after);
    if (after.length > 0) {
      return;
    }
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>What was agreed</DialogTitle>
          <DialogDescription>
            Without all three, nobody is invited. Once they are in, the links
            that are due go out at once.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <DialogBody>
            <div {...stylex.props(styles.form)}>
              <AgreedSwitch
                checked={draft.processing}
                description="The data processing agreement between the company and Grasp."
                label="Agreement on handling data signed"
                onChange={(processing) => {
                  change(withProcessing(draft, processing));
                }}
              />
              {draft.processing ? (
                <AgreedDay
                  label="Day the agreement on handling data was signed"
                  late={late.includes("processingOn")}
                  onChange={(day) => {
                    change(withDay(draft, "processingOn", day));
                  }}
                  value={draft.processingOn}
                />
              ) : null}
              <AgreedSwitch
                checked={draft.assessment}
                description="The data protection impact assessment, signed off by the company."
                label="The company’s look at the risks signed off"
                onChange={(assessment) => {
                  change(withAssessment(draft, assessment));
                }}
              />
              {draft.assessment ? (
                <AgreedDay
                  label="Day the look at the risks was signed off"
                  late={late.includes("assessmentOn")}
                  onChange={(day) => {
                    change(withDay(draft, "assessmentOn", day));
                  }}
                  value={draft.assessmentOn}
                />
              ) : null}
              <Field>
                <FieldLabel>Works council</FieldLabel>
                <NativeSelect
                  style={styles.council}
                  onChange={(event) => {
                    const council = councils.find(
                      (each) => each.value === event.target.value
                    )?.value;
                    if (council !== undefined) {
                      change(withCouncil(draft, council));
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
              {draft.council === "waiting" ? null : (
                <AgreedDay
                  label="Day the works council said yes, or it was found there is none"
                  late={late.includes("councilOn")}
                  onChange={(day) => {
                    change(withDay(draft, "councilOn", day));
                  }}
                  value={draft.councilOn}
                />
              )}
              <CommandFailure failure={failure} />
            </div>
          </DialogBody>
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
        <Icon icon={PencilIcon} />
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
