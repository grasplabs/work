import type { Id } from "@grasp-os/sdk";
import {
  useClient,
  useMutation,
  useQuery,
  useWorkflow,
} from "@grasp-os/sdk/react";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { useEffect, useRef, useState } from "react";

import { api, workflows } from "#grasp";

import { DraftEditor } from "../components/draft-editor";
import type { EditorResult } from "../components/draft-editor";
import { Extractions } from "../components/extractions";
import type { Found, Reading } from "../components/extractions";
import {
  mediumLabels,
  originLabels,
  refusal,
  settle,
} from "../components/intake";
import type { DraftSource, GuestChat, OpenedDraft } from "../components/intake";
import { NotesForm } from "../components/notes-form";
import type { NotesInput } from "../components/notes-form";
import { Stakeholders } from "../components/stakeholders";

/**
 * What the screen shows: the drafts, a new source typed in (the
 * `count`-th since the screen opened), notes to read, or a draft opened
 * for review.
 */
type View =
  | { kind: "list" }
  | { kind: "new"; count: number }
  | { kind: "notes" }
  | { kind: "open"; opened: OpenedDraft; problem: string };

/** Why something failed, when there is a reason. */
const Problem = ({ text }: { text: string }) =>
  text === "" ? null : (
    <p role="alert" className="text-destructive text-sm">
      {text}
    </p>
  );

/** The screen's title, and what someone who takes intake starts from it. */
const IntakeHeader = ({
  canStart,
  onNotes,
  onNew,
}: {
  canStart: boolean;
  onNotes: () => void;
  onNew: () => void;
}) => (
  <div className="flex items-center justify-between gap-2">
    <h1 className="text-lg font-medium">Intake</h1>
    {canStart ? (
      <div className="flex gap-2">
        <Button onClick={onNotes}>Read notes</Button>
        <Button variant="outline" onClick={onNew}>
          New source
        </Button>
      </div>
    ) : null}
  </div>
);

/** What the intake shows the person (operations/chats.ts `overview`). */
interface Overview {
  /** Whether they may review drafts: intake is the App's builders'. */
  writable: boolean;
  /** Stakeholder chats; null while the App can't invite anyone. */
  chats: GuestChat[] | null;
}

/** Why intake shows nothing, when it isn't the person's to take. */
const AccessNote = ({ overview }: { overview: Overview | null }) =>
  overview?.writable === false ? (
    <p className="text-muted-foreground text-sm">
      Only the App&apos;s builders take intake.
    </p>
  ) : null;

/**
 * The drafts waiting for review, newest first, kept up to date as they
 * are kept, saved or discarded. Mounted only for someone who may review
 * them: the store refuses anyone else, which a query throws.
 */
const DraftList = ({ onOpen }: { onOpen: (id: Id<"drafts">) => void }) => {
  const drafts = useQuery(api.drafts.list, {});
  if (drafts === undefined) {
    return <p className="text-muted-foreground text-sm">Loading drafts…</p>;
  }
  return drafts.length === 0 ? (
    <p className="text-muted-foreground text-sm">No drafts wait for review.</p>
  ) : (
    <Table aria-label="Drafts">
      <TableHeader>
        <TableRow>
          <TableHead>Source</TableHead>
          <TableHead>Taken from</TableHead>
          <TableHead>Date</TableHead>
          <TableHead>Statements</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {drafts.map((draft) => (
          <TableRow key={draft.id}>
            <TableCell>{draft.title}</TableCell>
            <TableCell>{originLabels[draft.origin]}</TableCell>
            <TableCell>{draft.date}</TableCell>
            <TableCell>{draft.statements}</TableCell>
            <TableCell>
              <Button
                variant="outline"
                aria-label={`Review ${draft.title}`}
                onClick={() => {
                  onOpen(draft.id);
                }}
              >
                Review
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};

/**
 * The sources saved most recently, newest first, kept up to date as more
 * are saved. Mounted only for someone who may review drafts, as the list.
 */
const SavedList = () => {
  const saved = useQuery(api.drafts.saved, {});
  if (saved === undefined || saved.length === 0) {
    return null;
  }
  return (
    <Table aria-label="Saved sources">
      <TableHeader>
        <TableRow>
          <TableHead>Saved source</TableHead>
          <TableHead>Medium</TableHead>
          <TableHead>Date</TableHead>
          <TableHead>From</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {saved.map((source) => (
          <TableRow key={source.id}>
            <TableCell>
              {source.title}
              {source.guest ? (
                <Badge variant="secondary" className="ml-2">
                  stakeholder&apos;s words
                </Badge>
              ) : null}
            </TableCell>
            <TableCell>{mediumLabels[source.medium]}</TableCell>
            <TableCell>{source.date}</TableCell>
            <TableCell>{source.from}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};

/**
 * Intake: sources and the statements taken from them, reviewed and edited
 * as drafts before they are saved, in the App's own store.
 */
const Intake = () => {
  const client = useClient();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [view, setView] = useState<View>({ kind: "list" });
  const [problem, setProblem] = useState("");
  const [notice, setNotice] = useState("");
  // Each overview and opening asked for, numbered: an answer to any but
  // the latest, arriving late, is dropped, as it would show what the
  // person moved away from.
  const listings = useRef(0);
  const openings = useRef(0);
  const counts = useRef(0);
  const extract = useWorkflow(workflows.extract);
  const propose = useMutation(api.drafts.propose);
  // The notes this screen sent to be read, newest first, each with the
  // source it keeps them under once its run found their statements.
  const [reading, setReading] = useState<Reading[]>([]);
  // The readings being kept as drafts now: a second Review of one before
  // its first lands keeps no second draft.
  const reviewing = useRef(new Set<string>());

  const list = async (): Promise<void> => {
    listings.current += 1;
    const asked = listings.current;
    const answer = await settle(
      async () => await client.action(api.chats.overview, {})
    );
    if (asked !== listings.current) {
      return;
    }
    if ("error" in answer) {
      setProblem(refusal(answer.error));
      return;
    }
    setProblem("");
    setOverview(answer.ok);
  };

  useEffect(() => {
    let mounted = true;
    const first = async (): Promise<void> => {
      listings.current += 1;
      const asked = listings.current;
      const answer = await settle(
        async () => await client.action(api.chats.overview, {})
      );
      if (!mounted || asked !== listings.current) {
        return;
      }
      if ("error" in answer) {
        setProblem(refusal(answer.error));
        return;
      }
      setOverview(answer.ok);
    };
    void first();
    return () => {
      mounted = false;
    };
  }, [client]);

  const showList = (): void => {
    openings.current += 1;
    setView({ kind: "list" });
  };

  const open = async (id: Id<"drafts">): Promise<void> => {
    openings.current += 1;
    const asked = openings.current;
    setNotice("");
    const answer = await settle(
      async () => await client.query(api.drafts.get, { id })
    );
    if (asked !== openings.current) {
      return;
    }
    if ("error" in answer) {
      setProblem(refusal(answer.error));
      return;
    }
    if (answer.ok === null) {
      setProblem(refusal("intake.not_found"));
      return;
    }
    const { _id, _rev, origin, source, statements } = answer.ok;
    setProblem("");
    setView({
      kind: "open",
      opened: {
        id: _id,
        revision: _rev,
        origin,
        draft: { source, statements },
      },
      problem: "",
    });
  };

  /**
   * Starts reading notes, or a stakeholder's chat, called `title` while
   * it is read, and says why it didn't start, if it didn't. A chat is read
   * as notes by the App's own action first (`chats.notes`): the workflow
   * only reads what it is given.
   */
  const startReading = async (
    input: NotesInput | { chat: string },
    title: string
  ): Promise<string | undefined> => {
    let source: DraftSource;
    let lines: { role: "guest" | "question"; text: string }[] = [];
    let guest = false;
    if ("chat" in input) {
      const read = await settle(
        async () => await client.action(api.chats.notes, { chat: input.chat })
      );
      if ("error" in read) {
        return refusal(read.error);
      }
      source = { ...read.ok.source, notes: read.ok.notes };
      ({ lines } = read.ok);
      guest = true;
    } else {
      source = { ...input.source, notes: input.notes };
    }
    const started = await settle(
      async () => await extract.run({ notes: source.notes, lines })
    );
    if ("error" in started) {
      return refusal(started.error);
    }
    const { runId } = started.ok;
    setReading((runs) => [{ id: runId, title, source, guest }, ...runs]);
    showList();
    return undefined;
  };

  /**
   * Keeps what a finished reading found as a draft, as its source's (a
   * chat's marked a guest's), and opens it for review.
   */
  const review = async (read: Reading, found: Found): Promise<void> => {
    if (reviewing.current.has(read.id)) {
      return;
    }
    reviewing.current.add(read.id);
    const kept = await settle(
      async () =>
        await propose({
          source: read.source,
          statements: found.statements,
          guest: read.guest,
        })
    );
    if ("error" in kept) {
      reviewing.current.delete(read.id);
      setProblem(refusal(kept.error));
      return;
    }
    // Kept: the reading goes, and stays marked, so it is never kept again.
    setReading((runs) => runs.filter(({ id }) => id !== read.id));
    await open(kept.ok);
  };

  const onResult = (result: EditorResult): void => {
    switch (result.kind) {
      case "kept": {
        openings.current += 1;
        setView({
          kind: "open",
          opened: result.opened,
          problem: result.problem ?? "",
        });
        return;
      }
      case "saved": {
        const { statements } = result.saved;
        setNotice(
          `Saved: ${statements} ${statements === 1 ? "statement" : "statements"} and their source.`
        );
        showList();
        return;
      }
      case "discarded": {
        setNotice("Discarded.");
        showList();
        return;
      }
      default: {
        result satisfies never;
      }
    }
  };

  const writable = overview?.writable === true;
  // Stakeholder chats, while the App may invite: null otherwise.
  const chats = overview?.chats ?? null;
  // The lists, for someone who takes intake, while nothing is open.
  const listing = view.kind === "list" && writable;
  return (
    <main className="flex flex-col gap-4 p-6">
      <IntakeHeader
        canStart={listing}
        onNotes={() => {
          openings.current += 1;
          setNotice("");
          setView({ kind: "notes" });
        }}
        onNew={() => {
          counts.current += 1;
          openings.current += 1;
          setNotice("");
          setView({ kind: "new", count: counts.current });
        }}
      />
      <Problem text={problem} />
      {notice === "" ? null : <output className="text-sm">{notice}</output>}
      <AccessNote overview={overview} />
      {listing ? (
        <Extractions
          started={reading}
          onReview={(read, found) => {
            void review(read, found);
          }}
          onDismiss={(run) => {
            setReading((runs) => runs.filter(({ id }) => id !== run));
          }}
        />
      ) : null}
      {listing && chats !== null ? (
        <Stakeholders
          chats={chats}
          onChanged={list}
          onRead={(chat) => {
            void (async () => {
              const why = await startReading(
                { chat: chat.id },
                `Chat with ${chat.name}`
              );
              setProblem(why ?? "");
            })();
          }}
        />
      ) : null}
      {listing ? (
        <DraftList
          onOpen={(id) => {
            void open(id);
          }}
        />
      ) : null}
      {listing ? <SavedList /> : null}
      {view.kind === "notes" ? (
        <NotesForm
          onStart={async (input) =>
            await startReading(input, input.source.title)
          }
          onBack={showList}
        />
      ) : null}
      {view.kind === "new" || view.kind === "open" ? (
        <DraftEditor
          key={
            view.kind === "new"
              ? `new:${view.count}`
              : `${view.opened.id}@${view.opened.revision}`
          }
          opened={view.kind === "new" ? null : view.opened}
          problem={view.kind === "new" ? "" : view.problem}
          onResult={onResult}
          onBack={showList}
        />
      ) : null}
    </main>
  );
};

export default Intake;
