import fs from "node:fs";
import path from "node:path";
import { decodeEventLog } from "viem";
import { FACTORY_ABI, MANDATE_ABI } from "./chain.js";
import { reasonText } from "./executor.js";

const ser = (v) => (typeof v === "bigint" ? v.toString() : v);

/** Incrementally indexes every mandate's events so the dashboard does not have to scan the chain. */
export class Indexer {
  constructor({ pub, cfg, log }) {
    this.pub = pub;
    this.cfg = cfg;
    this.log = log;
    this.file = path.join(cfg.dataDir, "events.json");
    this.db = fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file, "utf8"))
      : { cursor: cfg.indexFromBlock.toString(), mandates: [], events: [], blockTimes: {} };
    this.chunk = 10_000n; // Arc caps eth_getLogs at 10k blocks
  }

  save() {
    fs.mkdirSync(this.cfg.dataDir, { recursive: true });
    fs.writeFileSync(this.file + ".tmp", JSON.stringify(this.db));
    fs.renameSync(this.file + ".tmp", this.file);
  }

  async mandates() {
    const n = await this.pub.readContract({ address: this.cfg.factory, abi: FACTORY_ABI, functionName: "count" });
    const all = [];
    for (let i = 0n; i < n; i++)
      all.push(await this.pub.readContract({ address: this.cfg.factory, abi: FACTORY_ABI, functionName: "allMandates", args: [i] }));
    return all;
  }

  /** Coalesce concurrent syncs (agent cycle + API requests) into one run. */
  sync() {
    this.inflight ||= this._sync().finally(() => {
      this.inflight = null;
      this.lastSync = Date.now();
    });
    return this.inflight;
  }

  async _sync() {
    const addrs = await this.mandates();
    const known = new Set(this.db.mandates.map((a) => a.toLowerCase()));
    const fresh = addrs.filter((a) => !known.has(a.toLowerCase()));
    // a new mandate needs its history from the start
    if (fresh.length && this.db.mandates.length) this.db.cursor = this.cfg.indexFromBlock.toString();
    this.db.mandates = addrs;
    if (!addrs.length) return this.save();

    const head = await this.pub.getBlockNumber({ cacheTime: 0 }); // viem caches the head for 4s by default
    let from = BigInt(this.db.cursor);
    const seen = new Set(this.db.events.map((e) => `${e.tx}:${e.logIndex}`));
    while (from <= head) {
      const to = from + this.chunk - 1n > head ? head : from + this.chunk - 1n;
      let logs;
      try {
        logs = await this.pub.getLogs({ address: [...addrs, this.cfg.factory], fromBlock: from, toBlock: to });
      } catch (e) {
        if (this.chunk > 500n) {
          this.chunk /= 2n;
          continue;
        }
        throw e;
      }
      for (const l of logs) {
        const id = `${l.transactionHash}:${l.logIndex}`;
        if (seen.has(id)) continue;
        const isFactory = l.address.toLowerCase() === this.cfg.factory.toLowerCase();
        let ev;
        try {
          ev = decodeEventLog({ abi: isFactory ? FACTORY_ABI : MANDATE_ABI, data: l.data, topics: l.topics });
        } catch {
          continue;
        }
        const args = Object.fromEntries(Object.entries(ev.args || {}).map(([k, v]) => [k, typeof v === "object" && v !== null && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).map(([a, b]) => [a, ser(b)])) : ser(v)]));
        if (ev.eventName === "Breach" || ev.eventName === "Frozen") args.reasonText = reasonText(args.reason);
        if (ev.eventName === "Note") args.tagText = reasonText(args.tag);
        this.db.events.push({
          mandate: isFactory ? args.mandate : l.address,
          name: ev.eventName,
          args,
          block: Number(l.blockNumber),
          tx: l.transactionHash,
          logIndex: l.logIndex,
        });
        seen.add(id);
      }
      from = to + 1n;
      this.db.cursor = from.toString();
      if (this.chunk < 10_000n) this.chunk *= 2n;
    }
    await this.fillTimes();
    this.db.events.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
    this.save();
  }

  async fillTimes() {
    const need = [...new Set(this.db.events.map((e) => e.block))].filter((b) => !this.db.blockTimes[b]);
    for (const b of need.slice(0, 200)) {
      const blk = await this.pub.getBlock({ blockNumber: BigInt(b) });
      this.db.blockTimes[b] = Number(blk.timestamp);
    }
    for (const e of this.db.events) e.ts = this.db.blockTimes[e.block] ?? null;
  }

  eventsFor(mandate) {
    const m = mandate.toLowerCase();
    return this.db.events.filter((e) => e.mandate?.toLowerCase() === m);
  }
}
