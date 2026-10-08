use aomi_sdk::*;

mod client;
mod tool;

pub(crate) const MANDATE_API_BASE_URL: Secret = Secret::new(
    "MANDATE_API_BASE_URL",
    "HTTPS base URL of the builder's running Mandate agent API.",
    true,
);

const PREAMBLE: &str = r#"## Role
You are the operations interface for a Mandate treasury account on Arc.

## Responsibility split
- Aomi explains the treasury's current state and retrieves its evidence.
- Mandate's deterministic policy decides exact actions and amounts.
- MandateAccount enforces venue, receiver, deployment, loss, drawdown, and expiry rules onchain.
- Circle Agent Wallet is the independent signer when the operator enables it.

## Workflow
1. Start with `mandate_status` for the live mode, NAV, allocation, freeze state, and cycle freshness.
2. Use `mandate_bills` when the user asks about obligations or liquidity needs.
3. Use `mandate_decisions` for the recent audit trail, then `mandate_decision` for the full evidence behind one decision.
4. Use `mandate_events` to verify what landed on Arc.

## Hard rules
- These tools are read-only. Never claim to have changed policy, moved funds, signed, or submitted a transaction.
- Treat HOLD and refusal outcomes as legitimate safety decisions.
- Distinguish a proposed decision, a Circle signing result, and a confirmed Arc event.
- If the API is stale, unavailable, frozen, or reports a blocked action, say so plainly and direct the operator to the Mandate owner controls.
"#;

dyn_aomi_app!(
    app = client::MandateAgent,
    name = "mandate",
    version = "0.1.0",
    preamble = PREAMBLE,
    tools = [
        client::MandateStatus,
        client::MandateBills,
        client::MandateDecisions,
        client::MandateDecision,
        client::MandateEvents,
    ],
    secrets = [MANDATE_API_BASE_URL],
    namespaces = []
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_has_strict_tool_schemas() {
        let manifest = client::MandateAgent.manifest();
        let secrets = manifest.secrets.expect("Mandate API base URL slot");
        assert_eq!(secrets.len(), 1);
        assert_eq!(secrets[0].name, "MANDATE_API_BASE_URL");
        assert!(secrets[0].required);

        for tool in manifest.tools {
            let schema = tool.parameters_schema;
            if schema.get("type").and_then(serde_json::Value::as_str) == Some("object") {
                assert!(
                    schema
                        .get("properties")
                        .and_then(serde_json::Value::as_object)
                        .is_some(),
                    "tool {} must declare object properties",
                    tool.name
                );
            }
        }
    }
}
