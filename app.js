const form = document.querySelector("form");
const message = document.querySelector("#message");
const result = document.querySelector("#result");
const topic = document.querySelector("#topic");
const draft = document.querySelector("#draft");
const topics = { delivery: "Доставка", pricing: "Стоимость", other: "Другое" };
let latestRequest = 0;
let activeController;

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const requestId = ++latestRequest;
  activeController?.abort();
  topic.textContent = "";
  draft.textContent = "";
  result.textContent = "";

  const text = message.value.trim();
  if (!text) {
    result.textContent = "Введите текст заявки.";
    message.focus();
    return;
  }

  const controller = new AbortController();
  activeController = controller;
  result.textContent = "Разбираем заявку.";
  // Also bound network waiting if the API itself stops responding.
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const reply = await fetch("/api/triage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
    const data = await reply.json();
    if (requestId !== latestRequest) return;

    if (reply.status === 400 && data?.status === "invalid_input") {
      result.textContent = "Проверьте текст заявки и повторите отправку.";
      return;
    }
    if (!reply.ok || data?.status !== "ready" ||
        !Object.hasOwn(topics, data.topic) ||
        typeof data.draft !== "string" || !data.draft.trim()) {
      throw new Error("Manual review required");
    }

    topic.textContent = topics[data.topic];
    draft.textContent = data.draft.trim();
    result.textContent = "Черновик готов. Проверьте его перед отправкой клиенту.";
  } catch {
    if (requestId !== latestRequest) return;
    topic.textContent = "";
    draft.textContent = "";
    result.textContent = "Нужен ручной разбор. Автоматически подготовить ответ не удалось. Текст заявки сохранён, обработайте её вручную.";
  } finally {
    clearTimeout(timeout);
    if (requestId === latestRequest) activeController = null;
  }
});
