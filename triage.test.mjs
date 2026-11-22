import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createTriageServer } from "./server.mjs";

const manual = { status: "manual_review", topic: null, draft: null };

async function start(t, model) {
  const server = createTriageServer(model);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function post(base, body) {
  const reply = await fetch(`${base}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  return { code: reply.status, body: await reply.json() };
}

test("API rejects missing, blank, non-string and malformed input before calling AI", async (t) => {
  let calls = 0;
  const base = await start(t, () => { calls += 1; });
  for (const input of ["{", "null", "[]", "{}", '{"text":null}', '{"text":42}',
    '{"text":true}', '{"text":[]}', '{"text":""}', '{"text":"  \\n  "}']) {
    assert.deepEqual(await post(base, input), { code: 400, body: { status: "invalid_input" } });
  }
  assert.equal(calls, 0);
});

test("API returns only allowed fields and trims valid text", async (t) => {
  const base = await start(t, (text) => {
    assert.equal(text, "доставка");
    return JSON.stringify({ topic: "delivery", draft: " Ответ ", extra: "ignore" });
  });
  assert.deepEqual(await post(base, '{"text":" доставка "}'), {
    code: 200, body: { status: "ready", topic: "delivery", draft: "Ответ" },
  });
});

test("all mock failures use manual review, including timeout", async (t) => {
  const base = await start(t);
  for (const text of ["[timeout]", "[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
    assert.deepEqual(await post(base, JSON.stringify({ text })), { code: 200, body: manual });
  }
});

test("API deadline works even if provider ignores AbortSignal", async (t) => {
  let signal;
  const base = await start(t, (_, options) => {
    signal = options.signal;
    return new Promise(() => {});
  });
  const begin = performance.now();
  assert.deepEqual(await post(base, '{"text":"заявка"}'), { code: 200, body: manual });
  const elapsed = performance.now() - begin;
  assert.ok(elapsed >= 250 && elapsed < 1000, `elapsed ${elapsed} ms`);
  assert.equal(signal.aborted, true);
});

test("API rejects wrong shape, invalid topics and empty drafts", async (t) => {
  const values = [null, [], {}, { topic: "refund", draft: "text" },
    { topic: "delivery", draft: "  " }, { topic: "other", draft: 7 },
    { topic: "pricing" }];
  const base = await start(t, () => JSON.stringify(values.shift()));
  for (let i = 0; i < 7; i++) {
    assert.deepEqual(await post(base, '{"text":"заявка"}'), { code: 200, body: manual });
  }
});

const clientCode = await readFile(new URL("./app.js", import.meta.url), "utf8");
function client() {
  const nodes = Object.fromEntries(["form", "#message", "#result", "#topic", "#draft"]
    .map((key) => [key, { textContent: "", value: "", focus() {} }]));
  let submit;
  nodes.form.addEventListener = (_, handler) => { submit = handler; };
  const requests = [];
  const timers = new Map();
  let timerId = 0;
  runInNewContext(clientCode, {
    document: { querySelector: (selector) => nodes[selector] },
    AbortController,
    setTimeout: (callback) => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: (id) => timers.delete(id),
    fetch: (_, options) => new Promise((resolve, reject) => {
      requests.push({ options, resolve, reject });
      options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  });
  return {
    nodes, requests, timers,
    submit: (text) => {
      nodes["#message"].value = text;
      return submit({ preventDefault() {} });
    },
  };
}
function ready(draft) {
  return { ok: true, status: 200, json: async () => ({ status: "ready", topic: "other", draft }) };
}

test("page clears old draft and avoids AI request for whitespace input", async () => {
  const c = client();
  c.nodes["#draft"].textContent = "old";
  await c.submit("   ");
  assert.equal(c.requests.length, 0);
  assert.equal(c.nodes["#draft"].textContent, "");
  assert.match(c.nodes["#result"].textContent, /Введите/);
});

test("page success followed by failure clears draft and preserves input", async () => {
  const c = client();
  let pending = c.submit("первая");
  c.requests[0].resolve(ready("первый ответ"));
  await pending;
  assert.equal(c.nodes["#draft"].textContent, "первый ответ");
  pending = c.submit("вторая");
  assert.equal(c.nodes["#draft"].textContent, "");
  c.requests[1].resolve({ ok: true, status: 200, json: async () => manual });
  await pending;
  assert.equal(c.nodes["#draft"].textContent, "");
  assert.equal(c.nodes["#topic"].textContent, "");
  assert.equal(c.nodes["#message"].value, "вторая");
  assert.match(c.nodes["#result"].textContent, /ручной разбор/);
});

test("page handles broken JSON, unknown topic, blank draft, HTTP and network failures", async () => {
  for (const reply of [
    { ok: true, json: async () => { throw new Error("JSON"); } },
    { ok: true, json: async () => ({ status: "ready", topic: "refund", draft: "text" }) },
    ready("   "),
    { ok: false, status: 500, json: async () => ({}) },
    null,
  ]) {
    const c = client();
    c.nodes["#draft"].textContent = "previous";
    const pending = c.submit("заявка");
    if (reply) c.requests[0].resolve(reply);
    else c.requests[0].reject(new Error("network"));
    await pending;
    assert.equal(c.nodes["#draft"].textContent, "");
    assert.match(c.nodes["#result"].textContent, /ручной разбор/);
  }
});

test("page network timeout falls back to manual review", async () => {
  const c = client();
  const pending = c.submit("заявка");
  [...c.timers.values()][0]();
  await pending;
  assert.match(c.nodes["#result"].textContent, /ручной разбор/);
  assert.equal(c.nodes["#draft"].textContent, "");
});

test("late old response cannot overwrite a newer result", async () => {
  const c = client();
  // The first response headers arrive, but its body is delayed past request B.
  let finishBody;
  const a = c.submit("A");
  c.requests[0].resolve({
    ok: true,
    json: () => new Promise((resolve) => { finishBody = resolve; }),
  });
  await Promise.resolve();
  const b = c.submit("B");
  c.requests[1].resolve(ready("свежий ответ"));
  await b;
  finishBody({ status: "ready", topic: "delivery", draft: "устаревший ответ" });
  await a;
  assert.equal(c.nodes["#draft"].textContent, "свежий ответ");
  assert.equal(c.nodes["#topic"].textContent, "Другое");
});
