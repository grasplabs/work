// Compile-time guarantees of navigation between an App's screens (spec
// 10.7.7), against the Notes fixture's generated `screens`: a navigation
// names one of the App's screens and takes exactly its route input, left
// out only when the input may be, and a screen's props are its normalized
// input. No URL, path or string, no surface yet, no navigation object.
// This file is type-checked by `vp check` and never run: every
// `@ts-expect-error` below must stay an error.
import { expectTypeOf } from "vite-plus/test";

import type { Id } from "../src/index.ts";
import { useNavigate } from "../src/react.ts";
import type { Navigate, ScreenProps } from "../src/react.ts";
import { screens } from "./notes/.grasp/references.ts";

declare const navigate: Navigate;
declare const id: Id<"notes">;

expectTypeOf(useNavigate).returns.toEqualTypeOf<Navigate>();
expectTypeOf(navigate(screens.note, { id })).toEqualTypeOf<Promise<void>>();
void navigate(screens.note, { id }, { replace: true });
// An empty route input may be left out.
void navigate(screens.notes);
void navigate(screens.notes, {}, { replace: false });

// @ts-expect-error a note's route needs its ID
void navigate(screens.note);
// @ts-expect-error an ID of another table
void navigate(screens.note, { id: "n1" });
// @ts-expect-error a field the route doesn't take
void navigate(screens.note, { id, admin: true });
// @ts-expect-error a URL is no screen
void navigate("https://example.com", {});
// @ts-expect-error nor a route
void navigate("/notes/:id", { id });
// @ts-expect-error nor a screen's name
void navigate("note", { id });
// @ts-expect-error a screen the App doesn't declare
void navigate(screens.settings, {});
// @ts-expect-error surfaces arrive with their own sub-issue
void navigate(screens.notes, {}, { surface: "panel" });
// @ts-expect-error replace is true or false
void navigate(screens.notes, {}, { replace: "yes" });

// A screen's props: its route input, as the host normalized it.
expectTypeOf<ScreenProps<typeof screens.note>>().toEqualTypeOf<{
  readonly input: { id: Id<"notes"> };
}>();
expectTypeOf<ScreenProps<typeof screens.notes>["input"]>().toEqualTypeOf<
  Record<never, never>
>();
