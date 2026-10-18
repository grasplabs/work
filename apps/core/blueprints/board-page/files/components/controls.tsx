import type { Id } from "@grasp-os/sdk";
import { useAction, useMutation } from "@grasp-os/sdk/react";
import { Button } from "@grasp-os/ui/components/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import { Input } from "@grasp-os/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { useState } from "react";

import { api } from "#grasp";

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
    </div>
  );
};

/**
 * The snapshot's narrative and the decision it asks for, saved as its
 * next version; what it froze stays as it was taken.
 */
export const NarrativeEditor = ({
  snapshot,
  onSaved,
  onRefused,
}: {
  snapshot: Snapshot;
  onSaved: (id: Id<"snapshots">) => void;
  onRefused: (code: string) => void;
}) => {
  const [decision, setDecision] = useState(
    snapshot.record.decisionNeeded ?? ""
  );
  const [body, setBody] = useState(snapshot.body);
  const [saving, setSaving] = useState(false);
  const write = useMutation(api.snapshots.write);
  const save = async (): Promise<void> => {
    const answer = await whilePending(
      setSaving,
      async () =>
        await settle(
          async () =>
            await write({
              id: snapshot.id,
              expectedRevision: snapshot.revision,
              decisionNeeded: decision,
              narrative: body,
            })
        )
    );
    if ("error" in answer) {
      onRefused(answer.error);
      return;
    }
    onSaved(snapshot.id);
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Narrative and decision</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-2">
          <Input
            aria-label="Edit the decision needed"
            placeholder="The one decision the board needs to make"
            value={decision}
            onChange={(event) => {
              setDecision(event.target.value);
            }}
          />
          <Textarea
            aria-label="Edit the narrative"
            placeholder="Where we stand and what changed, in a few lines"
            value={body}
            onChange={(event) => {
              setBody(event.target.value);
            }}
          />
          <div>
            <Button
              variant="outline"
              disabled={saving}
              onClick={() => {
                void save();
              }}
            >
              Save
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
