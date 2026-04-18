/**
 * Direct provider probe: bypasses the kernel to surface raw provider errors.
 */
import { OpenAICompatProvider } from "@emerge/provider-openai-compat";

const baseURL = process.env["EMERGE_LLM_BASE_URL"]!;
const apiKey = process.env["EMERGE_LLM_API_KEY"]!;
const model = process.env["EMERGE_LLM_MODEL"]!;
const protocol = (process.env["EMERGE_LLM_PROTOCOL"] ?? "chat") as "chat" | "responses";

console.log("Probe config:");
console.log("  Base URL:", baseURL);
console.log("  Model:   ", model);
console.log("  Protocol:", protocol);
console.log("");

const provider = new OpenAICompatProvider({
  name: "probe",
  baseURL,
  apiKey,
  model,
  protocol,
});

console.log("Calling provider.invoke()...\n");
const events: unknown[] = [];

try {
  for await (const event of provider.invoke({
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: [{ type: "text", text: "Say 'hello' in 3 words." }] },
    ],
    maxOutputTokens: 50,
  })) {
    events.push(event);
    const json = JSON.stringify(event);
    console.log("EVENT:", json.length > 250 ? `${json.slice(0, 250)}...` : json);
  }
} catch (e: unknown) {
  const err = e as Error;
  console.error("\nTHREW:", err.message);
  if (err.stack) console.error("STACK:", err.stack.split("\n").slice(0, 8).join("\n"));
}

console.log(`\nTotal events: ${events.length}`);

// --- now probe WITH a tool spec ---
console.log("\n=== Probe 2: with a tool spec ===\n");
const toolEvents: unknown[] = [];
try {
  for await (const event of provider.invoke({
    messages: [
      { role: "user", content: [{ type: "text", text: "Read /etc/hostname using the read_file tool." }] },
    ],
    tools: [
      {
        name: "read_file",
        description: "Reads a file from the local filesystem.",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string", description: "Absolute path to the file." } },
          required: ["path"],
        },
      },
    ],
    maxOutputTokens: 200,
  })) {
    toolEvents.push(event);
    const json = JSON.stringify(event);
    console.log("EVENT:", json.length > 300 ? `${json.slice(0, 300)}...` : json);
  }
} catch (e: unknown) {
  const err = e as Error;
  console.error("\nTHREW:", err.message);
  if (err.stack) console.error("STACK:", err.stack.split("\n").slice(0, 10).join("\n"));
  // OpenAI SDK errors often have additional context
  const anyErr = e as { status?: number; error?: unknown; response?: { status?: number; data?: unknown } };
  if (anyErr.status) console.error("HTTP STATUS:", anyErr.status);
  if (anyErr.error) console.error("ERROR DETAIL:", JSON.stringify(anyErr.error).slice(0, 500));
  if (anyErr.response?.status) console.error("RESPONSE STATUS:", anyErr.response.status);
  if (anyErr.response?.data) console.error("RESPONSE DATA:", JSON.stringify(anyErr.response.data).slice(0, 500));
}
console.log(`\nTool-probe events: ${toolEvents.length}`);
