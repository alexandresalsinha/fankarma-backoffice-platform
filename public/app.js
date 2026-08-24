// ── State ──────────────────────────────────────────────────────────────
const state = {
  profiles: [],
  selected: new Map(),   // profile_id::network -> profile
  metrics: new Map(),    // keyOf(profile) -> { status, followers, likes, error }
  networkFilter: null,
  search: "",
  history: [],           // [{role, content}]
  streaming: false,
  model: localStorage.getItem("llm-model") || "",   // selected LLM (empty → server default)
  theme: localStorage.getItem("theme") || "dark",   // "dark" | "light"
};

const nf = new Intl.NumberFormat("pt-PT");
const fmt = (n) => nf.format(Math.round(Number(n) || 0));

const NETWORK_ORDER = ["instagram", "facebook", "tiktok", "youtube", "linkedin", "x", "threads", "bluesky", "pinterest"];
const keyOf = (p) => `${p.network}:${p.profile_id}`;

// The Fanpage Karma API exposes no company/group field on profiles — the brand
// is only present inside the profile name (repeated across networks/regions).
// We derive a "company" by stripping country/region qualifiers and normalising
// separators, then group networks/regions of the same brand together.
const REGION_WORDS = new Set([
  "portugal", "pt", "espana", "spain", "france", "angola", "luxembourg",
  "suisse", "switzerland", "usa", "uk", "brasil", "brazil", "restelo", "lisboa",
]);
const deaccent = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

// A display-friendly brand name: keep original casing, drop descriptor suffixes
// (after " - "), normalise separators, and remove region words.
function cleanBrandName(name) {
  const s = String(name).split(/\s+[-–]\s+/)[0].replace(/[.|&/(),]/g, " ");
  const tokens = s.split(/\s+/).filter(Boolean).filter((t) => {
    if (t.toLowerCase() === "l") return false;          // "Omoda l Jaecoo" separator
    return !REGION_WORDS.has(deaccent(t).toLowerCase());
  });
  return tokens.join(" ").trim();
}

// Stable grouping key (case/accent-insensitive) for a profile's company.
const companyKeyOf = (name) => deaccent(cleanBrandName(name)).toLowerCase() || deaccent(name).toLowerCase();

// Pick the nicest label among the brand names seen for one company:
// most frequent, then avoid ALL-CAPS, prefer a leading capital, then shortest.
function pickCompanyLabel(names) {
  const freq = {};
  names.forEach((n) => (freq[n] = (freq[n] || 0) + 1));
  return [...new Set(names)].sort((a, b) => {
    if (freq[b] !== freq[a]) return freq[b] - freq[a];
    const capA = a === a.toUpperCase() && /[A-Z]/.test(a);
    const capB = b === b.toUpperCase() && /[A-Z]/.test(b);
    if (capA !== capB) return capA ? 1 : -1;
    const luA = /^[A-ZÀ-Ý]/.test(a), luB = /^[A-ZÀ-Ý]/.test(b);
    if (luA !== luB) return luA ? -1 : 1;
    if (a.length !== b.length) return a.length - b.length;
    return a.localeCompare(b);
  })[0];
}

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ── Theme (dark / light) ─────────────────────────────────────────────────
function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("theme", theme);
  document.querySelectorAll("#theme-toggle .theme-opt").forEach((b) =>
    b.classList.toggle("active", b.dataset.theme === theme));
}

// ── Top bar: platform version + LLM model picker ─────────────────────────
async function loadConfig() {
  const select = $("#model-select");
  try {
    const res = await fetch("/api/config");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to load config");

    $("#platform-version").textContent = "v" + (data.version || "—");

    const models = data.models?.length ? data.models : [data.defaultModel].filter(Boolean);
    // Restore a previously-chosen model only if the server still offers it.
    if (!models.includes(state.model)) state.model = data.defaultModel || models[0] || "";

    select.innerHTML = "";
    models.forEach((m) => {
      const opt = el("option");
      opt.value = m;
      opt.textContent = m;
      opt.selected = m === state.model;
      select.appendChild(opt);
    });

    // Reflect the (masked) Fanpage Karma key so admins can see it is set.
    const input = $("#fpk-auth-input");
    input.value = "";
    input.placeholder = data.fpkAuth?.configured
      ? `Chave atual: ${data.fpkAuth.preview} — escreva para substituir`
      : "Ainda não configurada";
  } catch (e) {
    select.innerHTML = `<option value="" disabled selected>Indisponível</option>`;
    console.error("Config load failed:", e.message);
  }
}

async function saveSettings() {
  const btn = $("#settings-save");
  const status = $("#settings-status");
  const input = $("#fpk-auth-input");
  const fpkAuth = input.value.trim();

  btn.disabled = true;
  status.className = "settings-status";
  status.textContent = "A guardar…";
  try {
    // Theme and model are already applied + persisted the moment they change;
    // only the API key needs a server round-trip, and only when one was typed.
    if (fpkAuth) {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fpkAuth }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Falha ao guardar");
      input.value = "";
      input.placeholder = data.fpkAuth?.configured
        ? `Chave atual: ${data.fpkAuth.preview} — escreva para substituir`
        : "Ainda não configurada";
    }
    status.className = "settings-status ok";
    status.textContent = "Guardado ✓";
  } catch (e) {
    status.className = "settings-status err";
    status.textContent = "⚠ " + e.message;
  } finally {
    btn.disabled = false;
  }
}

// ── Profiles ───────────────────────────────────────────────────────────
async function loadProfiles() {
  try {
    const res = await fetch("/api/profiles");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to load profiles");
    state.profiles = data.profiles;
    renderNetworkFilters();
    renderProfiles();
  } catch (e) {
    $("#profile-list").innerHTML = `<div class="loading">⚠ Erro ao carregar perfis: ${esc(e.message)}</div>`;
  }
}

function renderNetworkFilters() {
  const nets = [...new Set(state.profiles.map((p) => p.network))].sort(
    (a, b) => NETWORK_ORDER.indexOf(a) - NETWORK_ORDER.indexOf(b),
  );
  const box = $("#network-filters");
  box.innerHTML = "";
  nets.forEach((net) => {
    const chip = el("span", "chip" + (state.networkFilter === net ? " active" : ""), net);
    chip.onclick = () => {
      state.networkFilter = state.networkFilter === net ? null : net;
      renderNetworkFilters();
      renderProfiles();
    };
    box.appendChild(chip);
  });
}

function renderProfiles() {
  const list = $("#profile-list");
  list.innerHTML = "";
  const q = state.search.toLowerCase();

  const filtered = state.profiles.filter((p) => {
    if (state.networkFilter && p.network !== state.networkFilter) return false;
    if (!q) return true;
    return (p.profile_name + " " + p.username + " " + p.network + " " + cleanBrandName(p.profile_name)).toLowerCase().includes(q);
  });

  if (!filtered.length) {
    list.innerHTML = `<div class="loading">Nenhum perfil corresponde.</div>`;
    return;
  }

  // Group by company (derived from the profile name) first, then by network.
  const companies = {};
  filtered.forEach((p) => {
    const key = companyKeyOf(p.profile_name);
    (companies[key] ??= { labels: [], items: [] });
    companies[key].labels.push(cleanBrandName(p.profile_name) || p.profile_name);
    companies[key].items.push(p);
  });

  const ordered = Object.values(companies)
    .map((g) => ({ label: pickCompanyLabel(g.labels), items: g.items }))
    .sort((a, b) => a.label.localeCompare(b.label));

  ordered.forEach(({ label, items }) => {
    list.appendChild(el("div", "company-group-label", `${esc(label)} · ${items.length}`));

    const byNetwork = {};
    items.forEach((p) => (byNetwork[p.network] ??= []).push(p));
    const nets = Object.keys(byNetwork).sort((a, b) => NETWORK_ORDER.indexOf(a) - NETWORK_ORDER.indexOf(b));

    nets.forEach((net) => {
      list.appendChild(el("div", "net-group-label", `${net} · ${byNetwork[net].length}`));
      byNetwork[net]
        .sort((a, b) => a.profile_name.localeCompare(b.profile_name))
        .forEach((p) => list.appendChild(profileRow(p)));
    });
  });
}

function profileRow(p) {
  const k = keyOf(p);
  const row = el("div", "profile" + (state.selected.has(k) ? " selected" : ""));
  const img = el("img");
  img.src = p.profile_picture_url || "";
  img.referrerPolicy = "no-referrer";
  img.onerror = () => { img.style.visibility = "hidden"; };
  const netCls = "net-" + (NETWORK_ORDER.includes(p.network) ? p.network : "default");
  row.append(
    img,
    el("div", "meta",
      `<div class="name">${esc(p.profile_name)}</div>
       <div class="sub"><span class="net-badge ${netCls}">${esc(p.network)}</span> @${esc(p.username)}</div>`),
    el("div", "check", "✓"),
  );
  row.onclick = () => {
    if (state.selected.has(k)) state.selected.delete(k);
    else state.selected.set(k, p);
    renderProfiles();
    updateSelection();
    syncDashboard();
  };
  return row;
}

function updateSelection() {
  const n = state.selected.size;
  $("#selection-count").textContent = `${n} selecionado${n === 1 ? "" : "s"}`;
  const ctx = $("#context-line");
  if (n === 0) ctx.textContent = "Selecione perfis à esquerda para definir o âmbito das suas perguntas.";
  else {
    const names = [...state.selected.values()].map((p) => p.profile_name);
    ctx.textContent =
      "Em contexto: " + names.slice(0, 3).join(", ") + (n > 3 ? ` +${n - 3}` : "");
  }
}

// ── Dashboard (live totals via the Fanpage Karma MCP) ────────────────────
// Each selected (network, profile) gets its followers + likes fetched once and
// cached. Toggling a profile recomputes the totals in real time.
async function syncDashboard() {
  // Kick off a fetch for every freshly-selected profile we haven't loaded yet.
  const pending = [];
  for (const [k, p] of state.selected) {
    const m = state.metrics.get(k);
    if (m && m.status !== "error") continue;   // cached (or in-flight)
    state.metrics.set(k, { status: "loading" });
    pending.push(fetchMetrics(k, p));
  }
  renderDashboard();
  scheduleInsights();
  if (pending.length) await Promise.all(pending);
}

// ── LLM insights ─────────────────────────────────────────────────────────
// A fixed set of questions re-asked whenever the selection changes, scoped to
// the selected profiles and streamed into the bottom of the dashboard. Each
// question is debounced (a burst of toggles collapses into one request) and
// abortable (a new selection cancels the in-flight stream).
const INSIGHTS = [
  {
    id: "best-network",
    title: "Melhor desempenho",
    question: "Que rede tem melhor desempenho para esta marca?",
  },
  {
    id: "growth-content",
    title: "Conteúdos que atraíram seguidores",
    question:
      "Indica-me quais os conteúdos que mais contribuíram para a angariação de followers e encontra-me ingredientes nesses posts que possam ter contribuído para esse crescimento.",
  },
];

function buildInsightSections() {
  const host = $("#insights");
  host.innerHTML = "";
  INSIGHTS.forEach((ins) => {
    const section = el("div", "dash-section");
    section.id = `insight-${ins.id}`;
    section.hidden = true;
    section.innerHTML =
      `<h3>${esc(ins.title)} <span class="insight-status" data-status="${ins.id}"></span></h3>
       <div class="insight-body" data-body="${ins.id}"></div>`;
    host.appendChild(section);
    ins._timer = null;
    ins._controller = null;
    ins._seq = 0;
  });
}

function scheduleInsights() {
  const empty = state.selected.size === 0;
  INSIGHTS.forEach((ins) => {
    clearTimeout(ins._timer);
    const section = $(`#insight-${ins.id}`);
    if (empty) {
      if (ins._controller) ins._controller.abort();
      ins._seq++;                       // invalidate any in-flight stream
      section.hidden = true;
      $(`[data-body="${ins.id}"]`).innerHTML = "";
      $(`[data-status="${ins.id}"]`).innerHTML = "";
      return;
    }
    section.hidden = false;
    $(`[data-status="${ins.id}"]`).innerHTML = `<span class="spinner"></span> a aguardar…`;
    ins._timer = setTimeout(() => runInsight(ins), 900);
  });
}

async function runInsight(ins) {
  const body = $(`[data-body="${ins.id}"]`);
  const status = $(`[data-status="${ins.id}"]`);
  if (ins._controller) ins._controller.abort();
  const controller = new AbortController();
  ins._controller = controller;
  const seq = ++ins._seq;

  const profiles = [...state.selected.values()].map((p) => ({
    network: p.network, profile_id: p.profile_id,
    profile_name: p.profile_name, username: p.username,
  }));

  status.innerHTML = `<span class="spinner"></span> a analisar…`;
  body.innerHTML = "";
  let answer = "";

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: ins.question }], profiles, model: state.model }),
      signal: controller.signal,
    });
    await readSSE(res, (event, data) => {
      if (seq !== ins._seq) return;     // a newer request superseded this one
      if (event === "text") {
        answer += (answer ? "\n\n" : "") + data.text;
        body.innerHTML = renderMarkdown(answer);
      } else if (event === "tool" && data.status === "running") {
        status.innerHTML = `<span class="spinner"></span> a consultar dados…`;
      } else if (event === "error") {
        body.innerHTML += `<div class="insight-error">⚠ ${esc(data.error)}</div>`;
      }
    });
    if (seq === ins._seq) status.innerHTML = "";
  } catch (e) {
    if (e.name === "AbortError" || seq !== ins._seq) return;
    status.innerHTML = "";
    body.innerHTML = `<div class="insight-error">⚠ ${esc(e.message)}</div>`;
  }
}

async function fetchMetrics(k, p) {
  try {
    const url = `/api/metrics?network=${encodeURIComponent(p.network)}&profile_id=${encodeURIComponent(p.profile_id)}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Falha ao obter métricas");
    // Ignore if the profile was deselected while the request was in flight.
    if (!state.selected.has(k)) { state.metrics.delete(k); return; }
    state.metrics.set(k, { status: "done", followers: data.followers, likes: data.likes });
  } catch (e) {
    if (state.selected.has(k)) state.metrics.set(k, { status: "error", error: e.message });
  }
  renderDashboard();
}

function renderDashboard() {
  const selected = [...state.selected.entries()];
  const n = selected.length;

  // Context line + loading status.
  const ctx = $("#dash-context");
  ctx.textContent = n === 0
    ? "Selecione redes de perfis à esquerda para ver os totais."
    : `${n} rede${n === 1 ? "" : "s"} selecionada${n === 1 ? "" : "s"} · dados dos últimos 28 dias.`;

  const loadingCount = selected.filter(([k]) => state.metrics.get(k)?.status === "loading").length;
  $("#dash-status").innerHTML = loadingCount
    ? `<span class="spinner"></span> A atualizar ${loadingCount}…`
    : "";

  // Totals (only count profiles whose metrics have arrived).
  let totFollowers = 0, totLikes = 0;
  const byNet = {};   // network -> { followers, likes, count }
  for (const [k, p] of selected) {
    const m = state.metrics.get(k);
    const net = (byNet[p.network] ??= { followers: 0, likes: 0, count: 0 });
    net.count++;
    if (m?.status === "done") {
      totFollowers += m.followers;
      totLikes += m.likes;
      net.followers += m.followers;
      net.likes += m.likes;
    }
  }
  setKpi("#kpi-followers", totFollowers);
  setKpi("#kpi-likes", totLikes);

  // Per-network breakdown bars.
  const bd = $("#network-breakdown");
  bd.innerHTML = "";
  const nets = Object.keys(byNet).sort((a, b) => NETWORK_ORDER.indexOf(a) - NETWORK_ORDER.indexOf(b));
  if (!nets.length) {
    bd.innerHTML = `<div class="dash-empty">Nenhuma rede selecionada.</div>`;
  } else {
    const maxF = Math.max(1, ...nets.map((net) => byNet[net].followers));
    const maxL = Math.max(1, ...nets.map((net) => byNet[net].likes));
    nets.forEach((net) => {
      const d = byNet[net];
      const netCls = "net-" + (NETWORK_ORDER.includes(net) ? net : "default");
      bd.appendChild(el("div", "net-row",
        `<div class="net-row-head">
           <span class="net-badge ${netCls}">${esc(net)}</span>
           <span class="net-count">${d.count} perfil${d.count === 1 ? "" : "s"}</span>
         </div>
         <div class="net-metric">
           <div class="net-metric-top"><span class="lbl">Seguidores</span><span class="val">${fmt(d.followers)}</span></div>
           <div class="bar-track"><div class="bar-fill followers" style="width:${(d.followers / maxF) * 100}%"></div></div>
         </div>
         <div class="net-metric">
           <div class="net-metric-top"><span class="lbl">Likes</span><span class="val">${fmt(d.likes)}</span></div>
           <div class="bar-track"><div class="bar-fill likes" style="width:${(d.likes / maxL) * 100}%"></div></div>
         </div>`));
    });
  }

  // Per-profile list (shows loading / error state for each selected network).
  const sn = $("#selected-nets");
  const title = $("#selected-nets-title");
  sn.innerHTML = "";
  title.style.display = n ? "" : "none";
  selected
    .sort((a, b) => a[1].profile_name.localeCompare(b[1].profile_name))
    .forEach(([k, p]) => {
      const m = state.metrics.get(k);
      const netCls = "net-" + (NETWORK_ORDER.includes(p.network) ? p.network : "default");
      let nums, cls = "sel-net";
      if (m?.status === "done") nums = `👥 ${fmt(m.followers)} · ❤ ${fmt(m.likes)}`;
      else if (m?.status === "error") { nums = "erro"; cls += " error"; }
      else nums = `<span class="spinner"></span>`;
      sn.appendChild(el("div", cls,
        `<span class="net-badge ${netCls}">${esc(p.network)}</span>
         <span class="name">${esc(p.profile_name)}</span>
         <span class="nums">${nums}</span>`));
    });
}

function setKpi(sel, value) {
  const node = $(sel);
  const next = fmt(value);
  if (node.textContent !== next && next !== "0") {
    const card = node.closest(".kpi-card");
    card.classList.remove("pulse");
    void card.offsetWidth;   // restart the animation
    card.classList.add("pulse");
  }
  node.textContent = next;
}

// ── Chat ───────────────────────────────────────────────────────────────
function addMessage(role) {
  const empty = $(".empty-chat");
  if (empty) empty.remove();
  const msg = el("div", `msg ${role}`);
  msg.append(
    el("div", "avatar", role === "user" ? "🧑" : "📊"),
    (() => {
      const body = el("div", "body");
      body.append(el("div", "role", role === "user" ? "Você" : "Assistente"));
      body.append(el("div", "bubble"));
      return body;
    })(),
  );
  $("#messages").appendChild(msg);
  scrollDown();
  return msg.querySelector(".bubble");
}

function scrollDown() {
  const m = $("#messages");
  m.scrollTop = m.scrollHeight;
}

async function send(text) {
  if (!text.trim() || state.streaming) return;
  state.streaming = true;
  $("#send").disabled = true;

  const userBubble = addMessage("user");
  userBubble.textContent = text;
  state.history.push({ role: "user", content: text });

  const asstBubble = addMessage("assistant");
  let answer = "";

  const profiles = [...state.selected.values()].map((p) => ({
    network: p.network, profile_id: p.profile_id,
    profile_name: p.profile_name, username: p.username,
  }));

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: state.history, profiles, model: state.model }),
    });

    await readSSE(res, (event, data) => {
      if (event === "text") {
        answer += (answer ? "\n\n" : "") + data.text;
        asstBubble.innerHTML = renderMarkdown(answer);
      } else if (event === "tool") {
        renderTool(asstBubble, data);
      } else if (event === "error") {
        asstBubble.innerHTML += `<div class="tool-call error">⚠ ${esc(data.error)}</div>`;
      }
      scrollDown();
    });

    if (answer) state.history.push({ role: "assistant", content: answer });
  } catch (e) {
    asstBubble.innerHTML += `<div class="tool-call error">⚠ ${esc(e.message)}</div>`;
  } finally {
    state.streaming = false;
    $("#send").disabled = false;
  }
}

function renderTool(bubble, data) {
  let node = bubble.querySelector(`[data-tool="${data.id}"]`);
  if (!node) {
    node = el("div", "tool-call");
    node.dataset.tool = data.id;
    bubble.appendChild(node);
  }
  if (data.status === "running") {
    node.className = "tool-call";
    node.innerHTML = `<span class="spinner"></span> A consultar <code>${esc(data.name)}</code>…`;
  } else if (data.status === "done") {
    node.className = "tool-call done";
    node.innerHTML = `<span class="dot">●</span> <code>${esc(data.name)}</code> devolveu dados`;
  } else if (data.status === "error") {
    node.className = "tool-call error";
    node.innerHTML = `⚠ <code>${esc(data.name)}</code> falhou: ${esc(data.error || "")}`;
  }
}

// Parse an SSE stream from a fetch Response.
async function readSSE(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const chunks = buf.split("\n\n");
    buf = chunks.pop();
    for (const chunk of chunks) {
      let event = "message", data = "";
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (data) {
        try { onEvent(event, JSON.parse(data)); } catch { /* ignore */ }
      }
    }
  }
}

// ── Minimal Markdown renderer (headings, bold/italic, code, tables, lists) ─
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
    while (i < lines.length && lines[i].trim() !== "" && !/^(#{1,4}\s|[-*]\s|\d+\.\s)/.test(lines[i]) && !lines[i].includes("|")) {
      para += " " + lines[i]; i++;
    }
    html += `<p>${inline(para)}</p>`;
  }
  return html;
}

// ── Schema modal ─────────────────────────────────────────────────────────
async function openSchema() {
  const modal = $("#schema-modal");
  const body = $("#schema-body");
  modal.classList.remove("hidden");
  body.innerHTML = `<div class="loading">A carregar esquema…</div>`;
  try {
    const res = await fetch("/api/schema");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed");
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

document.addEventListener("DOMContentLoaded", () => {
  loadConfig();
  loadProfiles();
  renderSuggestions();
  updateSelection();
  buildInsightSections();
  renderDashboard();
  initResizers();

  $("#search").addEventListener("input", (e) => { state.search = e.target.value; renderProfiles(); });
  $("#clear-selection").onclick = () => { state.selected.clear(); renderProfiles(); updateSelection(); renderDashboard(); scheduleInsights(); };
  $("#reset-chat").onclick = resetChat;
  $("#collapse-chat").onclick = () => document.body.classList.add("chat-collapsed");
  $("#open-chat").onclick = () => {
    document.body.classList.remove("chat-collapsed");
    $("#input").focus();
  };
  $("#model-select").addEventListener("change", (e) => {
    state.model = e.target.value;
    localStorage.setItem("llm-model", state.model);
  });
  const settingsModal = $("#settings-modal");
  const openSettings = () => {
    $("#settings-status").textContent = "";
    settingsModal.classList.remove("hidden");
  };
  const closeSettings = () => settingsModal.classList.add("hidden");
  $("#settings-btn").onclick = openSettings;
  $("#settings-close").onclick = closeSettings;
  settingsModal.onclick = (e) => { if (e.target.id === "settings-modal") closeSettings(); };
  $("#settings-save").onclick = saveSettings;

  document.querySelectorAll("#theme-toggle .theme-opt").forEach((b) => {
    b.onclick = () => applyTheme(b.dataset.theme);
  });
  applyTheme(state.theme);   // sync the toggle's active state with the stored theme
  $("#login-btn").onclick = () => {
    // Login flow is not implemented yet — placeholder until auth is wired up.
    alert("Início de sessão em breve.");
  };

  const schemaBtn = $("#schema-btn");
  if (schemaBtn) schemaBtn.onclick = openSchema;   // footer button is optional
  $("#schema-close").onclick = () => $("#schema-modal").classList.add("hidden");
  $("#schema-modal").onclick = (e) => { if (e.target.id === "schema-modal") $("#schema-modal").classList.add("hidden"); };

  const input = $("#input");
  input.addEventListener("input", autoGrow);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
  });
  $("#composer").addEventListener("submit", (e) => { e.preventDefault(); submit(); });

  function submit() {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    autoGrow();
    send(text);
  }
});
