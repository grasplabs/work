import type { Json } from "@grasp-os/shared/json";

import { clientError, issueDetails } from "./client-error.ts";
import type {
  ScreenReference,
  SurfaceInputOf,
  SurfaceNameOf,
} from "./references.ts";
import type { ValueDescriptor } from "./value-descriptor.ts";
import { validateValue } from "./value-interpreter.ts";

// Navigation between an App's own screens (spec 10.7.7), as the client
// asks the trusted host for it. The screen names a generated screen
// reference and that screen's route input; nothing else crosses: no URL,
// path, App or person. The input is normalized here by the route's own
// schema, as an operation's arguments are, so a mistake fails before
// anything is sent; the host checks the target and the input again with
// core before it navigates, and it alone builds the route.

/**
 * How a client reaches the trusted host for navigation (the page, for a
 * screen's frame). A client without it navigates nowhere.
 */
export interface NavigationTransport {
  /**
   * Asks the host to open the screen `request` names (JSON text: its
   * route name, its normalized input and whether it replaces the current
   * entry). Resolves once the host accepted the navigation.
   */
  navigate: (request: string) => Promise<void>;
  /**
   * Tells the host whether a form of the screen holds unsaved edits or a
   * submission whose outcome isn't known yet, so it confirms once before
   * leaving the screen.
   */
  leaveGuard: (guarded: boolean) => void;
}

/** How a route navigation goes: pushing a new entry, or replacing the current. */
export interface NavigateOptions {
  readonly replace?: boolean;
  readonly surface?: undefined;
}

/**
 * A navigation to one of the screen's declared surfaces (spec 34.1): the
 * host places it; only a route replaces an entry.
 */
export interface SurfaceNavigateOptions<Surface extends string> {
  readonly surface: Surface;
  readonly replace?: never;
}

/** The arguments a route navigation to `Screen` takes, as an operation's would. */
export type NavigateArguments<Screen> =
  Screen extends ScreenReference<string, infer Input>
    ? Record<never, never> extends Input
      ? [input?: Input, options?: NavigateOptions]
      : [input: Input, options?: NavigateOptions]
    : never;

/**
 * What `useNavigate` answers: one stable function for every navigation,
 * to a screen's route, or to one of its declared surfaces with that
 * surface's input.
 */
export interface Navigate {
  <Screen extends ScreenReference>(
    screen: Screen,
    ...args: NavigateArguments<Screen>
  ): Promise<void>;
  <Screen extends ScreenReference, Surface extends SurfaceNameOf<Screen>>(
    screen: Screen,
    input: SurfaceInputOf<Screen, Surface>,
    options: SurfaceNavigateOptions<Surface>
  ): Promise<void>;
}

const screenNamePattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;

/** What a screen reference holds that navigation reads. */
interface ReadScreen {
  name: string;
  input: ValueDescriptor;
  /** Its declared surfaces' input descriptors, by name. */
  surfaces: ReadonlyMap<string, ValueDescriptor>;
}

/** A reference's surfaces' input descriptors, or undefined if malformed. */
const readSurfaces = (
  value: unknown
): ReadonlyMap<string, ValueDescriptor> | undefined => {
  if (value === undefined) {
    return new Map();
  }
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const surfaces = new Map<string, ValueDescriptor>();
  for (const [name, surface] of Object.entries(value)) {
    const input: unknown =
      typeof surface === "object" && surface !== null
        ? Reflect.get(surface, "input")
        : undefined;
    if (typeof input !== "object" || input === null) {
      return undefined;
    }
    // SAFETY: a generated reference's descriptor, as `#grasp` froze it;
    // `validateValue` refuses one that isn't a descriptor.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    surfaces.set(name, input as ValueDescriptor);
  }
  return surfaces;
};

/** `value`'s route name, input descriptor and surfaces, if it is a screen reference. */
const readScreen = (value: unknown): ReadScreen | undefined => {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const name: unknown = Reflect.get(value, "name");
  const path: unknown = Reflect.get(value, "path");
  const input: unknown = Reflect.get(value, "input");
  if (
    typeof name !== "string" ||
    !screenNamePattern.test(name) ||
    typeof path !== "string" ||
    typeof input !== "object" ||
    input === null
  ) {
    return undefined;
  }
  const surfaces = readSurfaces(Reflect.get(value, "surfaces"));
  if (surfaces === undefined) {
    return undefined;
  }
  // SAFETY: a generated screen reference's descriptor, as `#grasp` froze
  // it; `validateValue` refuses one that isn't a descriptor.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return { name, input: input as ValueDescriptor, surfaces };
};

const invalidOptions = (message: string, path: string[] = []): Error =>
  clientError("contract.invalid_args", { issues: [{ message, path }] });

/**
 * `options` read strictly: `replace`, a boolean, or `surface`, one of the
 * screen's declared surfaces, never both.
 */
const readNavigateOptions = (
  options: unknown,
  surfaces: ReadonlyMap<string, ValueDescriptor>
): { replace: boolean; surface?: string } => {
  if (options === undefined) {
    return { replace: false };
  }
  if (
    typeof options !== "object" ||
    options === null ||
    !Object.keys(options).every((key) => key === "replace" || key === "surface")
  ) {
    throw invalidOptions("Navigation options are { replace? } or { surface }");
  }
  const replace: unknown = Reflect.get(options, "replace");
  const surface: unknown = Reflect.get(options, "surface");
  if (replace !== undefined && typeof replace !== "boolean") {
    throw invalidOptions("`replace` is true or false", ["replace"]);
  }
  if (surface === undefined) {
    return { replace: replace === true };
  }
  if (typeof surface !== "string" || !surfaces.has(surface)) {
    throw invalidOptions("`surface` is one the screen declares", ["surface"]);
  }
  if (replace !== undefined) {
    throw invalidOptions(
      "Only a route replaces: `replace` takes no `surface`",
      ["replace"]
    );
  }
  return { replace: false, surface };
};

/**
 * Asks the host, through `transport`, to open `screen` with `input` (spec
 * 10.7.7), resolving once it accepted. Refused before anything is sent for
 * what isn't a generated screen reference (`navigation.invalid_screen`),
 * input its route's schema refuses (`contract.invalid_args`), unknown
 * options, or a client with no host to navigate (`navigation.unavailable`).
 */
export const navigateThrough = async (
  transport: NavigationTransport | undefined,
  screen: unknown,
  input: unknown,
  options: unknown
): Promise<void> => {
  const read = readScreen(screen);
  if (read === undefined) {
    throw clientError("navigation.invalid_screen");
  }
  const { replace, surface } = readNavigateOptions(options, read.surfaces);
  const descriptor =
    surface === undefined ? read.input : read.surfaces.get(surface);
  if (descriptor === undefined) {
    throw clientError("navigation.invalid_screen");
  }
  let checked: ReturnType<typeof validateValue>;
  try {
    // Only input left out is `{}`: `null` is input, refused as the host does.
    checked = validateValue(descriptor, input === undefined ? {} : input);
  } catch {
    throw clientError("navigation.invalid_screen");
  }
  if (checked.issues !== undefined) {
    throw clientError("contract.invalid_args", {
      issues: issueDetails(checked.issues),
    });
  }
  if (transport === undefined) {
    throw clientError("navigation.unavailable");
  }
  // SAFETY: the interpreter answers a fresh JSON copy of what it accepted.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const normalized = checked.value as Json;
  await transport.navigate(
    JSON.stringify(
      surface === undefined
        ? { screen: read.name, input: normalized, replace }
        : { screen: read.name, input: normalized, surface }
    )
  );
};
