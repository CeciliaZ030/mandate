use crate::client::*;
use aomi_sdk::*;
use serde_json::Value;

pub(crate) struct MandateStatus;

impl DynAomiTool for MandateStatus {
    type App = MandateAgent;
    type Args = StatusArgs;
    const NAME: &'static str = "mandate_status";
    const DESCRIPTION: &'static str = "Read the live Mandate agent cycle and treasury state: mode, NAV, idle and deployed USDC, freeze status, chosen action, signer address, and last-cycle freshness. Start here for health or allocation questions.";

    fn run(_app: &MandateAgent, args: Self::Args, ctx: DynToolCallCtx) -> Result<Value, String> {
        MandateClient::from_ctx(&ctx)?.status(args.mandate.as_deref())
    }
}

pub(crate) struct MandateBills;

impl DynAomiTool for MandateBills {
    type App = MandateAgent;
    type Args = MandateArgs;
    const NAME: &'static str = "mandate_bills";
    const DESCRIPTION: &'static str = "List owner-signed bills and their open or paid status for one Mandate account. Use to explain upcoming liquidity needs; this tool never creates or pays a bill.";

    fn run(_app: &MandateAgent, args: Self::Args, ctx: DynToolCallCtx) -> Result<Value, String> {
        MandateClient::from_ctx(&ctx)?.bills(&args.mandate)
    }
}

pub(crate) struct MandateDecisions;

impl DynAomiTool for MandateDecisions {
    type App = MandateAgent;
    type Args = ListArgs;
    const NAME: &'static str = "mandate_decisions";
    const DESCRIPTION: &'static str = "List recent deterministic treasury decisions for one Mandate account, newest first. Returns record hashes, tags, action kinds, amounts, and execution status. Use a returned hash with mandate_decision for full evidence.";

    fn run(_app: &MandateAgent, args: Self::Args, ctx: DynToolCallCtx) -> Result<Value, String> {
        let limit = args.limit();
        MandateClient::from_ctx(&ctx)?.decisions(&args.mandate, limit)
    }
}

pub(crate) struct MandateDecision;

impl DynAomiTool for MandateDecision {
    type App = MandateAgent;
    type Args = DecisionArgs;
    const NAME: &'static str = "mandate_decision";
    const DESCRIPTION: &'static str = "Fetch the full content-addressed decision record for one hash, including observed state, candidates, selected action, reviewer result, deterministic policy, and any execution evidence.";

    fn run(_app: &MandateAgent, args: Self::Args, ctx: DynToolCallCtx) -> Result<Value, String> {
        MandateClient::from_ctx(&ctx)?.decision(&args.hash)
    }
}

pub(crate) struct MandateEvents;

impl DynAomiTool for MandateEvents {
    type App = MandateAgent;
    type Args = ListArgs;
    const NAME: &'static str = "mandate_events";
    const DESCRIPTION: &'static str = "Read recent indexed Arc events for one Mandate account, newest first. Use to distinguish a proposed decision from an Executed, Breach, Frozen, Withdrawn, or Note event that actually landed onchain.";

    fn run(_app: &MandateAgent, args: Self::Args, ctx: DynToolCallCtx) -> Result<Value, String> {
        let limit = args.limit();
        MandateClient::from_ctx(&ctx)?.events(&args.mandate, limit)
    }
}
