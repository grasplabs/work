---
title: Pages
description: React components people open in Grasp, which read and write through the App's server functions and stay up to date.
sidebar:
  order: 4
---

A Page is what people see of your App: a React component in `screens/`, which Grasp renders inside the product. A Page reads and writes only through your App's server functions: it has no network of its own and no access to anything else.

## Declaring a Page

Each Page is a file that exports its component as the default, listed in `app.ts` under `screens` with a name and a route:

```ts app.ts
import { app, v } from "@grasp-os/sdk";

import schema from "./schema.ts";

export default app({
  name: "Tasks",
  schema,
  access: {
    tables: { tasks: { read: "appMembers", write: "appMembers" } },
  },
  screens: [
    { name: "tasks", path: "/", source: "screens/tasks.tsx" },
    {
      name: "task",
      path: "/tasks/:id",
      source: "screens/task.tsx",
      input: v.object({ id: v.id("tasks") }),
    },
  ],
});
```

A route's parameters are the Page's `input`, typed by its schema.

## Reading data

`useQuery` subscribes to a query. It returns `undefined` while the query loads, then the query's result, and renders again whenever that result changes: nobody refreshes a Page in Grasp.

```tsx screens/task.tsx
import { useMutation, useQuery } from "@grasp-os/sdk/react";
import type { ScreenProps } from "@grasp-os/sdk/react";
import { Button } from "@grasp-os/ui/components/button";
import { api } from "@server/_generated/api";
import type { screens } from "@server/_generated/api";

const Task = ({ input }: ScreenProps<typeof screens.task>) => {
  const task = useQuery(api.details.get, { id: input.id });
  const complete = useMutation(api.tasks.complete);
  if (task === undefined) {
    return <output>Loading…</output>;
  }
  if (task === null) {
    return <p>This task is gone.</p>;
  }
  return (
    <main className="flex flex-col gap-3 p-6">
      <h1>{task.title}</h1>
      <Button
        disabled={task.done}
        onClick={async () =>
          await complete({ id: task._id, expectedRevision: task._rev })
        }
      >
        Complete
      </Button>
    </main>
  );
};

export default Task;
```

```ts server/details.ts
import { v } from "@grasp-os/sdk";
import { doc, query } from "@server/_generated/server";

export const get = query({
  args: { id: v.id("tasks") },
  returns: doc("tasks").nullable(),
  handler: async (ctx, args) => await ctx.db.get("tasks", args.id),
});
```

Pass `"skip"` instead of the arguments to read nothing yet. A query that fails throws to the Page's error boundary.

## Writing data

`useMutation` and `useAction` return a function that calls the mutation or action and resolves with what it returned, once Grasp has committed it. Every Page that reads the data it changed updates on its own.

## Moving between Pages

`useNavigate` opens another of the App's Pages, by its name in `screens` and with its input:

```tsx screens/tasks.tsx
import { useNavigate, useQuery } from "@grasp-os/sdk/react";
import { Button } from "@grasp-os/ui/components/button";
import { api, screens } from "@server/_generated/api";

const Tasks = () => {
  const tasks = useQuery(api.tasks.list, { done: false });
  const navigate = useNavigate();
  if (tasks === undefined) {
    return <output>Loading tasks…</output>;
  }
  return (
    <main className="flex flex-col gap-2 p-6">
      {tasks.map((task) => (
        <Button
          key={task._id}
          variant="ghost"
          onClick={async () => await navigate(screens.task, { id: task._id })}
        >
          {task.title}
        </Button>
      ))}
    </main>
  );
};

export default Tasks;
```

## Who is using it

`useUser` returns who is using the Page: their name, email and roles in the App. Use it to show things, never to decide what someone may do: that belongs in a server function, with `ctx.auth.getUser()`, which a Page can't change.

## How Pages look

Pages are built from `@grasp-os/ui`, the same components and theme as Grasp itself: buttons, forms, tables, cards, charts and more, each under `@grasp-os/ui/components/<name>`. Lay them out with Tailwind's layout classes and leave their look to the components; Grasp's checks refuse raw colours and restyled components, so every App looks like Grasp.
