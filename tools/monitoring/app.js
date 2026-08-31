const DATA_ROOT = "data";

const escapeHtml = (value = "") => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

function relativeTime(value) {
  if (!value) return "Never";
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "Unknown";
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const units = [
    ["year", 31_536_000], ["month", 2_592_000], ["day", 86_400],
    ["hour", 3_600], ["minute", 60], ["second", 1],
  ];
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size || unit === "second") return formatter.format(Math.round(seconds / size), unit);
  }
}

function fullDate(value) {
  if (!value) return "No successful run yet";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function duration(value) {
  if (!Number.isFinite(value)) return "—";
  return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${value} ms`;
}

function monitorCard(monitor, index) {
  const active = monitor.configured;
  const statusClass = monitor.status === "healthy" ? "healthy" : monitor.status === "error" ? "error" : "pending";
  const statusLabel = monitor.status === "healthy" ? "Healthy" : monitor.status === "error" ? "Needs attention" : "Not configured";
  const source = monitor.sourceUrl
    ? `<a href="${escapeHtml(monitor.sourceUrl)}" target="_blank" rel="noreferrer">Source ↗</a>`
    : "Source pending";

  let body;
  if (active) {
    const pagination = monitor.pagination;
    body = `
      ${monitor.error ? `<div class="alert error-alert monitor-alert" role="alert"><strong>Incomplete run</strong><span>${escapeHtml(monitor.error)}</span></div>` : ""}
      <div class="monitor-stats">
        <div class="monitor-stat"><span>Merchants</span><strong>${monitor.currentCount ?? "—"}</strong></div>
        <div class="monitor-stat"><span>Pages</span><strong>${pagination?.pagesFetched ?? "—"}</strong></div>
        <div class="monitor-stat"><span>Duration</span><strong>${duration(monitor.durationMs)}</strong></div>
      </div>
      <div class="monitor-footer">
        <span>${escapeHtml(monitor.cadence ?? "Manual")}</span>
        <span>Latest success ${escapeHtml(relativeTime(monitor.latestSuccessAt))}</span>
        ${source}
      </div>`;
  } else {
    const configKeys = Object.keys(monitor.config ?? {});
    body = `
      <div class="config-list" aria-label="Collector configuration fields">
        ${configKeys.map((key) => `<span class="config-chip">${escapeHtml(key)}</span>`).join("")}
      </div>
      <div class="monitor-footer"><span>Collector slot ready</span>${source}</div>`;
  }

  return `
    <article class="monitor-card ${statusClass}">
      <div class="monitor-top">
        <span class="monitor-index">0${index + 1}</span>
        <span class="status-pill ${statusClass}">${statusLabel}</span>
      </div>
      <h3>${escapeHtml(monitor.name)}</h3>
      <p class="monitor-description">${escapeHtml(monitor.description)}</p>
      ${body}
    </article>`;
}

function diffMarkup(run) {
  const diff = run?.diff ?? { added: [], removed: [], renamed: [] };
  const changed = diff.added.length || diff.removed.length || diff.renamed.length;
  if (!changed) {
    return `<div class="no-change"><span class="check" aria-hidden="true">✓</span><div><strong>No merchant changes</strong><p>${escapeHtml(run?.summary ?? "The latest successful crawl matches the saved baseline.")}</p></div></div>`;
  }

  const list = (items) => items.length
    ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
    : `<p>None</p>`;
  return `
    <div class="diff-columns">
      <div class="diff-group added"><h3>Added · ${diff.added.length}</h3>${list(diff.added)}</div>
      <div class="diff-group removed"><h3>Removed · ${diff.removed.length}</h3>${list(diff.removed)}</div>
    </div>
    ${diff.renamed.length ? `<div class="rename-list" aria-label="Likely renames">${diff.renamed.map((item) => `<div class="rename-row"><span>${escapeHtml(item.from)}</span><span aria-hidden="true">→</span><span>${escapeHtml(item.to)}</span></div>`).join("")}</div>` : ""}`;
}

function runMarkup(run) {
  const kind = run.status === "failure" ? "failure" : run.changed ? "change" : "stable";
  const badge = run.status === "failure"
    ? `<span class="badge error">Failed</span>`
    : run.changed ? `<span class="badge change">Change</span>` : `<span class="badge success">Stable</span>`;
  const open = kind !== "stable" ? " open" : "";
  const pageText = run.pagination ? `${run.pagination.pagesFetched} pages · ${run.pagination.pageCounts.join(" + ")}` : "Pagination incomplete";
  return `
    <details class="run ${kind}"${open}>
      <summary>
        <span class="run-title"><strong>${escapeHtml(run.summary)}</strong><span>${escapeHtml(fullDate(run.timestamp))}</span></span>
        <span class="run-meta">${run.count ?? "—"} merchants</span>
        <span class="run-meta">${duration(run.durationMs)}</span>
        ${badge}
      </summary>
      <div class="run-body">
        <div class="run-facts"><span>${escapeHtml(pageText)}</span><span>Confirmation: ${run.confirmed ? "complete" : "not complete"}</span><span>Baseline preserved: ${run.status === "failure" ? "yes" : "updated"}</span></div>
        ${run.error ? `<p class="run-error">${escapeHtml(run.error)}</p>` : diffMarkup(run)}
      </div>
    </details>`;
}

async function loadJson(name) {
  const response = await fetch(`${DATA_ROOT}/${name}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  return response.json();
}

async function render() {
  try {
    const [state, history, baseline, feed] = await Promise.all([
      loadJson("state.json"), loadJson("history.json"), loadJson("paze-baseline.json"), loadJson("change-feed.json"),
    ]);
    const configured = state.monitors.filter((monitor) => monitor.configured);
    const paze = state.monitors.find((monitor) => monitor.id === "paze-directory");
    const latestRun = history.runs[0];
    const latestChange = history.runs.find((run) => run.changed);

    const overall = document.querySelector("#overall-status");
    overall.className = `overall-card is-${state.overallStatus}`;
    overall.querySelector("strong").textContent = state.overallStatus === "healthy" ? "All active monitors healthy" : "A monitor needs attention";
    overall.querySelector(".meta").textContent = `${configured.length} active · ${state.monitors.length - configured.length} ready to configure`;

    document.querySelector("#active-count").textContent = configured.length;
    document.querySelector("#configured-count").textContent = `${state.monitors.length - configured.length} collector slots ready`;
    document.querySelector("#latest-success").textContent = relativeTime(paze?.latestSuccessAt);
    document.querySelector("#latest-success-date").textContent = fullDate(paze?.latestSuccessAt);
    document.querySelector("#last-change").textContent = latestChange ? relativeTime(latestChange.timestamp) : "None yet";
    document.querySelector("#last-change-date").textContent = latestChange ? fullDate(latestChange.timestamp) : "Baseline established; no later change";
    document.querySelector("#run-count").textContent = history.runs.length;
    document.querySelector("#generated-at").textContent = `Snapshot ${relativeTime(state.generatedAt)} · ${fullDate(state.generatedAt)}`;
    document.querySelector("#monitor-list").innerHTML = state.monitors.map(monitorCard).join("");

    document.querySelector("#latest-diff").className = "";
    document.querySelector("#latest-diff").innerHTML = diffMarkup(latestChange ?? latestRun);
    const confirmation = document.querySelector("#confirmation-badge");
    confirmation.className = `badge ${latestRun?.status === "failure" ? "error" : latestChange ? "change" : "success"}`;
    confirmation.textContent = latestRun?.status === "failure" ? "Baseline preserved" : latestChange ? "Confirmed twice" : "No change";

    document.querySelector("#merchant-total").textContent = baseline.merchants.length;
    document.querySelector("#merchant-roster").innerHTML = baseline.merchants
      .map((merchant) => `<span class="merchant-name">${escapeHtml(merchant.name)}</span>`).join("");
    document.querySelector("#run-history").innerHTML = history.runs.length
      ? history.runs.map(runMarkup).join("")
      : `<p class="empty-state">No runs recorded yet.</p>`;

    const feedLink = document.querySelector('.feed-callout .button-link');
    feedLink.setAttribute("aria-label", `Open change feed with ${feed.events.length} retained meaningful events`);
  } catch (error) {
    console.error(error);
    document.querySelector("#load-error").hidden = false;
    const overall = document.querySelector("#overall-status");
    overall.className = "overall-card is-attention";
    overall.querySelector("strong").textContent = "Snapshot unavailable";
    overall.querySelector(".meta").textContent = "The dashboard could not read its repository data";
  }
}

render();
