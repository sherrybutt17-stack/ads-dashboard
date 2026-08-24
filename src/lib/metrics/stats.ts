/**
 * The two special functions the keep/kill engine needs, and nothing else.
 *
 * Written out rather than pulled from a dependency because they are forty lines
 * of well-specified numerical analysis with exact reference values to test
 * against, and because a statistics library is a large surface to add for two
 * functions on a Vercel bundle.
 *
 * Both are standard: the Lanczos approximation for `lnGamma`, and Lentz's
 * continued fraction for the regularized incomplete beta. Accuracy is around
 * 1e-13 relative, far beyond what a verdict on nine leads requires.
 */

/** Lanczos g=7, n=9 coefficients. */
const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012,
  9.9843695780195716e-6, 1.5056327351493116e-7,
];

export function lnGamma(z: number): number {
  // Reflection for the left half-plane, where the series does not converge.
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  z -= 1;
  let x = 0.99999999999980993;
  for (let i = 0; i < LANCZOS.length; i++) x += LANCZOS[i] / (z + i + 1);
  const t = z + LANCZOS.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/** Lentz's method for the continued fraction of the incomplete beta. */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const TINY = 1e-30;
  const EPS = 3e-14;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;

  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;

  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    // Even step.
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;

    // Odd step.
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/**
 * Regularized incomplete beta, `I_x(a, b)` — the CDF of a Beta(a, b) at x.
 *
 * This is the whole of the keep/kill comparison. See `keepkill.ts` for why:
 * the probability that one Gamma-distributed rate is below another has an exact
 * closed form in terms of this function, so there is no simulation, no sampling
 * and no seed anywhere in the engine.
 */
export function incompleteBeta(a: number, b: number, x: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(x)) return NaN;
  if (a <= 0 || b <= 0) return NaN;
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  const front = Math.exp(
    lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );

  // Converges quickly only on one side of the mode; use the symmetry
  // I_x(a,b) = 1 - I_{1-x}(b,a) for the other.
  return x < (a + 1) / (a + b + 2)
    ? (front * betaContinuedFraction(a, b, x)) / a
    : 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

/**
 * `P(X < Y)` for two independent Gamma-distributed rates.
 *
 * X ~ Gamma(shape `aX`, RATE `bX`), Y ~ Gamma(`aY`, `bY`). Exact, via the
 * standard identity: with U ~ Gamma(aX,1) and V ~ Gamma(aY,1),
 *
 *     P(X < Y) = P(U·bY < V·bX) = P(U/(U+V) < bX/(bX+bY))
 *
 * and `U/(U+V)` is exactly Beta(aX, aY). So the whole comparison collapses to
 * one incomplete-beta evaluation.
 *
 * ⚠️ `bX`/`bY` are RATE parameters, not scale. Gamma is written both ways and
 * swapping them inverts every verdict this engine produces.
 */
export function probRateBelow(
  aX: number,
  bX: number,
  aY: number,
  bY: number,
): number {
  if (bX + bY <= 0) return NaN;
  return incompleteBeta(aX, aY, bX / (bX + bY));
}

/**
 * `P(X ≤ k)` for `X ~ Poisson(mean)`.
 *
 * Answers "how surprising is a count this low, if nothing actually changed" —
 * which is the right question wherever a fixed percentage would be wrong at both
 * ends. A 40% fall is meaningless at 5 leads and alarming at 500; this scales
 * with the count instead of pretending it does not matter.
 *
 * Summed directly, in log space. The exponent stays near
 * `-½·ln(2π·mean)` around the mode, so nothing under- or overflows even for a
 * large mean, and the loop is bounded by `k` — a lead count, never large.
 */
export function poissonAtMost(k: number, mean: number): number {
  if (!Number.isFinite(k) || !Number.isFinite(mean) || k < 0 || mean < 0) return NaN;
  // A process with rate zero produces zero, so every outcome is at or below k.
  if (mean === 0) return 1;
  const kk = Math.floor(k);
  let total = 0;
  for (let i = 0; i <= kk; i++) {
    total += Math.exp(-mean + i * Math.log(mean) - lnGamma(i + 1));
  }
  return Math.min(1, total);
}

/** ln of the Beta function, `B(x, y)`. */
function lnBeta(x: number, y: number): number {
  return lnGamma(x) + lnGamma(y) - lnGamma(x + y);
}

/**
 * `P(X > Y)` for two independent Beta-distributed PROPORTIONS. Exact.
 *
 * The comparison behind "did answering faster actually book more". Both sides
 * are k successes out of n trials, so with a uniform Beta(1,1) prior each
 * posterior is Beta(k+1, n−k+1) — and because those parameters are integers, the
 * probability that one exceeds the other has a closed form:
 *
 *     P(X > Y) = Σ_{i=0}^{aX−1}  B(aY+i, bY+bX)
 *                                ───────────────────────────────
 *                                (bX+i) · B(1+i, bX) · B(aY, bY)
 *
 * A finite sum of `aX` terms, evaluated in logs. No sampling, no seed, no
 * quadrature, and nothing to tune — the same property that keeps the keep/kill
 * engine reproducible. Whole families of exact reference values exist to test it
 * against (Beta(a,1) against a uniform is exactly `a/(a+1)`), which is why this
 * is written out rather than approximated.
 *
 * ⚠️ `aX` must be a positive integer — the sum's upper limit. That holds for a
 * count-plus-one posterior and for nothing else, so this is not a general
 * two-Beta comparison. Uniform priors rather than Jeffreys for exactly this
 * reason: Beta(0.5, 0.5) would put the closed form out of reach and force
 * numerical integration through a singularity at each end.
 */
export function probBetaGreater(
  aX: number,
  bX: number,
  aY: number,
  bY: number,
): number {
  if (![aX, bX, aY, bY].every((v) => Number.isFinite(v) && v > 0)) return NaN;
  if (!Number.isInteger(aX)) return NaN;

  const base = lnBeta(aY, bY);
  let total = 0;
  for (let i = 0; i < aX; i++) {
    total += Math.exp(
      lnBeta(aY + i, bY + bX) - Math.log(bX + i) - lnBeta(1 + i, bX) - base,
    );
  }
  // Rounding across many terms can drift a hair outside [0,1]; a probability
  // rendered as "100.4%" would discredit every other number on the panel.
  return Math.min(1, Math.max(0, total));
}

/**
 * Two-sided `P(|T| > t)` for Student's t with `df` degrees of freedom.
 *
 * Falls straight out of the incomplete beta already here:
 *
 *     P(|T| > t) = I_{df/(df+t²)}(df/2, 1/2)
 *
 * which is exact, and testable against closed forms — a Cauchy (df = 1) puts
 * exactly half its mass beyond ±1, and df = 2 gives `1 − t/√(2+t²)`.
 */
export function studentTTwoSided(t: number, df: number): number {
  if (!Number.isFinite(t) || !Number.isFinite(df) || df <= 0) return NaN;
  if (t === 0) return 1;
  return incompleteBeta(df / 2, 0.5, df / (df + t * t));
}

/**
 * Spearman's rank correlation, with average ranks for ties.
 *
 * Rank-based rather than Pearson because the series it is used on — a month's
 * ad spend against that month's non-paid lead count — are a dozen points with
 * no reason to be linear and every reason to contain one outlying month. A
 * Pearson coefficient on twelve points is one budget test away from any value
 * you like.
 */
export function spearman(xs: readonly number[], ys: readonly number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return NaN;

  const rank = (v: readonly number[]): number[] => {
    const idx = v.map((value, i) => ({ value, i })).sort((a, b) => a.value - b.value);
    const out = new Array<number>(v.length);
    let i = 0;
    while (i < idx.length) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1].value === idx[i].value) j++;
      // Average rank across the tie, so a run of identical months does not
      // manufacture an ordering that is not in the data.
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) out[idx[k].i] = avg;
      i = j + 1;
    }
    return out;
  };

  const rx = rank(xs.slice(0, n));
  const ry = rank(ys.slice(0, n));
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const mx = mean(rx);
  const my = mean(ry);

  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  if (dx <= 0 || dy <= 0) return NaN;
  return num / Math.sqrt(dx * dy);
}

/**
 * The `p`-quantile of Beta(a, b) — inverse of `incompleteBeta`, by bisection.
 *
 * Used for credible intervals on a conversion rate. Bisection rather than
 * Newton because the derivative vanishes at the ends for a < 1 or b < 1 and a
 * Newton step there walks straight out of [0, 1]; 200 halvings pin the answer to
 * ~1e-60, which is free at this call volume and cannot diverge.
 */
export function betaQuantile(a: number, b: number, p: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return NaN;
  if (!Number.isFinite(p) || p < 0 || p > 1) return NaN;
  if (p === 0) return 0;
  if (p === 1) return 1;

  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (incompleteBeta(a, b, mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
