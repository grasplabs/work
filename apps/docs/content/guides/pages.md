---
title: Pages
description: React components people open in Grasp, which read and write through the App's server functions and stay up to date.
sidebar:
  order: 4
---

A Page is what people see of your App: a route of its own small React app, which Grasp runs inside the product. A Page reads and writes only through your App's server functions: it has no network of its own and no access to anything else.

## Routes are files

Each Page is a [TanStack Router](https://tanstack.com/router) file route in `src/routes/`. Its file name is its address, and it exports its `Route`:

```text
src/routes/__root.tsx         The layout around every Page (optional)
src/routes/index.tsx          /
src/routes/tasks.$taskId.tsx  /tasks/$taskId, with the task's ID as a parameter
```

Grasp generates the route tree from these files, as TanStack does in any project, so a route's parameters are typed. The App's own components go in `src/components/`, and the rest of its code in `src/lib/`.

## Reading data

`useQuery` subscribes to a query. It returns `undefined` while the query loads, then the query's result, and renders again whenever that result changes: nobody refreshes a Page in Grasp.

```tsx src/routes/tasks.$taskId.tsx
import { useMutation, useQuery } from "@grasp-os/sdk/react";
import { Button } from "@grasp-os/ui/components/button";
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderContent,
  PageHeaderTitle,
} from "@grasp-os/ui/components/page-header";
import { Skeleton } from "@grasp-os/ui/components/skeleton";
import { api } from "@server/_generated/api";
import type { Id } from "@server/_generated/dataModel";
import { createFileRoute } from "@tanstack/react-router";

const Task = () => {
  const { taskId } = Route.useParams();
  const task = useQuery(api.details.get, { id: taskId });
  const complete = useMutation(api.tasks.complete);
  if (task === undefined) {
    return <Skeleton className="m-6 h-9 w-64" />;
  }
  if (task === null) {
    return <p className="p-6">This task is gone.</p>;
  }
  return (
    <main className="p-6">
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>{task.title}</PageHeaderTitle>
        </PageHeaderContent>
        <PageHeaderActions>
          <Button
            disabled={task.done}
            onClick={async () =>
              await complete({ id: task._id, expectedRevision: task._rev })
            }
          >
            Complete
          </Button>
        </PageHeaderActions>
      </PageHeader>
    </main>
  );
};

export const Route = createFileRoute("/tasks/$taskId")({
  // A task's ID, read from the address as text: the server checks it is
  // a task's, and one the person may read, on every call.
  params: { parse: ({ taskId }) => ({ taskId: taskId as Id<"tasks"> }) },
  component: Task,
});
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

Pages link to each other with TanStack's `Link`, and move in code with its `useNavigate`, typed by the routes the App has:

```tsx src/routes/index.tsx
import { useQuery } from "@grasp-os/sdk/react";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { api } from "@server/_generated/api";
import { createFileRoute, Link } from "@tanstack/react-router";

const Tasks = () => {
  const tasks = useQuery(api.tasks.list, { done: false });
  if (tasks === undefined) {
    return <Spinner className="m-6" />;
  }
  return (
    <main className="flex flex-col gap-2 p-6">
      {tasks.map((task) => (
        <Link key={task._id} params={{ taskId: task._id }} to="/tasks/$taskId">
          {task.title}
        </Link>
      ))}
    </main>
  );
};

export const Route = createFileRoute("/")({ component: Tasks });
```

Where the App is shows in Grasp's address, so Back, Forward, a reload and a shared link all land on the same Page. Only a person's own click or key adds to their history: a Page that moves on its own takes the place of the one it was on.

Anyone the App is shared with can open any of its routes from a link, with any parameters. So a Page changes nothing as it loads, in its component, an effect or a loader: it writes, sends or starts something only when the person acts on it. Who may do what is decided in your server functions, on every call.

## Where Grasp shows a Page

A Page without parameters can also show elsewhere in Grasp: as an entry in the sidebar, in the side panel beside a chat, or as the App's own settings. Its file says so:

```tsx src/routes/settings.tsx
import { createFileRoute } from "@tanstack/react-router";

export const surface = { kind: "settings", title: "Options" };

const Settings = () => <main className="p-6">Options</main>;

export const Route = createFileRoute("/settings")({ component: Settings });
```

`kind` is `sidebar`, `panel` or `settings`, and both values are written out: Grasp reads them without running your code.

## Who is using it

`useUser` returns who is using the Page: their name, email and roles in the App. Use it to show things, never to decide what someone may do: that belongs in a server function, with `ctx.auth.getUser()`, which a Page can't change.

## npm packages

A Page can use any npm package the App's builder approved. Ask for it with `env.build.resolveDependencies(app, { purpose, dependencies: [{ name: "recharts", range: "^2.15.0" }] })`: the builder approves it on a card in the chat, and from your next write on you import it by name, as anywhere else.

```text
import { LineChart, Line } from "recharts";
```

It is bundled into the App's build and runs on the kit's React. An import of a package that isn't approved is refused when the Page compiles, saying to ask for it. A package reported as malware is refused, and one revoked later stops the App's Pages and server functions until it is removed.

## How Pages look

Pages are built from `@grasp-os/ui`, the same components and theme as Grasp itself: buttons, forms, tables, cards, charts and more, each under `@grasp-os/ui/components/<name>`. Lay them out with Tailwind's layout classes and leave their look to the components; Grasp's checks refuse raw colours and restyled components, so every App looks like Grasp.
