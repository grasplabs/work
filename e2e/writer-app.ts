/**
 * A Writer App whose one screen follows a streaming action (spec 10.7.6)
 * through `useStream`: a draft written a word at a time, each word a
 * whole progress snapshot, then its result; a run the person can cancel.
 */

const schema = `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  drafts: defineTable({ text: v.string().max(2000) }),
});
`;

const operations = `import { v } from "@grasp-os/sdk";
import { action } from "#grasp/server";

const pause = async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms));

export const draft = action({
  args: { topic: v.string().trim().min(1).max(200), pauseMs: v.number().integer().min(0).max(2000) },
  returns: v.object({ text: v.string() }),
  stream: v.object({ text: v.string() }),
  handler: async (ctx, args) => {
    let text = "";
    for (const word of ["A", "draft", "about", args.topic]) {
      text = text === "" ? word : text + " " + word;
      await ctx.emit({ text });
      await pause(args.pauseMs);
    }
    return { text: text + "." };
  },
});
`;

const registration = `import { app } from "@grasp-os/sdk";
import { draft } from "./operations/writer.ts";
import schema from "./schema.ts";

export default app({
  name: "Writer",
  schema,
  access: { tables: { drafts: { read: "owner", write: "owner" } } },
  operations: { writer: { draft } },
  internalOperations: {},
  screens: [{ name: "writer", path: "/", source: "screens/writer.tsx" }],
  uses: [],
});
`;

const screen = `import { useStream } from "@grasp-os/sdk/react";
import { Button } from "@grasp-os/ui/components/button";
import { useState } from "react";
import { api } from "#grasp";

export default function Writer() {
  const draft = useStream(api.writer.draft);
  const [finished, setFinished] = useState(0);
  const [refused, setRefused] = useState("");
  const write = async (pauseMs: number, options?: { signal?: AbortSignal }) => {
    try {
      await draft.run({ topic: "launch", pauseMs }, options);
      setFinished((count) => count + 1);
    } catch (error) {
      // The view shows how a run ended; what was refused before one is here.
      const code = error instanceof Error ? Reflect.get(error, "code") : undefined;
      setRefused(typeof code === "string" ? code : error instanceof Error ? error.name : "thrown");
    }
  };
  const wronglyOptioned = async () => {
    try {
      await draft.run({ topic: "launch", pauseMs: 0 }, { retries: 1 } as never);
    } catch (error) {
      setRefused(error instanceof Error ? error.name : "thrown");
    }
  };
  const busy = draft.status === "running" || draft.status === "recovering";
  return (
    <main className="flex flex-col gap-4 p-6">
      <h1 className="text-2xl font-semibold">Writer</h1>
      <div className="flex gap-2">
        <Button disabled={busy} onClick={() => void write(300)}>Write</Button>
        <Button disabled={busy} onClick={() => void write(2000)} variant="outline">Write slowly</Button>
        <Button disabled={busy} onClick={() => void write(0, { signal: AbortSignal.abort() })} variant="outline">Write, stopped already</Button>
        <Button disabled={busy} onClick={() => void wronglyOptioned()} variant="outline">Write with a wrong option</Button>
        <Button disabled={!busy} onClick={() => void draft.cancel()} variant="outline">Cancel</Button>
      </div>
      <p role="status">{draft.status}</p>
      <p aria-label="Finished">{finished}</p>
      <p aria-label="Refused">{refused}</p>
      <p aria-label="Draft">
        {draft.status === "completed"
          ? draft.output.text
          : draft.status === "idle"
            ? ""
            : (draft.progress?.text ?? "")}
      </p>
    </main>
  );
}
`;

/** The Writer App's files. */
export const writerAppFiles = (): Record<string, string> => ({
  "schema.ts": schema,
  "operations/writer.ts": operations,
  "app.ts": registration,
  "screens/writer.tsx": screen,
});
