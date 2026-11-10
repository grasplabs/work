import type { FunctionReference, ValueSchema } from "@grasp-os/runtime/app";
import { GraspClient } from "@grasp-os/runtime/page";
import { GraspProvider } from "@grasp-os/runtime/react";
import { isRecord } from "@grasp-os/shared/json";
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach } from "vite-plus/test";

// What an App page's kit parts (the data grid, the form fields) are
// tested against: a real session client, as the platform mounts one, over
// a host that answers each query and mutation as the test says. The host
// is the outside system here; the client, the hooks and the kit are the
// real ones.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** A page a paginated list's query asks for (`paginationOptionsValidator`). */
export interface PageAsked {
  readonly pageSize: number;
  readonly cursor: string | null;
  /** Where the page ends, once a page follows it. */
  readonly endCursor?: string;
}

/** One query read or call the client sent the host. */
export interface Sent {
  readonly contractId: string;
  /** Its arguments, without `pagination`. */
  readonly input: Readonly<Record<string, unknown>>;
  /** The page a paginated list's read asks for, if it is one. */
  readonly pagination: PageAsked | undefined;
}

/** What the host answers: a value, or a failure the App's code raised. */
export type Answer =
  | { readonly value: unknown }
  | { readonly failed: string; readonly message: string }
  /** No answer yet: a read never pushed, a call never settled. */
  | "pending";

/** The transport a session client over a frame takes. */
type Transport = Extract<
  ConstructorParameters<typeof GraspClient>[0],
  { readonly watch: unknown }
>;

/** The field `key` of `value`, if it is a record. */
const read = (value: unknown, key: string): unknown =>
  isRecord(value) ? value[key] : undefined;

/** The page `pagination` asks for, if it is one. */
const pageAskedOf = (pagination: unknown): PageAsked | undefined => {
  const pageSize = read(pagination, "pageSize");
  const cursor = read(pagination, "cursor");
  const endCursor = read(pagination, "endCursor");
  if (typeof pageSize !== "number") {
    return undefined;
  }
  return {
    pageSize,
    cursor: typeof cursor === "string" ? cursor : null,
    ...(typeof endCursor === "string" ? { endCursor } : {}),
  };
};

/** What `body` asks for: its function, input and page. */
const sentOf = (body: string): Sent => {
  const parsed: unknown = JSON.parse(body);
  const contractId = read(read(parsed, "reference"), "name");
  const sentInput = read(parsed, "args");
  const { pagination, ...input } = isRecord(sentInput) ? sentInput : {};
  return {
    contractId: typeof contractId === "string" ? contractId : "",
    input,
    pagination: pageAskedOf(pagination),
  };
};

/** The result core sends for `answer`. */
const resultOf = (answer: Exclude<Answer, "pending">) =>
  "value" in answer
    ? { ok: true, value: answer.value }
    : {
        ok: false,
        error: {
          code: answer.failed,
          message: answer.message,
          category: "domain",
          retryable: false,
          requestId: "r",
        },
      };

/** The ID core gives every file uploaded here. */
export const uploadedFileId = "01890000-0000-7000-8000-0000000000f1";

/**
 * A session client whose host answers each read and call with `answer`,
 * and every read and call it was sent, in order.
 */
export const testHost = (
  answer: (sent: Sent) => Answer,
  { holdUploads = false }: { readonly holdUploads?: boolean } = {}
) => {
  const reads: Sent[] = [];
  const calls: Sent[] = [];
  /** Each file uploaded: through which resource, and its name. */
  const uploads: { resource: string; name: string }[] = [];
  /** Each link opened: through which resource, and its address. */
  const links: { resource: string; url: string }[] = [];
  const transport: Transport = {
    call: async (body) => {
      const sent = sentOf(body);
      calls.push(sent);
      await Promise.resolve();
      const answered = answer(sent);
      if (answered === "pending") {
        // Never settles: the call is still under way.
        await Promise.withResolvers<never>().promise;
      }
      return {
        result: resultOf(answered === "pending" ? { value: null } : answered),
      };
    },
    watch: async (body, onSnapshot) => {
      const sent = sentOf(body);
      reads.push(sent);
      await Promise.resolve();
      const answered = answer(sent);
      if (answered !== "pending") {
        onSnapshot({ revision: 1, result: resultOf(answered) });
      }
      return {
        release: () => {
          // Nothing to let go of: the host pushes once.
        },
      };
    },
    links: {
      open: async (resource, url) => {
        links.push({ resource, url });
        await Promise.resolve();
      },
    },
    files: {
      upload: async (resource, _file, name, { cancel }) => {
        uploads.push({ resource, name });
        await Promise.resolve();
        if (holdUploads) {
          // Still under way, until it is cancelled.
          const { promise, reject } = Promise.withResolvers<never>();
          cancel.addEventListener("abort", () => {
            reject(
              Object.assign(new Error("Cancelled."), { code: "file.cancelled" })
            );
          });
          await promise;
        }
        return uploadedFileId;
      },
      read: async () => {
        await Promise.resolve();
        throw new Error("Nothing here reads a file.");
      },
      download: async () => {
        await Promise.resolve();
        throw new Error("Nothing here downloads a file.");
      },
      delete: async () => {
        await Promise.resolve();
        throw new Error("Nothing here deletes a file.");
      },
    },
  };
  return { client: new GraspClient(transport), reads, calls, uploads, links };
};

/**
 * The page of `records` `asked` names, each cursor the position the page
 * after it starts at: from its cursor to its end cursor, else as many as
 * its size.
 */
export const pageOf = (records: readonly unknown[], asked?: PageAsked) => {
  const cursor = asked?.cursor ?? null;
  const start = cursor === null ? 0 : Number(cursor);
  const end =
    asked?.endCursor === undefined
      ? start + (asked?.pageSize ?? 25)
      : Number(asked.endCursor);
  return end < records.length
    ? {
        value: {
          items: records.slice(start, end),
          hasMore: true,
          nextCursor: String(end),
        },
      }
    : {
        value: {
          items: records.slice(start),
          hasMore: false,
          nextCursor: null,
        },
      };
};

/** A public reference of an App's function, as the host generates one. */
export const reference = <Args, Return, Kind extends "query" | "mutation">(
  kind: Kind,
  name: string,
  args: ValueSchema<Args, unknown>,
  returns: ValueSchema<Return, unknown>
): FunctionReference<Kind, "public", Args, Return> =>
  // What `_generated` builds for a function of `kind`: a query's declared
  // return, a mutation's kind and arguments.
  // SAFETY: the reference type follows `Kind`, which `kind` is; a generic
  // conditional type isn't narrowed by checking it.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  (kind === "query"
    ? { name, returns: returns.descriptor }
    : { name, kind, args: args.descriptor }) as FunctionReference<
    Kind,
    "public",
    Args,
    Return
  >;

/** Lets queued work and the renders it causes land. */
export const settle = async (ms = 0): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<null>();
    setTimeout(() => {
      resolve(null);
    }, ms);
    await promise;
  });
};

let root: Root | undefined;

// Unmounted after each test, so nothing a page left pending (a search's
// settle timer) runs after the test file's page is gone.
afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
});

/** Renders `page` in a fresh page, under `client`. */
export const rendered = async (
  client: GraspClient,
  page: ReactNode
): Promise<void> => {
  root?.unmount();
  document.body.replaceChildren();
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(<GraspProvider client={client}>{page}</GraspProvider>);
    await settle();
  });
};

/** The first element `selector` matches, or a failure naming it. */
export const find = (selector: string, text?: string): HTMLElement => {
  const found = [...document.querySelectorAll<HTMLElement>(selector)].find(
    (element) => text === undefined || element.textContent?.trim() === text
  );
  if (found === undefined) {
    throw new Error(`Nothing matches ${selector} ${text ?? ""}`);
  }
  return found;
};

/** The element named `name` by its `aria-label`. */
export const named = (name: string): HTMLElement =>
  find(`[aria-label="${name}"]`);

/** An element that holds what the person typed or chose. */
type ValueElement = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

/** `element` as one that holds a value, or a failure saying it doesn't. */
export const valueOf = (element: Element): ValueElement => {
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    return element;
  }
  throw new Error(`${element.tagName} holds no value.`);
};

/** Clicks `element`, as a person's pointer does, and lets it land. */
export const click = async (element: Element): Promise<void> => {
  await act(async () => {
    element.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0 })
    );
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    element.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, button: 0 })
    );
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    if (element instanceof HTMLElement) {
      element.click();
    }
    await Promise.resolve();
  });
  await settle();
};

/** Types `value` into `element`, replacing what it holds, as typing does. */
export const typeInto = async (
  target: Element,
  value: string
): Promise<void> => {
  const element = valueOf(target);
  await act(async () => {
    // React tracks the value it set: the element's own setter, as typing
    // goes through, is what it hears change.
    const prototype = Reflect.getPrototypeOf(element) ?? {};
    Reflect.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      element,
      value
    );
    element.dispatchEvent(
      element instanceof HTMLSelectElement
        ? new Event("change", { bubbles: true })
        : new InputEvent("input", { bubbles: true, inputType: "insertText" })
    );
    await Promise.resolve();
  });
  await settle();
};

/** Leaves `element`, as moving focus away does. */
export const leave = async (element: HTMLElement): Promise<void> => {
  await act(async () => {
    element.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    element.dispatchEvent(new FocusEvent("blur"));
    await Promise.resolve();
  });
  await settle();
};
