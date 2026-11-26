/**
 * Changing how Stephen is set up for one company, from its Interviews:
 * the languages he interviews in, what he leaves alone and the words he
 * has to know. Saved in the company's Grasp as a command
 * (commands.tsx), it holds from the next interview turn on; taking it
 * back leaves what the first conversation suggests.
 */

import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import { interviewLocales } from "@grasp-os/shared/onboarding";
import type { InterviewLocale } from "@grasp-os/shared/onboarding";
import {
  stephenLimitMaxLength,
  stephenLimitsMax,
  stephenSetupSchema,
  stephenTermMaxLength,
  stephenTermsMax,
} from "@grasp-os/shared/onboarding-staff";
import { Alert, AlertDescription } from "@grasp-os/ui/components/alert";
import { Button } from "@grasp-os/ui/components/button";
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
  FieldDescription,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import { Textarea } from "@grasp-os/ui/components/textarea";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import { Icon, PencilIcon, UndoIcon } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { CommandFailure, useCommand } from "./commands.tsx";

const styles = stylex.create({
  form: { display: "flex", flexDirection: "column", gap: space["5"] },
  dialog: { width: "36rem" },
  actions: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: space["1"],
  },
  buttons: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space["2"],
  },
});

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
  if (limits.some((line) => line.length > stephenLimitMaxLength)) {
    return `Each thing to leave alone at most ${stephenLimitMaxLength} characters.`;
  }
  if (terms.some((line) => line.length > stephenTermMaxLength)) {
    return `Each word at most ${stephenTermMaxLength} characters.`;
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
      <DialogContent style={styles.dialog}>
        <DialogHeader>
          <DialogTitle>How Stephen is set up</DialogTitle>
          <DialogDescription>
            For this company only. It holds from the next interview turn on.
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
              <Field>
                <FieldLabel>Languages he interviews in</FieldLabel>
                <ToggleGroup
                  aria-label="Languages he interviews in"
                  multiple
                  onValueChange={(value) => {
                    setLanguages(value);
                  }}
                  size="sm"
                  value={languages}
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
                <FieldLabel>What he leaves alone</FieldLabel>
                <Textarea onValueChange={setLimits} rows={4} value={limits} />
                <FieldDescription>
                  One a line. He doesn’t ask about it, and moves on when
                  somebody brings it up.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel>Words he has to know</FieldLabel>
                <Textarea onValueChange={setTerms} rows={4} value={terms} />
                <FieldDescription>
                  One a line: tools, products and the company’s own words, so he
                  hears them right.
                </FieldDescription>
              </Field>
              {problem === null ? null : (
                <Alert live="polite" variant="warning">
                  <AlertDescription>{problem}</AlertDescription>
                </Alert>
              )}
              <CommandFailure failure={failure} />
            </div>
          </DialogBody>
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
    <div {...stylex.props(styles.actions)}>
      <div {...stylex.props(styles.buttons)}>
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
            variant="outline"
          >
            <Icon icon={UndoIcon} />
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
          <Icon icon={PencilIcon} />
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
