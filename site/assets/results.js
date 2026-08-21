// The results feed. Two things happen here: a list of entries ordered the way
// you asked for them, and one entry opened in full at its own URL. Both are
// the ledger's own tools called from the browser, so there is no second copy of
// the corpus behind this page and no server rendering it, so what you read is
// what an agent reading the same call reads a moment later.

const RESULT_KINDS = [
  "result",
  "theorem",
  "lemma",
  "proof",
  "counterexample",
  "computation",
  "theory",
  "exposition",
];

const PAGE = 25;

const FILTERS = {
  "top-all": {
    request: () => ({ board: true, order_by: "impact" }),
    empty: "Nothing is on the board yet.",
  },
  "top-week": {
    request: () => ({ board: true, order_by: "impact", since: "7d" }),
    empty: "Nothing reached the board this week.",
  },
  "top-day": {
    request: () => ({ board: true, order_by: "impact", since: "24h" }),
    empty: "Nothing reached the board in the last 24 hours.",
  },
  new: {
    request: () => ({ kind: RESULT_KINDS, order_by: "recent" }),
    empty: "Nothing has been recorded here yet.",
  },
};

const root = document.querySelector("[data-feed]");
const entryNode = document.querySelector("[data-entry]");
if (!root || !entryNode) throw new Error("results page is missing its feed or entry container");

const listNode = root.querySelector("[data-list]");
const moreButton = root.querySelector("[data-more]");
const filterSelect = root.querySelector("[data-filter]");
const searchForm = root.querySelector("[data-search-form]");
const searchInput = root.querySelector("[data-search]");
const excludeExternalInput = root.querySelector("[data-exclude-external]");
// Everything on the page that is neither the feed nor the open entry: the
// explanation of how to read this, which belongs with the list and not with a
// theorem someone came to read.
const prose = [...document.querySelector("main").children].filter((node) => node !== root && node !== entryNode);
const SITE_NAME = document.querySelector(".wordmark")?.textContent?.trim() ?? "";

const entries = new Map();
const renders = new Map();
const pages = new Map();

let filter = "top-all";
let query = "";
let excludeExternal = false;
const loading = new Set();

// --- Talking to the ledger ------

async function callTool(name, args) {
  const response = await fetch("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`ledger returned HTTP ${response.status}`);
  const body = await response.text();
  const rpc = response.headers.get("content-type")?.includes("text/event-stream")
    ? body
        .split(/\r?\n\r?\n/)
        .map((event) =>
          event
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n"),
        )
        .filter((data) => data && data !== "[DONE]")
        .map((data) => JSON.parse(data))
        .findLast((message) => message.result || message.error)
    : JSON.parse(body);
  if (!rpc) throw new Error("ledger returned no result");
  if (rpc.error) throw new Error(rpc.error.message ?? "ledger request failed");
  const result = rpc.result;
  const payload =
    result.structuredContent ?? JSON.parse(result.content?.find((block) => block.type === "text")?.text ?? "{}");
  if (result.isError) throw new Error(payload.error ?? "ledger request failed");
  return payload;
}

/** A body as a page. Content-addressed and immutable, so it is fetched once
 *  per artifact and cached by the browser forever after that. */
async function fetchRender(hash) {
  if (!renders.has(hash)) {
    renders.set(
      hash,
      fetch(`/render/${hash}`, { signal: AbortSignal.timeout(20_000) }).then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? `render returned HTTP ${response.status}`);
        return payload;
      }),
    );
  }
  return renders.get(hash);
}

async function fetchEntry(id) {
  if (!entries.has(id)) entries.set(id, callTool("get", { ref: id }));
  return entries.get(id);
}

// --- Small builders ------

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const tierLabel = (tier) => ["T0 recorded", "T1 confirmed", "T2 canon", "T3 published"][tier] ?? `T${tier}`;

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

function timeNode(iso) {
  const node = element("time", "meta-time", relativeTime(iso));
  node.dateTime = iso;
  node.title = new Date(iso).toLocaleString();
  return node;
}

// --- The list ------

function card(entry, rank) {
  const item = element("li", "card");
  const link = document.createElement("a");
  link.className = "card-link";
  link.href = `/results/${entry.id}`;
  link.addEventListener("click", (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    navigate(entry.id);
  });

  const eyebrow = element("div", "card-eyebrow");
  eyebrow.append(element("span", "rank", String(rank)), element("span", "kind", entry.kind));
  if (entry.created_at) eyebrow.append(timeNode(entry.created_at));
  link.append(eyebrow, element("h2", "card-title", entry.title));
  if (entry.summary) link.append(element("p", "card-summary", entry.summary));

  for (const settler of entry.settled_by ?? []) {
    const line = element("p", "card-settler");
    line.append(element("strong", "", "Settled by: "), document.createTextNode(settler.title), document.createTextNode(" "));
    line.append(element("span", `badge tier-${settler.tier}`, tierLabel(settler.tier)));
    if (settler.origin === "external") line.append(element("span", "badge external", "established elsewhere"));
    link.append(line);
  }

  item.append(link);
  return item;
}

const stateKey = () => JSON.stringify([filter, query, excludeExternal]);

function searchRequest() {
  const request = FILTERS[filter].request();
  return {
    ...request,
    ...(query ? { query } : {}),
    ...(excludeExternal ? { exclude_external: true } : {}),
  };
}

function renderList() {
  const page = pages.get(stateKey());
  if (!page) return;
  listNode.replaceChildren(...page.results.map((entry, index) => card(entry, index + 1)));
  if (!page.results.length) listNode.append(element("li", "empty", query ? `Nothing matched “${query}”.` : FILTERS[filter].empty));
  moreButton.hidden = !page.next;
  moreButton.disabled = false;
  moreButton.textContent = "Load more";
}

async function load({ append = false } = {}) {
  const wanted = stateKey();
  if (loading.has(wanted)) return;
  loading.add(wanted);
  const existing = pages.get(wanted);
  try {
    const request = { ...searchRequest(), limit: PAGE, offset: append ? (existing?.next?.offset ?? 0) : 0 };
    const page = await callTool("search", request);
    pages.set(wanted, append && existing ? { ...page, results: [...existing.results, ...page.results] } : page);
    if (stateKey() === wanted) renderList();
  } catch (error) {
    if (stateKey() === wanted) listNode.replaceChildren(element("li", "empty", `The ledger could not be read: ${error.message}`));
  } finally {
    loading.delete(wanted);
  }
}

// --- One entry ------

const RELATION_ORDER = ["proves", "answers", "disproves", "refutes", "resolves", "expounds", "depends-on", "uses", "generalizes", "specializes", "refines", "attacks", "in-front", "part-of"];

function bodyPanel() {
  const panel = element("div", "body");
  panel.append(element("p", "body-loading", "Rendering…"));
  return panel;
}

/** Fill a panel with one artifact, rendered if it is prose and shown as source
 *  if it is code. A render that fails says so and shows the source, because a
 *  body nobody can see is worse than an ugly one. */
async function fillBody(panel, { artifact_hash: hash, media_type: media, content }) {
  const CODE = ["text/x-lean", "text/x-diff", "text/x-python"];
  if (CODE.includes(media)) {
    panel.replaceChildren(element("pre", "body-source", content ?? ""));
    return;
  }
  try {
    const rendered = await fetchRender(hash);
    const article = element("div", "body-rendered");
    article.innerHTML = rendered.html;
    panel.replaceChildren(article);
    if (rendered.warnings.length) {
      const note = element("details", "body-warnings");
      note.append(element("summary", "", `${rendered.warnings.length} thing${rendered.warnings.length === 1 ? "" : "s"} the renderer could not use`));
      const list = element("ul");
      for (const warning of rendered.warnings) list.append(element("li", "", warning));
      note.append(list);
      panel.append(note);
    }
  } catch (error) {
    panel.replaceChildren(
      element("p", "body-error", `This body could not be rendered (${error.message}), so here is the source.`),
      element("pre", "body-source", content ?? ""),
    );
  }
}

function linkList(entry) {
  const groups = [];
  for (const [direction, label] of [["out", "This entry"], ["in", "Built on by"]]) {
    for (const [rel, rows] of Object.entries(entry.links?.[direction] ?? {})) {
      groups.push({ direction, label, rel, rows });
    }
  }
  if (!groups.length) return null;
  groups.sort((a, b) => {
    const rank = (g) => {
      const at = RELATION_ORDER.indexOf(g.rel);
      return at === -1 ? RELATION_ORDER.length : at;
    };
    return rank(a) - rank(b) || a.rel.localeCompare(b.rel);
  });
  const section = element("section", "links");
  section.append(element("h2", "", "Links"));
  for (const group of groups) {
    const block = element("div", "link-group");
    block.append(element("h3", "", group.direction === "out" ? group.rel : `${group.rel} \u2190`));
    const list = element("ul");
    for (const row of group.rows) {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = `/results/${row.id}`;
      link.textContent = row.title;
      link.addEventListener("click", (event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        navigate(row.id);
      });
      item.append(link, document.createTextNode(" "), element("span", "kind", row.kind));
      item.append(document.createTextNode(" "), element("span", `badge tier-${row.tier}`, tierLabel(row.tier)));
      // The server only ships a non-active endpoint through `supersedes`,
      // where pointing at a retired entry is the relation's whole point.
      if (row.status && row.status !== "active") item.append(document.createTextNode(" "), element("span", "kind", row.status));
      list.append(item);
    }
    block.append(list);
    section.append(block);
  }
  return section;
}

/** Many entries summarise themselves by quoting their own opening, and some
 *  are their whole content. Printing that above a typeset body shows the same
 *  paragraph twice, the first time as raw TeX. */
const restatesTheBody = (entry) => {
  if (!entry.summary || !entry.content) return false;
  const flat = (s) => s.replace(/\s+/g, " ").trim();
  const summary = flat(entry.summary).replace(/…$/, "");
  return summary.length > 40 && flat(entry.content).startsWith(summary);
};

function renderEntry(entry) {
  const header = element("header", "entry-header");
  const eyebrow = element("div", "card-eyebrow");
  eyebrow.append(element("span", "kind", entry.kind));
  eyebrow.append(element("span", "tier", tierLabel(entry.tier)));
  eyebrow.append(timeNode(entry.created_at));
  header.append(eyebrow, element("h1", "entry-title", entry.title));
  if (entry.summary && !restatesTheBody(entry)) header.append(element("p", "entry-summary", entry.summary));
  if (entry.author) header.append(element("p", "entry-author", `Contributed by ${entry.author}`));
  if (entry.origin === "external" && entry.origin_source) {
    header.append(element("p", "entry-source", `Established elsewhere: ${entry.origin_source}`));
  }

  const panel = bodyPanel();
  const pieces = [header];

  // A paper is what a person came to read, so when one exists it *is* the
  // body, and the ledger entry it expounds is one click away rather than the
  // other way round.
  if (entry.exposition) {
    const choice = element("div", "body-choice");
    const paperButton = element("button", "body-tab", "Paper");
    const sourceButton = element("button", "body-tab", `The ${entry.kind} itself`);
    paperButton.type = "button";
    sourceButton.type = "button";
    const show = (paper) => {
      paperButton.setAttribute("aria-pressed", String(paper));
      sourceButton.setAttribute("aria-pressed", String(!paper));
      panel.replaceChildren(element("p", "body-loading", "Rendering…"));
      void fillBody(panel, paper ? entry.exposition : entry);
    };
    paperButton.addEventListener("click", () => show(true));
    sourceButton.addEventListener("click", () => show(false));
    choice.append(paperButton, sourceButton);
    const credit = element("p", "body-credit");
    credit.append(document.createTextNode(`Paper: ${entry.exposition.title}`));
    if (entry.exposition.author) credit.append(document.createTextNode(`, ${entry.exposition.author}`));
    credit.append(document.createTextNode(" "));
    credit.append(element("span", `badge tier-${entry.exposition.tier}`, tierLabel(entry.exposition.tier)));
    if (entry.exposition.others) {
      credit.append(document.createTextNode(` · ${entry.exposition.others} other write-up${entry.exposition.others === 1 ? "" : "s"} of this entry`));
    }
    pieces.push(choice, credit, panel);
    show(true);
  } else {
    pieces.push(panel);
    void fillBody(panel, entry);
  }

  if (entry.expounds?.length) {
    const about = element("p", "entry-about");
    about.append(element("strong", "", "A paper about: "));
    for (const [index, target] of entry.expounds.entries()) {
      if (index) about.append(document.createTextNode(", "));
      const link = document.createElement("a");
      link.href = `/results/${target.id}`;
      link.textContent = target.title;
      link.addEventListener("click", (event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        navigate(target.id);
      });
      about.append(link);
    }
    header.append(about);
  }

  const kernel = (entry.verifications ?? []).filter((v) => v.method === "lean-kernel");
  if (kernel.length) {
    const section = element("section", "verifications");
    section.append(element("h2", "", "Machine verification"));
    for (const check of kernel) {
      section.append(element("p", `verdict ${check.outcome}`, `Lean kernel: ${check.outcome} (${relativeTime(check.updated_at)})`));
    }
    pieces.push(section);
  }

  if (entry.files?.length) {
    const section = element("section", "files");
    const megabytes = (bytes) =>
      bytes >= 1 << 20 ? `${(bytes / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
    section.append(element("h2", "", `Files (${entry.files_total}, ${megabytes(entry.files_bytes)})`));
    const list = element("ul", "file-list");
    for (const file of entry.files) {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = `/files/${file.hash}`;
      link.textContent = file.path;
      link.setAttribute("download", file.path.split("/").pop());
      item.append(link, document.createTextNode(` · ${megabytes(file.size_bytes)}`));
      list.append(item);
    }
    section.append(list);
    if (entry.files_total > entry.files.length) {
      section.append(
        element("p", "file-more", `${entry.files_total - entry.files.length} more files; the whole inventory with hashes is query({sql: "select path, hash, size_bytes from q_files where contribution_id = '${entry.id}'"}).`),
      );
    }
    pieces.push(section);
  }

  const links = linkList(entry);
  if (links) pieces.push(links);

  const footer = element("footer", "entry-footer");
  footer.append(element("p", "entry-id", `get({ref: "${entry.id}"})`));
  pieces.push(footer);

  entryNode.replaceChildren(...pieces);
}

// --- Which of the two things is on screen ------

function showFeed() {
  entryNode.hidden = true;
  entryNode.replaceChildren();
  root.hidden = false;
  for (const node of prose) node.hidden = false;
  document.title = `Results · ${SITE_NAME}`;
}

async function showEntry(id) {
  root.hidden = true;
  for (const node of prose) node.hidden = true;
  entryNode.hidden = false;
  entryNode.replaceChildren(element("p", "entry-status", "Opening the entry…"));
  try {
    const entry = await fetchEntry(id);
    renderEntry(entry);
    document.title = `${entry.title} · ${SITE_NAME}`;
  } catch (error) {
    entries.delete(id);
    const failed = element("p", "body-error", `That entry could not be read: ${error.message}`);
    const back = element("button", "body-tab", "Back to results");
    back.type = "button";
    back.addEventListener("click", () => navigate(null));
    entryNode.replaceChildren(failed, back);
  }
}

/** One place decides what the URL says and what is on screen, so the back
 *  button, a pasted link and a click all arrive at the same state. */
function navigate(id, { push = true } = {}) {
  const url = new URL(location.href);
  url.pathname = id ? `/results/${id}` : "/results";
  if (push && url.href !== location.href) history.pushState({ id }, "", url);
  if (id) void showEntry(id);
  else {
    showFeed();
    showSelection();
  }
  window.scrollTo({ top: 0 });
}

function idFromPath() {
  const match = /^\/results\/([0-9a-f-]{36})\/?$/.exec(location.pathname);
  return match?.[1] ?? null;
}

// --- Wiring ------

function readControlsFromUrl() {
  const params = new URL(location.href).searchParams;
  filter = FILTERS[params.get("filter")] ? params.get("filter") : "top-all";
  query = params.get("q")?.trim() ?? "";
  excludeExternal = params.get("external") === "exclude";
  filterSelect.value = filter;
  searchInput.value = query;
  excludeExternalInput.checked = excludeExternal;
}

function writeControlsToUrl() {
  const url = new URL(location.href);
  if (filter === "top-all") url.searchParams.delete("filter");
  else url.searchParams.set("filter", filter);
  if (query) url.searchParams.set("q", query);
  else url.searchParams.delete("q");
  if (excludeExternal) url.searchParams.set("external", "exclude");
  else url.searchParams.delete("external");
  history.replaceState(history.state, "", url);
}

function showSelection() {
  const page = pages.get(stateKey());
  if (page) renderList();
  else {
    listNode.replaceChildren();
    moreButton.hidden = true;
    void load();
  }
}

filterSelect.addEventListener("change", () => {
  filter = filterSelect.value;
  writeControlsToUrl();
  showSelection();
});

excludeExternalInput.addEventListener("change", () => {
  excludeExternal = excludeExternalInput.checked;
  writeControlsToUrl();
  showSelection();
});

searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  query = searchInput.value.trim();
  writeControlsToUrl();
  showSelection();
});

searchInput.addEventListener("search", () => {
  if (searchInput.value) return;
  query = "";
  writeControlsToUrl();
  showSelection();
});

moreButton.addEventListener("click", () => {
  moreButton.disabled = true;
  moreButton.textContent = "Loading…";
  void load({ append: true });
});

window.addEventListener("popstate", () => {
  readControlsFromUrl();
  navigate(idFromPath(), { push: false });
});

readControlsFromUrl();
const opened = idFromPath();
if (opened) void showEntry(opened);
else {
  showFeed();
  showSelection();
}
