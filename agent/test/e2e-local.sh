#!/usr/bin/env bash
# Full local run: anvil + real Mandate contracts + mock USDC/vault + the real agent process.
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT"
RPC=http://127.0.0.1:8547
OWNER_PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
AGENT_PK=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
OWNER=$(cast wallet address $OWNER_PK); AGENT=$(cast wallet address $AGENT_PK)
WORK=$(mktemp -d); trap 'kill $(jobs -p) 2>/dev/null || true' EXIT

anvil --port 8547 --silent & sleep 2
node agent/test/fake-llm.mjs 4999 >/dev/null & sleep 0.5
forge build -q
dep() { forge create --rpc-url $RPC --private-key $OWNER_PK --broadcast "$@" 2>/dev/null | awk '/Deployed to/{print $3}'; }
USDC=$(dep test/mocks/Mocks.sol:MockUSDC)
VAULT=$(dep test/mocks/Mocks.sol:MockVault --constructor-args $USDC)
cast send $USDC "mint(address,uint256)" $OWNER 100000000 --rpc-url $RPC --private-key $OWNER_PK >/dev/null
FACTORY=$(USDC=$USDC forge script script/Deploy.s.sol --rpc-url $RPC --private-key $OWNER_PK --broadcast 2>&1 | awk '/MandateFactory:/{print $2}')
MANDATE=$(FACTORY=$FACTORY AGENT=$AGENT VAULT=$VAULT DEPOSIT=5000000 forge script script/CreateMandate.s.sol --rpc-url $RPC --private-key $OWNER_PK --broadcast 2>&1 | awk '/Mandate:/{print $2}')
echo "factory $FACTORY | mandate $MANDATE | vault $VAULT"

cat > "$WORK/.env" <<ENV
ARC_RPC_URL=$RPC
CHAIN_ID=31337
FACTORY=$FACTORY
USDC=$USDC
KNOWN_VENUES=$VAULT:MockVault
AGENT_PRIVATE_KEY=$AGENT_PK
LLM_BASE_URL=http://127.0.0.1:4999
PORT=8196
DATA_DIR=$WORK/data
PAYABLES_FILE=$WORK/payables.json
INDEX_FROM_BLOCK=0
POKE_MINUTES=0
HEARTBEAT_HOURS=1000
EXPLORER_URL=local
ENV
run() { (set -a; . "$WORK/.env"; set +a; node agent/src/index.js --once) 2>&1 | sed 's/^[0-9T:.Z-]* //' | grep -v "^api on"; }
nav() { printf "   state: nav=%s idle=%s deployed=%s frozen=%s\n" \
  "$(cast call $MANDATE 'nav()(uint256)' --rpc-url $RPC | awk '{print $1}')" \
  "$(cast call $USDC 'balanceOf(address)(uint256)' $MANDATE --rpc-url $RPC | awk '{print $1}')" \
  "$(cast call $MANDATE 'deployed()(uint256)' --rpc-url $RPC | awk '{print $1}')" \
  "$(cast call $MANDATE 'frozen()(bool)' --rpc-url $RPC)"; }

echo; echo "── 1. idle cash, nothing due: reviewer stages the sweep (half)"; run; nav
echo; echo "── 2. next cycle: remaining idle above target, sweep again"; run; nav
NOW=$(cast block latest -f timestamp --rpc-url $RPC)
DUE=$(node -e 'console.log(new Date(Number(process.argv[1]) * 1000).toISOString())' "$((NOW + 6*3600))")
echo "{\"$MANDATE\":[{\"id\":\"inv-1\",\"label\":\"contractor invoice\",\"amount\":\"2.00\",\"dueAt\":\"$DUE\"}]}" > "$WORK/payables.json"
echo; echo "── 3. invoice of 2.00 due in 6h: mandatory withdrawal"; run; nav
echo; echo "── 4. vault loses 1%: agent exits everything"; cast send $VAULT "simulateLoss(uint256)" 100 --rpc-url $RPC --private-key $OWNER_PK >/dev/null; run; nav
echo; echo "── 5. owner freezes: agent only alerts"; cast send $MANDATE "freeze()" --rpc-url $RPC --private-key $OWNER_PK >/dev/null; run; nav

echo; echo "── on-chain notes"
cast logs --address $MANDATE "Note(bytes32 indexed,bytes32,string)" --from-block 0 --rpc-url $RPC --json | node -e '
let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{for(const l of JSON.parse(d)){const tag=Buffer.from(l.topics[1].slice(2),"hex").toString().replace(/\0+$/,"");console.log("   ",tag.padEnd(10),"hash",l.data.slice(0,66).replace(/^0x0*/,"0x").slice(0,18)+"…")}})'
echo; echo "── decision record served by the API matches its on-chain hash"
(set -a; . "$WORK/.env"; set +a; node agent/src/index.js >/dev/null 2>&1 &) ; sleep 3
H=$(node -e 'const i=require(process.argv[1]);console.log(i.at(-1).hash)' "$WORK/data/decisions/index.json")
curl -s http://127.0.0.1:8196/d/$H.json > "$WORK/rec.json"
echo "   served $(wc -c < "$WORK/rec.json") bytes; keccak = $(cast keccak "$(cat "$WORK/rec.json")")"
echo "   index  hash              = $H"
curl -s "http://127.0.0.1:8196/api/events?mandate=$MANDATE" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const e=JSON.parse(d).events;const n={};for(const x of e)n[x.name]=(n[x.name]||0)+1;console.log("   indexed events:",JSON.stringify(n))})'
pkill -f "agent/src/index.js" || true
