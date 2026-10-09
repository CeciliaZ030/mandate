# Mandate Aomi Agent

This Aomi App turns a running Mandate agent API into a hosted, conversational treasury-operations interface. It is deliberately read-only: Aomi explains live state and retrieves evidence, Mandate decides and enforces policy, and Circle Agent Wallet signs when enabled.

The app exposes five tools:

- `mandate_status`
- `mandate_bills`
- `mandate_decisions`
- `mandate_decision`
- `mandate_events`

The live reference account is `0xEa08f2195ae9f29079a4cb6aFB05238949576d57` on Arc mainnet.

## Deploy it under your Aomi account

1. Merge this branch into `Makabeez/Mandate` and push a clean commit. Keep `Cargo.toml` and `aomi.toml` at the repository root; Aomi Build discovers the App from those files.
2. Open [build.aomi.dev](https://build.aomi.dev) and sign in with GitHub.
3. Install the Aomi GitHub App when prompted and grant it access to `Makabeez/Mandate` only. In **Projects**, create or import a project from that repository and select the branch containing this App.
4. Confirm that the detected App is `mandate` / **Mandate Treasury Agent**. Leave the source root as the repository root (`/`). The checked-in manifest currently targets the `staging` runtime for acceptance testing.
5. Add the one required App secret:

   ```text
   MANDATE_API_BASE_URL=https://mandate.baserep.xyz
   ```

   This must be the public HTTPS origin of your running Mandate agent API. Do not add a Circle token, wallet key, or signer credential to Aomi: signing remains inside your Mandate deployment.
6. Start the deployment. Wait for the source, build, and artifact checks to finish, then activate the release. The deployment is ready only when Build reports the App as **active** and **loaded**. Copy the resulting **Application ID**; it is the stable identifier your widget, CLI, or backend uses.
7. Open the App preview and run this acceptance prompt:

   ```text
   Audit Mandate account 0xEa08f2195ae9f29079a4cb6aFB05238949576d57.
   Report its current mode and freeze state, then find the newest successful
   decision and verify its transaction against the matching Arc event.
   ```

   A successful run calls `mandate_status`, `mandate_decisions`, `mandate_decision`, and `mandate_events`; it should distinguish the stored decision from the confirmed Arc event instead of claiming that Aomi moved funds.

### What is deployed where

- **Aomi App:** the read-only conversational and evidence layer deployed from this repository.
- **Mandate API:** `mandate.baserep.xyz`, which owns policy decisions and serves status, bills, decisions, and events.
- **Circle Agent Wallet:** configured in the Mandate agent deployment; it signs permitted contract calls and never exposes its credentials to Aomi.
- **MandateAccount:** the Arc contract that enforces the final venue, receiver, cap, loss, drawdown, and expiry rules.

For an update, push a new commit, redeploy the same Build project, activate the new release, and keep the same Application ID. If Build reports an SDK mismatch, use the exact SDK version it requests rather than widening the `aomi-sdk` dependency. Production promotion is a separate commit that broadens `server_tags`; keep `staging` for the initial acceptance run.
