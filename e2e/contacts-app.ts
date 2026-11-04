/**
 * A contact list, as an App's chat writes one into its draft (the fake
 * model's `buildsApp`, e2e/model-scripts.ts): spec 8's layout, a table of
 * contacts, a query that lists them and a mutation that adds one, and a
 * screen that adds a contact by name and lists them live.
 */
export const contactsApp: Record<string, string> = {
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  contacts: defineTable({ name: v.string().max(200) }),
});
`,
  "operations/contacts.ts": `import { v } from "@grasp-os/sdk";
import { mutation, query } from "#grasp/server";

export const list = query({
  args: {},
  returns: v.array(v.string().max(200)),
  handler: async (ctx) =>
    (await ctx.db.query("contacts").take(100)).map(({ name }) => name),
});

export const add = mutation({
  args: { name: v.string().min(1).max(200) },
  returns: v.id("contacts"),
  handler: async (ctx, args) => await ctx.db.insert("contacts", args),
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { add, list } from "./operations/contacts.ts";
import schema from "./schema.ts";

export default app({
  name: "Contacts",
  schema,
  access: { tables: { contacts: { read: "appMembers", write: "appMembers" } } },
  operations: { contacts: { add, list } },
  internalOperations: {},
  screens: [{ name: "contacts", path: "/", source: "screens/contacts.tsx" }],
});
`,
  "screens/contacts.tsx": `import { useMutation, useQuery } from "@grasp-os/sdk/react";
import { Button } from "@grasp-os/ui/components/button";
import { Input } from "@grasp-os/ui/components/input";
import { useState } from "react";
import { api } from "#grasp";

export default function Contacts() {
  const names = useQuery(api.contacts.list, {});
  const add = useMutation(api.contacts.add);
  const [name, setName] = useState("");
  return (
    <main className="flex flex-col gap-4 p-6">
      {/* No <form>: a screen's frame is sandboxed without forms, so
          the browser submits nothing. */}
      <div className="flex gap-2">
        <Input
          aria-label="Contact's name"
          onChange={(event) => {
            setName(event.target.value);
          }}
          value={name}
        />
        <Button
          onClick={() => {
            void add({ name });
            setName("");
          }}
        >
          Add contact
        </Button>
      </div>
      <ul aria-label="Contacts">
        {(names ?? []).map((each) => (
          <li key={each}>{each}</li>
        ))}
      </ul>
    </main>
  );
}
`,
};
