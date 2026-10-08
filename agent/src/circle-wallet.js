import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getAbiItem, getAddress } from "viem";

const execFileAsync = promisify(execFile);

const abiType = (input) => {
  if (!input.type.startsWith("tuple")) return input.type;
  const suffix = input.type.slice("tuple".length);
  return `(${input.components.map(abiType).join(",")})${suffix}`;
};

const cliArg = (value) => {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return `[${value.map(cliArg).join(",")}]`;
  if (value && typeof value === "object") return `(${Object.values(value).map(cliArg).join(",")})`;
  return String(value);
};

async function runCircle(binary, args) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(binary, [...args, "--output", "json"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 180_000,
    }));
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message).trim();
    throw new Error(`Circle CLI failed: ${detail}`);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`Circle CLI returned invalid JSON: ${stdout.trim()}`);
  }
}

/** Viem-compatible writeContract adapter backed by a Circle Agent Wallet. */
export class CircleWallet {
  constructor({ account, chain, binary = "circle", run = runCircle }) {
    this.account = account;
    this.chain = chain;
    this.binary = binary;
    this.run = run;
  }

  async writeContract({ address, abi, functionName, args = [], value = 0n }) {
    const item = getAbiItem({ abi, name: functionName, args });
    if (!item || item.type !== "function") throw new Error(`ABI function not found: ${functionName}`);
    const signature = `${item.name}(${item.inputs.map(abiType).join(",")})`;
    const command = [
      "wallet",
      "execute",
      signature,
      ...args.map(cliArg),
      "--contract",
      getAddress(address),
      "--address",
      this.account.address,
      "--chain",
      this.chain,
    ];
    if (value) command.push("--amount", value.toString());

    const response = await this.run(this.binary, command);
    const transaction = response?.data ?? response;
    if (transaction?.state !== "CONFIRMED" || !transaction.txHash) {
      throw new Error(`Circle transaction did not confirm: ${transaction?.state || "unknown state"}`);
    }
    return transaction.txHash;
  }
}
