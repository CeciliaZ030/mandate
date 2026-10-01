// Owner-signed bills: the owner tells the agent what has to be paid and when.
// A bill is a plain-text message signed with the owner's wallet (EIP-191), so the
// agent's server cannot invent bills and nobody but the owner can add or remove one.
// A bill is settled automatically when the account pays the payee at least its amount
// (a Withdrawn event to that address after the bill was created).
import fs from "node:fs";
import path from "node:path";
import { getAddress, isAddress, verifyMessage } from "viem";
import { MANDATE_ABI } from "./chain.js";

const HEADER = "Mandate bill";
const MAX_MSG = 1200;
const MAX_OPEN = 50;
const MAX_STORED = 200; // per account, removed bills included
const CLOCK_SKEW_S = 600;

export class BillError extends Error {}

/** Parse "key: value" lines. The signed text itself is the source of truth. */
export function parseBillMessage(message) {
  if (typeof message !== "string" || message.length > MAX_MSG) throw new BillError("message missing or too long");
  const lines = message.replace(/\r/g, "").split("\n");
  if (lines[0].trim() !== HEADER) throw new BillError(`message must start with "${HEADER}"`);
  const f = {};
  for (const line of lines.slice(1)) {
    const i = line.indexOf(":");
    if (i < 1) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    if (k in f) throw new BillError(`duplicate field ${k}`);
    f[k] = line.slice(i + 1).trim();
  }
  for (const k of ["mandate", "chain", "action", "id", "issued"]) if (!f[k]) throw new BillError(`missing ${k}`);
  if (!isAddress(f.mandate)) throw new BillError("bad mandate address");
  if (!/^[A-Za-z0-9_-]{4,40}$/.test(f.id)) throw new BillError("bad id");
  if (!["add", "remove"].includes(f.action)) throw new BillError("action must be add or remove");
  const issued = Date.parse(f.issued);
  if (!Number.isFinite(issued)) throw new BillError("bad issued time");
  const out = { mandate: getAddress(f.mandate), chain: Number(f.chain), action: f.action, id: f.id, issued };
  if (f.action === "add") {
    if (!isAddress(f.payee ?? "")) throw new BillError("bad payee address");
    if (!/^\d{1,7}(\.\d{1,6})?$/.test(f.amount ?? "")) throw new BillError("amount must be a USDC number with up to 6 decimals");
    const amt = Number(f.amount);
    if (!(amt > 0)) throw new BillError("amount must be positive");
    const due = Date.parse(f.due ?? "");
    if (!Number.isFinite(due)) throw new BillError("bad due date");
    const label = String(f.label ?? "").slice(0, 80);
    Object.assign(out, { payee: getAddress(f.payee), amount: f.amount, due: new Date(due).toISOString(), label: label || "Bill" });
  }
  return out;
}

export class Bills {
  /** isMandate(address) → bool: only accounts created by our factory may store bills (anyone can deploy a contract with an owner()). */
  constructor({ cfg, pub, isMandate = null }) {
    this.cfg = cfg;
    this.pub = pub;
    this.isMandate = isMandate;
    this.file = path.join(cfg.dataDir, "bills.json");
    this.db = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, "utf8")) : {};
  }

  save() {
    fs.mkdirSync(this.cfg.dataDir, { recursive: true });
    fs.writeFileSync(this.file + ".tmp", JSON.stringify(this.db, null, 1));
    fs.renameSync(this.file + ".tmp", this.file);
  }

  /** Verify an owner-signed message and apply it. Returns the resulting bill list entry. */
  async submit({ message, signature }, now = Date.now()) {
    const m = parseBillMessage(message);
    if (m.chain !== this.cfg.chainId) throw new BillError(`signed for chain ${m.chain}, this agent runs on ${this.cfg.chainId}`);
    if (Math.abs(now - m.issued) > CLOCK_SKEW_S * 1000) throw new BillError("signature is stale; sign again");
    if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new BillError("bad signature");
    if (this.isMandate && !(await this.isMandate(m.mandate))) throw new BillError("not a mandate account from this factory");
    let owner;
    try {
      owner = await this.pub.readContract({ address: m.mandate, abi: MANDATE_ABI, functionName: "owner" });
    } catch {
      throw new BillError("not a mandate account");
    }
    const ok = await verifyMessage({ address: owner, message, signature }).catch(() => false);
    if (!ok) throw new BillError("signature is not from this account's owner");

    const key = m.mandate.toLowerCase();
    const list = (this.db[key] ||= []);
    const existing = list.find((b) => b.id === m.id);
    if (m.action === "add") {
      if (existing) throw new BillError("a bill with this id already exists");
      if (list.filter((b) => !b.removed).length >= MAX_OPEN || list.length >= MAX_STORED) throw new BillError(`at most ${MAX_OPEN} open bills per account`);
      const bill = { id: m.id, label: m.label, payee: m.payee, amount: m.amount, due: m.due, createdAt: new Date(m.issued).toISOString(), message, signature };
      list.push(bill);
      this.save();
      return bill;
    }
    if (!existing || existing.removed) throw new BillError("no such bill");
    existing.removed = new Date(m.issued).toISOString();
    existing.removeMessage = message;
    existing.removeSignature = signature;
    this.save();
    return existing;
  }

  /** Bills with status, settled against Withdrawn events (each payment settles at most one bill). */
  list(mandate, events) {
    const bills = (this.db[mandate.toLowerCase()] || []).filter((b) => !b.removed);
    const pays = events
      .filter((e) => e.name === "Withdrawn")
      .map((e) => ({ to: String(e.args.to).toLowerCase(), amount: BigInt(e.args.amount), ts: e.ts ?? Infinity, tx: e.tx, used: false }));
    const units = (s) => BigInt(Math.round(Number(s) * 1e6));
    return [...bills]
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .map((b) => {
        const created = Date.parse(b.createdAt) / 1000 - 120; // tolerate small clock differences
        const p = pays.find((x) => !x.used && x.to === b.payee.toLowerCase() && x.amount >= units(b.amount) && x.ts >= created);
        if (p) p.used = true;
        const { message, signature, ...pub } = b;
        return { ...pub, status: p ? "paid" : "open", paidTx: p?.tx ?? null };
      });
  }

  /** Open bills in the agent's payables format. */
  payables(mandate, events) {
    return this.list(mandate, events)
      .filter((b) => b.status === "open")
      .map((b) => ({ id: `bill-${b.id}`, label: b.label, amount: b.amount, dueAt: b.due }));
  }
}
