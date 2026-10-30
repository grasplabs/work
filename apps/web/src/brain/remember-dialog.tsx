import {
  memoryKindSchema,
  rememberTextMaxLength,
} from "@grasp-os/shared/knowledge";
import type { MemoryKind } from "@grasp-os/shared/knowledge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@grasp-os/ui/components/dialog";
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@grasp-os/ui/components/field";
import {
  RadioGroup,
  RadioGroupItem,
} from "@grasp-os/ui/components/radio-group";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { Trans, useLingui } from "@lingui/react/macro";
import { PlusIcon } from "lucide-react";
import { useId, useRef, useState } from "react";

import { ErrorText } from "../error-text.tsx";
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
  const ids = useId();
  const { busy, failure, run } = useCoreAction();
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
    if (receipt !== undefined) {
      onRemembered(recordOf(receipt));
    }
  };

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !busy) {
          void remember();
        }
      }}
    >
      <DialogHeader>
        <DialogTitle>
          <Trans>Remember something</Trans>
        </DialogTitle>
        <DialogDescription>
          <Trans>Only you and your agents read it, until you share it.</Trans>
        </DialogDescription>
      </DialogHeader>
      <FieldSet>
        <FieldLegend variant="label">
          <Trans>What it is</Trans>
        </FieldLegend>
        <RadioGroup
          className="grid-cols-2"
          disabled={busy}
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
              <RadioGroupItem id={`${ids}-${one}`} value={one} />
              <FieldLabel htmlFor={`${ids}-${one}`}>
                <KindLabel kind={one} />
              </FieldLabel>
            </Field>
          ))}
        </RadioGroup>
      </FieldSet>
      <Field>
        <FieldLabel htmlFor={`${ids}-text`}>
          <Trans>What to remember</Trans>
        </FieldLabel>
        <Textarea
          disabled={busy}
          id={`${ids}-text`}
          maxLength={rememberTextMaxLength}
          onChange={(event) => {
            setText(event.target.value);
          }}
          rows={4}
          value={text}
        />
        <FieldDescription>
          <Trans>
            It starts as proposed: Grasp uses it, and you can correct or retire
            it here.
          </Trans>
        </FieldDescription>
      </Field>
      <ErrorText>{failure}</ErrorText>
      <DialogFooter>
        <DialogClose
          disabled={busy}
          render={<Button type="button" variant="outline" />}
        >
          <Trans>Cancel</Trans>
        </DialogClose>
        <Button disabled={!ready || busy} type="submit">
          <Trans>Remember it</Trans>
        </Button>
      </DialogFooter>
    </form>
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
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        <PlusIcon data-icon="inline-start" />
        <Trans>Remember something</Trans>
      </DialogTrigger>
      <DialogContent closeLabel={t`Close`}>
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
