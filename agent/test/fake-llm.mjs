// Stand-in for the LiteLLM router in local tests: OpenAI-compatible, deterministic.
import http from "node:http";
const port = Number(process.argv[2] || 4999);
http.createServer(async (req, res) => {
  let b = ""; for await (const c of req) b += c;
  const prompt = JSON.parse(b).messages.at(-1).content;
  const ids = [...prompt.matchAll(/- id=(\S+)/g)].map((m) => m[1]);
  const choice = ids.includes("sweep_in_half") ? "sweep_in_half" : ids[0];
  const content = JSON.stringify({ choice, rationale: `stub reviewer: picked ${choice} of [${ids.join(", ")}]`, risk_flags: ["stub"] });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ model: "stub-reviewer", choices: [{ message: { content } }] }));
}).listen(port, "127.0.0.1", () => console.log("fake llm on", port));
