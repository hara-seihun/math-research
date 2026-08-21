const RESULT_KINDS = [
  "result",
  "theorem",
  "lemma",
  "proof",
  "counterexample",
  "computation",
  "theory",
];

const root = document.querySelector("[data-live-root]");
if (!root) throw new Error("live page has no data-live-root");

const resultsNode = root.querySelector("[data-live-results]");
const statusNode = root.querySelector("[data-live-status]");
const explainerNode = root.querySelector("[data-live-explainer]");
const tabs = [...root.querySelectorAll("[data-live-view]")];
const detailsCache = new Map();
const pages = new Map();
let loading = false;
let lastLoadedAt = 0;

const requestedView = new URL(location.href).searchParams.get("view");
let activeView = requestedView === "latest" ? "latest" : "highlights";

async function callTool(name, args) {
  const response = await fetch("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: { name, arguments: args },
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) throw new Error(`ledger returned HTTP ${response.status}`);
  const body = await response.text();
  const rpc = response.headers.get("content-type")?.includes("text/event-stream")
    ? body
        .split(/\r?\n\r?\n/)
        .map((event) => event.split(/\r?\n/).filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart()).join("\n"))
        .filter((data) => data && data !== "[DONE]")
        .map((data) => JSON.parse(data))
        .findLast((message) => message.result || message.error)
    : JSON.parse(body);
  if (!rpc) throw new Error("ledger returned no result");
  if (rpc.error) throw new Error(rpc.error.message ?? "ledger request failed");
  const result = rpc.result;
  const payload = result.structuredContent ?? JSON.parse(result.content?.find((block) => block.type === "text")?.text ?? "{}");
  if (result.isError) throw new Error(payload.error ?? "ledger request failed");
  return payload;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function tierLabel(tier) {
  return ["T0 recorded", "T1 confirmed", "T2 canon", "T3 published"][tier] ?? `T${tier}`;
}

function relativeTime(iso) {
  const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  return formatter.format(Math.round(minutes / 60), "hour");
}

function rankingReasons(entry) {
  const reasons = [];
  if (entry.ranking?.settles) {
    reasons.push(`settles ${entry.ranking.settles} active ${entry.ranking.settles === 1 ? "question" : "questions"}`);
  }
  if (entry.ranking?.built_on_by) {
    reasons.push(`built on by ${entry.ranking.built_on_by} active ${entry.ranking.built_on_by === 1 ? "entry" : "entries"}`);
  }
  if (entry.tier > 0) reasons.push(tierLabel(entry.tier).toLowerCase());
  if (entry.lean_verified) reasons.push("Lean verified");
  if (!reasons.length) reasons.push(`ranked from its ${entry.kind} prior and current graph evidence`);
  return reasons;
}

async function loadDetails(entry, panel, button) {
  button.disabled = true;
  button.textContent = "Loading entry…";
  try {
    let detail = detailsCache.get(entry.id);
    if (!detail) {
      detail = await callTool("get", { ref: entry.id });
      detailsCache.set(entry.id, detail);
    }
    const content = element("pre", "live-entry-content");
    content.textContent = detail.content ?? detail.summary ?? "This entry has no text body.";
    const identity = element("p", "live-entry-id", `Ledger id: ${entry.id}`);
    panel.replaceChildren(content, identity);
    button.textContent = "Hide full entry";
    button.disabled = false;
    button.dataset.open = "true";
  } catch (error) {
    panel.replaceChildren(element("p", "live-entry-error", `Could not load this entry: ${error.message}`));
    button.textContent = "Try loading full entry again";
    button.disabled = false;
  }
}

function resultCard(entry, rank) {
  const item = element("li", "live-result");
  const article = document.createElement("article");

  const eyebrow = element("div", "live-result-eyebrow");
  eyebrow.append(element("span", "live-rank", String(rank)), element("span", "live-kind", entry.kind));
  const time = element("time", "live-time", relativeTime(entry.created_at));
  time.dateTime = entry.created_at;
  time.title = new Date(entry.created_at).toLocaleString();
  eyebrow.append(time);

  const title = element("h2", "live-result-title", entry.title);
  article.append(eyebrow, title);
  if (entry.summary) article.append(element("p", "live-result-summary", entry.summary));

  const badges = element("div", "live-badges");
  badges.append(element("span", `live-badge tier-${entry.tier}`, tierLabel(entry.tier)));
  if (entry.lean_verified) badges.append(element("span", "live-badge lean", "Lean verified"));
  for (const topic of entry.topics ?? []) badges.append(element("span", "live-badge topic", topic));
  article.append(badges);

  const reason = element("p", "live-ranking-reason");
  reason.append(element("strong", "", activeView === "highlights" ? "Why highlighted: " : "Current signals: "));
  reason.append(document.createTextNode(rankingReasons(entry).join(" · ")));
  article.append(reason);

  const detailButton = element("button", "live-detail-button", "Read full ledger entry");
  detailButton.type = "button";
  const panel = element("div", "live-entry-detail");
  panel.hidden = true;
  detailButton.addEventListener("click", async () => {
    if (detailButton.dataset.open === "true") {
      panel.hidden = !panel.hidden;
      detailButton.textContent = panel.hidden ? "Show full entry" : "Hide full entry";
      return;
    }
    panel.hidden = false;
    await loadDetails(entry, panel, detailButton);
  });
  article.append(detailButton, panel);
  item.append(article);
  return item;
}

function render() {
  for (const tab of tabs) {
    const selected = tab.dataset.liveView === activeView;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  explainerNode.textContent = activeView === "highlights"
    ? "Ranked by graph impact and evidence. This is an attention signal, not an editorial verdict."
    : "Strictly ordered by creation time, newest first. Evidence labels do not affect this order.";

  const page = pages.get(activeView);
  if (!page) return;
  const entries = page.results ?? [];
  resultsNode.replaceChildren(...entries.map((entry, index) => resultCard(entry, index + 1)));
  if (!entries.length) resultsNode.append(element("li", "live-empty", "No result-type entries were recorded in this window."));
  const loaded = new Date(lastLoadedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
  statusNode.textContent = `Updated ${loaded} · ${page.total ?? entries.length} result-type entries in the rolling window`;
}

async function refresh() {
  if (loading || document.hidden) return;
  loading = true;
  statusNode.textContent = pages.size ? "Refreshing the ledger…" : "Loading the ledger…";
  try {
    const common = { kind: RESULT_KINDS, since: "24h", limit: 10 };
    const [highlights, latest] = await Promise.all([
      callTool("search", { ...common, order_by: "notability" }),
      callTool("search", { ...common, order_by: "recent" }),
    ]);
    pages.set("highlights", highlights);
    pages.set("latest", latest);
    lastLoadedAt = Date.now();
    render();
  } catch (error) {
    statusNode.textContent = `The live ledger could not be refreshed: ${error.message}`;
  } finally {
    loading = false;
  }
}

function selectView(view, updateUrl = true) {
  activeView = view;
  if (updateUrl) {
    const url = new URL(location.href);
    if (view === "highlights") url.searchParams.delete("view");
    else url.searchParams.set("view", view);
    history.replaceState(null, "", url);
  }
  render();
}

for (const tab of tabs) {
  tab.addEventListener("click", () => selectView(tab.dataset.liveView));
  tab.addEventListener("keydown", (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const next = activeView === "highlights" ? "latest" : "highlights";
    selectView(next);
    tabs.find((candidate) => candidate.dataset.liveView === next)?.focus();
  });
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && Date.now() - lastLoadedAt >= 30_000) void refresh();
});

selectView(activeView, false);
void refresh();
setInterval(() => void refresh(), 30_000);
