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
import { Button } from "@grasp-os/app-kit/components/button";
import { Skeleton } from "@grasp-os/app-kit/components/skeleton";
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
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">{task.title}</h1>
        <Button
          disabled={task.done}
          onClick={async () => await complete({ id: task._id })}
        >
          Complete
        </Button>
      </header>
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
import { Spinner } from "@grasp-os/app-kit/components/spinner";
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

A Page without parameters can also show elsewhere in Grasp: as an entry in the sidebar, or as the App's own settings. Its file says so:

```tsx src/routes/settings.tsx
import { createFileRoute } from "@tanstack/react-router";

export const surface = { kind: "settings", title: "Options" };

const Settings = () => <main className="p-6">Options</main>;

export const Route = createFileRoute("/settings")({ component: Settings });
```

`kind` is `sidebar` or `settings`, and both values are written out: Grasp reads them without running your code.

## Who is using it

`useUser` returns who is using the Page: their name, email and roles in the App. Use it to show things, never to decide what someone may do: that belongs in a server function, with `ctx.auth.getUser()`, which a Page can't change.

## npm packages

A Page can use any npm package the App's builder approved. Ask for it with `env.build.resolveDependencies(app, { purpose, dependencies: [{ name: "date-fns", range: "^4.1.0" }] })`: the builder approves it on a card in the chat, and from your next write on you import it by name, as anywhere else. Packages add up: what is approved stays until you take it out with `remove`, which the builder approves the same way.

```text
import { formatDistanceToNow } from "date-fns";
```

It is bundled into the App's build and runs on the kit's React. An import of a package that isn't approved is refused when the Page compiles, saying to ask for it. A package reported as malware is refused, and one revoked later stops the App's Pages and server functions until it is removed.

## How Pages look

Pages are built from `@grasp-os/app-kit`: every component of the registry's default style (`base-nova`), as its CLI installs them, in their neutral theme, light and dark, set in Geist. Buttons, inputs, selects, tables, cards, tabs, dialogs, toasts, charts, messages and more, each under `@grasp-os/app-kit/components/<name>`, with their own variants, sizes and props, so the registry's docs and examples hold as written. Charts import recharts' parts from `recharts`, which the kit provides, and colour their series through the chart's config (`color: "var(--chart-1)"`, then `fill="var(--color-<key>)"`). A Page's frame submits no form and has no clipboard, so the questionnaire's last step calls its `onSubmit` with the answers (`new FormData(event.currentTarget)`) without a submission, and the code block's copy button does nothing. Beside the components are the two parts bound to the SDK, drawn with the registry's components: `DataTable` (`@grasp-os/app-kit/components/data-table`), a list of records over a paginated query, searched, sorted and filtered by the query itself, with each cell shown and edited as the query's `returns` declares it; and the form and its fields (`@grasp-os/app-kit/form`), each a registry field on a value `useForm` holds. And `Markdown` (`@grasp-os/app-kit/components/markdown`), the registry's own for a model's answer, below.

There are no layout components: lay a Page out with Tailwind's layout classes on plain elements (`flex`, `grid`, `gap-4`, `p-6`), and give it its title as a heading (`<h1 className="text-2xl font-semibold tracking-tight">`). Leave the components' look to them: where a Page calls a kit component it gives it layout classes alone (margin, size, position, flex and grid placement, text alignment), never a class of look, even where the registry's docs show one. `<TableCell className="font-medium">` is refused; put the look on a plain element inside it (`<TableCell><span className="font-medium">`). Grasp's checks refuse raw colours, arbitrary values and restyled components, and name the variant or theme colour to use instead.

## A model's answer

An App that answers with a model asks it in an action, with `ctx.ai.generate`, and shows the conversation as the registry's examples do: each turn a `Message`, the person's words in a `Bubble`, and the answer as `Markdown` in a `ghost` bubble, which draws headings, lists, tables, links and fenced code (through the code block) from the model's text.

```ts grasp.config.ts
import { defineApp, permission } from "@grasp-os/sdk";

export default defineApp({
  name: "Tasks",
  permissions: { ai: permission.ai({ maxOutputTokens: 2000 }) },
});
```

```ts server/assistant.ts
import { v } from "@grasp-os/sdk";
import { action } from "@server/_generated/server";

export const ask = action({
  args: { question: v.string().trim().min(1).max(2000) },
  returns: v.string(),
  handler: async (ctx, args) =>
    await ctx.ai.generate({ prompt: args.question }),
});
```

```tsx src/routes/ask.tsx
import { useAction } from "@grasp-os/sdk/react";
import { Bubble, BubbleContent } from "@grasp-os/app-kit/components/bubble";
import { Button } from "@grasp-os/app-kit/components/button";
import { Markdown } from "@grasp-os/app-kit/components/markdown";
import { Message, MessageContent } from "@grasp-os/app-kit/components/message";
import { Textarea } from "@grasp-os/app-kit/components/textarea";
import { api } from "@server/_generated/api";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

const Ask = () => {
  const ask = useAction(api.assistant.ask);
  const [question, setQuestion] = useState("");
  const [turn, setTurn] = useState<{ question: string; answer: string }>();
  return (
    <main className="flex flex-col gap-6 p-6">
      {turn !== undefined && (
        <>
          <Message align="end">
            <MessageContent>
              <Bubble>
                <BubbleContent>{turn.question}</BubbleContent>
              </Bubble>
            </MessageContent>
          </Message>
          <Message>
            <MessageContent>
              <Bubble variant="ghost">
                <BubbleContent>
                  <Markdown>{turn.answer}</Markdown>
                </BubbleContent>
              </Bubble>
            </MessageContent>
          </Message>
        </>
      )}
      <Textarea
        aria-label="Question"
        value={question}
        onChange={(event) => setQuestion(event.target.value)}
      />
      <Button
        className="self-end"
        disabled={question.trim() === ""}
        onClick={async () =>
          setTurn({ question, answer: await ask({ question }) })
        }
      >
        Ask
      </Button>
    </main>
  );
};

export const Route = createFileRoute("/ask")({ component: Ask });
```

Text that is still growing shows as it grows, as the registry's streaming example does: pass `isAnimating` while it does (`<Markdown isAnimating={growing}>{text}</Markdown>`). Half-written Markdown (bold, a link, a table or a code fence not closed yet) shows as it will end, and the code block's copy button waits for the fence to close. The text is the model's, so it is shown as Markdown alone: HTML in it shows as text, a link as its words with its address beside them (a Page opens no link by itself), and an image from another server is never loaded. Very large or pathological text shows as plain text: more than 60,000 characters, more than 3,000 emphasis, code or bracket marks (`*`, `_`, `~`, `` ` ``, `[`), or nesting deeper than 20 levels. Code very dense in such marks can reach that too, and then shows as plain text. A Page can't turn that off: `Markdown` refuses Streamdown's props that would change it (its plugins, URL transform and allowed tags), and its own link wins over a Page's `components`, which otherwise restyle the elements. Like every kit component, `Markdown` takes layout classes alone.
