const RESULT_KINDS = [
  "result",
  "theorem",
  "lemma",
  "proof",
  "counterexample",
  "computation",
  "theory",
];

// Each view is one `search` call. The two 24-hour views walk result-type
// entries in the rolling window; the all-time view is the record of settled
// questions — every problem or conjecture the ledger has closed, ranked by
// how much the whole graph builds on it.
const VIEWS = {
  highlights: {
    request: { kind: RESULT_KINDS, since: "24h", limit: 10, order_by: "notability" },
    explainer: "The last 24 hours, ranked by graph impact and evidence. This is an attention signal, not an editorial verdict.",
    reasonLabel: "Why highlighted: ",
    empty: "No result-type entries were recorded in this window.",
    status: (page) => `${page.total ?? 0} result-type entries in the rolling window`,
  },
  latest: {
    request: { kind: RESULT_KINDS, since: "24h", limit: 10, order_by: "recent" },
    explainer: "The last 24 hours, strictly ordered by creation time, newest first. Evidence labels do not affect this order.",
    reasonLabel: "Current signals: ",
    empty: "No result-type entries were recorded in this window.",
    status: (page) => `${page.total ?? 0} result-type entries in the rolling window`,
  },
  top: {
    request: { kind: ["problem", "conjecture"], state: "settled", settled_by_min_tier: 2, limit: 25, order_by: "notability" },
    explainer: "The all-time board: questions closed by a T2 reviewed link, ranked by how much the whole graph builds on them. Each card names what settled it.",
    reasonLabel: "Why it ranks: ",
    empty: "The ledger has not settled any questions yet.",
    status: (page) => `${page.total ?? 0} questions with T2 reviewed closures, all time`,
  },
};

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
let activeView = requestedView && VIEWS[requestedView] ? requestedView : "highlights";

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
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 48) return formatter.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 60) return formatter.format(days, "day");
  return formatter.format(Math.round(days / 30), "month");
}

function rankingReasons(entry) {
  const reasons = [];
  if (entry.state === "settled") reasons.push("settled — an active entry closes this question");
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

/** A button/panel pair that lazily loads one ledger entry's full text. */
function detailToggle(entry, label) {
  const button = element("button", "live-detail-button", label);
  button.type = "button";
  const panel = element("div", "live-entry-detail");
  panel.hidden = true;
  button.addEventListener("click", async () => {
    if (button.dataset.open === "true") {
      panel.hidden = !panel.hidden;
      button.textContent = panel.hidden ? label : "Hide full entry";
      return;
    }
    panel.hidden = false;
    await loadDetails(entry, panel, button);
  });
  return { button, panel };
}

function settlerBlock(settler) {
  const wrap = element("div", "live-settler");
  const head = element("p", "live-settler-head");
  head.append(element("strong", "", "Settled by: "));
  head.append(document.createTextNode(`${settler.title} `));
  head.append(element("span", "live-kind", settler.kind));
  head.append(document.createTextNode(" "));
  head.append(element("span", `live-badge tier-${settler.tier}`, tierLabel(settler.tier)));
  const { button, panel } = detailToggle(settler, "Read the settling entry");
  wrap.append(head, button, panel);
  return wrap;
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
  if (entry.state) badges.append(element("span", `live-badge state-${entry.state}`, entry.state));
  badges.append(element("span", `live-badge tier-${entry.tier}`, tierLabel(entry.tier)));
  if (entry.lean_verified) badges.append(element("span", "live-badge lean", "Lean verified"));
  for (const topic of entry.topics ?? []) badges.append(element("span", "live-badge topic", topic));
  article.append(badges);

  for (const settler of entry.settled_by ?? []) article.append(settlerBlock(settler));

  const reason = element("p", "live-ranking-reason");
  reason.append(element("strong", "", VIEWS[activeView].reasonLabel));
  reason.append(document.createTextNode(rankingReasons(entry).join(" · ")));
  article.append(reason);

  const { button, panel } = detailToggle(entry, "Read full ledger entry");
  article.append(button, panel);
  item.append(article);
  return item;
}

function render() {
  for (const tab of tabs) {
    const selected = tab.dataset.liveView === activeView;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  const view = VIEWS[activeView];
  explainerNode.textContent = view.explainer;

  const page = pages.get(activeView);
  if (!page) return;
  const entries = page.results ?? [];
  resultsNode.replaceChildren(...entries.map((entry, index) => resultCard(entry, index + 1)));
  if (!entries.length) resultsNode.append(element("li", "live-empty", view.empty));
  const loaded = new Date(lastLoadedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
  statusNode.textContent = `Updated ${loaded} · ${view.status(page)}`;
}

async function refresh() {
  if (loading || document.hidden) return;
  loading = true;
  statusNode.textContent = pages.size ? "Refreshing the ledger…" : "Loading the ledger…";
  try {
    const names = Object.keys(VIEWS);
    const loadedPages = await Promise.all(names.map((name) => callTool("search", VIEWS[name].request)));
    names.forEach((name, index) => pages.set(name, loadedPages[index]));
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
    const order = tabs.map((candidate) => candidate.dataset.liveView);
    const step = event.key === "ArrowRight" ? 1 : -1;
    const next = order[(order.indexOf(activeView) + step + order.length) % order.length];
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
