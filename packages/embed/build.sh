#!/usr/bin/env bash
# Builds src/embed.wasm from rust/ and writes its SHA-256 to
# src/wasm-sha256.ts, both committed: `vp run build:wasm` in packages/embed
# after changing rust/. CI's embed-wasm job runs it again and fails unless
# both come out byte for byte as committed, so the module every deployment
# runs is this source's. Needs rustup; the toolchain is the one
# rust/rust-toolchain.toml pins, installed on first use.
#
# What the bytes depend on, each fixed here or in rust/: the toolchain, the
# target and its features, the release profile (Cargo.toml) and the flags
# below. The crate has no dependencies.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd -P)"
cd "$here/rust"
rustup show active-toolchain > /dev/null 2>&1 || rustup toolchain install
# - simd128 and relaxed-simd: the kernels (src/encoder.rs).
# - Paths in panic locations name the crate, not this machine's directories.
# - At most 64 MiB of memory (1,024 pages), half an isolate's 128 MB: the
#   spike's model takes 26 MiB.
flags="-C target-feature=+simd128,+relaxed-simd --remap-path-prefix=$here/rust=rust --remap-path-prefix=$HOME=~ -C link-arg=--max-memory=67108864"
RUSTFLAGS="$flags" cargo build --quiet --locked --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/grasp_embed.wasm "$here/src/embed.wasm"
sha256="$(shasum -a 256 "$here/src/embed.wasm" | cut -d ' ' -f 1)"
# As the formatter lays it out.
cat > "$here/src/wasm-sha256.ts" << EOF
// Written by build.sh with embed.wasm: the module's SHA-256, part of every
// vector's build identifier (model-files.ts).
export const wasmSha256 =
  "$sha256";
EOF
echo "src/embed.wasm: $(wc -c < "$here/src/embed.wasm" | tr -d ' ') bytes, SHA-256 $sha256"
