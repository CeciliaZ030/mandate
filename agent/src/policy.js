// Pure decision engine for a corporate cash-sweep mandate.
// No I/O: takes a snapshot, returns candidate actions. Every amount the agent
// can ever move is computed here, never by the LLM.

export const USDC = 1_000_000n; // 6 decimals
export const BPS = 10_000n;

const min = (a, b) => (a < b ? a : b);
const max = (a, b) => (a > b ? a : b);
export const fmt = (x) => {
  const neg = x < 0n;
  const v = neg ? -x : x;
  const s = `${v / USDC}.${(v % USDC).toString().padStart(6, "0")}`;
  return (neg ? "-" : "") + s;
};

export const DEFAULTS = {
  reserveFloor: 500_000n, // 0.5 USDC always idle
  reserveBps: 1000n, // plus 10% of NAV idle
  horizonHours: 72, // payables due inside this window must be covered
  urgentHours: 24, // shortfall inside this window is non-negotiable
  payableBufferBps: 1000n, // cover payables +10%
  graceHours: 24, // ignore payables overdue by more than this (assumed paid)
  minMove: 250_000n, // never move less than 0.25 USDC
  bandBps: 500n, // tolerate idle within +/-5% of NAV of target before acting
  lossTripBps: 5n, // vault share price down >5 bps since last look => exit
  drawdownTripFrac: 2n, // exit at 1/2 of the mandate's drawdown limit
  windDownHours: 24, // exit venue this long before mandate expiry
  exitDustUnits: 1_000n, // withdrawals within 0.001 USDC of the position => redeem all
  capHeadroomBps: 10n, // stay 0.1% (min 0.01 USDC) under caps: interest accrues between preflight and inclusion
  capHeadroomMin: 10_000n,
};

/**
 * @param s snapshot {
 *   now (unix s), idle, hwm, frozen,
 *   limits {maxDeployed, maxDrawdownBps, maxLossPerCallBps, expiry},
 *   venue: null | { address, name, cap, active, value, shares, withdrawable|null,
 *                   sharePriceDropBps, apyBps|null },
 *   payables: [{ id, label, amount, dueAt }]
 * }
 */
export function decide(s, cfg = DEFAULTS) {
  const c = { ...DEFAULTS, ...cfg };
  const alert = (why) => result("ALERT", [{ id: "alert", kind: "ALERT", amount: 0n, mandatory: true, why }]);

  if (s.frozen) return alert("account is frozen by the mandate; owner review required before any action");
  if (s.now >= s.limits.expiry) return alert("mandate has expired; the agent has no rights left");
  const v = s.venue;
  if (!v || !v.active) return alert("no active, supported venue on this mandate");

  const nav = s.idle + v.value;
  const facts = { nav, idle: s.idle, deployed: v.value };
  const ddBpsNow = s.hwm > 0n && s.hwm > nav ? ((s.hwm - nav) * BPS) / s.hwm : 0n;
  const hoursLeft = (s.limits.expiry - s.now) / 3600;
  // conditions under which the agent must not (re-)enter the venue, deployed or not
  const noEntry =
    ddBpsNow * c.drawdownTripFrac > BigInt(s.limits.maxDrawdownBps)
      ? `drawdown ${ddBpsNow} bps is past half of the ${s.limits.maxDrawdownBps} bps limit; owner review needed before re-entering`
      : hoursLeft < c.windDownHours
        ? `mandate expires in ${hoursLeft.toFixed(1)}h; no new deployments`
        : s.cooldownUntil && s.now < s.cooldownUntil
          ? `cooling down after a risk exit until ${new Date(s.cooldownUntil * 1000).toISOString()}`
          : null;

  // ── hard risk exits: mandatory, the LLM cannot veto them ──
  if (v.value > 0n) {
    const exitAll = (why) =>
      result("RISK_EXIT", [{ id: "exit_all", kind: "EXIT_ALL", amount: v.value, mandatory: true, why }], facts);
    if (v.sharePriceDropBps !== null && v.sharePriceDropBps > Number(c.lossTripBps))
      return exitAll(`vault share price fell ${v.sharePriceDropBps} bps since the last observation`);
    if (ddBpsNow * c.drawdownTripFrac > BigInt(s.limits.maxDrawdownBps))
      return exitAll(`drawdown ${ddBpsNow} bps is past half of the ${s.limits.maxDrawdownBps} bps limit`);
    if (hoursLeft < c.windDownHours) return exitAll(`mandate expires in ${hoursLeft.toFixed(1)}h; winding down`);
  }

  // ── liquidity target from the payables schedule ──
  const H = 3600;
  const live = s.payables.filter((p) => p.dueAt >= s.now - c.graceHours * H);
  const dueIn = (hours) => live.filter((p) => p.dueAt <= s.now + hours * H).reduce((a, p) => a + p.amount, 0n);
  const withBuffer = (x) => (x * (BPS + c.payableBufferBps)) / BPS;
  const dueHorizon = dueIn(c.horizonHours);
  const dueUrgent = dueIn(c.urgentHours);

  let target = max(c.reserveFloor, (nav * c.reserveBps) / BPS);
  target = max(target, withBuffer(dueHorizon));
  target = min(target, nav);
  let uneconomic = null; // set when a deploy can't pay back its own gas
  const band = max(c.minMove, (nav * c.bandBps) / BPS);
  const gap = s.idle - target;
  Object.assign(facts, { target, band, dueHorizon, dueUrgent });

  const cands = [];
  const urgentShort = withBuffer(dueUrgent) > s.idle;

  if (urgentShort || gap < -band) {
    // pull cash out of the venue
    const cap = v.withdrawable ?? v.value;
    let need = min(target - s.idle, cap);
    if (need > 0n) {
      const kind = need + c.exitDustUnits >= v.value ? "EXIT_ALL" : "SWEEP_OUT";
      if (kind === "EXIT_ALL") need = v.value;
      const why = urgentShort
        ? `payables of ${fmt(dueUrgent)} USDC fall due within ${c.urgentHours}h and idle cash is ${fmt(s.idle)}`
        : `idle ${fmt(s.idle)} is below the ${fmt(target)} target (reserve + payables due in ${c.horizonHours}h)`;
      cands.push({ id: "sweep_out", kind, amount: need, mandatory: urgentShort, why });
      if (!urgentShort && kind === "SWEEP_OUT") {
        const half = need / 2n;
        if (half >= c.minMove)
          cands.push({ id: "sweep_out_half", kind: "SWEEP_OUT", amount: half, mandatory: false, why: "stage the withdrawal in two steps" });
      }
    }
  } else if (gap > band && !noEntry) {
    // put idle cash to work
    const head = (x) => max(c.capHeadroomMin, (x * c.capHeadroomBps) / BPS);
    const room = (limit) => (limit > v.value + head(limit) ? limit - v.value - head(limit) : 0n);
    const venueRoom = room(v.cap);
    const mandateRoom = room(s.limits.maxDeployed);
    const amt = min(gap, min(venueRoom, mandateRoom));
    // break-even filter: a deploy must earn back its gas within minBreakevenDays
    const gas = c.gasPerAction ?? 5_000n;
    const days = BigInt(Math.max(1, Math.round(c.minBreakevenDays ?? 30)));
    const apy = v.apyBps == null ? null : BigInt(Math.max(0, Math.round(v.apyBps)));
    const earns = (x) => (apy === null ? null : (x * apy * days) / (BPS * 365n));
    const pays = (x) => apy === null || earns(x) >= gas; // APY unknown: don't block
    if (amt >= c.minMove && !pays(amt))
      uneconomic = `skipped deploy of ${fmt(amt)}: gas ${fmt(gas)} exceeds its ${days}-day yield of ${fmt(earns(amt))} at ${(v.apyBps / 100).toFixed(2)}% APY`;
    if (amt >= c.minMove && pays(amt)) {
      cands.push({
        id: "sweep_in",
        kind: "SWEEP_IN",
        amount: amt,
        mandatory: false,
        why: `idle ${fmt(s.idle)} exceeds the ${fmt(target)} target; ${fmt(amt)} can earn yield within caps`,
      });
      const half = amt / 2n;
      if (half >= c.minMove && pays(half))
        cands.push({ id: "sweep_in_half", kind: "SWEEP_IN", amount: half, mandatory: false, why: "deploy half now, keep optionality" });
    }
  }

  const mandatory = cands.filter((x) => x.mandatory);
  if (mandatory.length) return result("MUST_ACT", mandatory, facts);
  const lo = target > band ? target - band : 0n;
  const hi = target + band;
  const range = `${fmt(lo)} to ${fmt(hi)}`;
  const holdWhy =
    s.idle < lo
      ? `do nothing: idle ${fmt(s.idle)} stays below the ${range} band (target ${fmt(target)}); saves gas but leaves the reserve short`
      : s.idle > hi
        ? cands.length
          ? `do nothing: idle ${fmt(s.idle)} stays above the ${fmt(hi)} ceiling and earns no yield; saves gas`
          : noEntry || uneconomic || `idle ${fmt(s.idle)} is above the ${fmt(hi)} ceiling but the venue cap or maxDeployed is already reached`
        : `idle ${fmt(s.idle)} is within the ${range} band around the ${fmt(target)} target`;
  cands.push({ id: "hold", kind: "HOLD", amount: 0n, mandatory: false, why: holdWhy });
  return result(cands.length > 1 ? "DISCRETIONARY" : "HOLD", cands, facts);
}

function result(mode, candidates, facts = {}) {
  return { mode, candidates, primary: candidates[0], facts };
}

/** Enforce that a reviewer's choice is one of the candidates; otherwise fall back. */
export function resolveChoice(decision, review) {
  const ids = new Set(decision.candidates.map((c) => c.id));
  if (decision.mode === "MUST_ACT" || decision.mode === "RISK_EXIT" || decision.mode === "ALERT")
    return { chosen: decision.primary, overridden: review?.choice && review.choice !== decision.primary.id, reason: "mandatory" };
  if (!review || !ids.has(review.choice)) return { chosen: decision.primary, overridden: !!review, reason: "invalid_or_missing_review" };
  return { chosen: decision.candidates.find((c) => c.id === review.choice), overridden: false, reason: "reviewer" };
}
