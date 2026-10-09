import assert from "node:assert/strict";
import { parseAbi } from "viem";
import { parseAccount } from "viem/accounts";
import { CircleWallet } from "../src/circle-wallet.js";

const walletAddress = "0x1111111111111111111111111111111111111111";
const mandate = "0x2222222222222222222222222222222222222222";
const venue = "0x3333333333333333333333333333333333333333";
const txHash = `0x${"44".repeat(32)}`;
const abi = parseAbi([
  "function execute(address target, bytes data) returns (bool)",
  "function note(bytes32 tag, bytes32 contentHash, string uri)",
]);

let invocation;
const wallet = new CircleWallet({
  account: parseAccount(walletAddress),
  chain: "ARC",
  run: async (binary, args) => {
    invocation = { binary, args };
    return { data: { state: "COMPLETE", txHash } };
  },
});

assert.equal(
  await wallet.writeContract({ address: mandate, abi, functionName: "execute", args: [venue, "0x1234"] }),
  txHash,
);
assert.deepEqual(invocation, {
  binary: "circle",
  args: [
    "wallet", "execute", "execute(address,bytes)", venue, "0x1234",
    "--contract", mandate, "--address", walletAddress, "--chain", "ARC",
  ],
});

const confirmed = new CircleWallet({
  account: parseAccount(walletAddress),
  chain: "ARC",
  run: async () => ({ data: { state: "CONFIRMED", txHash } }),
});
assert.equal(
  await confirmed.writeContract({ address: mandate, abi, functionName: "execute", args: [venue, "0x1234"] }),
  txHash,
);

const failed = new CircleWallet({
  account: parseAccount(walletAddress),
  chain: "ARC",
  run: async () => ({ data: { state: "FAILED" } }),
});
await assert.rejects(
  failed.writeContract({ address: mandate, abi, functionName: "note", args: [`0x${"00".repeat(32)}`, `0x${"11".repeat(32)}`, "https://example.com"] }),
  /did not confirm: FAILED/,
);

console.log("  ✓ Circle wallet accepts Circle's confirmed and complete terminal states");
console.log("  ✓ Circle wallet refuses non-confirmed transactions");

// The signer config must survive alongside the Earn Kit config (both are Circle settings).
{
  const env = { ...process.env };
  Object.assign(process.env, {
    ARC_RPC_URL: "http://127.0.0.1:1", FACTORY: mandate, AGENT_SIGNER: "circle",
    CIRCLE_WALLET_ADDRESS: walletAddress, CHAIN_ID: "5042",
  });
  const { config } = await import("../src/config.js");
  const { loadAccount, clients } = await import("../src/chain.js");
  const cfg = config();
  assert.equal((await loadAccount(cfg)).address, walletAddress);
  assert.ok(clients(cfg, await loadAccount(cfg)).wallet instanceof CircleWallet);
  assert.equal(typeof cfg.circle.enabled, "boolean"); // Earn Kit settings intact
  process.env = env;
}
console.log("  ✓ AGENT_SIGNER=circle loads the Circle wallet from env, Earn Kit config intact");
