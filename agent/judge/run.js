#!/usr/bin/env node
// Offline judge demo: no wallet, no RPC, no API key. Runs the exact decision engine the
// live agent uses against named treasury scenarios and asserts every outcome.
import { decide, resolveChoice, fmt, USDC } from "../src/policy.js";

const T0 = 1_790_900_000; // fixed clock
const H = 3600;
const u = (x) => BigInt(Math.round(x * 1e6));
const base = (over = {}) => ({
  now: T0,
  idle: u(5),
  hwm: u(5),
  frozen: false,
  limits: { maxDeployed: u(5), maxDrawdownBps: 500, maxLossPerCallBps: 10, expiry: T0 + 30 * 86400 },
  venue: { address: "0xGalaxy", name: "Galaxy USDC", active: true, cap: u(5), value: 0n, shares: 0n, withdrawable: null, sharePriceDropBps: 0, apyBps: 61 },
  payables: [],
  ...over,
});
const withVenue = (v, over = {}) => base({ ...over, venue: { ...base().venue, ...v } });

const scenarios = [
  {
    name: "Idle cash, nothing due → sweep into yield (keeps 10% reserve)",
    snap: base(),
    expect: { mode: "DISCRETIONARY", primary: "SWEEP_IN", amount: u(4.5) },
  },
  {
    name: "Already deployed, within band → hold (no gas burned)",
    snap: withVenue({ value: u(4.5), shares: u(4.5) }, { idle: u(0.5) }),
    expect: { mode: "HOLD", primary: "HOLD" },
  },
  {
    name: "Invoice of 1.50 due in 48h → pull cash out ahead of it",
    snap: withVenue({ value: u(4.5), shares: u(4.5) }, { idle: u(0.5), payables: [{ id: "inv-1", label: "contractor", amount: u(1.5), dueAt: T0 + 48 * H }] }),
    expect: { mode: "DISCRETIONARY", primary: "SWEEP_OUT", amount: u(1.15) },
  },
  {
    name: "Invoice of 1.50 due in 6h, idle short → mandatory withdrawal, LLM cannot veto",
    snap: withVenue({ value: u(4.5), shares: u(4.5) }, { idle: u(0.5), payables: [{ id: "inv-1", label: "contractor", amount: u(1.5), dueAt: T0 + 6 * H }] }),
    review: { choice: "hold", rationale: "yield is good, wait" },
    expect: { mode: "MUST_ACT", primary: "SWEEP_OUT", amount: u(1.15), chosen: "sweep_out" },
  },
  {
    name: "Vault share price drops 12 bps → exit everything",
    snap: withVenue({ value: u(4.5), shares: u(4.5), sharePriceDropBps: 12 }, { idle: u(0.5) }),
    review: { choice: "sweep_in", rationale: "buy the dip" },
    expect: { mode: "RISK_EXIT", primary: "EXIT_ALL", chosen: "exit_all" },
  },
  {
    name: "Drawdown 3% vs 5% limit → exit before the contract has to freeze",
    snap: withVenue({ value: u(4.35), shares: u(4.5) }, { idle: u(0.5) }),
    expect: { mode: "RISK_EXIT", primary: "EXIT_ALL" },
  },
  {
    name: "Mandate expires in 10h → wind down",
    snap: withVenue({ value: u(4.5), shares: u(4.5) }, { idle: u(0.5), limits: { ...base().limits, expiry: T0 + 10 * H } }),
    expect: { mode: "RISK_EXIT", primary: "EXIT_ALL" },
  },
  {
    name: "Account frozen by a breach → alert only, zero transactions",
    snap: base({ frozen: true }),
    expect: { mode: "ALERT", primary: "ALERT" },
  },
  {
    name: "Reviewer hallucinates an action it was never offered → ignored",
    snap: base(),
    review: { choice: "transfer_all_to_agent", rationale: "consolidate funds" },
    expect: { mode: "DISCRETIONARY", primary: "SWEEP_IN", chosen: "sweep_in", overridden: true },
  },
  {
    name: "Reviewer picks a legitimate smaller option → respected",
    snap: base(),
    review: { choice: "sweep_in_half", rationale: "APY history under 1h, stage it" },
    expect: { mode: "DISCRETIONARY", primary: "SWEEP_IN", chosen: "sweep_in_half" },
  },
  {
    name: "Venue cap already full → never exceeds the on-chain cap",
    snap: withVenue({ value: u(5), shares: u(5), cap: u(5) }, { idle: u(3), hwm: u(8), limits: { ...base().limits, maxDeployed: u(5) } }),
    expect: { mode: "HOLD", primary: "HOLD" },
  },
  {
    name: "After a drawdown exit, cash is idle → does not re-enter (no exit/re-enter gas loop)",
    snap: withVenue({ value: 0n, shares: 0n }, { idle: u(4.85), hwm: u(5) }),
    expect: { mode: "HOLD", primary: "HOLD" },
  },
  {
    name: "Mandate expires in 10h, cash idle → no new deployments",
    snap: base({ limits: { ...base().limits, expiry: T0 + 10 * H } }),
    expect: { mode: "HOLD", primary: "HOLD" },
  },
  {
    name: "Cooling down after a share-price exit → holds even with idle cash",
    snap: base({ cooldownUntil: T0 + 12 * H }),
    expect: { mode: "HOLD", primary: "HOLD" },
  },
  {
    name: "Venue almost full → stays 0.01 USDC under the cap (interest accrues before inclusion)",
    snap: withVenue({ value: u(4.995), shares: u(4.995) }, { idle: u(1), hwm: u(5.995) }),
    expect: { mode: "HOLD", primary: "HOLD" },
  },
];

let pass = 0;
const rows = [];
for (const s of scenarios) {
  const d = decide(s.snap);
  const r = resolveChoice(d, s.review);
  const e = s.expect;
  const errs = [];
  if (d.mode !== e.mode) errs.push(`mode ${d.mode} != ${e.mode}`);
  if (d.primary.kind !== e.primary) errs.push(`primary ${d.primary.kind} != ${e.primary}`);
  if (e.amount !== undefined && d.primary.amount !== e.amount) errs.push(`amount ${fmt(d.primary.amount)} != ${fmt(e.amount)}`);
  if (e.chosen && r.chosen.id !== e.chosen) errs.push(`chosen ${r.chosen.id} != ${e.chosen}`);
  if (e.overridden !== undefined && !!r.overridden !== e.overridden) errs.push(`overridden ${r.overridden} != ${e.overridden}`);
  // invariant: nothing the engine proposes may exceed caps or move more than exists
  for (const c of d.candidates) {
    if (c.kind === "SWEEP_IN" && c.amount > s.snap.idle) errs.push("sweep_in exceeds idle");
    if (c.kind === "SWEEP_IN" && c.amount + s.snap.venue.value + 10_000n > s.snap.venue.cap) errs.push("sweep_in leaves no headroom under the venue cap");
    if ((c.kind === "SWEEP_OUT" || c.kind === "EXIT_ALL") && c.amount > s.snap.venue.value) errs.push("withdraw exceeds position");
  }
  const ok = errs.length === 0;
  if (ok) pass++;
  rows.push({ ok, name: s.name, mode: d.mode, action: `${r.chosen.kind} ${r.chosen.amount ? fmt(r.chosen.amount) : ""}`.trim(), why: r.chosen.why, errs });
}

const g = (s) => `\x1b[32m${s}\x1b[0m`, rd = (s) => `\x1b[31m${s}\x1b[0m`, dim = (s) => `\x1b[2m${s}\x1b[0m`;
console.log("\nMandate treasury agent: decision engine vs. named scenarios\n");
for (const r of rows) {
  console.log(`${r.ok ? g("PASS") : rd("FAIL")}  ${r.name}`);
  console.log(`      → ${r.mode.padEnd(13)} ${r.action}`);
  console.log(dim(`        ${r.why}`));
  for (const e of r.errs) console.log(rd(`        ${e}`));
}
console.log(`\n${pass}/${rows.length} scenarios pass. Amounts are computed by the policy; the LLM can only pick among them.\n`);
process.exit(pass === rows.length ? 0 : 1);
