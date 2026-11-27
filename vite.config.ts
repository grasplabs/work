import { readFileSync } from "node:fs";

import ultracite from "ultracite/oxfmt";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import react from "ultracite/oxlint/react";
import shadcn from "ultracite/oxlint/shadcn";
import tanstack from "ultracite/oxlint/tanstack";
import vitest from "ultracite/oxlint/vitest";
import { defineConfig } from "vite-plus";
import { z } from "zod";

import { brainModules } from "./apps/core/test/brain-next-modules.ts";
import DurationSequencer from "./scripts/test-sequencer.ts";

/**
 * The App kit's files as the registry's CLI writes them, byte for byte but
 * for the changes packages/app-kit/local-changes.json lists, which
 * `vp run check:app-kit` holds (scripts/app-kit-sync.ts): kept from the
 * formatter and the linter, as the CLI's code style is upstream's.
 */
const appKitRegistryFiles = Object.keys(
  z
    .object({ files: z.record(z.string(), z.string()) })
    .parse(
      JSON.parse(
        readFileSync(
          new URL("packages/app-kit/registry.json", import.meta.url),
          "utf-8"
        )
      )
    ).files
).map((file) => `packages/app-kit/${file}`);

const generated = [
  ...appKitRegistryFiles,
  "**/routeTree.gen.ts",
  "**/worker-configuration.d.ts",
  "**/src/db/**/migrations/**",
  // Release fixtures and the golden manifest the release test writes.
  "scripts/release/testdata/**",
  // What the host generates for an App, byte for byte (spec 8), and the
  // config and schema an App's definition generates (the SDK's
  // definition-source.ts), which its commits must equal.
  "**/.grasp/**",
  "apps/core/blueprints/*/files/grasp.config.ts",
  "apps/core/blueprints/*/files/server/schema.ts",
  "apps/core/blueprints/*/files/server/_generated/**",
  "apps/core/test/fixtures/blueprints/*/files/grasp.config.ts",
  "apps/core/test/fixtures/blueprints/*/files/server/schema.ts",
  "apps/core/test/fixtures/blueprints/*/files/server/_generated/**",
  // The SDK's connector catalog, from the release's connectors
  // (apps/core/build-connector-catalog.ts).
  "packages/runtime/src/app/connector-catalog.gen.ts",
  // Each native tool's class, from the same connectors.
  "apps/core/src/native-tool-classes.gen.ts",
  // The names core's RPC targets give their parameters, from their source.
  "apps/core/src/rpc-param-names.gen.ts",
  // The Snowball project's own stemmers, as its release ships them
  // (scripts/brain-snowball.ts).
  "packages/brain-next/src/snowball/**",
  // What Damsko's token generator writes, which Damsko keeps from its own
  // formatter too: packages/ui holds them byte for byte (scripts/ui-sync.ts).
  "packages/ui/src/styles/**",
  "packages/ui/src/lib/tokens.stylex.ts",
  "packages/ui/src/lib/tokens.values.ts",
  // A connector's tools, generated from its vendor's OpenAPI spec, and the
  // spec as the vendor serves it, which they record the hash of
  // (scripts/connector-openapi.ts).
  "**/tools.gen.ts",
  "**/openapi.yaml",
  "**/openapi.json",
  // A connector's recorded vendor answers, as a recording run writes them
  // (apps/connect/test/fixture-recorder.ts).
  "**/fixtures.json",
];

/** Why a target may not extend Cap'n Web's or workerd's RpcTarget itself. */
const unboundedTarget =
  "Extend CoreRpcTarget (core) or a boundedRpcTarget (@grasp-os/shared/rpc-target), so every call's arguments are bounded.";

/** Cap'n Web's and workerd's RpcTarget, which core and the frontend never extend. */
const unboundedTargetPaths = [
  { name: "capnweb", importNames: ["RpcTarget"], message: unboundedTarget },
  {
    name: "cloudflare:workers",
    importNames: ["RpcTarget"],
    allowTypeImports: true,
    message: unboundedTarget,
  },
];

/**
 * The Brain's store and its files: reached only through its contract
 * (`@grasp-os/brain-next/contract`). Core's src/brain-store.ts alone
 * imports the store, to subclass it for its alarm. Its work queue (`/work`) is the store's
 * own too: its handlers run inside the store.
 */
const brainStoreImports = {
  group: [
    "@grasp-os/brain-next/store",
    "@grasp-os/brain-next/work",
    "**/brain-next/src/**",
  ],
  message:
    "Reach the Brain through @grasp-os/brain-next/contract (core's src/brain-next.ts), never its store.",
};

/**
 * The Brain's contract, inside core: only src/brain-next.ts holds it, so
 * the Brain's reader is made there alone, from core's own records.
 */
const brainContractImports = {
  group: ["@grasp-os/brain-next", "@grasp-os/brain-next/contract"],
  message:
    "In core, only src/brain-next.ts reaches the Brain: add and recall through its addSource and recallAs.",
};

/**
 * Core's module for the Brain (src/brain-next.ts): only the modules the
 * Brain's permission harness lists (apps/core/test/brain-next-modules.ts)
 * import it, each with the surface that probes it
 * (test/brain-next-surfaces.ts), so no module reaches the Brain without
 * them.
 */
const brainModuleImports = {
  // Every spelling that resolves to it: bare, .ts and .js.
  group: ["**/brain-next", "**/brain-next.ts", "**/brain-next.js"],
  message:
    "Only the modules the Brain's permission harness probes import src/brain-next.ts: add this one to apps/core/test/brain-next-modules.ts, with its surface in brainSurfaces (test/brain-next-surfaces.ts).",
};

// apps/web and apps/admin draw with Damsko alone (AGENTS.md, Design):
// nothing of the old kit, Lucide or Tailwind, in their tests either.
const oldDesignImports = {
  group: [
    "@grasp-os/app-kit",
    "@grasp-os/app-kit/**",
    "lucide-react",
    "lucide-react/**",
    "tailwindcss",
    "tailwindcss/**",
    "@tailwindcss/**",
  ],
  message:
    "apps/web and apps/admin draw with Damsko: components from @grasp-os/ui/components, icons from @grasp-os/ui/lib/icons, styles in StyleX with Damsko's tokens.",
};

// Test through real interfaces; mock only outside systems, at their
// boundary. (anti-slop/no-module-mocking only knows `vitest` imports.)
const noModuleMocks = ["mock", "doMock", "hoisted"].map((property) => ({
  object: "vi",
  property,
  message:
    "Don't mock modules. Pass the dependency through a real interface instead.",
}));

export default defineConfig({
  lint: {
    extends: [core, react, tanstack, vitest, shadcn],
    ignorePatterns: [
      ...(core.ignorePatterns ?? []),
      ...generated,
      // The tests' own built-in, an App of spec 8's layout: its functions
      // import what its seal generates (`@server/_generated/server`), which nothing
      // here maps, so its files are untyped, like any inline test App's
      // (the seal strips types without checking them), and
      // builtin-blueprints.test.ts covers what they do at runtime.
      "apps/core/test/fixtures/blueprints/*/files/**",
      // A built-in's pages, which need the route tree and the kit a page
      // build gives them: the build type-checks them as it does
      // any App's (builtin-blueprints.test.ts). Its config and server code
      // are checked here (each built-in's own tsconfig.json).
      "apps/core/blueprints/*/files/src/**",
      // The import boundary check's fixture workspace
      // (scripts/check-runtime-boundary.test.ts): modules that import its
      // own stand-in packages, which nothing here resolves.
      "scripts/testdata/runtime-boundary/**",
    ],
    jsPlugins: [
      ...(shadcn.jsPlugins ?? []),
      ...(antiSlop.jsPlugins ?? []),
      "./scripts/lint/grasp-plugin.ts",
    ],
    options: {
      typeAware: true,
      typeCheck: true,
      // No warning tier: a rule is either an error or off.
      denyWarnings: true,
      // A disable comment that no longer suppresses anything must go.
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      // Controls are closed: a page places them (layout) and nothing else.
      "shadcn/no-restyle": ["error", { allow: ["layout"] }],
      // Refuses inline style objects as the rule it replaces did, and lets
      // StyleX styles through to a component's `style`, whose type
      // (Damsko's LayoutStyle) holds them to layout
      // (scripts/lint/grasp-plugin.ts).
      "shadcn/no-inline-styles": "off",
      "grasp/no-inline-styles": "error",
      // Picked from Ultracite's anti-slop preset: the rules that stop agents
      // from silencing the type checker. The rest of that preset forces
      // workarounds (no options objects, no `unknown`).
      "anti-slop/no-chained-type-assertions": "error",
      "anti-slop/no-widen-then-assert": "error",
      "anti-slop/require-safety-comment-for-type-assertion": "error",
      // TanStack Router's `throw notFound()` is control flow, not an error.
      "typescript/only-throw-error": [
        "error",
        {
          allow: [
            {
              from: "package",
              package: "@tanstack/router-core",
              name: "NotFoundError",
            },
          ],
        },
      ],
      "no-restricted-properties": ["error", ...noModuleMocks],
    },
    settings: {
      shadcn: {
        ui: "@grasp-os/app-kit/components",
      },
    },
    overrides: [
      {
        // The frontend hides every scrollbar (apps/web/src/styles.css).
        files: ["apps/web/src/**"],
        rules: { "grasp/no-scrollbars": "error" },
      },
      {
        // Every answer of the interface is over within 300 ms (AGENTS.md,
        // Design), in the frontend and the admin. The kit's components move
        // as the stock default components do.
        files: ["apps/web/src/**", "apps/admin/src/**"],
        excludeFiles: ["**/*.test.ts", "**/*.test.tsx"],
        rules: { "grasp/no-slow-motion": "error" },
      },
      {
        // Seen once per person, so they may take longer to delight: the
        // onboarding, the interview and setup.
        files: [
          "apps/web/src/onboarding/**",
          "apps/web/src/interview/**",
          "apps/web/src/voice/**",
          "apps/web/src/routes/interview*",
          "apps/web/src/routes/setup*",
          "apps/web/src/frame/onboarding-frame.tsx",
        ],
        rules: { "grasp/no-slow-motion": "off" },
      },
      {
        // What clients and buyers read names the product Grasp Work
        // (GRA-143): the apps' and packages' source, not their tests.
        files: ["apps/*/src/**", "packages/*/src/**"],
        excludeFiles: ["**/*.test.ts", "**/*.test.tsx"],
        rules: { "grasp/no-old-product-name": "error" },
      },
      {
        // Nothing outside the Brain reaches its store (GRA-1720); the
        // overrides below that set their own restricted imports repeat it.
        files: ["apps/**", "packages/**", "scripts/**", "e2e/**"],
        excludeFiles: ["packages/brain-next/**"],
        rules: {
          "no-restricted-imports": ["error", { patterns: [brainStoreImports] }],
        },
      },
      {
        // The work queue's tests (its own, the leak harness's probes, and
        // erasure's, which erases queued work) define kinds of work whose
        // handlers they control, and add items.
        files: [
          "apps/core/test/brain-next-work.test.ts",
          "apps/core/test/brain-next-surfaces.ts",
          "apps/core/test/brain-next-vectors.test.ts",
          "apps/core/test/brain-next-erasure.test.ts",
          "apps/core/test/brain-report.test.ts",
          "apps/core/test/brain-next-own-work.test.ts",
        ],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                {
                  ...brainStoreImports,
                  group: ["@grasp-os/brain-next/store", "**/brain-next/src/**"],
                },
              ],
            },
          ],
        },
      },
      {
        // Workerflow is a generic engine: nothing of Grasp's domain (users,
        // Apps, connect, permissions) may reach it. Grasp imports it, never
        // the other way round.
        files: ["packages/workerflow/**"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                {
                  // Other workspace packages, by name or by path.
                  group: ["@grasp-os/**", "**/apps/**", "../../*/**"],
                  message:
                    "Workerflow imports nothing of Grasp: core maps Grasp onto it.",
                },
              ],
            },
          ],
        },
      },
      {
        // A connector is written with @grasp-os/sdk/connector and its own
        // files, nothing else (GRA-1374): no Zod, no Node, no other package
        // of ours or npm's. Its own files: `./…` in its folder, or
        // `../src/…` from another folder of the package (test/), and no
        // `..` past that, so no path leaves the package. Connect's build
        // refuses the rest too (apps/connect/build.ts). Google Workspace and Microsoft 365 keep
        // the old kit, Zod and the runtime until they move to the SDK
        // (GRA-2323, GRA-2324), as do connect's sample connectors written
        // with the old kit. Its values are typed with v, or say why they
        // are free-form (grasp/no-unexplained-json, GRA-2330); what the
        // OpenAPI generator writes is ignored above (`generated`).
        files: [
          "packages/connectors/**",
          "apps/connect/test/fixtures/*-connector.ts",
          "apps/connect/test/fixtures/*/**",
        ],
        excludeFiles: [
          "packages/connectors/google-workspace/**",
          "packages/connectors/microsoft-365/**",
          "apps/connect/test/fixtures/sample-connector.ts",
          "apps/connect/test/fixtures/sample-sync-connector.ts",
          "apps/connect/test/fixtures/sample-oauth-connector.ts",
          "apps/connect/test/fixtures/composio-named-connector.ts",
        ],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                brainStoreImports,
                {
                  group: [
                    "*",
                    "!@grasp-os/sdk/connector",
                    "!./**",
                    "!../src/**",
                    "./**/../**",
                    "../src/**/../**",
                  ],
                  message:
                    "A connector imports @grasp-os/sdk/connector and its own files, nothing else.",
                },
              ],
            },
          ],
          "grasp/no-unexplained-json": "error",
        },
      },
      {
        // Connect reaches the runtime through its connector entry alone,
        // which carries no React, TanStack or App code
        // (scripts/check-runtime-boundary.ts), and nothing of the SDK,
        // which is App code's. Its sample connectors are connectors.
        files: ["apps/connect/**"],
        excludeFiles: [
          "apps/connect/test/fixtures/*-connector.ts",
          "apps/connect/test/fixtures/*/**",
        ],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                brainStoreImports,
                {
                  group: [
                    "@grasp-os/runtime",
                    "@grasp-os/runtime/**",
                    "!@grasp-os/runtime/connector",
                    "@grasp-os/sdk",
                    "@grasp-os/sdk/**",
                  ],
                  message:
                    "Connect imports @grasp-os/runtime/connector of the runtime, and nothing of the SDK.",
                },
              ],
            },
          ],
        },
      },
      {
        // A target a browser or a page calls must hold what its methods
        // get to the session's limits: Cap'n Web bounds each message, not
        // a value built from several (@grasp-os/shared/rpc-target). In
        // workerd, Cap'n Web's RpcTarget is workerd's own.
        files: ["apps/core/src/**", "apps/web/src/**"],
        rules: { "grasp/no-unbounded-rpc-target": "error" },
      },
      {
        // Core's imports: RpcTarget only through the bounded base, and the
        // Brain's only as the patterns above allow.
        files: ["apps/core/src/**"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              paths: unboundedTargetPaths,
              patterns: [
                brainStoreImports,
                brainContractImports,
                brainModuleImports,
              ],
            },
          ],
        },
      },
      {
        // The frontend's, the same, and the old design's imports refused:
        // it draws with Damsko alone.
        files: ["apps/web/src/**"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              paths: unboundedTargetPaths,
              patterns: [
                brainStoreImports,
                brainContractImports,
                brainModuleImports,
                oldDesignImports,
              ],
            },
          ],
          "grasp/no-class-strings": "error",
        },
      },
      {
        // The admin draws with Damsko alone too: the old design's imports
        // refused, and no class list written out.
        files: ["apps/admin/src/**"],
        rules: {
          "no-restricted-imports": [
            "error",
            { patterns: [brainStoreImports, oldDesignImports] },
          ],
          "grasp/no-class-strings": "error",
        },
      },
      {
        // The modules that reach the Brain through core's module, each
        // probed by the permission harness (its list,
        // apps/core/test/brain-next-modules.ts).
        files: Object.keys(brainModules),
        rules: {
          "no-restricted-imports": [
            "error",
            {
              paths: unboundedTargetPaths,
              patterns: [brainStoreImports, brainContractImports],
            },
          ],
        },
      },
      {
        // Core reaches the Brain's store binding only through
        // src/brain-next.ts (and the provisioning probe, which lists every
        // binding), so no module skips the reader brain-next.ts makes.
        files: ["apps/core/src/**"],
        excludeFiles: [
          "apps/core/src/brain-next.ts",
          "apps/core/src/provision-probe.ts",
        ],
        rules: {
          "no-restricted-properties": [
            "error",
            ...noModuleMocks,
            {
              property: "BRAIN_STORE",
              message:
                "Reach the Brain through src/brain-next.ts, never its store binding.",
            },
            {
              // The same namespace, as the Worker's own exports give it.
              property: "BrainStore",
              message:
                "Reach the Brain through src/brain-next.ts, never its store.",
            },
          ],
        },
      },
      {
        // Core's subclass of the Brain's store (its alarm's host): the one
        // import of the store, and a module the harness probes.
        files: ["apps/core/src/brain-store.ts"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              paths: unboundedTargetPaths,
              patterns: [brainContractImports],
            },
          ],
        },
      },
      {
        // Core's one way to the Brain: its contract, never its store.
        files: ["apps/core/src/brain-next.ts"],
        rules: {
          "no-restricted-imports": [
            "error",
            { paths: unboundedTargetPaths, patterns: [brainStoreImports] },
          ],
        },
      },
      {
        // No package passes RpcTarget on for core or the frontend to
        // extend unbounded; the bounded base extends it in place.
        files: ["packages/**"],
        rules: {
          "grasp/no-unbounded-rpc-target": ["error", { reexportsOnly: true }],
        },
      },
      {
        // A run's host, and the host of each of its steps' attempts, are
        // served over workerd's own RPC to the run's isolate, never over
        // Cap'n Web, and extend workerd's RpcTarget.
        files: [
          "apps/core/src/workflows/host.ts",
          "apps/core/src/workflows/attempt-host.ts",
          // What holds a run's host to its time between steps, forwarding
          // each call to it unchanged (between-steps.ts).
          "apps/core/src/workflows/between-steps.ts",
        ],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              paths: [
                {
                  name: "capnweb",
                  importNames: ["RpcTarget"],
                  message: unboundedTarget,
                },
              ],
              patterns: [
                brainStoreImports,
                brainContractImports,
                brainModuleImports,
              ],
            },
          ],
        },
      },
      {
        // A test's stand-ins are called by the test alone. Its imports
        // reach what the frontend's own may not, apart from the old
        // design's: the frontend's tests draw with Damsko too.
        files: ["apps/web/src/**/*.test.ts", "apps/web/src/**/*.test.tsx"],
        rules: {
          "no-restricted-imports": ["error", { patterns: [oldDesignImports] }],
          "grasp/no-unbounded-rpc-target": "off",
        },
      },
      {
        // Core's JSX is Chat SDK's cards (apps/core/tsconfig.json), not
        // React's DOM: a card's `style` is a word ("primary", "muted").
        files: ["apps/core/src/**/*.tsx"],
        rules: { "react/style-prop-object": "off" },
      },
      {
        // Schema files start as comment-only placeholders until their first table.
        files: ["apps/*/src/db/**/schema.ts"],
        rules: { "unicorn/no-empty-file": "off" },
      },
      {
        // Damsko's components know nothing of Grasp: no translations, no
        // routes, none of the product's types. A product gives them words
        // through the I18nProvider and content through props.
        files: ["packages/ui/**"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                brainStoreImports,
                {
                  group: [
                    "@lingui/**",
                    "@tanstack/*router*",
                    "@grasp-os/**",
                    "**/apps/**",
                  ],
                  message:
                    "packages/ui is Damsko's source, which imports nothing of the product.",
                },
              ],
            },
          ],
          // Damsko's docs read two tags of their own from a props type:
          // `@when` and `@by`.
          "jsdoc/check-tag-names": ["error", { definedTags: ["when", "by"] }],
        },
      },
      {
        // Damsko's Markdown ends its switch over mdast's phrasing nodes in
        // a default: in Damsko, its docs' packages add node types of their
        // own to that union, which this copy never sees.
        files: ["packages/ui/src/components/markdown/markdown.tsx"],
        rules: { "typescript/switch-exhaustiveness-check": "off" },
      },
      {
        files: [
          "packages/app-kit/src/components/**",
          // Damsko's, installed the same way and held to these settings
          // in its own repository.
          "packages/ui/src/components/**",
          "packages/ui/src/blocks/**",
        ],
        rules: {
          "shadcn/no-arbitrary-values": "off",
          "shadcn/no-restyle": "off",
          "shadcn/require-static-classes": "off",
          // Components are added with the shadcn CLI; keep its code style.
          "func-style": "off",
          "react/function-component-definition": "off",
          // shadcn gives divs ARIA roles (group, list, link, status) for
          // their layout; a semantic tag would bring its own styles.
          "jsx-a11y/prefer-tag-over-role": "off",
        },
      },
    ],
  },
  fmt: {
    ...ultracite,
    ignorePatterns: [...(ultracite.ignorePatterns ?? []), ...generated],
  },
  test: {
    // The admin's Cloudflare Vite plugin cannot load as a Vitest project;
    // its tests have a config of their own.
    projects: [
      "apps/*",
      "!apps/admin",
      "apps/admin/vite.test.config.ts",
      "apps/admin/vite.components.config.ts",
      "apps/core/vite.pages.config.ts",
      "apps/core/vite.on-prem.config.ts",
      "apps/core/vite.brain-meaning.config.ts",
      "apps/core/vite.stephen.config.ts",
      "packages/*",
      "packages/app-kit/vite.browser.config.ts",
      "packages/workerflow/vite.process.config.ts",
      "packages/workerflow/vite.conformance.config.ts",
      "packages/connectors/*",
      // Repo tooling's pure logic, and core's and connect's build steps,
      // in Node.
      {
        test: {
          name: "scripts",
          include: [
            "scripts/**/*.test.ts",
            "apps/core/build-blueprints.test.ts",
            "apps/connect/build.test.ts",
            "apps/core/host-json.bundle.test.ts",
            "apps/admin/vite.config.test.ts",
          ],
          environment: "node",
        },
      },
    ],
    passWithNoTests: true,
    // CI's shards split by how long each file takes, and each shard's
    // longest files first (scripts/test-sequencer.ts).
    sequence: { sequencer: DurationSequencer },
  },
  staged: {
    "*": ["secretlint", "vp check --fix"],
    "*.{md,mdx}": "node scripts/check-docs.ts",
  },
});
