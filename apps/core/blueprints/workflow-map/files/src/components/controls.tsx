import type { Id } from "@grasp-os/sdk";
import { useAction, useForm } from "@grasp-os/sdk/react";
import { Button } from "@grasp-os/ui/components/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import {
  Form,
  FormError,
  SubmitButton,
  TextareaField,
  TextField,
} from "@grasp-os/ui/form";
import { api } from "@server/_generated/api";
import { useState } from "react";

import { maturityLevels } from "./board";
import { whilePending } from "./pending";
import { settle } from "./snapshot";
import type { Snapshot } from "./snapshot";

const levels = Array.from({ length: maturityLevels + 1 }, (_, level) => ({
  value: String(level),
  label: `Maturity ${level} of ${maturityLevels}`,
}));

/**
 * Takes a snapshot now: the page freezes each workflow of the map with
 * its hours, and the signals; the person says the maturity.
 */
export const TakeSnapshot = ({
  onTaken,
  onRefused,
}: {
  onTaken: (id: Id<"snapshots">) => void;
  onRefused: (code: string) => void;
}) => {
  const [maturity, setMaturity] = useState<string | null>(null);
  const [taking, setTaking] = useState(false);
  const takeSnapshot = useAction(api.snapshots.take);
  const take = async (): Promise<void> => {
    const answer = await whilePending(
      setTaking,
      async () =>
        await settle(
          async () => await takeSnapshot({ maturity: Number(maturity) })
        )
    );
    if ("error" in answer) {
      onRefused(answer.error);
      return;
    }
    onTaken(answer.ok);
  };
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Select
        items={levels}
        value={maturity}
        onValueChange={(value: string | null) => {
          setMaturity(value);
        }}
      >
        <SelectTrigger aria-label="Maturity">
          <SelectValue placeholder="Maturity" />
        </SelectTrigger>
        <SelectContent>
          {levels.map((level) => (
            <SelectItem key={level.value} value={level.value}>
              {level.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        disabled={maturity === null || taking}
        onClick={() => {
          void take();
        }}
      >
        Take a snapshot
      </Button>
      <p className="text-muted-foreground w-full text-sm">
        A snapshot freezes the workflow map&apos;s numbers and what runs, as you
        may see them, for everyone who can open this page.
      </p>
    </div>
  );
};

/**
 * The snapshot's narrative and the decision it asks for, saved as its
 * next version; what it froze stays as it was taken. The form starts from
 * the snapshot as it was opened, its revision among what it sends, so a
 * save someone else's overtook fails as `data.conflict`, shown in the
 * form, with what the person typed kept.
 */
export const NarrativeEditor = ({
  snapshot,
  onSaved,
}: {
  snapshot: Snapshot;
  onSaved: (id: Id<"snapshots">) => void;
}) => {
  const form = useForm(api.snapshots.write, {
    defaultValues: {
      id: snapshot.id,
      expectedRevision: snapshot.revision,
      decisionNeeded: snapshot.record.decisionNeeded ?? "",
      narrative: snapshot.body,
    },
    onSuccess: () => {
      onSaved(snapshot.id);
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Narrative and decision</CardTitle>
      </CardHeader>
      <CardContent>
        <Form aria-label="Narrative and decision" form={form}>
          <TextField
            form={form}
            label="Decision needed"
            name="decisionNeeded"
            placeholder="The one decision the board needs to make"
          />
          <TextareaField
            form={form}
            label="Narrative"
            name="narrative"
            placeholder="Where we stand and what changed, in a few lines"
          />
          <FormError form={form} />
          <div>
            <SubmitButton form={form} variant="outline">
              Save
            </SubmitButton>
          </div>
        </Form>
      </CardContent>
    </Card>
  );
};
