# Deploying the treasury agent and the dashboard

Everything below runs on the home VPS (WSL, PM2) from `/mnt/c/Github/mandate`.

## 1. Agent

```bash
cd /mnt/c/Github/mandate && git pull
cd agent && npm install
cp .env.example .env            # defaults already point at the live factory, Galaxy USDC and explorer
cp payables.example.json payables.json   # edit: real upcoming payments for the mandate

# keystore password, never typed on the command line
read -rsp "mandate-agent keystore password: " PW && printf '%s' "$PW" > ~/.mandate-agent.pass && unset PW && chmod 600 ~/.mandate-agent.pass

# dry run first: reads chain, asks the reviewer, preflights, sends nothing
DRY_RUN=true node src/index.js --once
```

Read the dry-run line for the live mandate. With 5 USDC fully deployed and no payables, expect a
discretionary `sweep_out` of 0.50 USDC (restoring the 10% idle reserve). Then go live:

```bash
node src/index.js --once        # one real cycle: action, note(), poke()
pm2 start ecosystem.config.cjs && pm2 save
pm2 logs mandate-agent --lines 30
```

`LLM_BASE_URL` points at the LiteLLM router (`agent-loop` alias). If the router has a master key,
set `LLM_API_KEY`. With no reviewer reachable, the agent falls back to the policy's primary choice
and says so in the decision record.

## 2. Public API (decision records linked from on-chain notes)

The agent serves `/api/*`, `/d/<hash>.json` and a read-only RPC relay on `127.0.0.1:8095`.
Expose it through the existing Baserep tunnel:

```bash
CFG=/home/vps/.cloudflared/baserep-config.yml
cp $CFG $CFG.bak.$(date +%s)
grep -c "mandate.baserep.xyz" $CFG || python3 - "$CFG" <<'EOF'
import sys; p=sys.argv[1]; s=open(p).read()
entry = "  - hostname: mandate.baserep.xyz\n    service: http://127.0.0.1:8095\n"
i = s.rfind("  - service: http_status:404")
assert i > 0, "catch-all rule not found"
open(p, "w").write(s[:i] + entry + s[i:]); print("ingress added")
EOF
cloudflared tunnel list                                   # copy the full ID of the Baserep tunnel (starts f65acfa8)
cloudflared tunnel route dns <full-tunnel-id> mandate.baserep.xyz
pm2 restart baserep-tunnel && sleep 5
curl -s https://mandate.baserep.xyz/api/health
```

`127.0.0.1`, not `localhost`: Node resolves `localhost` to `::1` first.

## 3. Dashboard

Static, one file: `app/index.html`. Deploy the folder to Vercel:

```bash
cd /mnt/c/Github/mandate/app && npx vercel deploy --prod
```

It reads Arc directly and falls back to the agent's `/rpc` relay if the browser can't reach
the RPC. For a local check against anvil: `?rpc=…&chain=31337&factory=…&featured=…&api=…`.
