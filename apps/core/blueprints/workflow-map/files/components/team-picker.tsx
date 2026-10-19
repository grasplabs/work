import type { Id } from "@grasp-os/sdk";
import { useMutation } from "@grasp-os/sdk/react";
import { Button } from "@grasp-os/ui/components/button";
import { Input } from "@grasp-os/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { useRef, useState } from "react";

import { api } from "#grasp";

import { whilePending } from "./pending";
import { settle } from "./store";
import type { Team } from "./store";
import { shortTextMax } from "./totals";

/** A workflow's team, picked from the map's teams, or a new one. */
export const TeamPicker = ({
  teams,
  team,
  onChange,
  onRefused,
}: {
  teams: Team[];
  team: Id<"teams"> | null;
  onChange: (team: Id<"teams"> | null) => void;
  onRefused: (code: string) => void;
}) => {
  const [added, setAdded] = useState<Team[]>([]);
  const [name, setName] = useState("");
  // While a team is being added: its button is off, and a second click
  // that lands before it is (a double click) adds nothing more.
  const [adding, setAdding] = useState(false);
  const addTeam = useMutation(api.teams.add);
  const addingNow = useRef(false);
  const pending = (on: boolean): void => {
    addingNow.current = on;
    setAdding(on);
  };
  const items = [
    { value: null, label: "No team" },
    // A team added here, until the live list has it too.
    ...[
      ...teams,
      ...added.filter(({ id }) => !teams.some((known) => known.id === id)),
    ].map(({ id, title }) => ({
      value: id,
      label: title,
    })),
  ];
  const add = async (): Promise<void> => {
    if (addingNow.current) {
      return;
    }
    const answer = await whilePending(
      pending,
      async () =>
        await settle(async () => await addTeam({ title: name.trim() }))
    );
    if ("error" in answer) {
      onRefused(answer.error);
      return;
    }
    setAdded([...added, { id: answer.ok, title: name.trim() }]);
    setName("");
    onChange(answer.ok);
  };
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Select
        items={items}
        value={team}
        onValueChange={(value: Id<"teams"> | null) => {
          onChange(value);
        }}
      >
        <SelectTrigger aria-label="Team">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value ?? ""} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        aria-label="New team"
        placeholder="New team"
        maxLength={shortTextMax}
        value={name}
        onChange={(event) => {
          setName(event.target.value);
        }}
      />
      <Button
        variant="outline"
        disabled={adding || name.trim() === ""}
        onClick={() => {
          void add();
        }}
      >
        Add team
      </Button>
    </div>
  );
};
