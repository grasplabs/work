import type { OperationReference, ValueSchema } from "@grasp-os/sdk";
import { GraspClient } from "@grasp-os/sdk/client";
import { GraspProvider } from "@grasp-os/sdk/react";
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

// What an App screen's kit parts (the data grid, the form fields) are
// tested against: a real session client, as the platform mounts one, over
// a host that answers each query and mutation as the test says. The host
// is the outside system here; the client, the hooks and the kit are the
// real ones.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** One query read or call the client sent the host. */
export interface Sent {
  readonly contractId: string;
  readonly input: Readonly<Record<string, unknown>>;
  /** A paginated list's window: how many records it asks for. */
  readonly extent: number | undefined;
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What `body` asks for: its function, input and window. */
const sentOf = (body: string): Sent => {
  const parsed: unknown = JSON.parse(body);
  const read = (value: unknown, key: string): unknown =>
    isRecord(value) ? value[key] : undefined;
  const contractId = read(read(parsed, "reference"), "contractId");
  const input = read(parsed, "input");
  const extent = read(read(parsed, "window"), "extent");
  return {
    contractId: typeof contractId === "string" ? contractId : "",
    input: isRecord(input) ? input : {},
    extent: typeof extent === "number" ? extent : undefined,
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
export const testHost = (answer: (sent: Sent) => Answer) => {
  const reads: Sent[] = [];
  const calls: Sent[] = [];
  /** Each file uploaded: through which resource, and its name. */
  const uploads: { resource: string; name: string }[] = [];
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
    files: {
      upload: async (resource, _file, name) => {
        uploads.push({ resource, name });
        await Promise.resolve();
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
  return { client: new GraspClient(transport), reads, calls, uploads };
};

/** A page of `records` for a list's window of `extent`. */
export const pageOf = (records: readonly unknown[], extent = 25) =>
  extent < records.length
    ? {
        value: {
          items: records.slice(0, extent),
          hasMore: true,
          nextCursor: String(extent),
        },
      }
    : { value: { items: records, hasMore: false, nextCursor: null } };

/** A public reference of an App's function, as the host generates one. */
export const reference = <Args, Return, Kind extends "query" | "mutation">(
  kind: Kind,
  contractId: string,
  args: ValueSchema<Args, unknown>,
  returns: ValueSchema<Return, unknown>
): OperationReference<Args, Return, Kind> => ({
  kind,
  contractId,
  visibility: "public",
  mode: "single",
  resourceId: "app_0000000000000000000000notes",
  resourceVersion: 1,
  fingerprint: "0".repeat(64),
  args: args.descriptor,
  returns: returns.descriptor,
});

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

/** Renders `screen` in a fresh page, under `client`. */
export const rendered = async (
  client: GraspClient,
  screen: ReactNode
): Promise<void> => {
  root?.unmount();
  document.body.replaceChildren();
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(<GraspProvider client={client}>{screen}</GraspProvider>);
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
