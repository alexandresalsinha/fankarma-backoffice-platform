const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const fmt = (n) => nf.format(Math.round(Number(n) || 0));

function renderMarkdown(md) {
  const lines = md.split("\n");
  let html = "", i = 0;
  const inline = (t) =>
    esc(t)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/`(.+?)`/g, "<code>$1</code>")
      .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block (```lang ... ```) — a ```chart block renders as a bar chart.
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      i++;
      const body = [];
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { body.push(lines[i]); i++; }
      i++; // skip closing fence
      if (fence[1] === "chart") html += renderChartBlock(body);
      else if (fence[1] === "posts") html += renderPostsBlock(body);
      else html += `<pre><code>${esc(body.join("\n"))}</code></pre>`;
      continue;
    }
    // Table
    if (line.includes("|") && lines[i + 1] && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      const header = line.split("|").filter((c) => c.trim() !== "");
      i += 2;
      let rows = "";
      while (i < lines.length && lines[i].includes("|")) {
        const cells = lines[i].split("|").filter((c) => c.trim() !== "");
        rows += "<tr>" + cells.map((c) => `<td>${inline(c.trim())}</td>`).join("") + "</tr>";
        i++;
      }
      html += "<table><thead><tr>" + header.map((h) => `<th>${inline(h.trim())}</th>`).join("") +
        "</tr></thead><tbody>" + rows + "</tbody></table>";
      continue;
    }
    // Headings
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) { const lvl = h[1].length + 2; html += `<h${lvl}>${inline(h[2])}</h${lvl}>`; i++; continue; }
    // Lists
    if (/^\s*[-*]\s+/.test(line)) {
      html += "<ul>";
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        html += `<li>${inline(lines[i].replace(/^\s*[-*]\s+/, ""))}</li>`; i++;
      }
      html += "</ul>"; continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      html += "<ol>";
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        html += `<li>${inline(lines[i].replace(/^\s*\d+\.\s+/, ""))}</li>`; i++;
      }
      html += "</ol>"; continue;
    }
    // Blank
    if (line.trim() === "") { i++; continue; }
    // Paragraph
    let para = line; i++;
    while (i < lines.length && lines[i].trim() !== "" && !/^(#{1,4}\s|[-*]\s|\d+\.\s|```)/.test(lines[i]) && !lines[i].includes("|")) {
      para += " " + lines[i]; i++;
    }
    html += `<p>${inline(para)}</p>`;
  }
  return html;
}

const CHART_PLOT_H = 120; // px — shared bar-area height, used for both bar scaling and gridlines

// Parses a ```chart block into a vertical (grouped, multi-series) bar chart.
// Pipe format: optional title line, then a header row "Categoria | Série 1 | Série 2 | ...",
// then one "Rótulo | valor1 | valor2 | ..." row per category. A colon-format
// fallback ("Label: value") is also accepted for a single series.
function renderChartBlock(lines) {
  const trimmed = lines.map((l) => l.trim()).filter(Boolean);
  if (!trimmed.length) return "";

  let title = "", seriesNames = [];
  const rows = [];
  const num = (s) => Number(String(s).replace(/[^\d-]/g, "")) || 0;

  if (trimmed.some((l) => l.includes("|"))) {
    let header = null;
    for (const line of trimmed) {
      if (!line.includes("|")) { if (!header) title = line; continue; }
      const cells = line.split("|").map((c) => c.trim()).filter((c) => c !== "");
      if (!header) { header = cells; seriesNames = cells.slice(1); continue; }
      rows.push({ label: cells[0], values: cells.slice(1).map(num) });
    }
  } else {
    seriesNames = ["Valor"];
    const rowRe = /^(.+?):\s*(-?[\d.,]+)\s*$/;
    for (const line of trimmed) {
      const m = line.match(rowRe);
      if (m) rows.push({ label: m[1].trim(), values: [num(m[2])] });
      else if (!rows.length && !title) title = line;
    }
  }
  if (!rows.length || !seriesNames.length) return "";

  const seriesColor = (idx) => `var(--series-${(idx % 8) + 1})`;
  const max = Math.max(1, ...rows.flatMap((r) => r.values));

  const legend = seriesNames.length > 1
    ? `<div class="insight-chart-legend">${seriesNames.map((s, idx) =>
        `<span class="insight-chart-legend-item"><span class="insight-chart-swatch" style="background:${seriesColor(idx)}"></span>${esc(s)}</span>`
      ).join("")}</div>`
    : "";

  const groups = rows.map((r) => {
    const cols = r.values.map((v, idx) => `
      <div class="insight-chart-col">
        <span class="insight-chart-value">${fmt(v)}</span>
        <div class="insight-chart-bar" style="height:${Math.max(2, Math.round((v / max) * CHART_PLOT_H))}px; background:${seriesColor(idx)}"></div>
      </div>`).join("");
    return `<div class="insight-chart-group">
      <div class="insight-chart-bars">${cols}</div>
      <div class="insight-chart-cat-label" title="${esc(r.label)}">${esc(r.label)}</div>
    </div>`;
  }).join("");

  const gridlines = [0, CHART_PLOT_H / 2, CHART_PLOT_H]
    .map((top) => `<div class="insight-chart-gridline${top === CHART_PLOT_H ? " base" : ""}" style="top:${top}px"></div>`)
    .join("");

  return `<div class="insight-chart">
    ${title ? `<div class="insight-chart-title">${esc(title)}</div>` : ""}
    ${legend}
    <div class="insight-chart-plot">${gridlines}<div class="insight-chart-groups">${groups}</div></div>
  </div>`;
}

// Parses a ```posts block into a grid of media cards. Format: one JSON object
// per line — {network, type, image, link, caption} — sourced verbatim from the
// get_profile_posts tool result. A post without an `image` is skipped; a post
// whose image later fails to load (hotlink protection, expired CDN URL, ...)
// hides its own card rather than showing a broken-image icon.
function renderPostsBlock(lines) {
  const posts = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const p = JSON.parse(line);
      if (p && typeof p.image === "string" && p.image) posts.push(p);
    } catch {
      /* skip malformed line */
    }
  }
  if (!posts.length) return "";

  const cards = posts.map((p) => {
    const network = String(p.network || "").toLowerCase();
    const type = String(p.type || "").toUpperCase();
    const link = typeof p.link === "string" ? p.link : "";
    const captionRaw = p.caption ? String(p.caption) : "";
    const caption = captionRaw
      ? esc(captionRaw.slice(0, 180)) + (captionRaw.length > 180 ? "…" : "")
      : "";

    const inner = `
      <div class="insight-post-thumb">
        <img src="${esc(p.image)}" alt="" loading="lazy" onerror="this.closest('.insight-post-card').style.display='none'" />
        <span class="insight-post-badge">${esc(network)}${type ? ` · ${esc(type)}` : ""}</span>
      </div>
      ${caption ? `<div class="insight-post-caption">${caption}</div>` : ""}`;

    return link
      ? `<a class="insight-post-card" href="${esc(link)}" target="_blank" rel="noreferrer">${inner}</a>`
      : `<div class="insight-post-card">${inner}</div>`;
  }).join("");

  return `<div class="insight-posts"><div class="insight-posts-grid">${cards}</div></div>`;
}

// ── Schema modal ─────────────────────────────────────────────────────────
async function openSchema() {
  console.log("openSchema: fetching /api/schema");
  const modal = $("#schema-modal");
  const body = $("#schema-body");
  modal.classList.remove("hidden");
  body.innerHTML = `<div class="loading">A carregar esquema…</div>`;
  try {
    const res = await fetch("/api/schema");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed");
    console.log("openSchema: loaded", data.tools?.length, "tools");
    body.innerHTML = "";
    data.tools.forEach((t) => {
      const props = t.inputSchema?.properties || {};
      const required = new Set(t.inputSchema?.required || []);
      const params = Object.keys(props)
        .map((k) => `<code>${esc(k)}</code>${required.has(k) ? "*" : ""} <span>${esc(props[k].description || props[k].type || "")}</span>`)
        .join("<br>");
      const div = el("div", "schema-tool",
        `<h4>${esc(t.name)}</h4><p>${esc(t.description || "")}</p>` +
        (params ? `<div class="params">${params}</div>` : ""));
      body.appendChild(div);
    });
  } catch (e) {
    console.error("openSchema failed:", e.message);
    body.innerHTML = `<div class="loading">⚠ ${esc(e.message)}</div>`;
  }
}

// ── Wiring ───────────────────────────────────────────────────────────────
const SUGGESTIONS = [
  "Quantos seguidores tem cada perfil selecionado?",
  "Compara a taxa de interação entre os perfis selecionados.",
  "Quais foram as melhores publicações dos últimos 28 dias?",
  "Que rede tem melhor desempenho para esta marca?",
];

function renderSuggestions() {
  const box = $("#suggestions");
  if (!box) return;
  SUGGESTIONS.forEach((s) => {
    const b = el("div", "suggestion", esc(s));
    b.onclick = () => { $("#input").value = s; $("#input").focus(); autoGrow(); };
    box.appendChild(b);
  });
}

function autoGrow() {
  const t = $("#input");
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 160) + "px";
}

function resetChat() {
  state.history = [];
  $("#messages").innerHTML =
    `<div class="empty-chat"><div class="empty-emoji">💬</div>
     <h3>Faça perguntas sobre os seus perfis ligados</h3>
     <p>Selecione um ou mais perfis e faça perguntas — o assistente consulta a API da Fanpage Karma em tempo real.</p>
     <div class="suggestions" id="suggestions"></div></div>`;
  renderSuggestions();
}

// ── Panel resizing (drag the gutters between the three panels) ───────────
function initResizers() {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  document.querySelectorAll(".resizer").forEach((r) => {
    r.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const target = r.dataset.target;   // "left" (sidebar) or "mid" (dashboard)
      const varName = target === "left" ? "--w-left" : "--w-mid";
      const startX = e.clientX;
      const startW = parseFloat(getComputedStyle(document.body).getPropertyValue(varName));
      r.classList.add("dragging");
      document.body.classList.add("resizing");

      const onMove = (ev) => {
        // Keep the chat panel usable: cap widths against the viewport.
        const max = window.innerWidth - (target === "left" ? 520 : 300);
        const w = clamp(startW + (ev.clientX - startX), 240, max);
        document.body.style.setProperty(varName, w + "px");
      };
      const onUp = () => {
        r.classList.remove("dragging");
        document.body.classList.remove("resizing");
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    });
  });
}

// ── Date filter (drives the dashboard KPIs + LLM insight queries) ────────
function initDateFilter() {
  const preset = $("#range-preset");
  const custom = $("#custom-range");

  const toggleCustom = () => {
    const isCustom = preset.value === "custom";
    custom.hidden = !isCustom;
    if (isCustom && !$("#range-to").value) {
      $("#range-to").value = isoDate(new Date());   // sensible default end date
    }
  };
  preset.addEventListener("change", toggleCustom);
  toggleCustom();

  $("#apply-range").onclick = applyDateFilter;
}

function applyDateFilter() {
  console.log("applyDateFilter: triggered");
  const preset = $("#range-preset").value;
  let range;
  if (preset === "custom") {
    const from = $("#range-from").value;
    const to = $("#range-to").value;
    if (!from || !to) { $("#range-from").focus(); return; }   // both dates required
    if (from > to) { $("#range-from").focus(); return; }      // guard inverted range
    range = { preset, from, to };
  } else {
    range = { preset, ...presetRange(preset) };
  }
  state.dateRange = range;
  console.log("applyDateFilter: range set to", range);
  renderDashboard();   // reflect the newly applied range in the "Dashboard" header
  // KPI metrics are NOT refetched here — they only update via the left panel's
  // "Aplicar". This range only scopes the LLM insight questions.
  runCheckedInsights();
}



module.exports = { renderMarkdown };