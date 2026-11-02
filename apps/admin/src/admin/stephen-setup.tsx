/**
 * Changing how Stephen and Claire are set up for one company, from its
 * Interviews: the languages they interview in, what they leave alone and
 * the words they have to know. Saved in the company's Grasp as a command
 * (commands.tsx), it holds from the next interview turn on; taking it
 * back leaves what the first conversation suggests.
 */
import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import { interviewLocales } from "@grasp-os/shared/onboarding";
import type { InterviewLocale } from "@grasp-os/shared/onboarding";
import {
  stephenLimitsMax,
  stephenSetupSchema,
  stephenTermsMax,
} from "@grasp-os/shared/onboarding-staff";
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
import { Textarea } from "@grasp-os/ui/components/textarea";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import { PencilIcon, RotateCcwIcon } from "lucide-react";
import { useId, useState } from "react";

import { CommandFailure, useCommand } from "./commands.tsx";

/** Stephen's setup as the snapshot has it. */
export type SetupRead = AdminSnapshot["setup"];

const languageNames = new Intl.DisplayNames("en", { type: "language" });

/** The lines of `text`, each trimmed, the empty ones and repeats left out. */
const linesOf = (text: string): string[] => [
  ...new Set(
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
  ),
];

const isLocale = (value: string): value is InterviewLocale =>
  interviewLocales.some((each) => each === value);

/** Why a setup can't be saved, in words; null when it can. */
const problemOf = (languages: string[], limits: string[], terms: string[]) => {
  if (languages.length === 0) {
    return "Choose at least one language.";
  }
  if (limits.length > stephenLimitsMax) {
    return `At most ${stephenLimitsMax} things to leave alone.`;
  }
  if (terms.length > stephenTermsMax) {
    return `At most ${stephenTermsMax} words.`;
  }
  return null;
};

/** The dialog that changes the setup, opened on what holds now. */
const SetupDialog = ({
  clientId,
  setup,
  open,
  onOpenChange,
}: {
  clientId: string;
  setup: SetupRead;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const limitsId = useId();
  const termsId = useId();
  const { busy, failure, give } = useCommand(clientId);
  const [languages, setLanguages] = useState<string[]>(setup.setup.languages);
  const [limits, setLimits] = useState(setup.setup.limits.join("\n"));
  const [terms, setTerms] = useState(setup.setup.terms.join("\n"));
  const lines = { limits: linesOf(limits), terms: linesOf(terms) };
  const problem = problemOf(languages, lines.limits, lines.terms);
  const save = async (): Promise<void> => {
    const parsed = stephenSetupSchema.safeParse({
      languages: languages.filter(isLocale),
      ...lines,
    });
    if (!parsed.success) {
      return;
    }
    if (
      await give({
        type: "onboarding.stephen",
        payload: { setup: parsed.data },
      })
    ) {
      onOpenChange(false);
    }
  };
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>How Stephen and Claire are set up</DialogTitle>
          <DialogDescription>
            For this company only. It holds from the next interview turn on.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Field>
            <FieldLabel>Languages they interview in</FieldLabel>
            <ToggleGroup
              aria-label="Languages they interview in"
              multiple
              onValueChange={(value: string[]) => {
                setLanguages(value);
              }}
              size="sm"
              spacing={1}
              value={languages}
              variant="outline"
            >
              {interviewLocales.map((locale) => (
                <ToggleGroupItem key={locale} value={locale}>
                  {languageNames.of(locale) ?? locale}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <FieldDescription>
              Someone chooses their own language when they open their link.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={limitsId}>What they leave alone</FieldLabel>
            <Textarea
              id={limitsId}
              onChange={(event) => {
                setLimits(event.target.value);
              }}
              rows={4}
              value={limits}
            />
            <FieldDescription>
              One a line. They don’t ask about it, and move on when somebody
              brings it up.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={termsId}>Words they have to know</FieldLabel>
            <Textarea
              id={termsId}
              onChange={(event) => {
                setTerms(event.target.value);
              }}
              rows={4}
              value={terms}
            />
            <FieldDescription>
              One a line: tools, products and the company’s own words, so they
              hear them right.
            </FieldDescription>
          </Field>
          {problem === null ? null : (
            <p className="text-status-attention">{problem}</p>
          )}
          <CommandFailure failure={failure} />
          <DialogFooter>
            <Button disabled={busy || problem !== null} type="submit">
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

/** Changing the setup, and taking it back to what the first conversation suggests. */
export const SetupActions = ({
  clientId,
  setup,
}: {
  clientId: string;
  setup: SetupRead;
}) => {
  const [open, setOpen] = useState(false);
  const back = useCommand(clientId);
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center gap-2">
        {setup.changed ? (
          <Button
            disabled={back.busy}
            onClick={() => {
              void back.give({
                type: "onboarding.stephen",
                payload: { setup: null },
              });
            }}
            size="sm"
            variant="ghost"
          >
            <RotateCcwIcon data-icon="inline-start" />
            As the first conversation suggests
          </Button>
        ) : null}
        <Button
          onClick={() => {
            setOpen(true);
          }}
          size="sm"
          variant="outline"
        >
          <PencilIcon data-icon="inline-start" />
          Change
        </Button>
      </div>
      <CommandFailure failure={back.failure} />
      {open ? (
        <SetupDialog
          clientId={clientId}
          onOpenChange={setOpen}
          open={open}
          setup={setup}
        />
      ) : null}
    </div>
  );
};
