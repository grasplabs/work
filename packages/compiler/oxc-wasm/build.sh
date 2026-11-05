#!/usr/bin/env bash
# Builds oxc.wasm (src/lib.rs) inside oxc's own workspace at the commit
# pin.json names (`oxc`, the commit of tag oxlint_v<oxlint>, which
# releases oxlint and oxfmt together; fetched by commit, as a tag can
# move), with oxc's own Rust toolchain (its rust-toolchain.toml, an exact
# version), its Cargo.lock and its release profile: `build.sh <out file>`.
# Run by the Build oxc WASM workflow, which publishes the result; installs
# and builds only download it (wasm.ts). Needs git, rustup and jq.
#
# What the bytes depend on, each fixed here or by the commit: the
# toolchain, the target, the flags below and oxc's own for the target
# (`+simd128`, which `--config` adds to rather than replaces, as
# `RUSTFLAGS` would), and every crate's version (Cargo.lock, which may
# gain only this crate).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
out="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
commit="$(jq -r .oxc "$here/pin.json")"
# Its real path, as rustc sees it (macOS's temporary folder is a link).
work="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$work"' EXIT

git init --quiet "$work/oxc"
cd "$work/oxc"
git fetch --quiet --depth 1 https://github.com/oxc-project/oxc.git "$commit"
git checkout --quiet FETCH_HEAD
mkdir -p napi/grasp_oxc_wasm
cp -R "$here/Cargo.toml" "$here/src" napi/grasp_oxc_wasm/
rustup target add wasm32-wasip1
# - Paths in panic messages name the crates, not this machine's directories.
# - A memory of at most 64 MiB (1,024 pages), half an isolate's 128 MB: a
#   file that needs more traps, and src/oxc.ts starts a fresh instance.
cargo build --release --target wasm32-wasip1 -p grasp_oxc_wasm \
  --config "target.wasm32-wasip1.rustflags=[\"--remap-path-prefix=$work/oxc=oxc\", \"--remap-path-prefix=$HOME=~\", \"-C\", \"link-arg=--max-memory=67108864\"]"
# oxc's lock, with only this crate added: no dependency resolved anew.
if git diff -U0 Cargo.lock | grep -Eq '^-([^-]|$)' ||
  [ "$(git diff -U0 Cargo.lock | grep -c '^+\[\[package\]\]')" != 1 ] ||
  ! git diff -U0 Cargo.lock | grep -q '^+name = "grasp_oxc_wasm"$'; then
  echo "Cargo.lock changed beyond adding grasp_oxc_wasm:" >&2
  git diff Cargo.lock >&2
  exit 1
fi
cp target/wasm32-wasip1/release/grasp_oxc_wasm.wasm "$out"
