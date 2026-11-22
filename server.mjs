import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { classify } from "./mock-ai.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));
const script = await readFile(new URL("./app.js", import.meta.url));
const topics = new Set(["delivery", "pricing", "other"]);
const manualReview = { status: "manual_review", topic: null, draft: null };

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function handleTriage(request, response, model) {
  let text;
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof input?.text !== "string" || !input.text.trim()) {
      return json(response, 400, { status: "invalid_input" });
    }
    text = input.text.trim();
  } catch {
    return json(response, 400, { status: "invalid_input" });
  }

  const controller = new AbortController();
  let timer;
  try {
    // Race bounds the request even if a provider ignores cancellation.
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("Model timeout"));
      }, 300);
    });
    const raw = await Promise.race([
      Promise.resolve().then(() => model(text, { signal: controller.signal })),
      deadline,
    ]);
    const result = JSON.parse(raw);
    if (!result || !topics.has(result.topic) ||
        typeof result.draft !== "string" || !result.draft.trim()) {
      return json(response, 200, manualReview);
    }
    return json(response, 200, {
      status: "ready",
      topic: result.topic,
      draft: result.draft.trim(),
    });
  } catch {
    return json(response, 200, manualReview);
  } finally {
    clearTimeout(timer);
  }
}

export function createTriageServer(model = classify) {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.method === "GET" && request.url === "/app.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end(script);
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }
    try {
      await handleTriage(request, response, model);
    } catch {
      if (!response.headersSent) json(response, 500, { status: "server_error" });
      else response.destroy();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createTriageServer().listen(Number(process.env.PORT || 3000), "127.0.0.1");
}
