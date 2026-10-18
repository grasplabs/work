import type { Id } from "@grasp-os/sdk";
import { useClient, usePaginatedQuery } from "@grasp-os/sdk/react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { useEffect, useRef, useState } from "react";

import { api } from "#grasp";

import { BoardPage } from "../components/board-page";
import { NarrativeEditor, TakeSnapshot } from "../components/controls";
import { refusal, settle, snapshotFrom } from "../components/snapshot";
import type { Outcome, Snapshot } from "../components/snapshot";
import { viewer } from "../components/viewer";
import type { Shown } from "../components/viewer";

/** Snapshots the list loads at a time. */
const listPage = 20;

/** Figures one read of a snapshot loads. */
const figuresPage = 100;

/**
 * The board page: a snapshot of the workflow map on one page, the newest
 * by default, with a way to take a new one and write its narrative. Only
 * the page itself prints: the controls around it don't.
 */
const Board = () => {
  const client = useClient();
  const listed = usePaginatedQuery(
    api.snapshots.list,
    {},
    { initialPageSize: listPage }
  );
  const [writable, setWritable] = useState(false);
  const [opened, setOpened] = useState<Snapshot | null>(null);
  const [problem, setProblem] = useState("");

  /** A snapshot and every one of its figures, read page by page. */
  const load = async (id: Id<"snapshots">): Promise<Outcome<Snapshot>> =>
    await settle(async () => {
      const stored = await client.query(api.snapshots.get, { id });
      if (stored === null) {
        throw Object.assign(new Error("There's no such snapshot."), {
          code: "board.not_found",
        });
      }
      const figures = [];
      let cursor: string | null = null;
      do {
        const page: {
          items: Awaited<
            ReturnType<typeof client.query<typeof api.snapshots.figures>>
          >["items"];
          nextCursor: string | null;
          // oxlint-disable-next-line no-await-in-loop -- each page starts after the last
        } = await client.query(api.snapshots.figures, {
          take: stored.take,
          pagination: { pageSize: figuresPage, cursor },
        });
        figures.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor !== null);
      return snapshotFrom(stored, figures);
    });

  // Which snapshot is shown, from the answers as they come (viewer.ts).
  const snapshots = useRef(viewer(load));
  const to: Shown = {
    show: (snapshot) => {
      setProblem("");
      setOpened(snapshot);
    },
    refuse: (code) => {
      setProblem(refusal(code));
    },
  };

  useEffect(() => {
    let mounted = true;
    const ask = async (): Promise<void> => {
      // Only a hint for what the page offers: the store checks every write
      // whatever this says.
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

  // The newest snapshot, once the list shows one, unless the person
  // opened one first.
  const newest = listed.items[0]?.id;
  useEffect(() => {
    if (newest !== undefined) {
      void snapshots.current.first(newest, {
        show: (snapshot) => {
          setOpened(snapshot);
        },
        refuse: (code) => {
          setProblem(refusal(code));
        },
      });
    }
  }, [newest]);

  const items = listed.items.map(({ id, title }) => ({
    value: id,
    label: title,
  }));
  const refused = (code: string): void => {
    setProblem(refusal(code));
  };

  return (
    <main className="flex flex-col gap-4 p-6 print:p-0">
      <div className="flex flex-wrap items-end justify-between gap-2 print:hidden">
        <h1 className="text-lg font-medium">Board page</h1>
        <div className="flex flex-wrap items-end gap-2">
          {items.length === 0 ? null : (
            <Select
              items={items}
              value={opened?.id ?? null}
              onValueChange={(id: Id<"snapshots"> | null) => {
                if (id !== null) {
                  void snapshots.current.open(id, to);
                }
              }}
            >
              <SelectTrigger aria-label="Snapshot">
                <SelectValue placeholder="Snapshot" />
              </SelectTrigger>
              <SelectContent>
                {items.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {writable ? (
            <TakeSnapshot
              onTaken={(id) => {
                void snapshots.current.open(id, to);
              }}
              onRefused={refused}
            />
          ) : null}
        </div>
      </div>
      {problem === "" ? null : (
        <p role="alert" className="text-destructive text-sm print:hidden">
          {problem}
        </p>
      )}
      {!listed.isLoading && listed.items.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {writable
            ? "No snapshots yet. Take the first one."
            : "No snapshots yet."}
        </p>
      ) : null}
      {opened === null ? null : (
        <>
          <p className="text-muted-foreground text-sm print:hidden">
            To print it or save it as a PDF, open this screen full page and use
            your browser&apos;s print: only the page below prints.
          </p>
          <BoardPage snapshot={opened.record} narrative={opened.body} />
          {writable ? (
            <div className="print:hidden">
              <NarrativeEditor
                key={`${opened.id}@${opened.revision}`}
                snapshot={opened}
                onSaved={(id) => {
                  void snapshots.current.saved(id, to);
                }}
                onRefused={refused}
              />
            </div>
          ) : null}
        </>
      )}
    </main>
  );
};

export default Board;
