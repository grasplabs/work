import type { Id } from "@grasp-os/sdk";
import { useClient, usePaginatedQuery, useQuery } from "@grasp-os/sdk/react";
import { Button } from "@grasp-os/ui/components/button";
import { useEffect, useRef, useState } from "react";

import { api } from "#grasp";

import { WorkflowEditor } from "../components/editor";
import { WorkflowList } from "../components/overview";
import { listedFrom, refusal, settle, workflowFrom } from "../components/store";
import type { Opened, Team } from "../components/store";

/** How many workflows the list loads at a time. */
const listPage = 10;

/**
 * What the screen shows: every workflow, a new one (the `draw`-th drawn
 * since the screen opened), or one opened.
 */
type View =
  | { kind: "list" }
  | { kind: "new"; draw: number }
  | { kind: "open"; opened: Opened };

/** The map's title, and drawing a new workflow for who may (`canDraw`). */
const MapHeader = ({
  canDraw,
  onDraw,
}: {
  canDraw: boolean;
  onDraw: () => void;
}) => (
  <div className="flex items-center justify-between gap-2">
    <h1 className="text-lg font-medium">Workflow map</h1>
    {canDraw ? <Button onClick={onDraw}>Draw a workflow</Button> : null}
  </div>
);

/** Why something failed, while `shown` and there is a reason. */
const Problem = ({ text, shown }: { text: string; shown: boolean }) =>
  shown && text !== "" ? (
    <p role="alert" className="text-destructive text-sm">
      {text}
    </p>
  ) : null;

/** What a view is of, as `selected` holds it. */
const selectionOf = (view: View): string | null => {
  switch (view.kind) {
    case "list": {
      return null;
    }
    case "new": {
      return `new:${view.draw}`;
    }
    case "open": {
      return view.opened.current.id;
    }
    default: {
      return view satisfies never;
    }
  }
};

/**
 * Every workflow by team, with its totals, kept up to date as they are
 * saved, loaded a page at a time.
 */
const Workflows = ({
  teams,
  writable,
  onOpen,
}: {
  teams: Team[];
  writable: boolean;
  onOpen: (id: Id<"workflows">) => void;
}) => {
  const { items, hasMore, isLoading, loadMore } = usePaginatedQuery(
    api.map.list,
    {},
    { initialPageSize: listPage }
  );
  return (
    <div className="flex flex-col gap-4">
      {isLoading && items.length === 0 ? (
        <p className="text-muted-foreground text-sm">Loading workflows…</p>
      ) : (
        <WorkflowList
          workflows={items.map(listedFrom)}
          teams={teams}
          writable={writable}
          onOpen={onOpen}
        />
      )}
      {hasMore ? (
        <Button
          variant="outline"
          disabled={isLoading}
          onClick={() => {
            loadMore();
          }}
        >
          More workflows
        </Button>
      ) : null}
    </div>
  );
};

/**
 * The workflow map: its workflows by team, with their totals, and an
 * editor for each, drawn and designed side by side.
 */
const WorkflowMap = () => {
  const client = useClient();
  const listedTeams = useQuery(api.teams.list, {});
  const [writable, setWritable] = useState(false);
  const [view, setView] = useState<View>({ kind: "list" });
  // Why an opening failed, cleared when the next one succeeds.
  const [openProblem, setOpenProblem] = useState("");
  // What the person asked for last (a workflow's ID, a new drawing, or
  // the list, null), and each opening asked for, numbered: an answer to
  // any but the latest, arriving late, is dropped, as it would show what
  // they moved away from, or an older version.
  const selected = useRef<string | null>(null);
  const openings = useRef(0);
  const draws = useRef(0);

  useEffect(() => {
    let mounted = true;
    const ask = async (): Promise<void> => {
      // Only a hint for what the screen offers: the store checks every
      // write whatever this says.
      const answer = await settle(
        async () => await client.action(api.access.writable, {})
      );
      if (mounted) {
        setWritable("ok" in answer && answer.ok);
      }
    };
    void ask();
    return () => {
      mounted = false;
    };
  }, [client]);

  // Asks for what the person chose, and forgets any opening on its way
  // (and why the last one failed).
  const choose = (next: View): void => {
    selected.current = selectionOf(next);
    openings.current += 1;
    setOpenProblem("");
    setView(next);
  };

  const open = async (id: Id<"workflows">): Promise<void> => {
    selected.current = id;
    openings.current += 1;
    const asked = openings.current;
    const answer = await settle(
      async () => await client.query(api.map.open, { id })
    );
    if (asked !== openings.current) {
      return;
    }
    if ("error" in answer) {
      setOpenProblem(refusal(answer.error));
      return;
    }
    if (answer.ok === null) {
      setOpenProblem(refusal("map.not_found"));
      return;
    }
    const { current, drawn } = answer.ok;
    setOpenProblem("");
    setView({
      kind: "open",
      opened: {
        current: workflowFrom(current._id, current),
        drawn: drawn === null ? null : workflowFrom(current._id, drawn),
      },
    });
  };

  // After a save from `from`: what was saved opened, only while the
  // person is still on what they saved. The list and the teams follow on
  // their own.
  const saved = async (from: View, id: Id<"workflows">): Promise<void> => {
    if (selected.current === selectionOf(from)) {
      await open(id);
    }
  };

  const teams: Team[] = (listedTeams ?? []).map(({ _id, title }) => ({
    id: _id,
    title,
  }));

  return (
    <main className="flex flex-col gap-4 p-6">
      <MapHeader
        canDraw={view.kind === "list" && writable}
        onDraw={() => {
          draws.current += 1;
          choose({ kind: "new", draw: draws.current });
        }}
      />
      <Problem text={openProblem} shown />
      {view.kind === "list" ? (
        <Workflows
          teams={teams}
          writable={writable}
          onOpen={(id) => {
            void open(id);
          }}
        />
      ) : (
        <WorkflowEditor
          key={
            view.kind === "new"
              ? `new:${view.draw}`
              : `${view.opened.current.id}@${view.opened.current.revision}`
          }
          opened={view.kind === "new" ? null : view.opened}
          teams={teams}
          writable={writable}
          onSaved={async (id) => {
            await saved(view, id);
          }}
          onBack={() => {
            choose({ kind: "list" });
          }}
        />
      )}
    </main>
  );
};

export default WorkflowMap;
