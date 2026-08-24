import { describe, it, expect } from "vitest";
import {
  lnGamma,
  incompleteBeta,
  probRateBelow,
  probBetaGreater,
  betaQuantile,
  studentTTwoSided,
  spearman,
  poissonAtMost,
} from "./stats";

/**
 * Numerical code, checked against values that exist independently of it.
 *
 * Every assertion here is either an exact closed form or a figure that can be
 * looked up, because a special function tested only against its own output is
 * tested against nothing. These two functions decide whether the product tells
 * an agency to switch off a campaign, so "it returns a number between 0 and 1"
 * is not a test.
 */

const close = (a: number, b: number, eps = 1e-10) =>
  expect(Math.abs(a - b)).toBeLessThan(eps);

describe("lnGamma", () => {
  it("reproduces the factorials", () => {
    // Γ(n) = (n−1)!
    close(Math.exp(lnGamma(1)), 1, 1e-9);
    close(Math.exp(lnGamma(5)), 24, 1e-7);
    close(Math.exp(lnGamma(11)), 3_628_800, 1e-3);
  });

  it("reproduces Γ(1/2) = √π", () => {
    close(Math.exp(lnGamma(0.5)), Math.sqrt(Math.PI), 1e-10);
  });

  it("handles the reflection branch", () => {
    // Γ(0.25)·Γ(0.75) = π / sin(π/4)
    close(
      Math.exp(lnGamma(0.25) + lnGamma(0.75)),
      Math.PI / Math.sin(Math.PI / 4),
      1e-9,
    );
  });
});

describe("incompleteBeta", () => {
  it("is the identity when a = b = 1, where Beta(1,1) is uniform", () => {
    for (const x of [0.1, 0.25, 0.5, 0.73, 0.9]) close(incompleteBeta(1, 1, x), x);
  });

  it("is 1/2 at x = 1/2 for any symmetric pair", () => {
    for (const a of [0.5, 1, 2, 3.5, 12]) close(incompleteBeta(a, a, 0.5), 0.5);
  });

  it("matches the closed form for integer shapes", () => {
    /*
     * For integer a, b the Beta CDF is the binomial tail:
     *   I_x(a, b) = Σ_{j=a}^{a+b−1} C(n, j) x^j (1−x)^{n−j},  n = a+b−1.
     * Independent of the continued fraction being tested.
     */
    const binomTail = (a: number, b: number, x: number) => {
      const n = a + b - 1;
      let sum = 0;
      for (let j = a; j <= n; j++) {
        const logC = lnGamma(n + 1) - lnGamma(j + 1) - lnGamma(n - j + 1);
        sum += Math.exp(logC + j * Math.log(x) + (n - j) * Math.log(1 - x));
      }
      return sum;
    };

    for (const [a, b] of [
      [2, 3],
      [4, 6],
      [1, 7],
      [9, 2],
    ]) {
      for (const x of [0.15, 0.4, 0.62, 0.88]) {
        close(incompleteBeta(a, b, x), binomTail(a, b, x), 1e-9);
      }
    }
  });

  it("obeys the symmetry I_x(a,b) = 1 − I_{1−x}(b,a)", () => {
    // The two branches of the implementation must agree where they meet.
    for (const [a, b, x] of [
      [3.5, 5.5, 0.45],
      [0.5, 2.5, 0.8],
      [12, 3, 0.2],
    ]) {
      close(incompleteBeta(a, b, x), 1 - incompleteBeta(b, a, 1 - x), 1e-11);
    }
  });

  it("is monotone in x", () => {
    let prev = -1;
    for (let x = 0; x <= 1.0001; x += 0.01) {
      const v = incompleteBeta(3.5, 5.5, x);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it("saturates and rejects nonsense rather than returning garbage", () => {
    expect(incompleteBeta(2, 3, 0)).toBe(0);
    expect(incompleteBeta(2, 3, 1)).toBe(1);
    expect(incompleteBeta(2, 3, -0.5)).toBe(0);
    expect(incompleteBeta(0, 3, 0.5)).toBeNaN();
    expect(incompleteBeta(2, 3, NaN)).toBeNaN();
  });
});

describe("probRateBelow", () => {
  it("is 1/2 for two identically distributed rates", () => {
    close(probRateBelow(4, 100, 4, 100), 0.5);
    close(probRateBelow(1.5, 7, 1.5, 7), 0.5);
  });

  it("🔴 orders the rates the right way round", () => {
    /*
     * The sign error that would invert every verdict in the product: a campaign
     * generating leads FASTER would be recommended for the chop.
     *
     * X has the same evidence count on a quarter of the spend, so its rate is
     * clearly higher — P(X < Y) must be small.
     */
    const pXWorse = probRateBelow(10, 100, 10, 400);
    expect(pXWorse).toBeLessThan(0.02);
    // And the mirror image is its complement.
    close(pXWorse, 1 - probRateBelow(10, 400, 10, 100), 1e-12);
  });

  it("is exactly the exponential race when both shapes are 1", () => {
    // For X~Exp(b1), Y~Exp(b2): P(X < Y) = b1/(b1+b2). No approximation.
    for (const [b1, b2] of [
      [1, 1],
      [2, 5],
      [90, 110],
    ]) {
      close(probRateBelow(1, b1, 1, b2), b1 / (b1 + b2));
    }
  });

  it("moves toward certainty as evidence accumulates at a fixed ratio", () => {
    /*
     * Same observed rates (half as many leads per dollar), more data. The
     * probability must climb monotonically toward 1 — this is the property that
     * makes "not enough evidence yet" a real state rather than a threshold
     * someone picked.
     */
    const ps = [1, 4, 16, 64, 256].map((k) => probRateBelow(k, 2 * k, 2 * k, 2 * k));
    for (let i = 1; i < ps.length; i++) expect(ps[i]).toBeGreaterThan(ps[i - 1]);
    expect(ps[0]).toBeLessThan(0.8);
    expect(ps[ps.length - 1]).toBeGreaterThan(0.999);
  });
});

/* ------------------------------------------------------------------ *
 * probBetaGreater — the two-proportion comparison
 * ------------------------------------------------------------------ */

describe("probBetaGreater", () => {
  /*
   * Exact reference family: for X ~ Beta(a, 1) the density is a·x^(a−1), so
   * against a uniform Y,
   *
   *     P(X > Y) = ∫₀¹ a·x^(a−1) · x dx = a/(a+1)
   *
   * which is a closed form for every integer a — a real external check on the
   * closed form, not a comparison of the function against itself.
   */
  it("matches a/(a+1) against a uniform, for every shape", () => {
    for (const a of [1, 2, 3, 5, 9, 40]) {
      close(probBetaGreater(a, 1, 1, 1), a / (a + 1), 1e-11);
    }
  });

  it("matches the hand-integrated Beta(2,1) vs Beta(1,2) = 5/6", () => {
    // ∫₀¹ 2x · (1 − (1−x)²) dx = ∫₀¹ (4x² − 2x³) dx = 4/3 − 1/2 = 5/6.
    close(probBetaGreater(2, 1, 1, 2), 5 / 6, 1e-11);
    close(probBetaGreater(1, 2, 2, 1), 1 / 6, 1e-11);
  });

  it("is exactly a half between identical posteriors", () => {
    for (const [a, b] of [
      [1, 1],
      [4, 9],
      [31, 3],
    ]) {
      close(probBetaGreater(a, b, a, b), 0.5, 1e-11);
    }
  });

  it("is the complement of its mirror", () => {
    // P(X>Y) + P(Y>X) = 1 for continuous distributions. A closed form that
    // fails this is summing the wrong series.
    close(
      probBetaGreater(5, 20, 3, 30) + probBetaGreater(3, 30, 5, 20),
      1,
      1e-11,
    );
  });

  it("🔴 stays uncertain on tiny samples and sharpens as leads accumulate", () => {
    /*
     * The property the whole panel rests on. Same observed rates throughout —
     * 40% against 20% — with the sample multiplied. One lead each side must be
     * near a coin flip; a hundred each side must be near certain. Without this,
     * "3 of 5 booked" would read as a finding.
     */
    const at = (scale: number) =>
      probBetaGreater(
        2 * scale + 1,
        3 * scale + 1, // 2/5 fast
        1 * scale + 1,
        4 * scale + 1, // 1/5 slow
      );
    const ps = [1, 2, 4, 10, 20].map(at);
    for (let i = 1; i < ps.length; i++) expect(ps[i]).toBeGreaterThan(ps[i - 1]);
    expect(ps[0]).toBeLessThan(0.8); // 2/5 vs 1/5 is not evidence
    expect(ps[ps.length - 1]).toBeGreaterThan(0.99); // 40/100 vs 20/100 is
  });

  it("never returns a probability outside [0,1] on large counts", () => {
    // Hundreds of summed terms, each exponentiated — drift here would render as
    // "100.4% confident" on a client's screen.
    for (const [k, n] of [
      [300, 400],
      [1, 900],
      [450, 900],
    ]) {
      const p = probBetaGreater(k + 1, n - k + 1, 50, 450);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
      expect(Number.isFinite(p)).toBe(true);
    }
  });

  it("refuses a non-integer success count rather than silently truncating", () => {
    // The closed form's upper limit IS the first shape parameter. A Jeffreys
    // prior would make it 2.5 and the sum would quietly compute something else.
    expect(Number.isNaN(probBetaGreater(2.5, 3, 1, 1))).toBe(true);
    expect(Number.isNaN(probBetaGreater(2, 0, 1, 1))).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * betaQuantile — the credible interval
 * ------------------------------------------------------------------ */

describe("betaQuantile", () => {
  it("inverts the three Betas with closed-form CDFs", () => {
    for (const p of [0.05, 0.1, 0.5, 0.9, 0.95]) {
      close(betaQuantile(1, 1, p), p, 1e-12); // CDF x
      close(betaQuantile(2, 1, p), Math.sqrt(p), 1e-12); // CDF x²
      close(betaQuantile(1, 2, p), 1 - Math.sqrt(1 - p), 1e-12); // 1−(1−x)²
    }
  });

  it("round-trips against incompleteBeta for awkward shapes", () => {
    for (const [a, b] of [
      [0.5, 0.5],
      [1, 40],
      [40, 1],
      [7, 93],
    ]) {
      for (const p of [0.1, 0.5, 0.9]) {
        close(incompleteBeta(a, b, betaQuantile(a, b, p)), p, 1e-9);
      }
    }
  });

  it("🔴 gives one lead an interval that spans almost everything", () => {
    /*
     * The number that stops "100% of leads called within 5 minutes booked" from
     * reading as a fact. One lead, one booking: the 80% interval runs from
     * roughly a fifth to essentially certain, and that width is what the panel
     * draws instead of a full-width bar.
     */
    const lo = betaQuantile(2, 1, 0.1); // 1 of 1 → Beta(2,1)
    const hi = betaQuantile(2, 1, 0.9);
    expect(lo).toBeLessThan(0.35);
    expect(hi).toBeGreaterThan(0.94);

    // Forty leads at the same observed rate is a claim; the interval says so.
    const lo40 = betaQuantile(41, 1, 0.1);
    expect(lo40).toBeGreaterThan(0.9);
  });

  it("is monotone in p and bounded to the unit interval", () => {
    let prev = -1;
    for (const p of [0, 0.01, 0.25, 0.5, 0.75, 0.99, 1]) {
      const q = betaQuantile(3, 7, p);
      expect(q).toBeGreaterThanOrEqual(prev);
      expect(q).toBeGreaterThanOrEqual(0);
      expect(q).toBeLessThanOrEqual(1);
      prev = q;
    }
  });
});

/* ------------------------------------------------------------------ *
 * studentTTwoSided — significance for the cannibalisation check
 * ------------------------------------------------------------------ */

describe("studentTTwoSided", () => {
  it("matches the Cauchy closed form at one degree of freedom", () => {
    /*
     * df = 1 IS the Cauchy, whose CDF is 1/2 + arctan(t)/π. So the two-sided
     * tail is exactly 1 − 2·arctan(t)/π — a reference the function knows
     * nothing about.
     */
    for (const t of [0.5, 1, Math.sqrt(3), 4]) {
      close(studentTTwoSided(t, 1), 1 - (2 * Math.atan(t)) / Math.PI, 1e-10);
    }
    close(studentTTwoSided(1, 1), 0.5, 1e-12); // half the mass beyond ±1
  });

  it("matches the closed form at two degrees of freedom", () => {
    // P(|T| > t) = 1 − t/√(2+t²) for df = 2.
    for (const t of [0.25, 1, 2, 5]) {
      close(studentTTwoSided(t, 2), 1 - t / Math.sqrt(2 + t * t), 1e-10);
    }
  });

  it("reproduces the printed table value for ten degrees of freedom", () => {
    // The 5% two-sided critical value at df = 10 is 2.228.
    expect(studentTTwoSided(2.228, 10)).toBeCloseTo(0.05, 3);
  });

  it("is one at zero and falls monotonically", () => {
    expect(studentTTwoSided(0, 8)).toBe(1);
    let prev = 1;
    for (const t of [0.5, 1, 2, 3, 6]) {
      const p = studentTTwoSided(t, 8);
      expect(p).toBeLessThan(prev);
      prev = p;
    }
  });

  it("is symmetric in the sign of t", () => {
    close(studentTTwoSided(1.7, 9), studentTTwoSided(-1.7, 9), 1e-12);
  });
});

/* ------------------------------------------------------------------ *
 * spearman
 * ------------------------------------------------------------------ */

describe("spearman", () => {
  it("is 1 for any increasing relationship, linear or not", () => {
    // The reason it is rank-based: a dozen monthly points have no reason to be
    // linear, and Pearson would report far less than 1 here.
    close(spearman([1, 2, 3, 4, 5], [1, 4, 9, 16, 25]), 1, 1e-12);
    close(spearman([1, 2, 3, 4, 5], [1, 2, 3, 4, 900]), 1, 1e-12);
  });

  it("is −1 for a perfectly reversed relationship", () => {
    close(spearman([1, 2, 3, 4, 5], [5, 4, 3, 2, 1]), -1, 1e-12);
  });

  it("matches the hand-computed 1 − 6Σd²/n(n²−1)", () => {
    // x ranks 1..5, y = [2,1,4,3,5] ranks [2,1,4,3,5]; Σd² = 4.
    // r = 1 − 6·4 / (5·24) = 0.8.
    close(spearman([1, 2, 3, 4, 5], [2, 1, 4, 3, 5]), 0.8, 1e-12);
  });

  it("🔴 averages ranks across ties instead of inventing an order", () => {
    /*
     * Months with identical spend are common — a flat budget produces them by
     * the handful. Breaking ties by input order would manufacture a correlation
     * out of the order rows happened to arrive in.
     */
    const a = spearman([1, 1, 1, 2, 3], [5, 4, 3, 2, 1]);
    const b = spearman([1, 1, 1, 2, 3], [3, 4, 5, 2, 1]);
    close(a, b, 1e-12);
  });

  it("refuses fewer than three points, and a flat series", () => {
    expect(Number.isNaN(spearman([1, 2], [1, 2]))).toBe(true);
    // Every month identical: there is no ordering to correlate against.
    expect(Number.isNaN(spearman([5, 5, 5, 5], [1, 2, 3, 4]))).toBe(true);
  });

  it("finds nothing in an unrelated pair", () => {
    expect(Math.abs(spearman([1, 2, 3, 4, 5, 6], [3, 1, 5, 2, 6, 4]))).toBeLessThan(0.5);
  });
});

describe("poissonAtMost", () => {
  /**
   * An independent implementation by the pmf recurrence — no lnGamma, no
   * logarithms. Two routes to the same number is worth more here than any
   * single hand-checked value, because a wrong tail silently changes which
   * clients a person is told to phone.
   */
  const byRecurrence = (k: number, mean: number) => {
    let pmf = Math.exp(-mean);
    let total = pmf;
    for (let i = 1; i <= k; i++) {
      pmf = (pmf * mean) / i;
      total += pmf;
    }
    return total;
  };

  it("matches values computable by hand", () => {
    // P(X ≤ 0 | λ=1) = e^-1; P(X ≤ 2 | λ=1) = e^-1 · (1 + 1 + ½)
    close(poissonAtMost(0, 1), Math.exp(-1), 1e-12);
    close(poissonAtMost(2, 1), Math.exp(-1) * 2.5, 1e-12);
  });

  it("matches the published tail for λ=10", () => {
    // P(X ≤ 5 | λ=10) = 0.067086, a standard table value.
    close(poissonAtMost(5, 10), 0.067086, 1e-6);
  });

  it("agrees with the recurrence across a wide range", () => {
    for (const mean of [0.5, 1, 3, 10, 40, 200]) {
      for (const k of [0, 1, 2, 5, 12, 40, 120, 400]) {
        close(poissonAtMost(k, mean), byRecurrence(k, mean), 1e-9);
      }
    }
  });

  it("🔴 does not underflow at a large mean, where the recurrence does", () => {
    /*
     * At λ=800, `Math.exp(-800)` IS zero in double precision, so the naive
     * recurrence above collapses the entire distribution to 0 — asserted here,
     * because that is the bug this function's log-space summation exists to
     * avoid. Returned as 0, an utterly ordinary count would read as impossible
     * and flag a large client every single week.
     *
     * Checked instead against the normal approximation with a continuity
     * correction: Φ(0.5/√800) = Φ(0.01768) ≈ 0.5071. The true value sits a
     * little above it because Poisson is right-skewed.
     */
    expect(byRecurrence(800, 800)).toBe(0);
    const clt = 0.5 + (0.5 / Math.sqrt(800)) * 0.3989422804;
    expect(Math.abs(poissonAtMost(800, 800) - clt)).toBeLessThan(0.01);
    expect(poissonAtMost(800, 800)).toBeGreaterThan(0.5);
  });

  it("approaches one far above the mean and zero far below", () => {
    expect(poissonAtMost(100, 5)).toBeCloseTo(1, 10);
    expect(poissonAtMost(0, 60)).toBeLessThan(1e-20);
  });

  it("returns one when the rate is zero", () => {
    // A process producing nothing cannot exceed anything. Not NaN, and not a
    // division — the caller compares a count against a prior period that may
    // genuinely have been empty.
    expect(poissonAtMost(0, 0)).toBe(1);
    expect(poissonAtMost(5, 0)).toBe(1);
  });

  it("refuses nonsense rather than returning a number", () => {
    expect(Number.isNaN(poissonAtMost(-1, 5))).toBe(true);
    expect(Number.isNaN(poissonAtMost(5, -1))).toBe(true);
    expect(Number.isNaN(poissonAtMost(NaN, 5))).toBe(true);
  });

  it("is monotone in k", () => {
    let prev = 0;
    for (let k = 0; k <= 30; k++) {
      const v = poissonAtMost(k, 8);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});
