/**
 * Linking an organization to its proposal's room in Grasp's Rooms, under
 * its Contract: a person at Grasp gives the room's id, as Rooms shows it in
 * the room's address, or unlinks it. Never matched by name
 * (src/proposal/link.ts). Saved, audited, and the admin read again, so the
 * proposal shows what Rooms says of the room just linked.
 */
import { Button } from "@grasp-os/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import { useRouter } from "@tanstack/react-router";

import { setRoomsProjectFn } from "../proposal/functions.ts";
import type { RoomsLinkChange } from "../proposal/functions.ts";
import type { RoomsLinkErrorCode } from "../proposal/link.ts";
import { thenRefresh, useAction } from "../use-action.ts";

/** What staff read when linking is refused, by its code. */
const refusals: Readonly<Record<RoomsLinkErrorCode, string>> = {
  unknown_client: "There’s no such organization.",
  project_id_invalid:
    "That isn’t a room’s id: it is the long code after /rooms/ in the room’s address in Rooms.",
};

/** The form: the linked room's id, to save, change or take away. */
export const RoomsLink = ({
  clientId,
  projectId,
}: {
  clientId: string;
  projectId: string | null;
}) => {
  const router = useRouter();
  const { busy, failure, run } = useAction(refusals);
  const save = (next: string | null) => {
    void run(
      async (): Promise<RoomsLinkChange> =>
        await thenRefresh(
          async () =>
            await setRoomsProjectFn({
              data: { clientId, projectId: next },
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
        const value = new FormData(event.currentTarget).get("projectId");
        save(typeof value === "string" ? value.trim() : "");
      }}
    >
      <Field>
        <FieldLabel htmlFor={`rooms-${clientId}`}>
          Its proposal in Rooms
        </FieldLabel>
        <Input
          defaultValue={projectId ?? ""}
          id={`rooms-${clientId}`}
          // Keyed by the link: the field starts again from it after a save.
          key={projectId ?? ""}
          maxLength={36}
          name="projectId"
          placeholder="The room’s id"
          required
        />
        <FieldDescription>
          The long code after /rooms/ in the room’s address. Check it is this
          company’s: its proposal and signatures show here.
        </FieldDescription>
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={busy} size="sm" type="submit" variant="outline">
          {projectId === null ? "Link" : "Save"}
        </Button>
        {projectId === null ? null : (
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
