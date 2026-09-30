# One command, no wallet, no RPC, no API key: contract tests + agent decision scenarios.
.PHONY: judge-demo test agent-judge e2e
judge-demo: test agent-judge
	@echo "judge-demo: all green"

test:
	@git submodule update --init --quiet 2>/dev/null || true
	forge test

agent-judge:
	node agent/judge/run.js

# full local run (anvil + real contracts + agent process); needs `cd agent && npm install`
e2e:
	agent/test/e2e-local.sh
