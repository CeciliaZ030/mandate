import { fmt } from "./policy.js";

const SYSTEM = `You are the review layer of a corporate cash-sweep agent that operates a USDC account on the Arc blockchain under an on-chain mandate.
The deterministic policy already computed every candidate action and every amount. You may only choose ONE candidate by its id. You cannot invent actions or amounts.
Priorities, in order: (1) payables must always be covered, (2) never risk the principal, (3) earn yield on genuinely idle cash, (4) avoid churn that wastes gas for negligible gain.
Answer with JSON only: {"choice":"<candidate id>","rationale":"<max 280 chars, plain English, cite the numbers>","risk_flags":["<short flag>", ...]}`;

export function buildPrompt(snap, decision) {
  const v = snap.venue;
  const lines = [
    `Mandate ${snap.mandate}`,
    `NAV ${fmt(decision.facts.nav ?? 0n)} USDC | idle ${fmt(snap.idle)} | deployed ${fmt(v?.value ?? 0n)} at ${v?.name ?? "n/a"}`,
    `High-water mark ${fmt(snap.hwm)} | limits: maxDeployed ${fmt(snap.limits.maxDeployed)}, maxDrawdown ${snap.limits.maxDrawdownBps} bps, maxLossPerCall ${snap.limits.maxLossPerCallBps} bps, expires ${new Date(snap.limits.expiry * 1000).toISOString()}`,
    v ? `Venue cap ${fmt(v.cap)} | APY ${v.apyBps == null ? "unknown (<1h history)" : (v.apyBps / 100).toFixed(2) + "%" + (v.apySource ? ` (${v.apySource})` : "")} | withdrawable ${v.withdrawable === null ? "unknown" : fmt(v.withdrawable)}` : "",
    v?.circle ? `Circle Earn Kit on this vault: ${v.circle.available} USDC available of ${v.circle.totalDeposits} (${v.circle.liquidPct ?? "?"}%) | warnings: ${v.circle.warnings.length ? v.circle.warnings.join(", ") : "none"}${v.circle.circleGuarded ? " | Circle-guarded" : ""}` : "",
    `Idle target ${fmt(decision.facts.target ?? 0n)} (band ±${fmt(decision.facts.band ?? 0n)}) | payables due ≤72h ${fmt(decision.facts.dueHorizon ?? 0n)}, ≤24h ${fmt(decision.facts.dueUrgent ?? 0n)}`,
    `Upcoming payables: ${snap.payables.length ? snap.payables.map((p) => `${p.label} ${fmt(p.amount)} due ${new Date(p.dueAt * 1000).toISOString()}`).join("; ") : "none"}`,
    `Gas per action ≈ 0.003-0.005 USDC.`,
    `Note: yield accrual can lift "deployed" slightly above maxDeployed or the venue cap. That is normal and NOT a breach; only calls that add exposure are capped.`,
    `Candidates:`,
    ...decision.candidates.map((c) => `- id=${c.id} kind=${c.kind} amount=${fmt(c.amount)} USDC — ${c.why}`),
  ];
  return lines.filter(Boolean).join("\n");
}

/** Pull the last parseable {...} object out of a model reply, ignoring <think> blocks and code fences. */
export function extractJson(text) {
  if (typeof text !== "string" || !text) return null;
  const t = text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/```(?:json)?/gi, "");
  for (let end = t.lastIndexOf("}"); end >= 0; end = t.lastIndexOf("}", end - 1)) {
    for (let start = t.lastIndexOf("{", end); start >= 0; start = t.lastIndexOf("{", start - 1)) {
      try {
        const o = JSON.parse(t.slice(start, end + 1));
        if (o && typeof o === "object" && "choice" in o) return o;
      } catch {}
    }
  }
  return null;
}

/** force: ask even when there is nothing to choose (the injection test measures what a steered reviewer would do on mandatory actions). */
export async function review(cfg, snap, decision, { force = false } = {}) {
  if (!cfg.llm.baseUrl || (!force && decision.candidates.length < 2)) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), cfg.llm.timeoutMs);
  try {
    const res = await fetch(`${cfg.llm.baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "content-type": "application/json", ...(cfg.llm.apiKey ? { authorization: `Bearer ${cfg.llm.apiKey}` } : {}) },
      body: JSON.stringify({
        model: cfg.llm.model,
        temperature: 0,
        // reasoning models spend tokens thinking before they answer: leave room for both
        max_tokens: cfg.llm.maxTokens,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: buildPrompt(snap, decision) },
        ],
      }),
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).replace(/\s+/g, " ").slice(0, 160)}`);
    const body = await res.json();
    const msg = body.choices?.[0]?.message ?? {};
    const json = extractJson(msg.content); // the answer only, never scrape the thinking trace
    if (!json) {
      const fin = body.choices?.[0]?.finish_reason;
      const peek = String(msg.content ?? "").replace(/\s+/g, " ").slice(0, 120);
      throw new Error(`no JSON in reply (finish_reason=${fin}${fin === "length" ? ", raise LLM_MAX_TOKENS" : ""}; content="${peek}")`);
    }
    return {
      choice: String(json.choice ?? ""),
      rationale: String(json.rationale ?? "").slice(0, 400),
      riskFlags: Array.isArray(json.risk_flags) ? json.risk_flags.map(String).slice(0, 6) : [],
      model: body.model || cfg.llm.model,
    };
  } catch (err) {
    return { choice: "", rationale: "", riskFlags: [], model: cfg.llm.model, error: String(err.message || err) };
  } finally {
    clearTimeout(t);
  }
}
