#!/usr/bin/env bash
# Builds oxc.wasm (src/lib.rs) inside oxc's own workspace at the tag of
# the oxlint pin.json names (oxlint and oxfmt are released together from
# it), with oxc's own Rust toolchain (its rust-toolchain.toml) and release
# profile: `build.sh <out file>`. Run by the Build oxc WASM
# workflow, which publishes the result; installs and builds only download
# it (wasm.ts). Needs git, rustup and jq.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
out="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
tag="oxlint_v$(jq -r .oxlint "$here/pin.json")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

git clone --quiet --depth 1 --branch "$tag" https://github.com/oxc-project/oxc.git "$work/oxc"
mkdir -p "$work/oxc/napi/grasp_oxc_wasm"
cp -R "$here/Cargo.toml" "$here/src" "$work/oxc/napi/grasp_oxc_wasm/"
cd "$work/oxc"
rustup target add wasm32-wasip1
# Paths in panic messages name the crates, not this machine's directories.
RUSTFLAGS="--remap-path-prefix=$work/oxc=oxc --remap-path-prefix=$HOME=~" \
  cargo build --release --target wasm32-wasip1 -p grasp_oxc_wasm
cp target/wasm32-wasip1/release/grasp_oxc_wasm.wasm "$out"
