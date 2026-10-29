/**
 * A destination's requirements as a plain checklist, in Setup's Hosting
 * section and on Platform's Destinations page: each one checked (by whom,
 * by provisioning's own check or by the platform's record, when, and
 * where it is recorded), still to be checked by a person, or to be
 * checked by provisioning itself the first time it runs there. In any
 * destination but Grasp's own, a person records what they checked with
 * one form, as themselves, also over a record already there (to put a failed
 * check right, or withdraw one that no longer holds); every record is
 * audited
 * (src/hosting/functions.ts, `recordCapabilityCheckFn`).
 */
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import {
  RadioGroup,
  RadioGroupItem,
} from "@grasp-os/ui/components/radio-group";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { thenRefresh, useAction } from "../use-action.ts";
import { recordCapabilityCheckFn } from "./functions.ts";
import type { CapabilityCheck } from "./placement.ts";
import { capabilityWords, inventoryWords } from "./words.ts";

const stateWords: Readonly<Record<CapabilityCheck["state"], string>> = {
  verified: "Checked",
  unsupported: "Doesn't hold",
  needs_checking: "Needs checking",
  checked_on_provision: "Checked when it provisions",
};

/** How it is verified, in words, beside its state. */
const methodWords: Readonly<Record<CapabilityCheck["method"], string>> = {
  read_back: "read back from Cloudflare",
  probe: "asked of core once deployed",
  release: "read from the release",
  platform: "platform fact, reviewed in code",
  manual: "checked by a person",
};

/** Who checked it, in words: a staff member, provisioning's own check, or the platform's record. */
const byWhom = (recordedBy: string): string => {
  if (recordedBy === "system") {
    return "an automatic check";
  }
  return recordedBy === "platform" ? "platform (reviewed in code)" : recordedBy;
};

/** Field `name` of `form`, as text. */
const textOf = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
};

/**
 * The instant a `datetime-local` field's `value` names, in UTC: the field
 * is in the browser's own time zone, which `Date` reads it in, and the
 * admin stores and shows every time in UTC.
 */
const utcOf = (value: string): string => new Date(value).toISOString();

/** The form a person records a check with. */
const RecordCheck = ({
  destinationId,
  capability,
  again,
}: {
  destinationId: string;
  capability: CapabilityCheck["capability"];
  /** Whether it has a record already, which this one replaces. */
  again: boolean;
}) => {
  const router = useRouter();
  const { busy, failure, run } = useAction(inventoryWords);
  const [holds, setHolds] = useState("yes");
  const id = `${destinationId}-${capability}`;
  const submit = (form: FormData) => {
    void run(
      async () =>
        await thenRefresh(
          async () =>
            await recordCapabilityCheckFn({
              data: {
                destinationId,
                capability,
                holds: holds === "yes",
                procedure: textOf(form, "procedure"),
                record: textOf(form, "record"),
                observedAt: utcOf(textOf(form, "observedAt")),
              },
            }),
          async () => {
            await router.invalidate({ sync: true });
          }
        )
    );
  };
  return (
    <Collapsible>
      <CollapsibleTrigger render={<Button size="sm" variant="outline" />}>
        {again ? "Record a new check" : "Record a check"}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <form
          className="mt-3 flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit(new FormData(event.currentTarget));
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${id}-procedure`}>
                What you checked
              </FieldLabel>
              <Textarea id={`${id}-procedure`} name="procedure" required />
              <FieldDescription>
                How you checked it, so someone else could do it again.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-record`}>Link</FieldLabel>
              <Input
                id={`${id}-record`}
                name="record"
                placeholder="https://"
                required
                type="url"
              />
              <FieldDescription>
                Where the record of it is: an issue, a test run, a document.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-when`}>
                When, in your own time
              </FieldLabel>
              <Input
                id={`${id}-when`}
                name="observedAt"
                required
                type="datetime-local"
              />
              <FieldDescription>
                Kept and shown in UTC, as every time in the admin is.
              </FieldDescription>
            </Field>
            <FieldSet>
              <FieldLegend variant="label">What you found</FieldLegend>
              <RadioGroup
                onValueChange={(value) => {
                  setHolds(String(value));
                }}
                value={holds}
              >
                <Field orientation="horizontal">
                  <RadioGroupItem id={`${id}-holds`} value="yes" />
                  <FieldLabel htmlFor={`${id}-holds`}>It holds</FieldLabel>
                </Field>
                <Field orientation="horizontal">
                  <RadioGroupItem id={`${id}-fails`} value="no" />
                  <FieldLabel htmlFor={`${id}-fails`}>
                    It doesn&apos;t hold
                  </FieldLabel>
                </Field>
              </RadioGroup>
            </FieldSet>
          </FieldGroup>
          <div className="flex flex-wrap items-center gap-4">
            <Button disabled={busy} type="submit">
              Record it as mine
            </Button>
            {failure === null ? null : (
              <p className="text-destructive text-sm" role="alert">
                {failure}
              </p>
            )}
          </div>
        </form>
      </CollapsibleContent>
    </Collapsible>
  );
};

/** One requirement: where it stands, who checked it, or the form to check it. */
const CheckItem = ({
  destinationId,
  check,
}: {
  destinationId: string;
  check: CapabilityCheck;
}) => (
  <li className="flex flex-col gap-2 border-t py-3 first:border-t-0">
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Badge
        variant={check.state === "unsupported" ? "destructive" : "outline"}
      >
        {stateWords[check.state]}
      </Badge>
      <span>{capabilityWords[check.capability]}</span>
      <span className="text-muted-foreground">{`(${methodWords[check.method]})`}</span>
    </div>
    {check.evidence === null ? null : (
      <p className="text-muted-foreground text-sm">
        {`By ${byWhom(check.evidence.recordedBy)}, ${check.evidence.observedAt.slice(0, 16).replace("T", " ")} UTC: ${check.evidence.procedure} `}
        <a
          className="underline"
          href={check.evidence.record}
          rel="noopener"
          target="_blank"
        >
          Record
        </a>
      </p>
    )}
    {/* Also once recorded: to put a failed check right, or withdraw one
        that no longer holds, as a new record that replaces it, audited.
        Only where a person checks it: Grasp's own hosting checks itself. */}
    {check.byHand ? (
      <RecordCheck
        again={check.evidence !== null}
        capability={check.capability}
        destinationId={destinationId}
      />
    ) : null}
  </li>
);

/** Every requirement of a destination under one policy, as a checklist. */
export const CapabilityChecklist = ({
  destinationId,
  checks,
}: {
  destinationId: string;
  checks: readonly CapabilityCheck[];
}) => (
  <div className="flex flex-col gap-2">
    {checks.some(({ state }) => state === "checked_on_provision") ? (
      <p className="text-sm">
        Grasp&apos;s own hosting checks itself when it provisions a client: it
        reads back from Cloudflare where each database and bucket was put, asks
        core where its Durable Objects are made, reads logs and model transport
        from the release, and stops if anything is outside the policy.
      </p>
    ) : null}
    <ul className="flex flex-col">
      {checks.map((check) => (
        <CheckItem
          check={check}
          destinationId={destinationId}
          key={check.capability}
        />
      ))}
    </ul>
  </div>
);
