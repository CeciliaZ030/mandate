#!/usr/bin/env bash
# The owner's bill flow, end to end on a local chain: the owner signs a bill, the agent's API
# verifies it, the agent raises cash for it, the owner pays, and the bill settles from the
# on-chain payment. Also checks that the API refuses forged, replayed, stale and tampered bills.
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT"
RPC=http://127.0.0.1:8548; API=http://127.0.0.1:8197
OWNER_PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
AGENT_PK=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
STRANGER_PK=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3f0eb5f5cf7a2b8d
OWNER=$(cast wallet address $OWNER_PK); AGENT=$(cast wallet address $AGENT_PK)
PAYEE=0x000000000000000000000000000000000000bEEF
WORK=$(mktemp -d); trap 'kill $(jobs -p) 2>/dev/null || true' EXIT
FAIL=0; ok() { echo "   ok   $*"; }; bad() { echo "   FAIL $*"; FAIL=1; }

anvil --port 8548 --silent >/dev/null 2>&1 & sleep 2
node agent/test/fake-llm.mjs 4998 >/dev/null 2>&1 & sleep 0.5
forge build -q
dep() { forge create --rpc-url $RPC --private-key $OWNER_PK --broadcast "$@" 2>/dev/null | awk '/Deployed to/{print $3}'; }
USDC=$(dep test/mocks/Mocks.sol:MockUSDC)
VAULT=$(dep test/mocks/Mocks.sol:MockVault --constructor-args $USDC)
cast send $USDC "mint(address,uint256)" $OWNER 100000000 --rpc-url $RPC --private-key $OWNER_PK >/dev/null
FACTORY=$(USDC=$USDC forge script script/Deploy.s.sol --rpc-url $RPC --private-key $OWNER_PK --broadcast 2>&1 | awk '/MandateFactory:/{print $2}')
MANDATE=$(FACTORY=$FACTORY AGENT=$AGENT VAULT=$VAULT DEPOSIT=20000000 forge script script/CreateMandate.s.sol --rpc-url $RPC --private-key $OWNER_PK --broadcast 2>&1 | awk '/Mandate:/{print $2}')
echo "factory $FACTORY | mandate $MANDATE (20 USDC) | vault $VAULT"

cat > "$WORK/.env" <<ENV
ARC_RPC_URL=$RPC
CHAIN_ID=31337
FACTORY=$FACTORY
USDC=$USDC
KNOWN_VENUES=$VAULT:MockVault
AGENT_PRIVATE_KEY=$AGENT_PK
LLM_BASE_URL=http://127.0.0.1:4998
PORT=8197
DATA_DIR=$WORK/data
PAYABLES_FILE=$WORK/payables.json
INDEX_FROM_BLOCK=0
POKE_MINUTES=100000
HEARTBEAT_HOURS=1000
CYCLE_SECONDS=36000
EXPLORER_URL=local
ENV
envrun() { (set -a; . "$WORK/.env"; set +a; exec "$@"); }
cycle() { envrun node agent/src/index.js --once 2>&1 | sed 's/^[0-9T:.Z-]* /   /' | grep -E "→|reviewer|preflight|sent|blocked|bill" || true; }
idle() { cast call $USDC 'balanceOf(address)(uint256)' $MANDATE --rpc-url $RPC | awk '{print $1}'; }
deployed() { cast call $MANDATE 'deployed()(uint256)' --rpc-url $RPC | awk '{print $1}'; }

# the API process runs the first cycle (sweeps idle cash into the vault), then serves requests
(set -a; . "$WORK/.env"; set +a; exec node agent/src/index.js) > "$WORK/api.log" 2>&1 & # exec: the job pid is node, so the trap stops it
for _ in $(seq 1 60); do curl -sf $API/api/health | grep -q '"lastCycle":"' && break; sleep 0.5; done
echo; echo "── 1. agent's first cycle: idle $(idle), deployed $(deployed)"

NOW=$(cast block latest -f timestamp --rpc-url $RPC)
iso() { node -e 'console.log(new Date(Number(process.argv[1]) * 1000).toISOString())' "$1"; }
msg() { # action id amount due issued
  printf 'Mandate bill\nmandate: %s\nchain: 31337\naction: %s\nid: %s\npayee: %s\namount: %s\ndue: %s\nlabel: Hosting, October\nissued: %s' \
    "$MANDATE" "$1" "$2" "$PAYEE" "$3" "$4" "$5"; }
post() { # message pk -> http code, body in $WORK/out
  local sig; sig=$(cast wallet sign --private-key "$2" "$1")
  node -e 'process.stdout.write(JSON.stringify({message:process.argv[1],signature:process.argv[2]}))' "$1" "$sig" > "$WORK/body"
  curl -s -o "$WORK/out" -w '%{http_code}' -X POST $API/api/bills -H 'content-type: application/json' --data-binary @"$WORK/body"; }

echo; echo "── 2. the API refuses bills the owner did not sign"
DUE=$(iso $((NOW + 6*3600))); ISSUED=$(iso $(date +%s))
[ "$(post "$(msg add inv-x1 3.50 $DUE $ISSUED)" $STRANGER_PK)" = 400 ] && ok "stranger's signature: $(cat $WORK/out)" || bad "stranger accepted"
[ "$(post "$(msg add inv-x2 3.50 $DUE $(iso $(( $(date +%s) - 3600 ))))" $OWNER_PK)" = 400 ] && ok "stale signature: $(cat $WORK/out)" || bad "stale accepted"
SIG=$(cast wallet sign --private-key $OWNER_PK "$(msg add inv-x3 3.50 $DUE $ISSUED)")
node -e 'process.stdout.write(JSON.stringify({message:process.argv[1],signature:process.argv[2]}))' "$(msg add inv-x3 350 $DUE $ISSUED)" "$SIG" > "$WORK/body"
[ "$(curl -s -o "$WORK/out" -w '%{http_code}' -X POST $API/api/bills -H 'content-type: application/json' --data-binary @"$WORK/body")" = 400 ] && ok "amount changed after signing: $(cat $WORK/out)" || bad "tampered accepted"
[ "$(curl -s -o "$WORK/out" -w '%{http_code}' -X POST $API/api/bills -H 'content-type: application/json' --data-binary 'not json')" = 400 ] && ok "malformed body: $(cat $WORK/out)" || bad "malformed accepted"

echo; echo "── 3. owner signs a 12.00 USDC bill due in 6h (more than the idle cash)"
BILL="$(msg add inv-oct 12.00 $DUE $ISSUED)"
[ "$(post "$BILL" $OWNER_PK)" = 200 ] && ok "accepted: $(cat $WORK/out)" || bad "owner bill refused: $(cat $WORK/out)"
SIG=$(cast wallet sign --private-key $OWNER_PK "$BILL")
node -e 'process.stdout.write(JSON.stringify({message:process.argv[1],signature:process.argv[2]}))' "$BILL" "$SIG" > "$WORK/body"
[ "$(curl -s -o "$WORK/out" -w '%{http_code}' -X POST $API/api/bills -H 'content-type: application/json' --data-binary @"$WORK/body")" = 400 ] && ok "replay of the same bill: $(cat $WORK/out)" || bad "replay accepted"
curl -s "$API/api/bills?mandate=$MANDATE" | grep -q '"signature"' && bad "signatures leak in GET" || ok "GET hides signatures"

echo; echo "── 4. agent cycle: the bill is due within 24h, so the agent pulls cash out of the vault"
cycle
IDLE=$(idle); [ "$IDLE" -ge 12000000 ] && ok "idle $IDLE ≥ 12000000 (bill covered), deployed $(deployed)" || bad "idle $IDLE does not cover the bill"

echo; echo "── 5. owner pays the bill from the account"
TX=$(cast send $MANDATE "withdraw(uint256,address)" 12000000 $PAYEE --rpc-url $RPC --private-key $OWNER_PK --json | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).transactionHash))')
echo "   payment tx $TX; payee holds $(cast call $USDC 'balanceOf(address)(uint256)' $PAYEE --rpc-url $RPC | awk '{print $1}')"
sleep 6 # the API re-indexes at most every 5s
curl -s "$API/api/bills?mandate=$MANDATE" > "$WORK/bills.json"
node -e 'const b=require(process.argv[1]).find(x=>x.id==="inv-oct");if(b.status==="paid"&&b.paidTx===process.argv[2]){console.log("   ok   bill settled by",b.paidTx.slice(0,12)+"…")}else{console.log("   FAIL bill",JSON.stringify(b));process.exit(1)}' "$WORK/bills.json" "$TX" || FAIL=1

echo; echo "── 6. next cycle: nothing due anymore, the agent may put spare cash back to work"
cycle
echo "   idle $(idle), deployed $(deployed)"

echo; echo "── 7. owner removes a bill"
DUE2=$(iso $((NOW + 10*86400)))
[ "$(post "$(msg add inv-nov 1.25 $DUE2 $(iso $(date +%s)))" $OWNER_PK)" = 200 ] || bad "second bill refused"
RM=$(printf 'Mandate bill\nmandate: %s\nchain: 31337\naction: remove\nid: inv-nov\nissued: %s' "$MANDATE" "$(iso $(date +%s))")
[ "$(post "$RM" $STRANGER_PK)" = 400 ] && ok "stranger cannot remove: $(cat $WORK/out)" || bad "stranger removed a bill"
[ "$(post "$RM" $OWNER_PK)" = 200 ] && ok "owner removed inv-nov" || bad "owner remove refused: $(cat $WORK/out)"
curl -s "$API/api/bills?mandate=$MANDATE" | grep -q inv-nov && bad "removed bill still listed" || ok "removed bill no longer listed"

echo; echo "── decision records (their hashes are on-chain as notes)"
node -e 'for(const d of require(process.argv[1]))console.log("  ",d.tag.padEnd(10),d.amount??"",d.hash.slice(0,14)+"…")' "$WORK/data/decisions/index.json"
grep -h "bill added\|bill removed" "$WORK/api.log" | sed 's/^[0-9T:.Z-]* /   api: /'
[ $FAIL = 0 ] && echo && echo "e2e-bills: all green" || { echo; echo "e2e-bills: FAILED"; exit 1; }
