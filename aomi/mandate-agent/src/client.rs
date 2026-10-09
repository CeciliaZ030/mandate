use aomi_sdk::schemars::JsonSchema;
use aomi_sdk::*;
use serde::Deserialize;
use serde_json::{Value, json};
use std::time::Duration;

pub(crate) use crate::tool::*;

#[derive(Clone, Default)]
pub(crate) struct MandateAgent;

#[derive(Clone)]
pub(crate) struct MandateClient {
    http: reqwest::blocking::Client,
    base_url: String,
}

impl MandateClient {
    pub(crate) fn from_ctx(ctx: &DynToolCallCtx) -> Result<Self, String> {
        let base_url = resolve_secret_value(
            ctx,
            None,
            crate::MANDATE_API_BASE_URL.name,
            "Mandate agent requires MANDATE_API_BASE_URL",
        )?
        .trim_end_matches('/')
        .to_string();
        if !(base_url.starts_with("https://")
            || base_url.starts_with("http://127.0.0.1:")
            || base_url.starts_with("http://localhost:"))
        {
            return Err("MANDATE_API_BASE_URL must use HTTPS (loopback HTTP is allowed)".into());
        }
        let http = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|error| format!("failed to build Mandate API client: {error}"))?;
        Ok(Self { http, base_url })
    }

    fn get(&self, path: &str) -> Result<Value, String> {
        let response = self
            .http
            .get(format!("{}{path}", self.base_url))
            .send()
            .map_err(|error| format!("Mandate API request failed: {error}"))?;
        let status = response.status();
        let body = response.text().unwrap_or_default();
        if !status.is_success() {
            return Err(format!("Mandate API returned {status}: {body}"));
        }
        serde_json::from_str(&body)
            .map_err(|error| format!("Mandate API response was invalid: {error}"))
    }

    pub(crate) fn status(&self, mandate: Option<&str>) -> Result<Value, String> {
        if let Some(address) = mandate {
            validate_address(address)?;
        }
        let value = self.get("/api/health")?;
        let Some(address) = mandate else {
            return Ok(json!({ "source": "mandate", "status": value }));
        };
        let accounts = value
            .get("mandates")
            .and_then(Value::as_object)
            .ok_or_else(|| "Mandate health response is missing accounts".to_string())?;
        let account = accounts
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(address))
            .map(|(_, value)| value.clone())
            .ok_or_else(|| format!("Mandate account not found: {address}"))?;
        Ok(json!({
            "source": "mandate",
            "agent": value.get("agent"),
            "dryRun": value.get("dryRun"),
            "lastCycle": value.get("lastCycle"),
            "mandate": { "address": address, "state": account },
        }))
    }

    pub(crate) fn bills(&self, mandate: &str) -> Result<Value, String> {
        validate_address(mandate)?;
        let bills = self.get(&format!("/api/bills?mandate={mandate}"))?;
        Ok(json!({ "source": "mandate", "mandate": mandate, "bills": bills }))
    }

    pub(crate) fn decisions(&self, mandate: &str, limit: usize) -> Result<Value, String> {
        validate_address(mandate)?;
        let value = self.get(&format!("/api/decisions?mandate={mandate}"))?;
        let decisions = value
            .as_array()
            .ok_or_else(|| "Mandate decisions response is not an array".to_string())?
            .iter()
            .take(limit)
            .cloned()
            .collect::<Vec<_>>();
        Ok(json!({ "source": "mandate", "mandate": mandate, "decisions": decisions }))
    }

    pub(crate) fn decision(&self, hash: &str) -> Result<Value, String> {
        validate_hash(hash)?;
        let decision = self.get(&format!("/d/{hash}.json"))?;
        Ok(json!({ "source": "mandate", "hash": hash, "decision": decision }))
    }

    pub(crate) fn events(&self, mandate: &str, limit: usize) -> Result<Value, String> {
        validate_address(mandate)?;
        let value = self.get(&format!("/api/events?mandate={mandate}"))?;
        let events = value
            .get("events")
            .and_then(Value::as_array)
            .ok_or_else(|| "Mandate events response is missing events".to_string())?;
        let recent = events.iter().rev().take(limit).cloned().collect::<Vec<_>>();
        Ok(json!({
            "source": "mandate",
            "mandate": mandate,
            "cursor": value.get("cursor"),
            "events": recent,
        }))
    }
}

pub(crate) fn validate_address(value: &str) -> Result<(), String> {
    if value.len() == 42
        && value.starts_with("0x")
        && value[2..].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        Ok(())
    } else {
        Err("mandate must be a 20-byte 0x-prefixed address".into())
    }
}

pub(crate) fn validate_hash(value: &str) -> Result<(), String> {
    if value.len() == 66
        && value.starts_with("0x")
        && value[2..].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        Ok(())
    } else {
        Err("decision hash must be a 32-byte 0x-prefixed hash".into())
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct StatusArgs {
    /// Optional MandateAccount address. Omit to return every account operated by this agent.
    #[serde(default)]
    pub(crate) mandate: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct MandateArgs {
    /// MandateAccount address on Arc.
    pub(crate) mandate: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct ListArgs {
    /// MandateAccount address on Arc.
    pub(crate) mandate: String,
    /// Maximum records to return, from 1 to 50. Defaults to 10.
    #[serde(default)]
    pub(crate) limit: Option<usize>,
}

impl ListArgs {
    pub(crate) fn limit(&self) -> usize {
        self.limit.unwrap_or(10).clamp(1, 50)
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct DecisionArgs {
    /// Keccak decision-record hash from `mandate_decisions` or a Note event.
    pub(crate) hash: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_chain_identifiers_and_caps_lists() {
        assert!(validate_address("0x1111111111111111111111111111111111111111").is_ok());
        assert!(validate_address("0x1234").is_err());
        assert!(validate_hash(&format!("0x{}", "ab".repeat(32))).is_ok());
        assert!(validate_hash("0x1234").is_err());
        assert_eq!(
            ListArgs {
                mandate: String::new(),
                limit: Some(999)
            }
            .limit(),
            50
        );
    }
}
