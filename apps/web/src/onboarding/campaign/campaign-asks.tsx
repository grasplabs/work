// Concepts only: what the admin can do on the campaign page, at most two
// things at once, each done with one press: nudge a quiet team (Grasp's
// reminder goes out in the admin's name, to those still to talk, whom the
// admin never sees), or correct an address an invitation bounced from.
// Every concept places them its own way; they act the same everywhere.
import { Button } from "@grasp-os/ui/components/button";
import { Field, FieldLabel } from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverFooter,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@grasp-os/ui/components/popover";
import { useId, useState } from "react";

import type { Ask } from "./fixtures.ts";

/** What core would do to send: here, nothing (fixtures). */
const sent = async (): Promise<void> => {
  await Promise.resolve();
};

/** The ask's words: a short title and one sentence; `line` says both at once. */
export const askLine = (ask: Ask, done: boolean): string => {
  if (ask.kind === "quiet") {
    return done
      ? `Done: ${ask.team} got a nudge from you.`
      : `${ask.team} is quiet, with ${ask.waiting} still to talk. A nudge from you usually helps.`;
  }
  return done
    ? "The invitation went out again."
    : `The invitation to ${ask.address} bounced.`;
};

export const askWords = (
  ask: Ask,
  done: boolean
): { title: string; sentence: string } => {
  if (ask.kind === "quiet") {
    return done
      ? {
          title: `${ask.team} is reminded`,
          sentence: `The ${ask.waiting} still to talk got a nudge in your name.`,
        }
      : {
          title: `${ask.team} is quiet`,
          sentence: `${ask.waiting} still to talk. A nudge from you usually helps: we send it in your name.`,
        };
  }
  return done
    ? {
        title: "Invitation sent again",
        sentence: `To the corrected address, in ${ask.team}.`,
      }
    : {
        title: "One invitation didn’t arrive",
        sentence: `${ask.address} bounced, in ${ask.team}.`,
      };
};

/** The one press for a quiet team. */
const Nudge = ({ ask, onDone }: { ask: Ask; onDone: () => void }) => (
  <Button
    onClick={async () => {
      await sent();
      onDone();
    }}
    size="sm"
    successText="Sent"
    variant="outline"
  >
    {`Nudge ${ask.team}`}
  </Button>
);

/** The address to correct, in a small panel beside its button. */
const Readdress = ({
  ask,
  onDone,
}: {
  ask: Extract<Ask, { kind: "bounce" }>;
  onDone: () => void;
}) => {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline">
          Correct the address
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end">
        <PopoverHeader>
          <PopoverTitle>Correct the address</PopoverTitle>
          <PopoverDescription>
            We send the invitation again at once.
          </PopoverDescription>
        </PopoverHeader>
        <Field>
          <FieldLabel htmlFor={id}>Email address</FieldLabel>
          <Input defaultValue={ask.address} id={id} type="email" />
        </Field>
        <PopoverFooter>
          <Button
            onClick={async () => {
              await sent();
              setOpen(false);
              onDone();
            }}
            size="sm"
          >
            Send again
          </Button>
        </PopoverFooter>
      </PopoverContent>
    </Popover>
  );
};

/** The press an ask takes; nothing once it is done. */
export const AskAction = ({
  ask,
  done,
  onDone,
}: {
  ask: Ask;
  done: boolean;
  onDone: () => void;
}) => {
  if (done) {
    return null;
  }
  return ask.kind === "quiet" ? (
    <Nudge ask={ask} onDone={onDone} />
  ) : (
    <Readdress ask={ask} onDone={onDone} />
  );
};

/** Which asks are done on this page, kept while it is open. */
export const useAsksDone = () => {
  const [done, setDone] = useState<string[]>([]);
  return {
    isDone: (ask: Ask) => done.includes(ask.id),
    markDone: (ask: Ask) => {
      setDone((was) => [...was, ask.id]);
    },
  };
};
