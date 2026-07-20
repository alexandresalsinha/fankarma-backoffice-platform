// ── State ──────────────────────────────────────────────────────────────
const state = {
  profiles: [],
  selected: new Map(),   // profile_id::network -> profile
  networkFilter: null,
  search: "",
  history: [],           // [{role, content}]
  streaming: false,
};

const NETWORK_ORDER = ["instagram", "facebook", "tiktok", "youtube", "linkedin", "x", "threads", "bluesky", "pinterest"];
const keyOf = (p) => `${p.network}:${p.profile_id}`;

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

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
    return (p.profile_name + " " + p.username + " " + p.network).toLowerCase().includes(q);
  });

  if (!filtered.length) {
    list.innerHTML = `<div class="loading">Nenhum perfil corresponde.</div>`;
    return;
  }

  const groups = {};
  filtered.forEach((p) => (groups[p.network] ??= []).push(p));
  const nets = Object.keys(groups).sort((a, b) => NETWORK_ORDER.indexOf(a) - NETWORK_ORDER.indexOf(b));

  nets.forEach((net) => {
    list.appendChild(el("div", "net-group-label", `${net} · ${groups[net].length}`));
    groups[net]
      .sort((a, b) => a.profile_name.localeCompare(b.profile_name))
      .forEach((p) => list.appendChild(profileRow(p)));
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
      body: JSON.stringify({ messages: state.history, profiles }),
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

document.addEventListener("DOMContentLoaded", () => {
  loadProfiles();
  renderSuggestions();
  updateSelection();

  $("#search").addEventListener("input", (e) => { state.search = e.target.value; renderProfiles(); });
  $("#clear-selection").onclick = () => { state.selected.clear(); renderProfiles(); updateSelection(); };
  $("#reset-chat").onclick = resetChat;
  $("#schema-btn").onclick = openSchema;
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
