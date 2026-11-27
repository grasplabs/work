# Grasp OS

One codebase, deployed once per client into the client's own Cloudflare account in the EU. Clients customise Grasp through configuration and in-product content (Apps, workflows, templates), never through code in this repo. If a template needs a platform code change, the platform is missing a capability: fix the platform, not the template.

## Layout

| Path | What it is |
| --- | --- |
| `apps/core` | Core Worker: sign-in, knowledge, Apps, workflows, model gateway, audit |
| `apps/connect` | Connector Worker: the connector layer, the only place OAuth tokens live |
| `apps/web` | Grasp OS frontend: React SPA, served as static files by core |
| `apps/docs` | SDK docs: how to build with Grasp, for people and the agent; ships with each release |
| `apps/admin` | Grasp's admin, where staff manage every client (TanStack Start); production runs in grasp-os-ops |
| `apps/router` | Stateless router: `*.<domain>` to each client's core; production runs in grasp-os-ops |
| `packages/sdk` | `@grasp-os/sdk`: the server, page and workflow SDK, the only API App code sees |
| `packages/runtime` | `@grasp-os/runtime`: what the SDK re-exports, and the hosts, pages and checks only platform code imports |
| `packages/ui` | `@grasp-os/ui`: Damsko, Grasp's design system (github.com/grasplabs/damsko), installed as source from its registry: StyleX on UI SDK. `apps/web` and `apps/admin` are drawn with it |
| `packages/app-kit` | `@grasp-os/app-kit`: the component kit for App pages: the registry's default components (shadcn on Base UI, Tailwind v4), as its CLI installs them, and the App-only parts bound to the SDK |
| `packages/compiler` | `@grasp-os/compiler`: builds and checks App code and pages |
| `packages/connectors/*` | Native MCP servers, loaded by connect, each written with `@grasp-os/sdk/connector` (implemented in `@grasp-os/runtime/connector`) |
| `packages/connector-kit` | `@grasp-os/connector-kit`: the old Zod `defineTool` and `defineConnector`, kept for the Google Workspace and Microsoft 365 connectors until they move to the SDK (GRA-2323, GRA-2324); deleted in GRA-2329 |
| `packages/shared` | `@grasp-os/shared`: types and Zod schemas |
| `scripts` | Repo tooling, run by Node directly (TypeScript, no build step) |

Each app keeps its own Drizzle schemas and migrations in `src/db`, one folder per database (`src/db/<name>/` in core). Workspace packages export TypeScript source; there is no library build step.

## Commands

Vite+ (`vp`) is the toolchain. Run from the repo root:

- `vp install`: install dependencies (also installs the git hooks)
- `vp check`: format, lint (Ultracite + @shadcn/lint) and type-check (tsgo)
- `vp check --fix`: auto-fix
- `vp test`: all tests; Worker tests run in workerd
- `vp run -r build`: build everything
- `vp run e2e`: Playwright end-to-end tests (`*.e2e.ts` in `e2e/`)
- `vp run smoke:workerd`: boot core on plain workerd (on-prem readiness)
- `vp run dev`: run the frontend (localhost:5173) with core and connect behind it (localhost:8787); `vp -C apps/admin dev` for the admin. It has a fake outside API to add as an HTTP connection (`apps/connect/test/outside-api-fake.ts`): `https://api.acme-billing.test`, any credential, paths under `/v1`. `/v1/invoices` answers at once, `/v1/slow` after 10 seconds, and `/v1/dropped` takes the request, then drops the connection without an answer
- `vp run seed`: while `vp run dev` runs, fill it with a demo company (`scripts/seed/`): people in teams, Apps with 30 days of runs, Knowledge, chats, and projects with their Apps and people, where a few of those people filed their chats; sign in as admin@acme.test. It adds only what's missing; to start over, stop dev and delete `apps/core/.wrangler/state`
- `vp run seed:onboarding`: on a fresh `vp run dev` instead of `vp run seed`, the same company halfway through its onboarding (`scripts/seed-onboarding.ts`): day 8 of 14 of the interviews, most leads heard, one team quiet, Grasp at 75% of the 80% go. Admin at `/setup` as admin@acme.test, Grasp's side at `/onboarding` as staff@grasp.test
- `vp run check:ui`: `packages/ui` is Damsko's at the pinned commit (`packages/ui/damsko.json`), byte for byte, but the files `packages/ui/local-changes.json` lists
- `vp run ui:update [commit|tag]`: install every Damsko item again, at the pin or at a commit on Damsko's `main` or a release tag (`v0.2.0`), with the shadcn CLI, unpack its fonts and carry the listed changes over, all or nothing; review `git diff` after it
- `vp run ui:propose`: write the listed changes as a patch for Damsko, and print the commands that open its pull request there
- `vp run check:app-kit`: `packages/app-kit` is what the registry's CLI installs for its style, by the hashes in `packages/app-kit/registry.json`, but the files `packages/app-kit/local-changes.json` lists; `vp run app-kit:update` installs every component and the theme again and pins them (network), leaving each listed file's new registry copy beside it to carry the change over
- `vp run -r typegen`: regenerate `worker-configuration.d.ts` after changing a `wrangler.jsonc`
- `vp run -r db:generate`: generate migrations after changing a schema

CI fails when generated files (Worker types, route trees, migrations) are not committed.

Vite+ docs: `node_modules/vite-plus/docs`.

## Conventions

- **Commits and PR titles** follow [Conventional Commits](https://www.conventionalcommits.org): `feat(core): …`, `fix(connect): …`, `chore(deps): …`. Scope is the app or package name. PRs are squash-merged, so the PR title is the commit on `main` and the release note. A `commit-msg` hook and CI enforce it.
- **Dependencies**: versions live in the `catalog` in `pnpm-workspace.yaml`, pinned exactly; packages reference them as `catalog:`. New versions wait 3 days (pnpm and Renovate). Only packages listed under `allowBuilds` may run install scripts.
- **No dev docs in the repo**: plans, ADRs, design notes and research live outside it. The Markdown allowed is `README.md`, this file, `.github/` templates, skills, and the SDK docs in `apps/docs/content/`, which ship with each release; CI enforces it. Docs change in the same pull request as the code they describe, and their code examples are type-checked against the SDK in CI. Put the why in code comments where the decision sits, and in PR descriptions.
- **Secrets**: never commit secrets, client names or client configuration; secretlint checks every commit and CI. Local secrets go in `.dev.vars` (see `.dev.vars.example`). Authenticate Wrangler through the 1Password shell plugin.
- **No compatibility code for the past**: until the first client release, no backfills, legacy fallbacks, readers for formats older than the current release, or dead code. Refuse an old stored format clearly instead (bump the format, "publish again"). The one exception is the release-to-release window below.
- **Schemas** (the exception) follow expand, then contract: add first, remove in a later release. Code must work against both the old and the new schema. This holds for Durable Object SQLite too, because the admin can roll a client back to an earlier release: add columns as nullable, and drop or rename in a later release.
- **No feature flags**: a feature works by default once it merges, in development too. Don't add a flag or a kill switch.
- **No AI attribution**: no co-author trailers or "generated with" lines in commits or pull requests.
- **Never skip the git hooks** (`--no-verify`), and never loosen a lint rule to make code pass, except where this file names the exception: fix the code.

## How we build

- **Simplest design that is secure.** KISS and DRY. No features, settings or toggles nobody asked for, and no validation beyond checking input at the boundary; a fixed choice is a constant in code.
- **Only make a change that is clearly better overall** and makes nothing worse. "Industry standard" alone is no reason.
- **Question existing code.** When reworking something, don't port a piece because it exists. If it has little value or isn't a common pattern, remove it, and say what you dropped and why in the pull request.
- **Stable IDs.** References use a stable key; a rename changes only a label and never breaks anything.
- **Use the library's feature**, don't build our own version of it. Change our design so the library works as designed.
- **Follow standards.** Code that reads a standard format (Markdown, URLs, MIME, email headers) uses a conformant parser, or follows the specification's grammar exactly. When a review finds a second edge case in a hand-written rule, replace the rule.
- **Allow and audit over blocking.** Sensible defaults; block only where the risk is severe and obvious. Audit records must be correct: one event per action with who, what and counts, not one per affected item. No arbitrary caps on how much someone may store or list; paging covers size. Limits that protect the platform (request bodies, model tokens, uploads) stay.
- **Content only one person may read** (their chats, their personal documents) is stored only where that person alone can reach it, such as their own Durable Object.

## Branches and pull requests

Trunk-based: `main` is the only long-lived branch; every merge deploys core and connect to staging. The admin and router, in the same Cloudflare account, deploy to staging on every merge to `main` too; production's are deployed only through the manual Deploy platform workflow. Releases reach clients through the admin, channel by channel: Edge, then Beta, then Stable.

1. Branch from `main` as `<type>/<kebab-description>`, e.g. `feat/audit-export`, using the commit types. A pre-push hook and CI check the name.
2. Open a **draft** pull request into `main`. CI runs the fast checks.
3. Have the diff reviewed by a reviewer that didn't write it (a fresh agent with no context from the author is fine) for correctness, simplicity and security. Fix what it finds and review again, until a round finds nothing of medium severity or worse.
4. Label it: `Security` when it changes who can see or do what (permissions, audiences, staff access, sign-in, tokens, the sandbox, secrets, the audit log, egress, CI); `Complexity: High` for a schema change with data risk, a cross-app or SDK contract, workflow durability or a risk of data loss. The `Review tier` workflow sets labels from size and paths and never lowers them; don't remove or lower one yourself.
5. `Security` or `Complexity: High` pull requests get one Greptile review, last, on a head that won't change: mark ready and comment `@greptileai review`. Merge at 5/5 with no open notes; a `Security` pull request also needs a security review that starts from its threat model, and one for a Linear issue labelled Security waits for a person's review before merge. Greptile is paid per review: never ask on a draft, and ask again only after fixing a P0 or P1 finding.
6. Nick and Jakob are requested as reviewers (CODEOWNERS); the ruleset doesn't require an approval. Resolve every review thread: an open one keeps the pull request out of the queue.
7. Add it to the merge queue (`gh pr merge --squash --auto --match-head-commit <sha>`, so a later push can't merge unreviewed), which runs the full suite on top of the latest `main` and squash-merges it. No need to keep the branch up to date by hand.

Nobody pushes to `main` directly. In an emergency, organisation owners can merge a pull request without a second review or passing checks; GitHub records every bypass. Use it only when waiting would do more harm. The rules live in `.github/rulesets/`; apply changes with `vp run github:setup`.

Conflicts: rebase your branch on `main`. For generated files (lockfile, Worker types, route trees) take either side and regenerate (`vp install`, `vp run -r typegen`, `vp run -r build`) instead of merging by hand. Migrations are different: keep `main`'s, delete your branch's, and run `vp run -r db:generate` again so yours come after them. A migration on `main` never changes; `vp run check:migrations` enforces it.

## Working from Linear

Work is planned in Linear (workspace Grasp OS, team GRA), not in this repo. Issues spent 6 to 15 October 2026 in Shipmunk and came back with new numbers: find an issue by its title, not by a number from an older commit, pull request or note.

- Only pick up issues in **Todo**; their blockers are done. Parent issues are containers; never pick one up.
- Move the issue to **In Progress** when you start and to **In Review** when the pull request is ready, with the pull request linked. Branch names and PR titles don't carry the issue ID, so move issues by hand.
- Linear is the project's history. Record a decision or a change of scope as a comment on the issue, and file a follow-up (an audit finding, a fix to merged work) as an issue linked to the one it extends before starting it.
- When your issue is **Done**, move any issue it blocked to **Todo** once all of that issue's blockers are done.
- Issues labelled **Security** are reviewed by a person before merge.
- Don't follow an issue blindly: if its scope conflicts with this file or the code, raise it in the issue.

## Architecture rules

- Every external call goes through connect; every model call through the model gateway in core.
- Agents and Apps start with access to nothing; every resource needs an explicit permission. The one exception is the Brain: every agent, App and workflow reads it by default, as the person it acts for in that person's own chat, and otherwise only what everyone in the company may read.
- Anything that runs on its own is a workflow. Pages never run in the background or register hooks.
- Workflow code imports only `@grasp-os/sdk`, never `@grasp-os/runtime`.
- Only use platform APIs that also run on workerd. Platform services sit behind adapter interfaces so the on-prem profile can swap them.
- EU jurisdiction is set when a resource is created (R2 `jurisdiction`, Durable Object `jurisdiction("eu")`, D1 location).
- All React is compiled by the React Compiler, and the build fails on anything it can't compile. Don't write `useMemo`, `useCallback` or `memo` by hand; if the compiler rejects a component, fix the component. The kit's registry files keep upstream's code as written, hooks included, and change only where the compiler rejects it (`packages/app-kit/local-changes.json`). The one exception is a `@grasp-os/app-kit` component that uses a library the compiler itself lists as incompatible: opt out that component alone with `"use no memo"`, say why in a comment, list its file in the compiler's `kitOptOuts`, and turn off `react/incompatible-library` for that file alone. App code never opts out.
- UI uses its design system's components and tokens (Design, below): Damsko's in `apps/web`, the kit's on App pages. No raw colours, arbitrary values or inline styles; `@shadcn/lint` names the kit's component, variant or token to use instead.

## Design

Two design systems, one on each side of an App page's frame. `apps/web` and `apps/admin` are drawn with Damsko (`@grasp-os/ui`, `packages/ui`): its components, its icons (`@grasp-os/ui/lib/icons`) and its tokens (`@grasp-os/ui/lib/tokens.stylex`), styled with StyleX; neither imports the kit, Lucide or Tailwind (lint refuses them). App pages are built with `@grasp-os/app-kit` and run in core's page frame with the CSS the compiler builds for them, so nothing of the kit's styles reaches either document. The admin's frame is Damsko's AppShell (`app-shell-01`), filled with the admin's places in `apps/admin/src/admin/frame.tsx` (nothing imported from `apps/web`), and its pages share a few compositions in `apps/admin/src/admin` (`data-rows.tsx`, a table that becomes cards on a phone; `next-row.tsx`, a page's one next step; `figures.tsx` and `page-part.tsx`, figures and parts straight on the page).

- **Damsko** (`packages/ui`) is the design system of `apps/web` and `apps/admin`. Its files are Damsko's source, installed with the shadcn CLI (`@damsko/<item>`, `packages/ui/components.json`) and updated by `vp run ui:update <commit>`, every installed item at once, never one alone and never `shadcn add --all`. CI fails on any file that differs from the pin and isn't listed in `packages/ui/local-changes.json` (`vp run check:ui`). The lint and format settings for `packages/ui` are Damsko's own, so its files pass unchanged. A page places a Damsko component through its `style` prop, with StyleX styles of layout properties made by `stylex.create` in the page's own file or in a styles module of the feature (`styles.ts`, `*.styles.ts` or `*-styles.ts`, which exports nothing else), never a wrapper element; a component of the feature's that is placed the same way takes `style?: LayoutStyle` (from `@grasp-os/ui/lib/utils`) and passes it on. The prop's type holds it to layout, and `grasp/no-inline-styles` refuses inline style objects everywhere and lets StyleX styles through only to the `style` of Damsko's components, the feature's own and those the file declares itself, never another package's (the kit's, the router's `Link`, also when a module of the feature re-exports it) (`scripts/lint/layout-style.ts` lists what it reads as StyleX styles). Its light and dark follow the root's `data-mode`, which `apps/web/public/theme.js` (and the admin's own `public/theme.js`) writes beside the `dark` class, the scheme as it resolves, which an App page's frame (`pages/page-bridge.ts`) and the drawings on a canvas follow; its fonts are files in `packages/ui/src/styles/fonts`. It knows nothing of Grasp (no Lingui, no router, no `@grasp-os/*`): what a component says itself comes from its `I18nProvider`, filled from Lingui in `apps/web/src/frame/ui-words.tsx`, and a need a component doesn't cover is a component in the feature that owns it.
- **`apps/web` uses nothing else.** Nothing of the kit, Lucide or Tailwind: `no-restricted-imports` refuses their imports, its tests' too, and `grasp/no-class-strings` a class list in JSX, which styles nothing there. The kit's App page parts are tested in the kit (`packages/app-kit/test`). Its stylesheet (`src/styles.css`) is Damsko's base, tokens, themes and fonts, and the few rules that hold for every page: no scrollbars, light on paper, the page an export prints, and the Brain's warm light (`--brain-heat`, `--brain-glow`), its own values until Damsko has such a colour.
- **Changing a Damsko file here**, when a feature needs it before Damsko has it: edit, add or remove it under `packages/ui/src` (never a font), list it in `packages/ui/local-changes.json` (`path`, a one-line `reason`, `since`: the day), run `vp run ui:propose` and open Damsko's pull request with the commands it prints, then add its address as `pullRequest`. Once it merges, `vp run ui:update <commit>` drops, keeps or re-applies each entry, or leaves git's conflict markers to resolve. `check:ui` fails for an unlisted difference and a stale entry, and names one older than 14 days (`scripts/ui-sync.ts` has the details).
- **The kit** (`packages/app-kit`), for App pages, is not Grasp's look: it is every component the registry installs for its default style (`base-nova`, `packages/app-kit/components.json`), and the theme its CLI's init writes (`packages/app-kit/src/styles.css`, neutral, light and dark, in Geist), byte for byte but for the changes `packages/app-kit/local-changes.json` lists, each with its reason and test, which `vp run check:app-kit` holds against the hashes in `packages/app-kit/registry.json`. Those files keep the CLI's code style: the formatter and the linter leave them alone. A change needs a reason the frame or a test gives: the frame (core's `pageFramePolicy`) refuses `innerHTML` (Trusted Types, no policy), cookies (an opaque origin), form submission and the clipboard, and allows inline styles; the React Compiler must compile every file. A component the frame can't run is left out with its reason (`excluded` in `registry.json`). Update with `vp run app-kit:update` after checking which style the registry's docs name as its default. Beyond the registry it has only what is bound to the SDK: the form and its fields (`@grasp-os/app-kit/form`), `data-grid` and `rich-text`, drawn with the registry's parts. No layout components: pages lay out with Tailwind's classes on plain elements. Add no token, variant or component of Grasp's own. The compiler gives a page the theme's font as a `data:` URL (its Latin face, `packages/compiler/build.ts`), as the frame takes fonts no other way, and recharts as the kit's own module, so a page imports it from `recharts` as the chart's docs do.
  - **Components own their look.** A page picks a component's variant and size and places it with layout classes; the compiler's design checks (`packages/compiler/src/classes.ts`) refuse the rest on App pages, as `@shadcn/lint` (`no-restyle`, `no-arbitrary-values`, `no-raw-colors`, `require-static-classes`) does in the repo. These hold App code, not the kit's registry files, whose inline styles (a chart's colours, an aspect ratio) the frame allows.
- **Motion**: each answer over within 300 ms, on Damsko's `duration` tokens in `apps/web` and `apps/admin`; `grasp/no-slow-motion` holds it for Motion's `transition` and `animate` durations (StyleX's durations by review), turned off only for what is seen once or rare, with the reason, in `vite.config.ts`. The kit moves as the stock default components do. A stylesheet's own animations and keyframes are checked by review. Under reduced motion nothing slides, grows or glides.

## Translations

The frontend (`apps/web`) speaks English, German, Dutch, Spanish and French through Lingui. English is written in the code; `vp run -r i18n:extract` collects it into `apps/web/src/locales/<locale>/messages.po`, and CI fails when a catalog isn't up to date. `locales.test.ts` fails when a language lacks a message or a translation drops a placeholder.

- JSX text in `<Trans>`; attributes and strings in a component with `t` from `useLingui()` (both from `@lingui/react/macro`). Outside components, `msg` from `@lingui/core/macro`, read with `i18n._()` from `@lingui/core` when rendering, never at module load.
- Whole sentences only, never glued fragments. Counts go through `plural`. Name placeholders after what they hold: a local `const date = …` gives translators `{date}`, not `{0}`.
- Lists through `formatList` (`apps/web/src/format.ts`), not `join(", ")` inside a message.
- Not translated: product and company names, people's names, what someone typed, core's own error messages, and text whose exact words are recorded (the Composio consent).
- `@grasp-os/ui` (Damsko) has its own few words in English: give a part's translations in `apps/web/src/frame/ui-words.tsx` in the pull request that first uses the part.
- `@grasp-os/app-kit` stays free of Lingui (App pages use it): the registry's components keep their few English words as upstream has them; the kit's own parts (form, data grid) speak the five languages and take `text` to say them otherwise.
- Every new message needs all four translations in the same pull request.

## Testing

Test what the code does, at real boundaries, never how it does it.

- **Integration tests in workerd are the default.** Go in through public interfaces: a Worker request, an RPC call, a Durable Object, a workflow run. Mock only outside systems (model providers, Microsoft Graph, Composio), never our own modules.
- **Playwright for critical user journeys only**, end to end, with a trace as the artifact.
- **Isolated unit tests only for pure logic**: permission evaluation, the audit hash chain, parsers.
- **Security-critical code starts from its threat model.** For the sandbox, permissions and connectors, write the ways it can fail first, including deliberate attacks, then the code.
- **Durability is tested by breaking things**: kill a run mid-step, restart the engine, replay events, retry with the same idempotency key.
- **No tautological tests.** Asserting what a mock was told to return, or re-implementing the code under test, proves nothing.
- **No change-detector tests.** Don't assert call order, internal structure or implementation snapshots; a refactor that keeps behaviour must keep tests green.
- **No absence tests.** Removing something needs no test that it's gone: no checks on an old export, a file or a name in the source. Where a removal matters, test the behaviour (the endpoint answers 404).
- **Concurrency and recovery claims** (conditional writes, retries, resumed runs) need a deterministic race or integration test through the real path.
- **Bug fixes close a behaviour gap.** Find the behaviour test that should have caught the bug and fix or extend it. Add a new test only for behaviour nothing covers; never a test named after a bug.
- Keep suites flat, use async/await, and never commit `.only` or `.skip`.
- Locally, run the test files you touched (`vp test <files> --maxWorkers=2`) and `vp check`; the merge queue runs everything. Run Playwright locally (`vp run e2e`, `vp run e2e:admin`) only when `apps/web`, `apps/admin` or `e2e/` changed.

<!-- ultracite:start — generated by `ultracite init --agents universal` (Ultracite 7.12.0); commands adapted to Vite+, testing rules moved to Testing above -->

## Code standards (Ultracite)

This project uses **Ultracite** presets for Oxlint and Oxfmt, loaded through Vite+ in `vite.config.ts`. Run `vp check --fix` to format and fix; most issues are fixed automatically. Full reference: `node_modules/ultracite/skills/ultracite/references/code-standards.md`.

Write code that is **accessible, performant, type-safe, and maintainable**. Focus on clarity and explicit intent over brevity.

### Type safety and explicitness

- Use explicit types for function parameters and return values when they enhance clarity
- Prefer `unknown` over `any` when the type is genuinely unknown
- Use const assertions (`as const`) for immutable values and literal types
- Leverage TypeScript's type narrowing instead of type assertions
- Use meaningful variable names instead of magic numbers; extract constants with descriptive names

### Modern JavaScript/TypeScript

- Use arrow functions for callbacks and short functions
- Prefer `for...of` loops over `.forEach()` and indexed `for` loops
- Use optional chaining (`?.`) and nullish coalescing (`??`) for safer property access
- Prefer template literals over string concatenation
- Use destructuring for object and array assignments
- Use `const` by default, `let` only when reassignment is needed, never `var`

### Async and promises

- Always `await` promises in async functions; don't forget to use the return value
- Use `async/await` syntax instead of promise chains
- Handle errors appropriately in async code with try-catch blocks
- Don't use async functions as Promise executors

### React and JSX

- Use function components over class components
- Call hooks at the top level only, never conditionally
- Specify all dependencies in hook dependency arrays correctly
- Use the `key` prop for elements in iterables (prefer unique IDs over array indices)
- Nest children between opening and closing tags instead of passing as props
- Don't define components inside other components
- Use ref as a prop instead of `React.forwardRef` (React 19)
- Use semantic HTML and ARIA attributes for accessibility: meaningful alt text, proper heading hierarchy, labels for form inputs, keyboard handlers alongside mouse events, semantic elements (`<button>`, `<nav>`) instead of divs with roles

### Error handling and debugging

- Remove `console.log`, `debugger`, and `alert` statements from production code
- Throw `Error` objects with descriptive messages, not strings or other values
- Use `try-catch` blocks meaningfully; don't catch errors just to rethrow them
- Prefer early returns over nested conditionals for error cases

### Code organization

- Keep functions focused and under reasonable cognitive complexity limits
- Extract complex conditions into well-named boolean variables
- Use early returns to reduce nesting
- Prefer simple conditionals over nested ternary operators
- Group related code together and separate concerns

### Security

- Add `rel="noopener"` when using `target="_blank"` on links
- Avoid `dangerouslySetInnerHTML` unless absolutely necessary
- Don't use `eval()` or assign directly to `document.cookie`
- Validate and sanitize user input

### Performance

- Avoid spread syntax in accumulators within loops
- Use top-level regex literals instead of creating them in loops
- Prefer specific imports over namespace imports
- Avoid barrel files (index files that re-export everything)

### When the linter can't help

Focus your attention on business logic correctness, meaningful naming, architecture decisions (component structure, data flow, API design), edge cases and error states, user experience (accessibility, performance, usability), and documentation (comment complex logic, but prefer self-documenting code).

<!-- ultracite:end -->
