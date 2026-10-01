// Unit test: signature checks and payment settlement for owner-signed bills (no chain needed).
import assert from "node:assert/strict";
import os from "node:os"; import fs from "node:fs"; import path from "node:path";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { Bills, BillError } from "../src/bills.js";

const owner = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const MANDATE = "0x1111111111111111111111111111111111111111";
const PAYEE = "0x2222222222222222222222222222222222222222";
const pub = { readContract: async () => owner.address };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bills-"));
const bills = new Bills({ cfg: { chainId: 5042, dataDir: dir }, pub });
const now = Date.now();
const msg = (o) => ["Mandate bill", `mandate: ${MANDATE}`, "chain: 5042", ...Object.entries(o).map(([k, v]) => `${k}: ${v}`)].join("\n");
const add = (id, extra = {}) => msg({ action: "add", id, payee: PAYEE, amount: "3.50", due: new Date(now + 86400e3).toISOString(), label: "Logo design", issued: new Date(now).toISOString(), ...extra });
const sign = (who, m) => who.signMessage({ message: m });
const rejects = async (p, re) => { await assert.rejects(p, (e) => e instanceof BillError && re.test(e.message)); };
let n = 0; const ok = (s) => { n++; console.log(`  ✓ ${s}`); };

const m1 = add("inv-001");
const b = await bills.submit({ message: m1, signature: await sign(owner, m1) }, now);
assert.equal(b.amount, "3.50"); ok("owner-signed bill accepted");
await rejects(bills.submit({ message: m1, signature: await sign(owner, m1) }, now), /already exists/); ok("same bill id rejected (replay)");
const m2 = add("inv-002");
await rejects(bills.submit({ message: m2, signature: await sign(stranger, m2) }, now), /not from this account's owner/); ok("stranger's signature rejected");
const m3 = add("inv-003", { issued: new Date(now - 3600e3).toISOString() });
await rejects(bills.submit({ message: m3, signature: await sign(owner, m3) }, now), /stale/); ok("hour-old signature rejected");
const m4 = add("inv-004").replace("chain: 5042", "chain: 1");
await rejects(bills.submit({ message: m4, signature: await sign(owner, m4) }, now), /chain/); ok("other-chain signature rejected");
const m5 = add("inv-005");
await rejects(bills.submit({ message: m5.replace("3.50", "350.00"), signature: await sign(owner, m5) }, now), /not from/); ok("tampered amount rejected");
await rejects(bills.submit({ message: add("inv-006", { amount: "-1" }), signature: "0x" + "00".repeat(65) }, now), /amount/); ok("negative amount rejected");

const ts = Math.floor(now / 1000);
const ev = (to, amount, dt) => ({ name: "Withdrawn", args: { to, amount: String(amount), highWaterMark: "0" }, ts: ts + dt, tx: `0xtx${dt}` });
assert.equal(bills.list(MANDATE, [])[0].status, "open"); ok("bill open before any payment");
assert.deepEqual(bills.payables(MANDATE, []).map((p) => p.amount), ["3.50"]); ok("open bill becomes an agent payable");
assert.equal(bills.list(MANDATE, [ev(PAYEE, 3_000_000, 60)])[0].status, "open"); ok("partial payment does not settle");
assert.equal(bills.list(MANDATE, [ev(owner.address, 3_500_000, 60)])[0].status, "open"); ok("payment to someone else does not settle");
assert.equal(bills.list(MANDATE, [ev(PAYEE, 3_500_000, -3600)])[0].status, "open"); ok("payment before the bill existed does not settle");
const paid = bills.list(MANDATE, [ev(PAYEE, 3_500_000, 60)])[0];
assert.equal(paid.status, "paid"); assert.equal(paid.paidTx, "0xtx60"); ok("matching payment settles the bill");
assert.equal(bills.payables(MANDATE, [ev(PAYEE, 3_500_000, 60)]).length, 0); ok("paid bill no longer reserved by the agent");
assert.ok(!("signature" in paid) && !("message" in paid)); ok("public listing hides signatures");

const rm = msg({ action: "remove", id: "inv-001", issued: new Date(now).toISOString() });
await bills.submit({ message: rm, signature: await sign(owner, rm) }, now);
assert.equal(bills.list(MANDATE, []).length, 0); ok("owner can remove a bill");

// an attacker's own contract with an owner() function is not a mandate: nothing is stored for it
const gated = new Bills({ cfg: { chainId: 5042, dataDir: dir }, pub, isMandate: async (a) => a.toLowerCase() === MANDATE });
const fake = add("inv-777").replace(MANDATE, "0x3333333333333333333333333333333333333333");
await rejects(gated.submit({ message: fake, signature: await sign(owner, fake) }, now), /not a mandate/); ok("bill for a contract outside the factory rejected");
console.log(`\n${n} bill checks pass`);
