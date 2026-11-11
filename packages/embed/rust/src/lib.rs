//! The embedder's WebAssembly: a ModernBERT-style embedding model's tokenizer and encoder, for wasm32 with simd128
//! and relaxed-simd. The host (../../src/engine.ts) copies the encoder and tokenizer files into this module's
//! memory once, then for each text writes it into `text_buf`, tokenizes it, looks the tokens' rows up in its own
//! storage, writes them into `rows_buf` and runs `forward`. The token table never enters this memory.
//!
//! One model per instance: a failed `model_init` or `tok_init` leaves the instance unusable, and the host starts a
//! fresh one.
#![allow(static_mut_refs)]
mod encoder;
mod simd;
mod tokenizer;

use encoder::{Kernel, Model, RowFormat};
use std::alloc::{Layout, alloc_zeroed, handle_alloc_error};
use tokenizer::Tok;

static mut MODEL: Option<Model> = None;
static mut TOK: Option<Tok> = None;
static mut TEXT: *mut u8 = core::ptr::null_mut();
static mut IDS: Vec<i32> = Vec::new();
static mut KERNEL: Option<Kernel> = None;
/// The most UTF-8 bytes of one text the tokenizer reads: far more than max tokens' worth of any text.
const TEXT_CAP: usize = 1 << 18;

/// Zeroed memory for `size` bytes, 16-aligned, never freed. Traps when the memory can't grow to it (its cap is
/// 64 MiB, build.sh), so a model that doesn't fit is never copied over address 0 or run on missing buffers: the
/// host sees the trap and drops the instance.
#[unsafe(no_mangle)]
pub extern "C" fn alloc(size: usize) -> *mut u8 {
    let Ok(layout) = Layout::from_size_align(size.max(16), 16) else { core::arch::wasm32::unreachable() };
    let p = unsafe { alloc_zeroed(layout) };
    if p.is_null() {
        handle_alloc_error(layout);
    }
    p
}

/// Reads the encoder file the host copied to `base` (it stays there). 0, or a negative error: -1 not an encoder
/// file of this version, -2 a shape this runtime doesn't run, -3 sizes that don't add up.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn model_init(base: *const u8, len: usize) -> i32 {
    match unsafe { Model::parse(base, len) } {
        Ok(m) => {
            unsafe {
                IDS = vec![0; m.max_tokens()];
                MODEL = Some(m);
            }
            0
        }
        Err(e) => e as i32,
    }
}

/// Reads the tokenizer file the host copied to `base` (it stays there). 0, or -1 when it isn't a consistent
/// tokenizer file of this version.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tok_init(base: *const u8, len: usize) -> i32 {
    let blob: &'static [u8] = unsafe { core::slice::from_raw_parts(base, len) };
    match Tok::parse(blob) {
        Some(t) => {
            unsafe { TOK = Some(t) };
            0
        }
        None => -1,
    }
}

/// The model's output width.
#[unsafe(no_mangle)]
pub extern "C" fn dim() -> usize {
    unsafe { MODEL.as_ref().map_or(0, |m| m.dim()) }
}
/// The most tokens the model reads, `<bos>` and `<eos>` included.
#[unsafe(no_mangle)]
pub extern "C" fn max_tokens() -> usize {
    unsafe { MODEL.as_ref().map_or(0, |m| m.max_tokens()) }
}
/// The most bytes of text one token covers (the host's buffer rule, engine.ts).
#[unsafe(no_mangle)]
pub extern "C" fn longest_token() -> usize {
    unsafe { TOK.as_ref().map_or(0, |t| t.longest_token()) }
}
/// The tokenizer's vocabulary size: the token table has as many rows.
#[unsafe(no_mangle)]
pub extern "C" fn vocab_size() -> usize {
    unsafe { TOK.as_ref().map_or(0, |t| t.vocab_size()) }
}

/// Which integer kernels run: 0 as this CPU runs fastest (the i16-pair kernels on x86 without VNNI, the i32 dot
/// otherwise), 1 the i32 dot, 2 the i16 pairs. Every choice gives the same bits; the choice exists for that test.
#[unsafe(no_mangle)]
pub extern "C" fn set_kernel(k: u32) {
    let kernel = match k {
        1 => Kernel::Dot,
        2 => Kernel::Pairs,
        _ if encoder::saturating_pairs() => Kernel::Pairs,
        _ => Kernel::Dot,
    };
    unsafe { KERNEL = Some(kernel) }
}

/// Where the host writes a text's UTF-8 bytes, `text_cap` at most.
#[unsafe(no_mangle)]
pub extern "C" fn text_buf() -> *mut u8 {
    unsafe {
        if TEXT.is_null() {
            TEXT = alloc(TEXT_CAP);
        }
        TEXT
    }
}
#[unsafe(no_mangle)]
pub extern "C" fn text_cap() -> usize {
    TEXT_CAP
}

/// Tokenizes the UTF-8 text in text_buf[0..len] into `ids_buf`, `<bos>` and `<eos>` included and truncated to the
/// model's max tokens. Returns the count.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tokenize(len: usize) -> usize {
    unsafe {
        let (Some(t), Some(m)) = (TOK.as_ref(), MODEL.as_ref()) else { return 0 };
        let s = core::slice::from_raw_parts(text_buf(), len.min(TEXT_CAP));
        let ids = t.encode(s, m.max_tokens().max(2));
        for (i, &id) in ids.iter().enumerate() {
            IDS[i] = id as i32;
        }
        ids.len()
    }
}
#[unsafe(no_mangle)]
pub extern "C" fn ids_buf() -> *const i32 {
    unsafe { IDS.as_ptr() }
}

/// Where the host writes the n token rows for `forward`, one after another in the row format it names.
#[unsafe(no_mangle)]
pub extern "C" fn rows_buf() -> *mut u8 {
    unsafe { MODEL.as_ref().map_or(core::ptr::null_mut(), |m| m.rows_buf()) }
}

/// Runs the encoder on the n token rows in `rows_buf` (`fmt`: 0 float32, 1 int8 with a float32 scale in front).
/// Returns a pointer to the L2-normalised embedding (`dim` floats), or null for n outside 1..=max tokens or an
/// unknown format.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn forward(n: usize, fmt: u32) -> *const f32 {
    unsafe {
        let (Some(m), Some(fmt)) = (MODEL.as_ref(), RowFormat::from(fmt)) else { return core::ptr::null() };
        if n == 0 || n > m.max_tokens() {
            return core::ptr::null();
        }
        if KERNEL.is_none() {
            set_kernel(0);
        }
        encoder::forward(m, KERNEL.unwrap(), n, fmt)
    }
}
