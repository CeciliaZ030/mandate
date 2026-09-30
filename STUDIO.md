# Arc Studio brief: Mandate UI

How to use: open Arc Studio (web, or as a subagent in Claude Code), paste the
prompt below, and attach `abi/*.json`. **Studio generates the frontend only.**
The contracts in `src/` are hand-written and tested; Studio must not generate,
modify or redeploy them. Export the result into `app/` in this repo.

Studio deploys to testnets only. For mainnet, deploy `src/` with Foundry
(see README) and point the UI at those addresses via env vars.

---

## Prompt

Build a single-page Next.js app called **Mandate** for existing contracts on
Arc (chain 5042; testnet 5042002). Use the attached ABIs exactly. Do NOT write
or deploy any Solidity. Read contract addresses from env:
`NEXT_PUBLIC_FACTORY`, `NEXT_PUBLIC_CHAIN_ID`. USDC ERC-20 is
`0x3600000000000000000000000000000000000000` with 6 decimals (never use
18-decimal native balances for display).

### Pages

**1. Leaderboard (`/`)**
- Read `MandateFactory.count()` and `allMandates(i)`.
- For each mandate: `nav()`, `highWaterMark()`, `deployed()`, `frozen()`,
  `agent()`, `limits()`. Show a table: agent (short address), NAV, return vs
  total deposits (sum of `Deposited` minus `Withdrawn` events), current
  drawdown vs HWM, status badge (Active / Frozen / Expired), breach count
  (`Breach` events).
- Sort by return. Frozen rows are shown, never hidden: a breach is public.

**2. Mandate detail (`/m/[address]`)**
- Header: NAV, HWM, drawdown floor (`drawdownFloor()`), deployed vs
  `maxDeployed`, expiry countdown, status.
- Limits card: every field of `limits()` in human units (bps → %).
- Venues card: `venueList()` → `venues(addr)` (active, cap) with current value
  from the valuer.
- **Activity timeline** from events, newest first, each linking to the Arc
  explorer tx: `Executed` (target, selector decoded to a function name when it
  matches deposit/withdraw/redeem/approve, NAV before → after), `Breach`
  (reason decoded from bytes32 to text, red), `CallReverted` (grey),
  `Checkpoint`, `Note` (tag + link to uri), `Deposited`, `Withdrawn`.
- Button: **Poke** (calls `poke()`, anyone can).

**3. Owner console (`/m/[address]/owner`, only when the connected wallet == `owner()`)**
- Deposit (approve USDC then `deposit`), Withdraw, Freeze, Unfreeze,
  Reset HWM.
- Set limits form, Set agent.
- Add venue form: vault address → deploy nothing; ask for an existing valuer
  address, cap in USDC → `setVenue`. Then preset rules for ERC-4626 with one
  click: `deposit` 0x6e553f65 mask 0x02, `withdraw` 0xb460af94 mask 0x06,
  `redeem` 0xba087652 mask 0x06 → three `setRule` calls.

**4. Create (`/new`)**
- Form: agent address, max deployed (USDC), max drawdown %, max loss per
  call %, duration in days → `MandateFactory.create(agent, limits)`; redirect
  to the new mandate from the `MandateCreated` event.

### Style
Dark, calm, "risk desk" feel: near-black navy background (#0B1020), blue→cyan
accent (#3B82F6 → #22D3EE), monospace for numbers and addresses, red only for
breaches. No marketing hero. Data first.

### Non-goals
No custody, no pooled vaults, no token, no backend. Everything is read from
chain via viem.
