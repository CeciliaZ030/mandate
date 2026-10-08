import { ERC20_ABI, ERC4626_ABI, MANDATE_ABI } from "./chain.js";

const ONE_SHARE = 10n ** 18n;

/** Read everything the policy needs for one mandate. */
export async function snapshot({ pub, cfg, state, mandate, payables, circle = null }) {
  const m = { address: mandate, abi: MANDATE_ABI };
  const read = (functionName, args = []) => pub.readContract({ ...m, functionName, args });

  const [owner, agent, frozen, hwm, limitsRaw, venueList, idle, block] = await Promise.all([
    read("owner"),
    read("agent"),
    read("frozen"),
    read("highWaterMark"),
    read("limits"),
    read("venueList"),
    pub.readContract({ address: cfg.usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [mandate] }),
    pub.getBlock(),
  ]);
  const [maxDeployed, maxDrawdownBps, maxLossPerCallBps, expiry] = limitsRaw;
  const limits = { maxDeployed, maxDrawdownBps: Number(maxDrawdownBps), maxLossPerCallBps: Number(maxLossPerCallBps), expiry: Number(expiry) };
  const now = Number(block.timestamp);

  // first venue on the mandate that this agent knows how to operate
  let venue = null;
  for (const addr of venueList) {
    const known = cfg.venues.find((v) => v.address === addr.toLowerCase());
    if (!known) continue;
    const [active, cap] = await read("venues", [addr]);
    const v = { address: addr, abi: ERC4626_ABI };
    const [shares, sharePrice, allowance] = await Promise.all([
      pub.readContract({ ...v, functionName: "balanceOf", args: [mandate] }),
      pub.readContract({ ...v, functionName: "convertToAssets", args: [ONE_SHARE] }),
      pub.readContract({ address: cfg.usdc, abi: ERC20_ABI, functionName: "allowance", args: [mandate, addr] }),
    ]);
    const value = shares === 0n ? 0n : await pub.readContract({ ...v, functionName: "convertToAssets", args: [shares] });
    let withdrawable = null;
    try {
      const mw = await pub.readContract({ ...v, functionName: "maxWithdraw", args: [mandate] });
      // Vault V2 style vaults report 0 by design: treat as unknown, preflight decides
      withdrawable = mw === 0n && value > 0n ? null : mw;
    } catch {}
    const { dropBps, apyBps } = trackSharePrice(state, addr, now, sharePrice);
    // Circle's view of the vault (Earn Kit); its 7-day APY stands in until we have an hour of our own history
    const cv = circle?.get(addr) ?? null;
    const circleApy = cv ? cv.apy7dBps ?? cv.apyBps : null;
    venue = {
      address: addr, name: known.name, active, cap, shares, value, withdrawable, allowance, sharePrice, sharePriceDropBps: dropBps,
      apyBps: apyBps ?? circleApy, apySource: apyBps !== null ? "share price" : circleApy !== null ? "Circle Earn Kit, 7-day" : null,
      circle: cv,
    };
    break;
  }

  return {
    mandate,
    owner,
    agent,
    now,
    block: Number(block.number),
    frozen,
    hwm,
    idle,
    limits,
    venue,
    payables: parsePayables(payables[mandate.toLowerCase()] || []),
    cooldownUntil: state.cooldownUntil?.[mandate.toLowerCase()] ?? null,
  };
}

function parsePayables(rows) {
  const out = [];
  for (const p of Array.isArray(rows) ? rows : []) {
    const amt = Number(p?.amount);
    const due = Date.parse(p?.dueAt);
    if (!Number.isFinite(amt) || amt <= 0 || !Number.isFinite(due)) {
      console.warn(`payables: skipping invalid row ${JSON.stringify(p)}`);
      continue;
    }
    out.push({ id: String(p.id ?? ""), label: String(p.label ?? p.id ?? "payable"), amount: BigInt(Math.round(amt * 1e6)), dueAt: Math.floor(due / 1000) });
  }
  return out;
}

/** Keep a 7-day share-price history per venue; derive last-step drop and trailing APY. */
function trackSharePrice(state, venue, now, sp) {
  const key = venue.toLowerCase();
  const hist = (state.sharePrice[key] ||= []);
  const last = hist.at(-1);
  let dropBps = null;
  if (last) {
    const prev = BigInt(last[1]);
    dropBps = sp < prev ? Number(((prev - sp) * 10_000n) / prev) : 0;
  }
  if (!last || now - last[0] >= 300) hist.push([now, sp.toString()]);
  while (hist.length && now - hist[0][0] > 7 * 86400) hist.shift();
  let apyBps = null;
  const first = hist[0];
  if (first && now - first[0] >= 3600) {
    const r = Number(sp) / Number(first[1]);
    apyBps = Math.round((Math.pow(r, (365 * 86400) / (now - first[0])) - 1) * 10_000);
  }
  return { dropBps, apyBps };
}
