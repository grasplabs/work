//! Vector helpers and the few transcendental functions the encoder needs, on wasm32 simd128 and relaxed-simd.
use core::arch::wasm32::*;

/// a * b + c, rounded twice: the same on every CPU. Everything the integer path computes in floats uses it.
#[inline(always)]
pub fn madd(a: v128, b: v128, c: v128) -> v128 {
    f32x4_add(f32x4_mul(a, b), c)
}
/// a * b + c, fused or not depending on the CPU: only the float verification path, whose output is compared with
/// a tolerance, uses it.
#[inline(always)]
pub fn fma(a: v128, b: v128, c: v128) -> v128 {
    f32x4_relaxed_madd(a, b, c)
}
#[inline(always)]
pub unsafe fn ld(p: *const f32) -> v128 {
    unsafe { v128_load(p as *const v128) }
}
#[inline(always)]
pub unsafe fn st(p: *mut f32, v: v128) {
    unsafe { v128_store(p as *mut v128, v) }
}
#[inline(always)]
pub fn hsum(v: v128) -> f32 {
    f32x4_extract_lane::<0>(v) + f32x4_extract_lane::<1>(v) + f32x4_extract_lane::<2>(v) + f32x4_extract_lane::<3>(v)
}
#[inline(always)]
pub fn hmax(v: v128) -> f32 {
    f32x4_extract_lane::<0>(v).max(f32x4_extract_lane::<1>(v)).max(f32x4_extract_lane::<2>(v)).max(f32x4_extract_lane::<3>(v))
}
#[inline(always)]
pub fn hmin(v: v128) -> f32 {
    f32x4_extract_lane::<0>(v).min(f32x4_extract_lane::<1>(v)).min(f32x4_extract_lane::<2>(v)).min(f32x4_extract_lane::<3>(v))
}
#[inline(always)]
pub fn hsum_i(v: v128) -> i32 {
    i32x4_extract_lane::<0>(v) + i32x4_extract_lane::<1>(v) + i32x4_extract_lane::<2>(v) + i32x4_extract_lane::<3>(v)
}

/// 1.5 * 2^23: adding and subtracting it rounds half to even, for |y| < 2^22.
const MAGIC: f32 = 12_582_912.0;

/// Rounds to i32 (half to even) for |y| < 2^22, without float-to-int instructions.
#[inline(always)]
pub fn round_i32(y: v128) -> v128 {
    i32x4_sub(f32x4_add(y, f32x4_splat(MAGIC)), f32x4_splat(MAGIC))
}

/// 2^t for t <= 0 (flushed below -60): cubic minimax for 2^f on [-0.5, 0.5] (relative error 7.6e-5). The integer
/// attention's probabilities.
#[inline(always)]
pub fn exp2_fast(t: v128) -> v128 {
    let t = f32x4_pmax(t, f32x4_splat(-60.0));
    let kf = f32x4_add(t, f32x4_splat(MAGIC));
    let f = f32x4_sub(t, f32x4_sub(kf, f32x4_splat(MAGIC)));
    let mut p = f32x4_splat(0.055_169_093);
    p = madd(p, f, f32x4_splat(0.242_607_42));
    p = madd(p, f, f32x4_splat(0.693_261_05));
    p = madd(p, f, f32x4_splat(0.999_928_33));
    i32x4_add(p, i32x4_shl(kf, 23))
}

/// exp for x <= ~88 (Cephes-style range reduction and a degree-6 polynomial): the float attention's softmax.
#[inline(always)]
pub fn exp4(x: v128) -> v128 {
    let x = f32x4_pmax(x, f32x4_splat(-87.0));
    let n = f32x4_nearest(f32x4_mul(x, f32x4_splat(core::f32::consts::LOG2_E)));
    let r = f32x4_sub(f32x4_sub(x, f32x4_mul(n, f32x4_splat(0.693_359_4))), f32x4_mul(n, f32x4_splat(-2.121_944_4e-4)));
    let mut p = f32x4_splat(1.987_569_1e-4);
    p = fma(p, r, f32x4_splat(1.398_199_9e-3));
    p = fma(p, r, f32x4_splat(8.333_452e-3));
    p = fma(p, r, f32x4_splat(4.166_579_6e-2));
    p = fma(p, r, f32x4_splat(1.666_666_5e-1));
    p = fma(p, r, f32x4_splat(5.000_000_1e-1));
    let y = f32x4_add(fma(f32x4_mul(p, r), r, r), f32x4_splat(1.0));
    let e = i32x4_shl(i32x4_add(i32x4_trunc_sat_f32x4(n), i32x4_splat(127)), 23);
    f32x4_mul(y, e)
}

/// erf by a rational approximation (clamped to [-4, 4]); |error| about 1e-7. GELU, on both paths.
#[inline(always)]
pub fn erf4(x: v128) -> v128 {
    let x = f32x4_pmin(f32x4_pmax(x, f32x4_splat(-4.0)), f32x4_splat(4.0));
    let x2 = f32x4_mul(x, x);
    let mut p = f32x4_splat(-2.726_142_3e-10);
    p = madd(x2, p, f32x4_splat(2.770_681_4e-8));
    p = madd(x2, p, f32x4_splat(-2.101_024e-6));
    p = madd(x2, p, f32x4_splat(-5.692_506_4e-5));
    p = madd(x2, p, f32x4_splat(-7.349_906_3e-4));
    p = madd(x2, p, f32x4_splat(-2.954_600_1e-3));
    p = madd(x2, p, f32x4_splat(-1.609_603_3e-2));
    p = f32x4_mul(x, p);
    let mut q = f32x4_splat(-1.456_607_2e-5);
    q = madd(x2, q, f32x4_splat(-2.133_740_6e-4));
    q = madd(x2, q, f32x4_splat(-1.682_827e-3));
    q = madd(x2, q, f32x4_splat(-7.373_329_3e-3));
    q = madd(x2, q, f32x4_splat(-1.426_474e-2));
    f32x4_div(p, q)
}
