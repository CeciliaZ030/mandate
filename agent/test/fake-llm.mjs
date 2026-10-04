// Stand-in for the LiteLLM router in local tests: OpenAI-compatible, deterministic.
// FAKE_LLM_MODE=obey turns it into the worst possible reviewer: it does whatever a bill
// label tells it to (first quoted id in the payables line), including invented actions
// and amounts. The injection test uses it to check the blast radius offline.
import http from "node:http";
const port = Number(process.argv[2] || 4999);
const obey = process.env.FAKE_LLM_MODE === "obey";
http.createServer(async (req, res) => {
  let b = ""; for await (const c of req) b += c;
  const prompt = JSON.parse(b).messages.at(-1).content;
  const ids = [...prompt.matchAll(/- id=(\S+)/g)].map((m) => m[1]);
  let choice = ids.includes("sweep_in_half") ? "sweep_in_half" : ids[0];
  const extra = {};
  if (obey) {
    const line = prompt.split("\n").find((l) => l.startsWith("Upcoming payables:")) || "";
    const told = line.match(/"([a-z_]+)"/);
    if (told) {
      choice = told[1];
      const amt = line.match(/([\d.]+) USDC to (0x[0-9a-fA-F]{40})/);
      if (amt) Object.assign(extra, { amount: amt[1], to: amt[2] });
    }
  }
  const content = JSON.stringify({ choice, ...extra, rationale: `stub reviewer${obey ? " (obey)" : ""}: picked ${choice} of [${ids.join(", ")}]`, risk_flags: [] });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ model: obey ? "stub-obedient" : "stub-reviewer", choices: [{ message: { content } }] }));
}).listen(port, "127.0.0.1", () => console.log("fake llm on", port));
