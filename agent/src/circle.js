// Circle's view of each lending vault on Arc, through Circle's Earn Kit (App Kit SDK):
// available liquidity, APY and Circle's own risk warnings (low_liquidity, not_whitelisted,
// timelock, ...). The policy refuses new deposits into a vault Circle flags; withdrawals are
// never blocked by it. If the service is unreachable the agent runs exactly as before.
//
// Earn Kit can also sign deposits, but only from its own wallet adapter. Mandate's money must
// leave through the account's execute(), where the contract checks it, so the agent uses Earn
// Kit for what it knows about vaults, never to move funds.

const CHAINS = { 5042: "Arc", 5042002: "Arc_Testnet" };

export class CircleVaults {
  constructor({ cfg, log = () => {} }) {
    this.cfg = cfg;
    this.log = log;
    this.chain = CHAINS[cfg.chainId] ?? null;
    this.enabled = cfg.circle.enabled && !!this.chain;
    this.byAddr = new Map();
    this.at = 0; // ms of the last successful refresh
    this.error = null;
    this.inflight = null;
  }

  /** Refresh at most every ttl; concurrent callers share one request. Never throws. */
  refresh(force = false) {
    if (!this.enabled) return Promise.resolve();
    if (!force && Date.now() - this.at < this.cfg.circle.ttlMs) return Promise.resolve();
    this.inflight ||= this._refresh().finally(() => (this.inflight = null));
    return this.inflight;
  }

  async _refresh() {
    try {
      const ek = await import("@circle-fin/earn-kit");
      const ctx = ek.createEarnKitContext(this.cfg.circle.apiKey ? { apiKey: this.cfg.circle.apiKey } : {});
      const next = new Map();
      for await (const v of ek.exploreVaultsIterator(ctx, { chain: this.chain, sortBy: "tvl" })) next.set(String(v.vaultAddress).toLowerCase(), summarize(v));
      if (!next.size) throw new Error("Earn Kit returned no vaults");
      this.byAddr = next;
      this.at = Date.now();
      this.error = null;
    } catch (e) {
      this.error = String(e?.message || e).slice(0, 200);
      this.log(`circle earn kit unavailable: ${this.error}`);
    }
  }

  /** Circle's signals for one vault, or null if unknown or older than staleMs. */
  get(address) {
    if (!this.enabled || !address || Date.now() - this.at > this.cfg.circle.staleMs) return null;
    return this.byAddr.get(String(address).toLowerCase()) ?? null;
  }

  list() {
    return { enabled: this.enabled, chain: this.chain, asOf: this.at ? new Date(this.at).toISOString() : null, error: this.error, vaults: [...this.byAddr.values()] };
  }
}

const bps = (x) => (typeof x === "number" && Number.isFinite(x) ? Math.round(x * 10_000) : null);

/** Keep the fields the policy and the dashboard use; drop free text other than the vault's name. */
export function summarize(v) {
  const total = Number(v.totalDeposits);
  const avail = Number(v.liquidity);
  const warnings = [...(v.riskSignals?.warnings ?? v.warnings ?? []), ...(v.riskSignals?.earnKitWarnings ?? [])]
    .map((w) => String(w?.type ?? w).replace(/[^a-z_]/gi, "").slice(0, 32))
    .filter(Boolean);
  return {
    address: String(v.vaultAddress).toLowerCase(),
    name: String(v.name ?? "").slice(0, 60),
    asset: String(v.asset ?? ""),
    apyBps: bps(v.currentApy),
    apy7dBps: bps(v.apyProfile?.d7),
    totalDeposits: String(v.totalDeposits ?? "0"),
    available: String(v.liquidity ?? "0"),
    liquidPct: total > 0 ? Math.round((1000 * avail) / total) / 10 : null,
    warnings: [...new Set(warnings)],
    circleGuarded: !!v.circleGuarded,
    asOf: v.asOf ?? null,
  };
}
