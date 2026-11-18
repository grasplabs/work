import {
  memoryKindSchema,
  rememberTextMaxLength,
} from "@grasp-os/shared/knowledge";
import type { MemoryKind } from "@grasp-os/shared/knowledge";
import { useLingui } from "@lingui/react/macro";
import { useRef, useState } from "react";

import { ErrorText } from "../error-text.tsx";
import {
  Dialog,
  DialogAction,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from "../grasp/dialog/index.ts";
import { Field, FieldLabel } from "../grasp/field/index.ts";
import { Plus } from "../grasp/icons/index.ts";
import { RadioGroup, RadioGroupItem } from "../grasp/radio-group/index.ts";
import { Textarea } from "../grasp/textarea/index.ts";
import { useCoreAction } from "../use-core-action.ts";
import { KindLabel, keyOf, recordOf } from "./memory-parts.tsx";

// Asking Grasp to remember something of the person's own (`remember`): what
// kind of thing it is and what it says. Core keeps it as a proposed record
// of theirs, only they read; sharing it with a team or the company is a
// separate step (share-record.tsx). The form keeps one idempotency key
// while it is open, so trying again after a lost answer never remembers
// it twice.

const RememberForm = ({
  onRemembered,
}: {
  onRemembered: (memoryId: string | undefined) => void;
}) => {
  const { t } = useLingui();
  const { failure, run } = useCoreAction();
  const [kind, setKind] = useState<MemoryKind>("fact");
  const [text, setText] = useState("");
  const idempotencyKey = useRef<string>(null);
  const ready = text.trim() !== "";

  const remember = async (): Promise<void> => {
    const receipt = await run(
      async (session) =>
        await session.knowledge.remember(
          { kind, text: text.trim() },
          { idempotencyKey: keyOf(idempotencyKey) }
        )
    );
    if (receipt === undefined) {
      // The dialog stays open, with core's reason under the fields.
      throw new Error("It wasn't remembered.");
    }
    onRemembered(recordOf(receipt));
  };

  return (
    <>
      <DialogBody>
        <Field>
          <FieldLabel>{t`What it is`}</FieldLabel>
          <RadioGroup
            onValueChange={(value) => {
              const parsed = memoryKindSchema.safeParse(value);
              if (parsed.success) {
                setKind(parsed.data);
              }
            }}
            value={kind}
          >
            {memoryKindSchema.options.map((one) => (
              <Field key={one} orientation="horizontal">
                <RadioGroupItem value={one} />
                <FieldLabel>
                  <KindLabel kind={one} />
                </FieldLabel>
              </Field>
            ))}
          </RadioGroup>
        </Field>
        <Field>
          <FieldLabel>{t`What to remember`}</FieldLabel>
          <Textarea
            maxLength={rememberTextMaxLength}
            onValueChange={(value) => {
              setText(value);
            }}
            rows={4}
            value={text}
          />
        </Field>
        <ErrorText>{failure}</ErrorText>
      </DialogBody>
      <DialogFooter>
        <DialogAction>{t`Cancel`}</DialogAction>
        <DialogAction
          action={remember}
          disabled={!ready}
          failedLabel={t`Not remembered`}
          variant="ink"
          workingLabel={t`Remembering`}
        >
          {t`Remember it`}
        </DialogAction>
      </DialogFooter>
    </>
  );
};

/** "Remember something", opening the form; `onRemembered` gets the record. */
export const RememberDialog = ({
  onRemembered,
}: {
  onRemembered: (memoryId: string | undefined) => void;
}) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger icon={Plus}>{t`Remember something`}</DialogTrigger>
      <DialogContent closeLabel={t`Close`}>
        <DialogTitle>{t`Remember something`}</DialogTitle>
        <DialogDescription>
          {t`Only you and your agents read it, until you share it.`}
        </DialogDescription>
        {open ? (
          <RememberForm
            onRemembered={(memoryId) => {
              setOpen(false);
              onRemembered(memoryId);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
};
