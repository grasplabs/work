/**
 * Linking an organization to its company in Grasp's Attio, under its
 * Details: a person at Grasp gives the company record's id, as Attio shows
 * it in the company's address, or unlinks it. Never matched by name or
 * domain (src/crm/link.ts). Saved, audited, and the admin read again, so
 * Details shows what Attio says of the company just linked.
 */
import { Button } from "@grasp-os/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import { useRouter } from "@tanstack/react-router";

import { setAttioCompanyFn } from "../crm/functions.ts";
import type { AttioLinkChange } from "../crm/functions.ts";
import type { AttioLinkErrorCode } from "../crm/link.ts";
import { thenRefresh, useAction } from "../use-action.ts";

/** What staff read when linking is refused, by its code. */
const refusals: Readonly<Record<AttioLinkErrorCode, string>> = {
  unknown_client: "There’s no such organization.",
  record_id_invalid:
    "That isn’t a company’s record id: it is the long code after /company/ in the company’s address in Attio.",
};

/** The form: the linked company's record id, to save, change or take away. */
export const AttioLink = ({
  clientId,
  recordId,
}: {
  clientId: string;
  recordId: string | null;
}) => {
  const router = useRouter();
  const { busy, failure, run } = useAction(refusals);
  const save = (next: string | null) => {
    void run(
      async (): Promise<AttioLinkChange> =>
        await thenRefresh(
          async () =>
            await setAttioCompanyFn({
              data: { clientId, recordId: next },
            }),
          async () => {
            await router.invalidate({ sync: true });
          }
        )
    );
  };
  return (
    <form
      className="flex flex-col gap-3 border-t px-5 py-4"
      onSubmit={(event) => {
        event.preventDefault();
        const value = new FormData(event.currentTarget).get("recordId");
        save(typeof value === "string" ? value.trim() : "");
      }}
    >
      <Field>
        <FieldLabel htmlFor={`attio-${clientId}`}>
          Its company in Attio
        </FieldLabel>
        <Input
          defaultValue={recordId ?? ""}
          id={`attio-${clientId}`}
          // Keyed by the link: the field starts again from it after a save.
          key={recordId ?? ""}
          maxLength={36}
          name="recordId"
          placeholder="The company’s record id"
          required
        />
        <FieldDescription>
          The long code after /company/ in the company’s address in Attio. Check
          it is this company: its people and deals show here.
        </FieldDescription>
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={busy} size="sm" type="submit" variant="outline">
          {recordId === null ? "Link" : "Save"}
        </Button>
        {recordId === null ? null : (
          <Button
            disabled={busy}
            onClick={() => {
              save(null);
            }}
            size="sm"
            type="button"
            variant="ghost"
          >
            Unlink
          </Button>
        )}
        {failure === null ? null : (
          <p className="text-destructive text-sm" role="alert">
            {failure}
          </p>
        )}
      </div>
    </form>
  );
};
