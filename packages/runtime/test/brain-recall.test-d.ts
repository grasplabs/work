// The SDK's recall types against the Brain's contract: the SDK owns its
// types, so a change to the Brain's pack or request fails here until the
// SDK says it too. The pack's source is core's (the producer's kind and
// its ID, where the store has one key), and core assigns its recall's
// answer to `BrainPack`, so that half is checked where it is made. This
// file is type-checked by `vp check` and never run.
import type {
  Entity,
  EntityKind,
  FoundBy,
  Pack,
  PackItem,
  recallRequestSchema,
} from "@grasp-os/brain-next/contract";
import { expectTypeOf } from "vite-plus/test";
import type { z } from "zod";

import type {
  BrainEntity,
  BrainEntityKind,
  BrainFound,
  BrainPack,
  BrainPackItem,
  BrainRecall,
} from "../src/brain-recall.ts";

type Request = z.input<typeof recallRequestSchema>;
type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

// How a passage was found: the same four ways.
expectTypeOf<BrainFound>().toEqualTypeOf<FoundBy>();

// A passage: the Brain's, apart from how its source is named.
expectTypeOf<Mutable<Omit<BrainPackItem, "source">>>().toEqualTypeOf<
  Omit<PackItem, "source">
>();

// The pack: the same fields, apart from its items, and passages alone:
// code gets no memory and no contested fact (core's `recallPassagesAs`;
// memories for code are GRA-1837's).
type Passages = Omit<Pack, "memories" | "contested">;
expectTypeOf<keyof BrainPack>().toEqualTypeOf<keyof Passages>();
expectTypeOf<Mutable<Omit<BrainPack, "items" | "notFound">>>().toEqualTypeOf<
  Omit<Passages, "items" | "notFound">
>();
expectTypeOf<BrainPack["notFound"][number]>().toEqualTypeOf<
  Pack["notFound"][number]
>();

// The request: the question and the budget as the Brain takes them, the
// moment as a string core reads into the Brain's date, and nothing of
// who reads: core names the reader, never the caller.
expectTypeOf<BrainRecall["question"]>().toEqualTypeOf<Request["question"]>();
expectTypeOf<Mutable<BrainRecall["budget"]>>().toEqualTypeOf<
  Request["budget"]
>();
expectTypeOf<Exclude<keyof BrainRecall, "asOf">>().toEqualTypeOf<
  Exclude<keyof Request, "asOf" | "reader" | "meaning" | "withoutMeaning">
>();
expectTypeOf<Request["asOf"]>().toEqualTypeOf<Date | undefined>();

// Entities, as code reads them: the Brain's kinds, and an entity as the
// Brain gives one, its ID, kind and earliest name.
expectTypeOf<BrainEntityKind>().toEqualTypeOf<EntityKind>();
expectTypeOf<Mutable<BrainEntity>>().toEqualTypeOf<Entity>();
