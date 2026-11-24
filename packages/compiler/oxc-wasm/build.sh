#!/usr/bin/env bash
# Builds oxc.wasm and oxc-parse.wasm (src/lib.rs) inside oxc's own
# workspace at the commit pin.json names (`oxc`, the commit of tag
# oxlint_v<oxlint>, which releases oxlint and oxfmt together; fetched by
# commit, as a tag can move), with oxc's own Rust toolchain (its
# rust-toolchain.toml, an exact version), its Cargo.lock and its release
# profile: `build.sh <oxc.wasm out> <oxc-parse.wasm out>`. Run by the
# Build oxc WASM workflow, which publishes oxc.wasm; installs and builds
# only download it (wasm.ts). oxc-parse.wasm is committed
# (packages/runtime/src/oxc-parse.wasm), and CI's oxc-wasm job builds it again
# and compares. Needs git, rustup and jq.
#
# What the bytes depend on, each fixed here or by the commit: the
# toolchain, the target, the flags below and oxc's own for the target
# (`+simd128`, which `--config` adds to rather than replaces, as
# `RUSTFLAGS` would), and every crate's version (Cargo.lock, which may
# gain only this crate).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
out="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
parser_out="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
commit="$(jq -r .oxc "$here/pin.json")"
# Its real path, as rustc sees it (macOS's temporary folder is a link).
work="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$work"' EXIT

git init --quiet "$work/oxc"
cd "$work/oxc"
git fetch --quiet --depth 1 https://github.com/oxc-project/oxc.git "$commit"
git checkout --quiet FETCH_HEAD
# oxc's own code, changed only where patches/ says why (each to go
# upstream): the native stack a wasm call runs on is V8's, far smaller
# than native oxlint's 8 MiB, and no flag of the module's can grow it.
for patch in "$here"/patches/*.patch; do
  git apply "$patch"
done
mkdir -p napi/grasp_oxc_wasm
cp -R "$here/Cargo.toml" "$here/src" napi/grasp_oxc_wasm/
rustup target add wasm32-wasip1 wasm32-unknown-unknown
remap="\"--remap-path-prefix=$work/oxc=oxc\", \"--remap-path-prefix=$HOME=~\""
# - Paths in panic messages name the crates, not this machine's directories.
# - A memory of at most 64 MiB (1,024 pages), half an isolate's 128 MB: a
#   file that needs more traps, and src/oxc.ts starts a fresh instance.
cargo build --release --target wasm32-wasip1 -p grasp_oxc_wasm \
  --config "target.wasm32-wasip1.rustflags=[$remap, \"-C\", \"link-arg=--max-memory=67108864\"]"
# The parser alone, for core's Worker (packages/runtime/src/oxc-parse.ts): no
# `tools`, no WASI (it imports nothing), and built for size, as what it
# parses is small: half the bytes of oxc's speed-first profile.
# - A memory of at most 16 MiB (256 pages), out of core's 128 MB: an
#   expression that needs more traps, and oxc-parse.ts starts a fresh one.
cargo build --release --target wasm32-unknown-unknown -p grasp_oxc_wasm \
  --no-default-features \
  --config 'profile.release.opt-level="z"' \
  --config "target.wasm32-unknown-unknown.rustflags=[$remap, \"-C\", \"link-arg=--max-memory=16777216\"]"
# oxc's lock, with only this crate added: no dependency resolved anew.
if git diff -U0 Cargo.lock | grep -Eq '^-([^-]|$)' ||
  [ "$(git diff -U0 Cargo.lock | grep -c '^+\[\[package\]\]')" != 1 ] ||
  ! git diff -U0 Cargo.lock | grep -q '^+name = "grasp_oxc_wasm"$'; then
  echo "Cargo.lock changed beyond adding grasp_oxc_wasm:" >&2
  git diff Cargo.lock >&2
  exit 1
fi
cp target/wasm32-wasip1/release/grasp_oxc_wasm.wasm "$out"
cp target/wasm32-unknown-unknown/release/grasp_oxc_wasm.wasm "$parser_out"
