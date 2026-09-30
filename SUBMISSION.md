# Tameion submission: Mandate

> Draft. Fill the `TODO` lines on the day you submit; everything else is true as of Oct 1, 2026.

## The problem, in two sentences

A company can't hand its treasury to an AI agent, because the agent's limits live in the agent's own code, where nobody can verify them and a bug or a prompt injection can route around them. Mandate puts the limits in the account itself: the agent sweeps idle USDC into yield and keeps payables covered, and the Arc contract refuses anything outside the mandate, freezes the account, and keeps the attempt on-chain.

## Links

| | |
|---|---|
| Live dashboard | TODO (Vercel URL) |
| Repo | https://github.com/Makabeez/mandate |
| Agent API / decision records | https://mandate.baserep.xyz/api/health |
| Factory (Arc mainnet) | `0xb3F362850E04aD6e9147698Cc1EdbcB8891f307e` |
| First mandate (Arc mainnet) | `0xEa08f2195ae9f29079a4cb6aFB05238949576d57` |
| Reproduce in one command | `make judge-demo` (no wallet, no RPC, no key, under 60s) |
| Video | TODO (60-90s: dashboard, a live sweep, the breach tx on the explorer) |

## What happens in a cycle

1. The agent reads the account (idle cash, vault position, high-water mark, limits) and the company's upcoming payables.
2. A deterministic policy computes the idle target (reserve plus payables due in 72h, +10%) and every candidate action with its exact amount.
3. A reviewer LLM (Kimi via LiteLLM, any OpenAI-compatible model) picks one candidate by id and writes the rationale. It cannot invent actions or amounts; urgent payables and risk exits are mandatory and it cannot veto them.
4. Each call is simulated as `execute()` from the agent address. If the mandate would refuse it, it is never sent.
5. The call executes through the mandate, which re-checks everything on-chain.
6. The full decision record is hashed and posted with `note(tag, hash, uri)`. The dashboard fetches the record and verifies the hash.

## What was built during Tameion (Sept 27 – Oct 10)

Honest delta: the `MandateAccount` / `MandateFactory` contracts were written on Sept 18, before the window.

| Built in the window | Evidence |
|---|---|
| Mainnet deployment of factory and first mandate (Sept 30) | factory deploy tx `0x128abd1c…`, block 23603562 |
| Live agent deposit into Galaxy USDC (Morpho) | tx `0xd9614d93…c6c2` |
| Live blocked theft attempt (`BAD_ARG`) + owner unfreeze | tx `0x1acc1506…8152`, `0x5cd4803d…67a0` |
| Treasury agent: payables-aware policy, reviewer LLM, preflight, on-chain decision log, event indexer, API | `agent/`, commits from Oct 1 |
| Dashboard: live headroom ruler, ledger with verifiable reasoning, one-flow mandate creation, owner console | `app/index.html` |
| Offline judge demo + local end-to-end harness | `make judge-demo`, `make e2e` |

## Real vs. simulated

| Claim | Status |
|---|---|
| Contracts deployed and operating on Arc mainnet | **Real** |
| Agent deposit into a live Morpho vault on Arc | **Real** |
| Breach blocked on mainnet, funds untouched, account frozen and unfrozen | **Real**, triggered on purpose by the builder to prove the guard |
| Agent sweeps and notes on mainnet | TODO: **Real** once the agent has run (tx links) |
| Payables schedule | **Illustrative** amounts from the builder's own mandate; no third-party company data |
| Vault loss / drawdown / expiry exits | **Simulated** in `make e2e` (mock vault loses 1%) and the judge scenarios; not triggered on mainnet |
| Third-party mandates | TODO: number of wallets other than the builder's that created a mandate |
| Reviewer model | **Real** LiteLLM call in production; a deterministic stub in local tests, labelled `stub-reviewer` in records |

## Constants and where they come from

| Constant | Value | Basis |
|---|---|---|
| Max loss per call | 10 bps | Measured: the live 5 USDC deposit lost 1 unit (0.000001 USDC) to vault rounding, 0.002 bps. 10 bps is 5,000× that and still catches a skimming venue in tests. |
| Reserve | max(0.5 USDC, 10% of NAV) | Owner-set policy, not derived. Configurable in `.env`. |
| Payables horizon / urgency | 72h / 24h, +10% buffer | Owner-set policy. |
| Risk exit on share price | >5 bps drop between observations | A lending vault's share price should never fall; any drop means bad debt or an exploit. 5 bps sits above rounding noise. |
| Drawdown exit | half of the mandate limit | Leaves room to exit through the vault before the contract freezes the account. |
| Gas per agent action | ~0.003–0.004 USDC | Measured on mainnet: 159,983 gas (approve) and 199,718 gas (deposit) at 20 gwei. |

## The honest limit: size

At the default cadence the agent spends about 0.003 USDC a day on upkeep (one `poke()`, ~0.0023 USDC measured at 114k gas, plus one heartbeat note, ~0.0008 USDC estimated), before any sweep. Galaxy USDC pays about 0.61% APY, so a 5 USDC mandate earns ~0.00008 USDC a day: **at demo size the agent costs more than it earns.** Break-even is roughly 180 USDC under mandate; above that the yield pays for the agent. The demo mandate exists to prove the guard and the decision loop on mainnet, not the economics.

## Circle tooling used

- Arc mainnet: settlement, deterministic finality for limit checks, USDC as gas.
- USDC's ERC-20 interface at `0x3600…0000` for all accounting.
- Not used: Gateway, App Kits, Agent Stack, Arc Studio. TODO: if time allows, one of these; otherwise say so.

## Traction

TODO before submitting: the number of mandates created by wallets other than the builder's, total USDC under mandate, and agent actions on mainnet. The hosted agent accepts any mandate that names it; the dashboard's create flow takes about seven wallet confirmations.

## Tooling feedback for Circle (separate $500 prize)

1. **Foundry scripts cannot move USDC on Arc.** `forge script` simulates locally before broadcasting, and USDC's `transferFrom` calls the blocklist precompile at `0x1800…0001`, which Foundry's EVM does not have (`OpcodeNotFound`). The whole script aborts and nothing is broadcast, including unrelated setup calls. The workaround was splitting setup (forge) from funding (`cast send`). A documented note, or a Foundry precompile shim, would save every team a debugging session.
2. **The RPC reference labels the mainnet endpoint "permissioned"**, but `rpc.mainnet.arc.io` answered `eth_chainId` and served a full deploy without allowlisting. Builders may go buy a private endpoint they don't need. Stating the actual policy (rate limits, which methods) would help.
3. **Native vs ERC-20 decimals** (18 vs 6 for the same balance) is well explained in the docs, but every tool that sends native value is a trap: `cast send --value 2` sends 2e-18 USDC. A bold warning in the "Connect to Arc" page would prevent real losses.
4. **ERC-4626 `max*` functions are not reliable liquidity signals across vault designs**; some implementations return 0 by design, so an agent that trusts `maxWithdraw` can conclude nothing is withdrawable. Not Circle's bug, but an Arc integration guide for the Morpho vaults that launched with mainnet (which to use, how to read liquidity) would help. Mandate treats 0 as unknown and relies on preflight simulation.
