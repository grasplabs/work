# @grasp-os/ui

Damsko ([grasplabs/damsko](https://github.com/grasplabs/damsko)), Grasp's design system, installed here as source from its registry with the stock shadcn CLI: StyleX on UI SDK. `apps/web` and `apps/admin` import it as `@grasp-os/ui/components/<name>`, `@grasp-os/ui/blocks/<name>`, `@grasp-os/ui/lib/<name>` and `@grasp-os/ui/hooks/<name>`.

The files under `src/` are Damsko's, byte for byte, at the commit `damsko.json` pins, except those `local-changes.json` lists. The code here is this repository's own: change it when a feature needs to, list the change, and send it back to Damsko.

| File | What it holds |
| --- | --- |
| `damsko.json` | `commit`: the commit of Damsko every file equals; `items`: the items added by name (the items they build on come with them) |
| `components.json` | the CLI's settings: the `@damsko` registry and where its files land |
| `local-changes.json` | the files changed here on purpose, one entry each |
| `package.json` | the packages the installed items name, each at `catalog:` |

## Commands

Run from the repository root.

| Command | What it does |
| --- | --- |
| `vp run check:ui` | fails where `src/` is not Damsko's at the pin and `local-changes.json` doesn't list the file, and on a listed file that no longer differs; names an entry older than 14 days without failing. CI runs it. |
| `vp run ui:update [commit]` | installs every item again with `shadcn add --overwrite`, at the pin or at a new commit (which becomes the pin), unpacks the fonts, carries each listed change over, then checks |
| `vp run ui:propose` | writes the listed changes as one patch against Damsko at the pin and prints the commands that open its pull request there; pushes nothing itself |

Never `shadcn add` one item alone or `shadcn add --all` (which reads shadcn's own registry): to add an item, put its name in `damsko.json`'s `items`, the packages it names in the catalog and in `package.json` as `catalog:`, then `vp run ui:update`.

## Changing a Damsko file here

1. Edit the file under `src/` in the feature's pull request. A file may also be added or removed.
2. List it in `local-changes.json`:

   ```json
   [
     {
       "path": "src/components/button.tsx",
       "reason": "Holds its width while pending, for the inbox's Grant.",
       "since": "2026-11-23"
     }
   ]
   ```

   `path` is the file's path in this package, `reason` one line on why, `since` the day it was listed. `check:ui` passes for it from then on, and still fails for any difference not listed.

3. `vp run ui:propose` writes the patch: each listed file maps to Damsko's file at the same path. Open the pull request in Damsko with the commands it prints, then add its address to the entry as `pullRequest`.
4. When Damsko has merged it, move the pin (`vp run ui:update <commit>`). For each entry, the update compares this repository's file with Damsko's at the old pin and at the new one:
   - Damsko's file is now the same: the entry is dropped.
   - Damsko left the file as it was: the change stays.
   - Damsko changed other lines: the change is applied again on top of Damsko's.
   - Damsko changed the same lines: the file is left with git's conflict markers (`here`, `pinned`, `Damsko`), the entry stays, and the update fails. Resolve the markers by hand and run `vp run check:ui`.

   Review `git diff` after it.

5. A listed file that equals Damsko's fails `check:ui`: remove its entry. An entry listed for over 14 days is named on every check: with no `pullRequest`, propose it; with one, move the pin once it merges.
