import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { BillError } from "./bills.js";

const RPC_ALLOW = new Set(["eth_chainId", "eth_blockNumber", "eth_call", "eth_getBalance", "eth_getCode", "eth_getLogs", "eth_getTransactionReceipt", "eth_getBlockByNumber"]);
const MAX_LOG_RANGE = 10_000;

/** Read-only API for the dashboard: indexed events, decision records, live snapshots, and an allow-listed RPC relay. */
export function startServer({ cfg, indexer, bills, circle, getStatus, log }) {
  const decisionsDir = path.join(cfg.dataDir, "decisions");
  const send = (res, code, body, type = "application/json") => {
    res.writeHead(code, {
      "content-type": type,
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "cache-control": "no-store",
    });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };

  // Re-index at most every 5s (concurrent syncs coalesce), and right away when the dashboard
  // says it just saw a transaction in a block the index hasn't reached (?block=N): a payment the
  // owner just made then shows on the ledger and settles its bill without waiting for a cycle.
  const freshen = async (url) => {
    const want = Number(url.searchParams.get("block") || 0);
    const behind = () => Number.isSafeInteger(want) && want > 0 && Number(indexer.db.cursor) <= want;
    const stale = !indexer.lastSync || Date.now() - indexer.lastSync > 5_000;
    const deadline = Date.now() + 8_000;
    for (let i = 0; i < 2 && (i === 0 ? stale || behind() : behind()) && Date.now() < deadline; i++)
      await Promise.race([indexer.sync().catch(() => {}), new Promise((r) => setTimeout(r, deadline - Date.now()))]);
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://x");
      if (req.method === "OPTIONS") return send(res, 204, "");
      if (url.pathname === "/api/health") return send(res, 200, { ok: true, ...getStatus() });

      // Circle's view of every vault on Arc (Earn Kit), cached by the agent
      if (url.pathname === "/api/vaults") {
        await circle?.refresh();
        return send(res, 200, circle ? circle.list() : { enabled: false, vaults: [] });
      }

      if (url.pathname === "/api/events") {
        const m = url.searchParams.get("mandate");
        await freshen(url);
        return send(res, 200, { cursor: indexer.db.cursor, events: m ? indexer.eventsFor(m) : indexer.db.events.slice(-2000) });
      }

      if (url.pathname === "/api/bills" && req.method === "GET") {
        const m = url.searchParams.get("mandate");
        if (!m || !/^0x[0-9a-fA-F]{40}$/.test(m)) return send(res, 400, { error: "mandate required" });
        await freshen(url);
        return send(res, 200, bills.list(m, indexer.eventsFor(m)));
      }

      if (url.pathname === "/api/bills" && req.method === "POST") {
        let raw = "";
        for await (const ch of req) {
          raw += ch;
          if (raw.length > 4_000) return send(res, 413, { error: "too large" });
        }
        try {
          const bill = await bills.submit(JSON.parse(raw));
          log(`  bill ${bill.removed ? "removed" : "added"}: ${bill.label} ${bill.amount} USDC to ${bill.payee} due ${bill.due}`);
          const { message, signature, removeMessage, removeSignature, ...pub } = bill;
          return send(res, 200, pub);
        } catch (e) {
          if (e instanceof BillError || e instanceof SyntaxError) return send(res, 400, { error: e.message });
          throw e;
        }
      }

      if (url.pathname === "/api/decisions") {
        const f = path.join(decisionsDir, "index.json");
        const idx = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : [];
        const m = url.searchParams.get("mandate")?.toLowerCase();
        return send(res, 200, (m ? idx.filter((d) => d.mandate?.toLowerCase() === m) : idx).slice(-200).reverse());
      }

      const d = url.pathname.match(/^\/d\/(0x[0-9a-f]{64})\.json$/);
      if (d) {
        const f = path.join(decisionsDir, `${d[1]}.json`);
        return fs.existsSync(f) ? send(res, 200, fs.readFileSync(f, "utf8")) : send(res, 404, { error: "not found" });
      }

      if (url.pathname === "/rpc" && req.method === "POST") {
        let raw = "";
        for await (const ch of req) {
          raw += ch;
          if (raw.length > 64_000) return send(res, 413, { error: "too large" });
        }
        const body = JSON.parse(raw);
        const calls = Array.isArray(body) ? body : [body];
        if (calls.length > 20) return send(res, 400, { error: "batch too large" });
        for (const c of calls) {
          if (typeof c !== "object" || c === null || !RPC_ALLOW.has(c.method)) return send(res, 403, { error: `method not allowed` });
          if (c.params !== undefined && !Array.isArray(c.params)) return send(res, 400, { error: "params must be an array" });
          if (c.method === "eth_getLogs") {
            const p = c.params?.[0] || {};
            const from = parseInt(p.fromBlock, 16), to = parseInt(p.toBlock, 16);
            if (!Number.isFinite(from) || !Number.isFinite(to) || to - from > MAX_LOG_RANGE) return send(res, 400, { error: "log range too large" });
          }
        }
        // re-serialize from the validated fields only: the upstream RPC may read duplicate or
        // differently-cased keys ("Method", "Params") that the checks above never saw
        const clean = calls.map((c) => {
          let params = Array.isArray(c.params) ? c.params : [];
          if (c.method === "eth_getLogs") {
            const p = params[0] || {};
            params = [{ address: p.address, topics: p.topics, fromBlock: p.fromBlock, toBlock: p.toBlock }];
          }
          return { jsonrpc: "2.0", id: c.id ?? null, method: c.method, params };
        });
        const up = await fetch(cfg.rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(Array.isArray(body) ? clean : clean[0]),
          signal: AbortSignal.timeout(15_000),
        });
        return send(res, up.status, await up.text());
      }

      return send(res, 404, { error: "not found" });
    } catch (e) {
      return send(res, 500, { error: String(e.message || e) });
    }
  });
  server.on("error", (e) => {
    log(e.code === "EADDRINUSE" ? `api: port ${cfg.port} is taken; set PORT in .env to a free port. The agent keeps running without the API.` : `api error: ${e.message}`);
  });
  server.listen(cfg.port, cfg.host, () => log(`api on http://${cfg.host}:${cfg.port}`));
  return server;
}
