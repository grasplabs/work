//! The encoder of a ModernBERT-style model: pre-norm layers without biases, rotary positions, GeGLU feed-forward,
//! global attention on some layers and a sliding window on the others, then a final norm, mean pooling and L2
//! normalisation. Its shape (width, heads, layers, which layers are local, the window) comes from the encoder file
//! (`parse`); only the head width is fixed, at 64.
//!
//! Two variants: float32 weights (the verification path, compared with the reference within a tolerance) and
//! int8 weights with 7-bit activations and int8 attention (what runs in production). The integer path computes
//! every float the same way on every CPU (no fused multiply-add, relaxed instructions only on inputs inside their
//! deterministic range), so its output is the same bit for bit on x86 and ARM, whichever kernel `linear` picks.
//! Kernels that matter for speed are `#[inline(never)]`: V8 has no on-stack replacement for WebAssembly, so a hot
//! function is swapped for its optimised build between calls, not inside one.
use crate::simd::*;
use core::arch::wasm32::*;

/// The width of an attention head, which the kernels below are written for.
pub const HD: usize = 64;
const HALF: usize = HD / 2;
const EPS: f32 = 1e-5;
/// Rows of activations per matrix tile.
const ROWS: usize = 4;

/// A linear layer's weights. Float: panels of 8 output channels, `[k][8]` each. Integer: per output channel
/// scales `s`, column sums `cs`, and panels `[k/4][2 halves][4 outs][4 ks]` for the relaxed dot products.
#[derive(Clone, Copy)]
struct Lin {
    w: *const u8,
    s: *const f32,
    cs: *const i32,
    nout: usize,
    k: usize,
}

struct Layer {
    local: bool,
    rope: usize,
    qkv: Lin,
    o: Lin,
    ff1: Lin,
    ff2: Lin,
    /// Per-channel gains on the inputs of qkv and ff1: the norm's weights divided by the smoothing scales folded
    /// into the weights (ones without smoothing).
    gq: *const f32,
    gf: *const f32,
    /// Feed-forward channels kept in float (the last `nod` channels of the GeGLU output; panels `[H/8][nod][8]`).
    nod: usize,
    wod: *const f32,
}

pub struct Model {
    int8: bool,
    h: usize,
    nh: usize,
    ff: usize,
    maxn: usize,
    window: usize,
    eln: *const f32,
    fln: *const f32,
    /// Rotary tables, `[maxn][HD/2]` cos and sin each, one pair per distinct rotary base.
    ropes: Vec<(*const f32, *const f32)>,
    layers: Vec<Layer>,
    /// Whether every linear layer's weights allow the i16-pair kernel exactly (`pairable`).
    pairs_exact: bool,
    b: Bufs,
}

struct Bufs {
    x: *mut f32,
    h: *mut f32,
    big: *mut f32,
    ctx: *mut f32,
    xq: *mut u8,
    xsc: *mut f32,
    xzp: *mut i32,
    rows: *mut u8,
    out: *mut f32,
    // float attention
    scores: *mut f32,
    kp: *mut f32,
    vp: *mut f32,
    // integer attention
    qq: *mut u8,
    qsc: *mut f32,
    qzp: *mut i32,
    kpan: *mut i8,
    ksc: *mut f32,
    ksum: *mut i32,
    vsc: *mut f32,
    srow: *mut f32,
    vpan16: *mut i16,
    prow16: *mut i16,
}

/// Which integer kernels run: `Dot` sums int8 products in i32 lanes (one relaxed dot each); `Pairs` sums two of
/// them in i16 lanes first and widens once, which is faster on x86 without VNNI. Both give the same bits.
#[derive(Clone, Copy, PartialEq)]
pub enum Kernel {
    Dot,
    Pairs,
}

const MAGIC_ENC: [u8; 4] = *b"GENC";
const VERSION: u32 = 1;
/// Header: magic, version, variant (0 float, 1 int8), hidden, heads, ff, layers, max tokens, window, rotary
/// tables, then one word per layer (bit 0: local; bits 8 and up: its rotary table), padded to 16 bytes.
const HEADER_WORDS: usize = 10;

pub enum InitError {
    Header = -1,
    Shape = -2,
    Size = -3,
}

fn alloc<T>(n: usize) -> *mut T {
    crate::alloc(n * core::mem::size_of::<T>()) as *mut T
}

impl Model {
    /// Reads an encoder file (see scripts/export.py) that stays where it is, at `base`, for the life of the model.
    pub unsafe fn parse(base: *const u8, len: usize) -> Result<Model, InitError> {
        let blob = unsafe { core::slice::from_raw_parts(base, len) };
        let word = |i: usize| -> Option<usize> { blob.get(i * 4..i * 4 + 4).map(|b| u32::from_le_bytes(b.try_into().unwrap()) as usize) };
        if blob.get(0..4) != Some(&MAGIC_ENC[..]) || word(1) != Some(VERSION as usize) {
            return Err(InitError::Header);
        }
        let w = |i: usize| word(i).ok_or(InitError::Header);
        let (variant, h, nh, ff, nl, maxn, window, nrope) = (w(2)?, w(3)?, w(4)?, w(5)?, w(6)?, w(7)?, w(8)?, w(9)?);
        let shape_ok = variant <= 1
            && nh > 0
            && h == nh * HD
            && ff > 0
            && ff % 16 == 0
            && nl > 0
            && nl <= 64
            && maxn > 0
            && maxn <= 8192
            && maxn % 8 == 0
            && (1..=4).contains(&nrope);
        if !shape_ok {
            return Err(InitError::Shape);
        }
        let mut kinds = Vec::with_capacity(nl);
        for l in 0..nl {
            let k = w(HEADER_WORDS + l)?;
            if k & !0xff01 != 0 || (k >> 8) >= nrope {
                return Err(InitError::Shape);
            }
            kinds.push((k & 1 == 1, k >> 8));
        }
        let int8 = variant == 1;
        let mut off = ((HEADER_WORDS + nl) * 4 + 15) & !15;
        let mut take = |bytes: usize| -> *const u8 {
            let p = unsafe { base.add(off.min(len)) };
            off += (bytes + 15) & !15;
            p
        };
        let eln = take(h * 4) as *const f32;
        let fln = take(h * 4) as *const f32;
        let mut ropes = Vec::with_capacity(nrope);
        for _ in 0..nrope {
            let c = take(maxn * HALF * 4) as *const f32;
            let s = take(maxn * HALF * 4) as *const f32;
            ropes.push((c, s));
        }
        let lin = |take: &mut dyn FnMut(usize) -> *const u8, nout: usize, k: usize| -> Lin {
            if int8 {
                let w = take(nout * k);
                let s = take(nout * 4) as *const f32;
                let cs = take(nout * 4) as *const i32;
                Lin { w, s, cs, nout, k }
            } else {
                Lin { w: take(nout * k * 4), s: core::ptr::null(), cs: core::ptr::null(), nout, k }
            }
        };
        let mut layers = Vec::with_capacity(nl);
        for &(local, rope) in &kinds {
            let qkv = lin(&mut take, 3 * h, h);
            let o = lin(&mut take, h, h);
            let ff1 = lin(&mut take, 2 * ff, h);
            // How many feed-forward channels stay in float, which sizes the rest of the layer.
            let nod_at = take(16) as usize - base as usize;
            let nod = word(nod_at / 4).ok_or(InitError::Size)?;
            if nod >= ff || (ff - nod) % 16 != 0 {
                return Err(InitError::Shape);
            }
            let ff2 = lin(&mut take, h, ff - nod);
            let gq = take(h * 4) as *const f32;
            let gf = take(h * 4) as *const f32;
            let wod = if nod > 0 { take(h * nod * 4) as *const f32 } else { core::ptr::null() };
            layers.push(Layer { local, rope, qkv, o, ff1, ff2, gq, gf, nod, wod });
        }
        if off != len {
            return Err(InitError::Size);
        }
        let mut m = Model { int8, h, nh, ff, maxn, window, eln, fln, ropes, layers, pairs_exact: false, b: Bufs::new(h, ff, maxn, int8) };
        m.pairs_exact = int8 && m.layers.iter().all(|l| [&l.qkv, &l.o, &l.ff1, &l.ff2].iter().all(|lin| unsafe { pairable(lin) }));
        Ok(m)
    }

    pub fn dim(&self) -> usize {
        self.h
    }
    pub fn max_tokens(&self) -> usize {
        self.maxn
    }
    pub fn rows_buf(&self) -> *mut u8 {
        self.b.rows
    }
}

impl Bufs {
    fn new(h: usize, ff: usize, maxn: usize, int8: bool) -> Bufs {
        let padn = maxn + 16;
        // Each path's attention buffers, only for the path the model runs.
        let float = |n: usize| if int8 { core::ptr::null_mut() } else { alloc(n) };
        fn int<T>(on: bool, n: usize) -> *mut T {
            if on { alloc(n) } else { core::ptr::null_mut() }
        }
        Bufs {
            x: alloc(padn * h),
            h: alloc(padn * h),
            big: alloc(padn * (2 * ff).max(3 * h)),
            ctx: alloc(padn * h),
            xq: alloc(padn * ff.max(h)),
            xsc: alloc(padn),
            xzp: alloc(padn),
            rows: alloc(maxn * 4 * h),
            out: alloc(h),
            scores: float(padn * padn),
            kp: float(padn * HD),
            vp: float(padn * HD),
            qq: int(int8, padn * HD),
            qsc: int(int8, padn),
            qzp: int(int8, padn),
            kpan: int(int8, padn * HD),
            ksc: int(int8, padn),
            ksum: int(int8, padn),
            vsc: int(int8, HD),
            srow: int(int8, ROWS * padn),
            vpan16: int(int8, padn * HD),
            prow16: int(int8, ROWS * padn),
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Float matmul (verification path). A panel is 8 output channels by k inputs, stored [k][8].

#[inline(always)]
unsafe fn tile_f32<const R: usize, const ADD: bool>(x: *const f32, xs: usize, k: usize, p: *const f32, y: *mut f32, ys: usize) {
    unsafe {
        let mut a0 = [f32x4_splat(0.0); R];
        let mut a1 = [f32x4_splat(0.0); R];
        for kk in 0..k {
            let w0 = ld(p.add(kk * 8));
            let w1 = ld(p.add(kk * 8 + 4));
            for r in 0..R {
                let xv = v128_load32_splat(x.add(r * xs + kk) as *const u32);
                a0[r] = fma(xv, w0, a0[r]);
                a1[r] = fma(xv, w1, a1[r]);
            }
        }
        for r in 0..R {
            let (mut v0, mut v1) = (a0[r], a1[r]);
            if ADD {
                v0 = f32x4_add(v0, ld(y.add(r * ys)));
                v1 = f32x4_add(v1, ld(y.add(r * ys + 4)));
            }
            st(y.add(r * ys), v0);
            st(y.add(r * ys + 4), v1);
        }
    }
}

/// y (+)= x P for n rows of x (stride xs) and one panel P of 8 outputs, into y (stride ys).
#[inline(never)]
unsafe fn mm_panel<const ADD: bool>(x: *const f32, xs: usize, n: usize, k: usize, p: *const f32, y: *mut f32, ys: usize) {
    unsafe {
        let mut r = 0;
        while r + ROWS <= n {
            tile_f32::<ROWS, ADD>(x.add(r * xs), xs, k, p, y.add(r * ys), ys);
            r += ROWS;
        }
        while r < n {
            tile_f32::<1, ADD>(x.add(r * xs), xs, k, p, y.add(r * ys), ys);
            r += 1;
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// int8 x u7 matmul: y[o] = sw[o] * s * (sum_k w[o,k] u[k] - zp * colsum[o]) (+ y[o] with ADD).

#[inline(always)]
unsafe fn epilogue<const R: usize, const ADD: bool>(a0: &[v128; R], a1: &[v128; R], xsc: *const f32, xzp: *const i32, y: *mut f32, ys: usize, s: *const f32, cs: *const i32) {
    unsafe {
        let (s0, s1) = (ld(s), ld(s.add(4)));
        let (c0, c1) = (v128_load(cs as *const v128), v128_load(cs.add(4) as *const v128));
        for r in 0..R {
            let xs = f32x4_splat(*xsc.add(r));
            let zp = i32x4_splat(*xzp.add(r));
            let v0 = f32x4_convert_i32x4(i32x4_sub(a0[r], i32x4_mul(zp, c0)));
            let v1 = f32x4_convert_i32x4(i32x4_sub(a1[r], i32x4_mul(zp, c1)));
            let (yo0, yo1) = if ADD { (ld(y.add(r * ys)), ld(y.add(r * ys + 4))) } else { (f32x4_splat(0.0), f32x4_splat(0.0)) };
            st(y.add(r * ys), madd(v0, f32x4_mul(s0, xs), yo0));
            st(y.add(r * ys + 4), madd(v1, f32x4_mul(s1, xs), yo1));
        }
    }
}

/// The relaxed i32 dot of int8 weights and u7 activations: exact on every CPU, as u7 inputs keep x86's saturating
/// pairs from saturating.
#[inline(always)]
unsafe fn tile_dot<const R: usize, const ADD: bool>(xq: *const u8, k: usize, xsc: *const f32, xzp: *const i32, p: *const i8, y: *mut f32, ys: usize, s: *const f32, cs: *const i32) {
    unsafe {
        let mut a0 = [i32x4_splat(0); R];
        let mut a1 = [i32x4_splat(0); R];
        for k4 in 0..k / 4 {
            let w0 = v128_load(p.add(k4 * 32) as *const v128);
            let w1 = v128_load(p.add(k4 * 32 + 16) as *const v128);
            for r in 0..R {
                let xv = v128_load32_splat(xq.add(r * k + k4 * 4) as *const u32);
                a0[r] = i32x4_relaxed_dot_i8x16_i7x16_add(w0, xv, a0[r]);
                a1[r] = i32x4_relaxed_dot_i8x16_i7x16_add(w1, xv, a1[r]);
            }
        }
        epilogue::<R, ADD>(&a0, &a1, xsc, xzp, y, ys, s, cs);
    }
}
#[inline(never)]
unsafe fn mm_dot<const ADD: bool>(xq: *const u8, xsc: *const f32, xzp: *const i32, k: usize, n: usize, p: *const i8, y: *mut f32, ys: usize, s: *const f32, cs: *const i32) {
    unsafe {
        let mut r = 0;
        while r + ROWS <= n {
            tile_dot::<ROWS, ADD>(xq.add(r * k), k, xsc.add(r), xzp.add(r), p, y.add(r * ys), ys, s, cs);
            r += ROWS;
        }
        while r < n {
            tile_dot::<1, ADD>(xq.add(r * k), k, xsc.add(r), xzp.add(r), p, y.add(r * ys), ys, s, cs);
            r += 1;
        }
    }
}

/// Two k4 steps summed in i16 lanes (pmaddubsw and paddw on x86), widened once. The same bits as `tile_dot` when
/// each group of 4 weights feeding one i16 lane has sum |w| <= 258 (`pairable`; the exporter makes it so).
#[inline(always)]
unsafe fn tile_pairs<const R: usize, const ADD: bool>(xq: *const u8, k: usize, xsc: *const f32, xzp: *const i32, p: *const i8, y: *mut f32, ys: usize, s: *const f32, cs: *const i32) {
    unsafe {
        let mut a0 = [i32x4_splat(0); R];
        let mut a1 = [i32x4_splat(0); R];
        let mut k4 = 0;
        while k4 < k / 4 {
            let (w0a, w1a) = (v128_load(p.add(k4 * 32) as *const v128), v128_load(p.add(k4 * 32 + 16) as *const v128));
            let (w0b, w1b) = (v128_load(p.add(k4 * 32 + 32) as *const v128), v128_load(p.add(k4 * 32 + 48) as *const v128));
            for r in 0..R {
                let xa = v128_load32_splat(xq.add(r * k + k4 * 4) as *const u32);
                let xb = v128_load32_splat(xq.add(r * k + k4 * 4 + 4) as *const u32);
                let h0 = i16x8_add(i16x8_relaxed_dot_i8x16_i7x16(w0a, xa), i16x8_relaxed_dot_i8x16_i7x16(w0b, xb));
                let h1 = i16x8_add(i16x8_relaxed_dot_i8x16_i7x16(w1a, xa), i16x8_relaxed_dot_i8x16_i7x16(w1b, xb));
                a0[r] = i32x4_add(a0[r], i32x4_extadd_pairwise_i16x8(h0));
                a1[r] = i32x4_add(a1[r], i32x4_extadd_pairwise_i16x8(h1));
            }
            k4 += 2;
        }
        epilogue::<R, ADD>(&a0, &a1, xsc, xzp, y, ys, s, cs);
    }
}
#[inline(never)]
unsafe fn mm_pairs<const ADD: bool>(xq: *const u8, xsc: *const f32, xzp: *const i32, k: usize, n: usize, p: *const i8, y: *mut f32, ys: usize, s: *const f32, cs: *const i32) {
    unsafe {
        let mut r = 0;
        while r + ROWS <= n {
            tile_pairs::<ROWS, ADD>(xq.add(r * k), k, xsc.add(r), xzp.add(r), p, y.add(r * ys), ys, s, cs);
            r += ROWS;
        }
        while r < n {
            tile_pairs::<1, ADD>(xq.add(r * k), k, xsc.add(r), xzp.add(r), p, y.add(r * ys), ys, s, cs);
            r += 1;
        }
    }
}

/// What the relaxed dot does on this CPU, from inputs outside its deterministic range: 1 for x86 without VNNI
/// (pmaddubsw saturates pairs), 0 otherwise (ARM's sdot, x86 with VNNI, anything else).
pub fn saturating_pairs() -> bool {
    static mut PROBE: [v128; 2] = [i64x2(0, 0); 2];
    unsafe {
        let p = &raw mut PROBE;
        core::ptr::write_volatile(&raw mut (*p)[0], i8x16_splat(-128));
        core::ptr::write_volatile(&raw mut (*p)[1], u8x16_splat(255));
        let r = i32x4_relaxed_dot_i8x16_i7x16_add(core::ptr::read_volatile(&raw const (*p)[0]), core::ptr::read_volatile(&raw const (*p)[1]), i32x4_splat(0));
        i32x4_extract_lane::<0>(r) == -65536
    }
}

/// Whether every group of 4 weights feeding one i16 lane in `tile_pairs` has sum |w| <= 258, so that 258 * 127
/// fits an i16 lane and the pair kernel is exact.
unsafe fn pairable(l: &Lin) -> bool {
    let w = l.w as *const i8;
    let lim = i16x8_splat(258);
    let mut ok = true;
    unsafe {
        for ob in 0..l.nout / 8 {
            for half in 0..2 {
                let mut t = 0;
                while t < l.k / 4 {
                    let g = |u: usize| u16x8_extadd_pairwise_u8x16(i8x16_abs(v128_load(w.add(ob * l.k * 8 + (t + u) * 32 + half * 16) as *const v128)));
                    ok &= !v128_any_true(i16x8_gt(i16x8_add(g(0), g(1)), lim));
                    t += 2;
                }
            }
        }
    }
    ok
}

/// Asymmetric per-row 7-bit quantisation of activations: u in 0..=127, x ~ s * (u - zp).
#[inline(never)]
unsafe fn quantize_rows_u7(x: *const f32, xs: usize, n: usize, k: usize, q: *mut u8, sc: *mut f32, zps: *mut i32) {
    unsafe {
        for r in 0..n {
            let xr = x.add(r * xs);
            let (mut lo, mut hi) = (f32x4_splat(0.0), f32x4_splat(0.0));
            for i in (0..k).step_by(4) {
                let v = ld(xr.add(i));
                lo = f32x4_pmin(lo, v);
                hi = f32x4_pmax(hi, v);
            }
            let (mn, mx) = (hmin(lo), hmax(hi));
            let s = if mx > mn { (mx - mn) / 127.0 } else { 1.0 };
            let zp = (-mn / s).round().clamp(0.0, 127.0);
            *sc.add(r) = s;
            *zps.add(r) = zp as i32;
            let inv = f32x4_splat(1.0 / s);
            let zv = i32x4_splat(zp as i32);
            let qr = q.add(r * k);
            for i in (0..k).step_by(16) {
                let c = |o: usize| i32x4_add(round_i32(f32x4_mul(ld(xr.add(i + o)), inv)), zv);
                let lo = i16x8_narrow_i32x4(c(0), c(4));
                let hi = i16x8_narrow_i32x4(c(8), c(12));
                let u = u8x16_min(u8x16_narrow_i16x8(lo, hi), u8x16_splat(127));
                v128_store(qr.add(i) as *mut v128, u);
            }
        }
    }
}

/// y[r] = LN(x[r]) * g (g may be null), no bias.
#[inline(never)]
unsafe fn ln_rows(h: usize, x: *const f32, y: *mut f32, n: usize, g: *const f32) {
    unsafe {
        for r in 0..n {
            let xr = x.add(r * h);
            let yr = y.add(r * h);
            let mut s = f32x4_splat(0.0);
            for i in (0..h).step_by(4) {
                s = f32x4_add(s, ld(xr.add(i)));
            }
            let mean = f32x4_splat(hsum(s) / h as f32);
            let mut s2 = f32x4_splat(0.0);
            for i in (0..h).step_by(4) {
                let d = f32x4_sub(ld(xr.add(i)), mean);
                s2 = madd(d, d, s2);
            }
            let inv = f32x4_splat(1.0 / (hsum(s2) / h as f32 + EPS).sqrt());
            for i in (0..h).step_by(4) {
                let d = f32x4_mul(f32x4_sub(ld(xr.add(i)), mean), inv);
                st(yr.add(i), if g.is_null() { d } else { f32x4_mul(d, ld(g.add(i))) });
            }
        }
    }
}

/// y[r] = x[r] * g
#[inline(never)]
unsafe fn scale_rows(h: usize, x: *const f32, y: *mut f32, n: usize, g: *const f32) {
    unsafe {
        for r in 0..n {
            for i in (0..h).step_by(4) {
                st(y.add(r * h + i), f32x4_mul(ld(x.add(r * h + i)), ld(g.add(i))));
            }
        }
    }
}

/// How the host wrote the token rows into `rows`: float32, or int8 with a float32 scale in front.
#[derive(Clone, Copy, PartialEq)]
pub enum RowFormat {
    F32,
    I8,
}
impl RowFormat {
    pub fn from(v: u32) -> Option<RowFormat> {
        match v {
            0 => Some(RowFormat::F32),
            1 => Some(RowFormat::I8),
            _ => None,
        }
    }
}

/// x = LN(token rows) * g_emb.
#[inline(never)]
unsafe fn embed(m: &Model, n: usize, fmt: RowFormat) {
    let (h, b) = (m.h, &m.b);
    unsafe {
        for i in 0..n {
            let xr = b.x.add(i * h);
            match fmt {
                RowFormat::F32 => core::ptr::copy_nonoverlapping(b.rows.add(i * 4 * h) as *const f32, xr, h),
                RowFormat::I8 => {
                    let row = b.rows.add(i * (h + 4));
                    let src = row.add(4) as *const i8;
                    let sc = f32x4_splat((row as *const f32).read_unaligned());
                    for j in (0..h).step_by(8) {
                        let v = i16x8_load_extend_i8x8(src.add(j));
                        st(xr.add(j), f32x4_mul(f32x4_convert_i32x4(i32x4_extend_low_i16x8(v)), sc));
                        st(xr.add(j + 4), f32x4_mul(f32x4_convert_i32x4(i32x4_extend_high_i16x8(v)), sc));
                    }
                }
            }
        }
        ln_rows(h, b.x, b.x, n, m.eln);
    }
}

/// Rotary positions (rotate-half form) on the q and k parts of big[n][3h], head by head.
#[inline(never)]
unsafe fn rope(m: &Model, table: usize, n: usize) {
    let (h, big) = (m.h, m.b.big);
    let (cos, sin) = m.ropes[table];
    unsafe {
        for i in 0..n {
            let c = cos.add(i * HALF);
            let s = sin.add(i * HALF);
            for part in 0..2 {
                for hh in 0..m.nh {
                    let p = big.add(i * 3 * h + part * h + hh * HD);
                    for d in (0..HALF).step_by(4) {
                        let (a, b) = (ld(p.add(d)), ld(p.add(d + HALF)));
                        let (cv, sv) = (ld(c.add(d)), ld(s.add(d)));
                        st(p.add(d), f32x4_sub(f32x4_mul(a, cv), f32x4_mul(b, sv)));
                        st(p.add(d + HALF), madd(a, sv, f32x4_mul(b, cv)));
                    }
                }
            }
        }
    }
}

/// GeGLU in place: big[r][j] = gelu(big[r][j]) * big[r][ff + j] (exact erf GELU).
#[inline(never)]
unsafe fn geglu(ff: usize, big: *mut f32, n: usize) {
    let half = f32x4_splat(0.5);
    let rs2 = f32x4_splat(core::f32::consts::FRAC_1_SQRT_2);
    unsafe {
        for r in 0..n {
            let p = big.add(r * 2 * ff);
            for j in (0..ff).step_by(4) {
                let v = ld(p.add(j));
                let g = ld(p.add(ff + j));
                let a = f32x4_mul(f32x4_mul(v, half), f32x4_add(f32x4_splat(1.0), erf4(f32x4_mul(v, rs2))));
                st(p.add(j), f32x4_mul(a, g));
            }
        }
    }
}

/// y (+)= x W^T for n rows of x (stride xs) into y (stride ys).
unsafe fn linear<const ADD: bool>(m: &Model, kernel: Kernel, l: &Lin, x: *const f32, xs: usize, n: usize, y: *mut f32, ys: usize) {
    let (b, k) = (&m.b, l.k);
    unsafe {
        if !m.int8 {
            for ob in 0..l.nout / 8 {
                mm_panel::<ADD>(x, xs, n, k, (l.w as *const f32).add(ob * k * 8), y.add(ob * 8), ys);
            }
            return;
        }
        quantize_rows_u7(x, xs, n, k, b.xq, b.xsc, b.xzp);
        let pairs = kernel == Kernel::Pairs && m.pairs_exact;
        let (xq, w) = (b.xq as *const u8, l.w as *const i8);
        for ob in 0..l.nout / 8 {
            let (p, yo, s, cs) = (w.add(ob * k * 8), y.add(ob * 8), l.s.add(ob * 8), l.cs.add(ob * 8));
            if pairs {
                mm_pairs::<ADD>(xq, b.xsc, b.xzp, k, n, p, yo, ys, s, cs);
            } else {
                mm_dot::<ADD>(xq, b.xsc, b.xzp, k, n, p, yo, ys, s, cs);
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Float attention (verification): scores, masked softmax, P V on big[n][3h] into ctx[n][h].

fn keep(local: bool, window: usize, i: usize, j: usize, n: usize) -> bool {
    j < n && (!local || i.abs_diff(j) <= window)
}

unsafe fn attention_f32(m: &Model, n: usize, local: bool) {
    let (h, b) = (m.h, &m.b);
    let n8 = (n + 7) & !7;
    unsafe {
        for hh in 0..m.nh {
            for jb in 0..n8 / 8 {
                for d in 0..HD {
                    for jj in 0..8 {
                        let j = jb * 8 + jj;
                        *b.kp.add((jb * HD + d) * 8 + jj) = if j < n { *b.big.add(j * 3 * h + h + hh * HD + d) } else { 0.0 };
                    }
                }
            }
            for ob in 0..HD / 8 {
                for j in 0..n8 {
                    for c in 0..8 {
                        *b.vp.add((ob * n8 + j) * 8 + c) = if j < n { *b.big.add(j * 3 * h + 2 * h + hh * HD + ob * 8 + c) } else { 0.0 };
                    }
                }
            }
            for jb in 0..n8 / 8 {
                mm_panel::<false>(b.big.add(hh * HD), 3 * h, n, HD, b.kp.add(jb * HD * 8), b.scores.add(jb * 8), n8);
            }
            for i in 0..n {
                let row = b.scores.add(i * n8);
                let mut mx = f32::NEG_INFINITY;
                for j in 0..n8 {
                    if keep(local, m.window, i, j, n) {
                        mx = mx.max(*row.add(j));
                    } else {
                        *row.add(j) = f32::NEG_INFINITY;
                    }
                }
                let mv = f32x4_splat(mx);
                let mut sum = f32x4_splat(0.0);
                for j in (0..n8).step_by(4) {
                    let e = exp4(f32x4_sub(ld(row.add(j)), mv));
                    let e = v128_and(e, f32x4_gt(ld(row.add(j)), f32x4_splat(f32::NEG_INFINITY)));
                    st(row.add(j), e);
                    sum = f32x4_add(sum, e);
                }
                *b.xsc.add(i) = 1.0 / hsum(sum);
            }
            for ob in 0..HD / 8 {
                mm_panel::<false>(b.scores, n8, n, n8, b.vp.add(ob * n8 * 8), b.ctx.add(hh * HD + ob * 8), h);
            }
            for i in 0..n {
                let c = b.ctx.add(i * h + hh * HD);
                let inv = f32x4_splat(*b.xsc.add(i));
                for d in (0..HD).step_by(4) {
                    st(c.add(d), f32x4_mul(ld(c.add(d)), inv));
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Integer attention: Q u7 per row, K i8 per row (bounded for the i16-pair kernel), scores in i32, P as 14-bit
// integers (P = round(2^(s - max + 14))), V i8 per column, P V with i32x4.dot_i16x8_s. Local layers only touch
// the band around the diagonal.

/// Quantises head hh: Q (u7 per row), K (i8 per row, packed [j/8][d/4][j%8/4][j%4][d%4], scale times log2 e) and
/// V (i8 per column, i16 panels [d/8][j/2][d%8/4][d%4][j%2]).
#[inline(never)]
unsafe fn pack_head_i8(m: &Model, n: usize, hh: usize) {
    let (h, b) = (m.h, &m.b);
    let qkv = 3 * h;
    let n8 = (n + 7) & !7;
    let n16 = (n + 15) & !15;
    unsafe {
        quantize_rows_u7(b.big.add(hh * HD), qkv, n, HD, b.qq, b.qsc, b.qzp);
        for j in 0..n8 {
            let base = b.kpan.add((j / 8) * (HD * 8) + ((j % 8) / 4) * 16 + (j % 4) * 4);
            if j >= n {
                for k4 in 0..HD / 4 {
                    (base.add(k4 * 32) as *mut u32).write(0);
                }
                *b.ksc.add(j) = 0.0;
                *b.ksum.add(j) = 0;
                continue;
            }
            let kr = b.big.add(j * qkv + h + hh * HD);
            let mut mxv = f32x4_splat(0.0);
            let mut g = 0f32;
            for t in 0..HD / 8 {
                let (a0, a1) = (f32x4_abs(ld(kr.add(8 * t))), f32x4_abs(ld(kr.add(8 * t + 4))));
                mxv = f32x4_pmax(mxv, f32x4_pmax(a0, a1));
                // The i16-pair kernel sums |k| over dims {8t+2p, 8t+2p+1, 8t+4+2p, 8t+5+2p} in one i16 lane: keep
                // that sum <= 256 before rounding (<= 258 after), so 258 * 127 fits. On every CPU, for one output.
                let a = f32x4_add(a0, a1);
                g = g.max(f32x4_extract_lane::<0>(a) + f32x4_extract_lane::<1>(a)).max(f32x4_extract_lane::<2>(a) + f32x4_extract_lane::<3>(a));
            }
            let mx = hmax(mxv);
            let s = if mx > 0.0 { (mx / 127.0).max(g / 256.0) } else { 1.0 };
            *b.ksc.add(j) = s * core::f32::consts::LOG2_E;
            let inv = f32x4_splat(1.0 / s);
            let mut sum = i32x4_splat(0);
            for k8 in 0..HD / 8 {
                let a = round_i32(f32x4_mul(ld(kr.add(k8 * 8)), inv));
                let c = round_i32(f32x4_mul(ld(kr.add(k8 * 8 + 4)), inv));
                sum = i32x4_add(sum, i32x4_add(a, c));
                let q = i8x16_narrow_i16x8(i16x8_narrow_i32x4(a, c), i16x8_splat(0));
                (base.add(k8 * 2 * 32) as *mut u32).write(i32x4_extract_lane::<0>(q) as u32);
                (base.add((k8 * 2 + 1) * 32) as *mut u32).write(i32x4_extract_lane::<1>(q) as u32);
            }
            *b.ksum.add(j) = hsum_i(sum);
        }
        // V: a scale per column over the n rows
        let vb = b.big.add(2 * h + hh * HD);
        let mut mx = [f32x4_splat(0.0); HD / 4];
        for j in 0..n {
            for c in 0..HD / 4 {
                mx[c] = f32x4_pmax(mx[c], f32x4_abs(ld(vb.add(j * qkv + c * 4))));
            }
        }
        let mut inv = [f32x4_splat(0.0); HD / 4];
        for c in 0..HD / 4 {
            let s = f32x4_pmax(f32x4_div(mx[c], f32x4_splat(127.0)), f32x4_splat(1e-30));
            st(b.vsc.add(c * 4), s);
            inv[c] = f32x4_div(f32x4_splat(1.0), s);
        }
        let q16 = |j: usize, c0: usize| -> v128 {
            if j >= n {
                return i32x4_splat(0);
            }
            let r = vb.add(j * qkv + c0 * 16);
            let v = |o: usize| round_i32(f32x4_mul(ld(r.add(o * 4)), inv[c0 * 4 + o]));
            i8x16_narrow_i16x8(i16x8_narrow_i32x4(v(0), v(1)), i16x8_narrow_i32x4(v(2), v(3)))
        };
        for jp in 0..n16 / 2 {
            let j = jp * 2;
            for c0 in 0..HD / 16 {
                let (ra, rb) = (q16(j, c0), q16(j + 1, c0));
                for hl in 0..2 {
                    let (a, c) = if hl == 0 { (i16x8_extend_low_i8x16(ra), i16x8_extend_low_i8x16(rb)) } else { (i16x8_extend_high_i8x16(ra), i16x8_extend_high_i8x16(rb)) };
                    let ob = c0 * 2 + hl;
                    let dst = b.vpan16.add(ob * n16 * 8 + jp * 16);
                    v128_store(dst as *mut v128, i16x8_shuffle::<0, 8, 1, 9, 2, 10, 3, 11>(a, c));
                    v128_store(dst.add(8) as *mut v128, i16x8_shuffle::<4, 12, 5, 13, 6, 14, 7, 15>(a, c));
                }
            }
        }
    }
}

/// Scores for rows i0..i0+R against keys [jlo, jhi) (multiples of 8) into srow, masked to -inf outside the
/// window; returns the row maxima.
#[inline(always)]
unsafe fn att_scores<const R: usize, const PAIRS: bool>(m: &Model, n: usize, i0: usize, jlo: usize, jhi: usize, local: bool) -> [f32; R] {
    let b = &m.b;
    let stride = m.maxn + 16;
    unsafe {
        let qq = b.qq.add(i0 * HD);
        let mut rmax = [f32x4_splat(f32::NEG_INFINITY); R];
        let qs: [v128; R] = core::array::from_fn(|r| f32x4_splat(*b.qsc.add(i0 + r)));
        let qz: [v128; R] = core::array::from_fn(|r| i32x4_splat(*b.qzp.add(i0 + r)));
        let lane = i32x4(0, 1, 2, 3);
        let ninf = f32x4_splat(f32::NEG_INFINITY);
        let win = m.window as i32;
        for jb in jlo / 8..jhi / 8 {
            let p = b.kpan.add(jb * HD * 8);
            let mut a0 = [i32x4_splat(0); R];
            let mut a1 = [i32x4_splat(0); R];
            if PAIRS {
                for k8 in 0..HD / 8 {
                    let (w0a, w1a) = (v128_load(p.add(k8 * 64) as *const v128), v128_load(p.add(k8 * 64 + 16) as *const v128));
                    let (w0b, w1b) = (v128_load(p.add(k8 * 64 + 32) as *const v128), v128_load(p.add(k8 * 64 + 48) as *const v128));
                    for r in 0..R {
                        let xa = v128_load32_splat(qq.add(r * HD + k8 * 8) as *const u32);
                        let xb = v128_load32_splat(qq.add(r * HD + k8 * 8 + 4) as *const u32);
                        let h0 = i16x8_add(i16x8_relaxed_dot_i8x16_i7x16(w0a, xa), i16x8_relaxed_dot_i8x16_i7x16(w0b, xb));
                        let h1 = i16x8_add(i16x8_relaxed_dot_i8x16_i7x16(w1a, xa), i16x8_relaxed_dot_i8x16_i7x16(w1b, xb));
                        a0[r] = i32x4_add(a0[r], i32x4_extadd_pairwise_i16x8(h0));
                        a1[r] = i32x4_add(a1[r], i32x4_extadd_pairwise_i16x8(h1));
                    }
                }
            } else {
                for k4 in 0..HD / 4 {
                    let w0 = v128_load(p.add(k4 * 32) as *const v128);
                    let w1 = v128_load(p.add(k4 * 32 + 16) as *const v128);
                    for r in 0..R {
                        let xv = v128_load32_splat(qq.add(r * HD + k4 * 4) as *const u32);
                        a0[r] = i32x4_relaxed_dot_i8x16_i7x16_add(w0, xv, a0[r]);
                        a1[r] = i32x4_relaxed_dot_i8x16_i7x16_add(w1, xv, a1[r]);
                    }
                }
            }
            let j = jb * 8;
            let (s0, s1) = (ld(b.ksc.add(j)), ld(b.ksc.add(j + 4)));
            let (c0, c1) = (v128_load(b.ksum.add(j) as *const v128), v128_load(b.ksum.add(j + 4) as *const v128));
            let j0 = i32x4_add(i32x4_splat(j as i32), lane);
            let j1 = i32x4_add(j0, i32x4_splat(4));
            let nv = i32x4_splat(n as i32);
            for r in 0..R {
                let v0 = f32x4_convert_i32x4(i32x4_sub(a0[r], i32x4_mul(qz[r], c0)));
                let v1 = f32x4_convert_i32x4(i32x4_sub(a1[r], i32x4_mul(qz[r], c1)));
                let mut v0 = f32x4_mul(v0, f32x4_mul(s0, qs[r]));
                let mut v1 = f32x4_mul(v1, f32x4_mul(s1, qs[r]));
                let (mut k0, mut k1) = (i32x4_lt(j0, nv), i32x4_lt(j1, nv));
                if local {
                    let i = (i0 + r) as i32;
                    let (lo, hi) = (i32x4_splat(i - win), i32x4_splat(i + win));
                    k0 = v128_and(k0, v128_and(i32x4_ge(j0, lo), i32x4_le(j0, hi)));
                    k1 = v128_and(k1, v128_and(i32x4_ge(j1, lo), i32x4_le(j1, hi)));
                }
                v0 = v128_bitselect(v0, ninf, k0);
                v1 = v128_bitselect(v1, ninf, k1);
                st(b.srow.add(r * stride + j), v0);
                st(b.srow.add(r * stride + j + 4), v1);
                rmax[r] = f32x4_pmax(rmax[r], f32x4_pmax(v0, v1));
            }
        }
        core::array::from_fn(|r| hmax(rmax[r]))
    }
}

/// P = round(2^(s - max + 14)) as i16 for the rows of srow over [jlo, jhi); returns 1 / sum P per row.
#[inline(always)]
unsafe fn att_softmax<const R: usize>(m: &Model, jlo: usize, jhi: usize, rmax: &[f32; R]) -> [f32; R] {
    let b = &m.b;
    let stride = m.maxn + 16;
    let mut inv = [0f32; R];
    unsafe {
        for r in 0..R {
            let row = b.srow.add(r * stride);
            let off = f32x4_splat(rmax[r] - 14.0);
            let mut sum = i32x4_splat(0);
            let pr = b.prow16.add(r * stride);
            let mut j = jlo;
            while j < jhi {
                let u0 = round_i32(exp2_fast(f32x4_sub(ld(row.add(j)), off)));
                let u1 = round_i32(exp2_fast(f32x4_sub(ld(row.add(j + 4)), off)));
                sum = i32x4_add(sum, i32x4_add(u0, u1));
                v128_store(pr.add(j) as *mut v128, i16x8_narrow_i32x4(u0, u1));
                j += 8;
            }
            inv[r] = 1.0 / hsum_i(sum).max(1) as f32;
        }
    }
    inv
}

#[inline(always)]
unsafe fn att_pv<const R: usize>(m: &Model, n: usize, hh: usize, i0: usize, jlo: usize, jhi: usize, inv: &[f32; R]) {
    let (h, b) = (m.h, &m.b);
    let stride = m.maxn + 16;
    let n16 = (n + 15) & !15;
    unsafe {
        for ob in 0..HD / 8 {
            let p = b.vpan16.add(ob * n16 * 8);
            let mut a0 = [i32x4_splat(0); R];
            let mut a1 = [i32x4_splat(0); R];
            for jp in jlo / 2..jhi / 2 {
                let w0 = v128_load(p.add(jp * 16) as *const v128);
                let w1 = v128_load(p.add(jp * 16 + 8) as *const v128);
                for r in 0..R {
                    let xv = v128_load32_splat(b.prow16.add(r * stride + jp * 2) as *const u32);
                    a0[r] = i32x4_add(a0[r], i32x4_dot_i16x8(xv, w0));
                    a1[r] = i32x4_add(a1[r], i32x4_dot_i16x8(xv, w1));
                }
            }
            let (s0, s1) = (ld(b.vsc.add(ob * 8)), ld(b.vsc.add(ob * 8 + 4)));
            for r in 0..R {
                let iv = f32x4_splat(inv[r]);
                let c = b.ctx.add((i0 + r) * h + hh * HD + ob * 8);
                st(c, f32x4_mul(f32x4_convert_i32x4(a0[r]), f32x4_mul(s0, iv)));
                st(c.add(4), f32x4_mul(f32x4_convert_i32x4(a1[r]), f32x4_mul(s1, iv)));
            }
        }
    }
}

#[inline(never)]
unsafe fn att_block<const R: usize>(m: &Model, kernel: Kernel, n: usize, hh: usize, i0: usize, local: bool) {
    let n8 = (n + 7) & !7;
    let (jlo, jhi) = if local { (i0.saturating_sub(m.window) & !7, ((i0 + R + m.window + 7) & !7).min(n8)) } else { (0, n8) };
    unsafe {
        let rmax = if kernel == Kernel::Pairs { att_scores::<R, true>(m, n, i0, jlo, jhi, local) } else { att_scores::<R, false>(m, n, i0, jlo, jhi, local) };
        let inv = att_softmax::<R>(m, jlo, jhi, &rmax);
        att_pv::<R>(m, n, hh, i0, jlo, jhi, &inv);
    }
}

unsafe fn attention_i8(m: &Model, kernel: Kernel, n: usize, local: bool) {
    unsafe {
        for hh in 0..m.nh {
            pack_head_i8(m, n, hh);
            let mut i = 0;
            while i + ROWS <= n {
                att_block::<ROWS>(m, kernel, n, hh, i, local);
                i += ROWS;
            }
            while i < n {
                att_block::<1>(m, kernel, n, hh, i, local);
                i += 1;
            }
        }
    }
}

/// Runs the encoder on the n token rows (1 <= n <= max tokens) the host wrote into `rows` in format `fmt`.
/// Returns the L2-normalised, mean-pooled embedding (`dim` floats).
pub unsafe fn forward(m: &Model, kernel: Kernel, n: usize, fmt: RowFormat) -> *const f32 {
    let (h, ff, b) = (m.h, m.ff, &m.b);
    let x = b.x;
    unsafe {
        embed(m, n, fmt);
        for (li, l) in m.layers.iter().enumerate() {
            // Attention block. The first layer has no attention norm; later norms' gains are folded into Wqkv.
            if li == 0 {
                scale_rows(h, x, b.h, n, l.gq);
            } else {
                ln_rows(h, x, b.h, n, l.gq);
            }
            linear::<false>(m, kernel, &l.qkv, b.h, h, n, b.big, 3 * h);
            rope(m, l.rope, n);
            if m.int8 {
                attention_i8(m, kernel, n, l.local);
            } else {
                attention_f32(m, n, l.local);
            }
            linear::<true>(m, kernel, &l.o, b.ctx, h, n, x, h);
            // Feed-forward block.
            ln_rows(h, x, b.h, n, l.gf);
            linear::<false>(m, kernel, &l.ff1, b.h, h, n, b.big, 2 * ff);
            geglu(ff, b.big, n);
            linear::<true>(m, kernel, &l.ff2, b.big, 2 * ff, n, x, h);
            if l.nod > 0 {
                for ob in 0..h / 8 {
                    mm_panel_exact(b.big.add(ff - l.nod), 2 * ff, n, l.nod, l.wod.add(ob * l.nod * 8), x.add(ob * 8), h);
                }
            }
        }
        // Final norm, mean pooling (the final gain commutes with the mean), L2 normalisation.
        let out = b.out;
        ln_rows(h, x, b.h, n, core::ptr::null());
        for j in (0..h).step_by(4) {
            let mut s = f32x4_splat(0.0);
            for i in 0..n {
                s = f32x4_add(s, ld(b.h.add(i * h + j)));
            }
            st(out.add(j), f32x4_mul(s, ld(m.fln.add(j))));
        }
        let mut nn = 0.0f32;
        for j in 0..h {
            nn += *out.add(j) * *out.add(j);
        }
        let inv = 1.0 / nn.sqrt();
        for j in 0..h {
            *out.add(j) *= inv;
        }
        out
    }
}

/// y += x P for the feed-forward channels kept in float, without fused multiply-add: part of the integer path.
#[inline(never)]
unsafe fn mm_panel_exact(x: *const f32, xs: usize, n: usize, k: usize, p: *const f32, y: *mut f32, ys: usize) {
    unsafe {
        for r in 0..n {
            let (mut a0, mut a1) = (f32x4_splat(0.0), f32x4_splat(0.0));
            for kk in 0..k {
                let xv = f32x4_splat(*x.add(r * xs + kk));
                a0 = madd(xv, ld(p.add(kk * 8)), a0);
                a1 = madd(xv, ld(p.add(kk * 8 + 4)), a1);
            }
            st(y.add(r * ys), f32x4_add(a0, ld(y.add(r * ys))));
            st(y.add(r * ys + 4), f32x4_add(a1, ld(y.add(r * ys + 4))));
        }
    }
}
