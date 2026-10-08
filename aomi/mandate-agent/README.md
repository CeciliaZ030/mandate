# Mandate Aomi Agent

This Aomi App turns a running Mandate agent API into a hosted, conversational treasury-operations interface. It is deliberately read-only: Aomi explains live state and retrieves evidence, Mandate decides and enforces policy, and Circle Agent Wallet signs when enabled.

Deploy the repository through [Aomi Build](https://build.aomi.dev), configure `MANDATE_API_BASE_URL` with the public HTTPS origin of the running agent (for the reference deployment: `https://mandate.baserep.xyz`), and activate the returned Application ID.

The app exposes five tools:

- `mandate_status`
- `mandate_bills`
- `mandate_decisions`
- `mandate_decision`
- `mandate_events`

The live reference account is `0xEa08f2195ae9f29079a4cb6aFB05238949576d57` on Arc mainnet.
