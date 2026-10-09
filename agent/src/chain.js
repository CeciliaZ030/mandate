import fs from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, parseAbi } from "viem";
import { parseAccount, privateKeyToAccount } from "viem/accounts";
import { REPO_DIR } from "./config.js";
import { CircleWallet } from "./circle-wallet.js";

const abi = (name) => JSON.parse(fs.readFileSync(path.join(REPO_DIR, "abi", `${name}.json`), "utf8"));
export const MANDATE_ABI = abi("MandateAccount");
export const FACTORY_ABI = abi("MandateFactory");

export const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
]);
export const ERC4626_ABI = parseAbi([
  "function asset() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function maxWithdraw(address) view returns (uint256)",
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function withdraw(uint256 assets, address receiver, address owner) returns (uint256)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256)",
]);

export function makeChain(cfg) {
  return defineChain({
    id: cfg.chainId,
    name: cfg.chainId === 5042 ? "Arc" : `chain-${cfg.chainId}`,
    // native view of USDC is 18 decimals; all accounting here uses the 6-dec ERC-20
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  });
}

export async function loadAccount(cfg) {
  if (cfg.signer === "circle") {
    if (!cfg.circleWallet.address) throw new Error("AGENT_SIGNER=circle requires CIRCLE_WALLET_ADDRESS");
    if (!cfg.circleWallet.chain) throw new Error("AGENT_SIGNER=circle requires CIRCLE_CHAIN for this chain id");
    return parseAccount(cfg.circleWallet.address);
  }
  if (cfg.signer !== "local") throw new Error(`unsupported AGENT_SIGNER ${cfg.signer}; expected local or circle`);
  if (cfg.keystore) {
    if (!cfg.keystorePasswordFile) throw new Error("KEYSTORE set but KEYSTORE_PASSWORD_FILE missing");
    const st = fs.statSync(cfg.keystorePasswordFile);
    if (st.mode & 0o077) throw new Error(`${cfg.keystorePasswordFile} must be chmod 600`);
    const { Wallet } = await import("ethers");
    const json = fs.readFileSync(cfg.keystore, "utf8");
    const pw = fs.readFileSync(cfg.keystorePasswordFile, "utf8").replace(/\r?\n$/, "");
    const w = await Wallet.fromEncryptedJson(json, pw);
    return privateKeyToAccount(w.privateKey);
  }
  if (cfg.privateKey) return privateKeyToAccount(cfg.privateKey);
  throw new Error("no agent key: set KEYSTORE + KEYSTORE_PASSWORD_FILE (preferred) or AGENT_PRIVATE_KEY");
}

export function clients(cfg, account) {
  const chain = makeChain(cfg);
  const transport = http(cfg.rpcUrl, { retryCount: 3, timeout: 20_000 });
  const pub = createPublicClient({ chain, transport });
  const wallet = account
    ? cfg.signer === "circle"
      ? new CircleWallet({ account, chain: cfg.circleWallet.chain, binary: cfg.circleWallet.cli })
      : createWalletClient({ chain, transport, account })
    : null;
  return { chain, pub, wallet };
}
