/**
 * Whether a source or a person was erased from a client's Brain, for
 * Grasp's staff answering the client's own question (GRA-1818): staff
 * type the source's key or the person's id as the client gave it, and
 * read yes or no, with when the ledger recorded it. Nothing else: no
 * list, no search, no content, and "not erased" alike for something that
 * never existed. Core writes every lookup to the company's audit log, by
 * the staff member, before it answers; nothing of it is kept here.
 */
import type { BrainErasureLookup } from "@grasp-os/shared/brain-report";
import { Button } from "@grasp-os/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import { useId, useState } from "react";

import { brainErasureFn } from "../clients/brain-functions.ts";
import type { BrainErasureResult } from "../clients/brain.ts";
import { answerKept, answerShown } from "./erasure-answer.ts";
import type { LookupAnswer } from "./erasure-answer.ts";
import { Section } from "./section.tsx";

const kinds = [
  { value: "source", label: "A source, by its key" },
  { value: "person", label: "A person, by their id" },
] as const;

type Kind = BrainErasureLookup["kind"];

/** What staff read for each answer that isn't a yes, and is the same for either kind. */
const answerWords: Readonly<
  Record<Exclude<BrainErasureResult["state"], "erased" | "not_erased">, string>
> = {
  erasing:
    "Not finished: the erasure is recorded, and still being written to the ledger or deleted.",
  skipped:
    "Not done, and not tried again: the erasure of this person from the Brain was recorded as skipped. Raise it with engineering.",
  unavailable:
    "The Brain can't read its erasure ledger right now, or is applying it after a restore: try again shortly.",
  unknown:
    "The company's Grasp answered in a way this admin can't read yet: it runs a newer release. Try again once the admin is updated.",
  not_answered: "The company's Grasp didn't answer: try again.",
};

/** The answers that say something is wrong: not a yes, a no, or not finished yet. */
const wrongStates = new Set<BrainErasureResult["state"]>([
  "skipped",
  "unavailable",
  "unknown",
  "not_answered",
]);

/** What staff read when no erasure is recorded: a source may have gone with a person. */
const notErasedWords: Readonly<Record<Kind, string>> = {
  source:
    "No erasure of this source itself is recorded; erasing a person may have covered it.",
  person: "No: the ledger holds no erasure of this person.",
};

/** The line an answer about `kind` leaves, and whether it says something went wrong. */
const saidOf = (
  kind: Kind,
  result: BrainErasureResult
): { text: string; wrong: boolean } => {
  if (result.state === "erased") {
    return {
      text: `Yes: erased from the Brain and recorded in its ledger on ${new Date(result.at).toLocaleString("en-GB", { dateStyle: "long", timeStyle: "short" })}; its files are deleted by the Brain's sweep once their grace period has passed.`,
      wrong: false,
    };
  }
  if (result.state === "not_erased") {
    return { text: notErasedWords[kind], wrong: false };
  }
  return {
    text: answerWords[result.state],
    wrong: wrongStates.has(result.state),
  };
};

/** The lookup `kind` names, of what staff typed. */
const lookupOf = (kind: Kind, typed: string): BrainErasureLookup =>
  kind === "source" ? { kind, key: typed } : { kind, id: typed };

export const BrainErasureLookupSection = ({
  clientId,
}: {
  clientId: string;
}) => {
  const kindId = useId();
  const nameId = useId();
  const [kind, setKind] = useState<Kind>("source");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<LookupAnswer | null>(null);
  const [lastAsked, setLastAsked] = useState(0);
  // Only the answer to the lookup submitted last, while it is still what
  // is typed (erasure-answer.ts).
  const said = answerShown(answer, kind, typed, lastAsked);
  const lookUp = () => {
    const name = typed.trim();
    if (name === "") {
      return;
    }
    const asked = lastAsked + 1;
    const lookedUp = kind;
    setLastAsked(asked);
    setAnswer(null);
    setBusy(true);
    void (async () => {
      let next = { text: "That didn't work: try again.", wrong: true };
      try {
        next = saidOf(
          lookedUp,
          await brainErasureFn({
            data: { clientId, lookup: lookupOf(lookedUp, name) },
          })
        );
      } catch {
        // Said as failed: nothing of the error is for staff.
      }
      setAnswer((kept) =>
        answerKept(kept, { kind: lookedUp, name, asked, ...next })
      );
      setBusy(false);
    })();
  };
  return (
    <Section
      description="Answer a company's question whether something was erased. Type its key or id as the company gave it. Each lookup is in the company's audit log, with your name."
      title="Was it erased?"
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          lookUp();
        }}
      >
        <Field>
          <FieldLabel htmlFor={kindId}>What to look up</FieldLabel>
          <NativeSelect
            className="w-56"
            id={kindId}
            onChange={(event) => {
              const chosen = kinds.find(
                (each) => each.value === event.target.value
              )?.value;
              if (chosen !== undefined) {
                setKind(chosen);
                setAnswer(null);
              }
            }}
            value={kind}
          >
            {kinds.map((each) => (
              <NativeSelectOption key={each.value} value={each.value}>
                {each.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Field>
          <FieldLabel htmlFor={nameId}>
            {kind === "source" ? "Source key" : "Person's id"}
          </FieldLabel>
          <Input
            autoComplete="off"
            id={nameId}
            maxLength={256}
            onChange={(event) => {
              setTyped(event.target.value);
              setAnswer(null);
            }}
            required
            spellCheck={false}
            value={typed}
          />
          <FieldDescription>
            {kind === "source"
              ? "Its producer and the producer's id, as upload:…"
              : "Their user id in the company's Grasp."}
          </FieldDescription>
        </Field>
        <div>
          <Button disabled={busy || typed.trim() === ""} type="submit">
            Look up
          </Button>
        </div>
        {said === null ? null : (
          <p
            className={
              said.wrong
                ? "text-destructive text-sm"
                : "text-muted-foreground text-sm"
            }
            role={said.wrong ? "alert" : "status"}
          >
            {said.text}
          </p>
        )}
      </form>
    </Section>
  );
};
