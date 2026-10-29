// Warehouse screen: a paired browser (wall monitor, touch screen) that shows paid/confirmed orders
// and drives picking with a barcode scanner. Scanners type the code and press Enter like a keyboard.
const $ = (sel) => document.querySelector(sel);
const TOKEN_KEY = "em_screen_token";
const POLL_MS = 5000;

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const ago = (ts) => {
  const min = Math.max(0, Math.round((Date.now() - ts) / 60000));
  return min < 60 ? `${min} daq` : `${Math.floor(min / 60)} soat ${min % 60} daq`;
};
const no = (o) => (o.number ? `#${o.number}` : `#${o.id.slice(-5).toUpperCase()}`);

function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

function setToken(token, name) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem("em_screen_name", name);
  } catch {}
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", "x-screen-token": getToken() },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 403 && getToken()) {
    // The admin removed this screen: drop the token and ask for a new pairing code.
    localStorage.removeItem(TOKEN_KEY);
    showPair();
  }
  if (!res.ok) throw new Error(data.error || "Xatolik yuz berdi");
  return data;
}

// ---------- sound ----------
let audio = null;
function beep(kind) {
  if (!audio) return;
  const notes = { ok: [880], bad: [220, 180], done: [660, 880, 1100], fresh: [520, 780] }[kind];
  notes.forEach((freq, i) => {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = freq;
    osc.type = kind === "bad" ? "square" : "sine";
    gain.gain.value = 0.15;
    osc.connect(gain).connect(audio.destination);
    const t = audio.currentTime + i * 0.14;
    osc.start(t);
    osc.stop(t + 0.12);
  });
}

$("#soundBtn").onclick = () => {
  audio = new AudioContext();
  $("#soundBtn").hidden = true;
  beep("ok");
};

// ---------- pairing ----------
function showPair() {
  $("#pairView").hidden = false;
  $("#boardView").hidden = true;
  $("#pickView").hidden = true;
  $("#pairCode").focus();
}

$("#pairForm").onsubmit = async (e) => {
  e.preventDefault();
  $("#pairError").hidden = true;
  try {
    const { token, name } = await api("/api/screens/pair", { method: "POST", body: { code: $("#pairCode").value } });
    setToken(token, name);
    start();
  } catch (err) {
    $("#pairError").textContent = err.message;
    $("#pairError").hidden = false;
  }
};

// ---------- board ----------
let orders = [];
let seen = null;
let openId = null;

function cardHtml(o) {
  const items = o.items.map((i) => `<li>${esc(i.name)} × ${i.qty}</li>`).join("");
  const chips = [
    o.orderType === "pickup" ? "🏬 Olib ketish" : "🚚 Yetkazish",
    o.payment === "card" ? '<span class="chip chip--paid">💳 To\'langan</span>' : "💵 Naqd",
    `${o.boxesNeeded} quti`,
  ]
    .map((c) => (c.startsWith("<span") ? c : `<span class="chip">${c}</span>`))
    .join("");
  const pct = Math.round((o.boxesPicked / o.boxesNeeded) * 100);
  const action = {
    new: `<button class="btn" data-start="${o.id}">Yig'ishni boshlash</button>`,
    picking: `<div class="bar"><div style="width:${pct}%"></div></div><button class="btn btn--dark" data-open="${o.id}">Davom ettirish · ${o.boxesPicked}/${o.boxesNeeded}</button>`,
    ready: `<button class="btn" data-ship="${o.id}">${o.orderType === "pickup" ? "Mijozga topshirildi" : "Yo'lga chiqarish"}</button>`,
    shipped: "",
  }[o.stage];
  return `<article class="card ${seen && !seen.has(o.id) ? "fresh" : ""}">
    <div class="card-head"><span class="card-no">${no(o)}</span><span class="card-time">${ago(o.stageAt)}</span></div>
    <ul>${items}</ul>
    <div class="chips">${chips}</div>
    ${action}
  </article>`;
}

function renderBoard() {
  for (const col of document.querySelectorAll(".col")) {
    const list = orders.filter((o) => o.stage === col.dataset.stage);
    col.querySelector("h2 span").textContent = list.length;
    col.querySelector(".cards").innerHTML = list.length ? list.map(cardHtml).join("") : '<p class="empty">Bo\'sh</p>';
  }
}

async function refresh() {
  try {
    const next = await api("/api/fulfillment");
    $("#netDot").classList.remove("off");
    const fresh = seen && next.some((o) => o.stage === "new" && !seen.has(o.id));
    orders = next;
    renderBoard();
    if (fresh) beep("fresh");
    seen = new Set(next.map((o) => o.id));
    if (openId) renderPick();
  } catch {
    $("#netDot").classList.add("off");
  }
}

$("#board").onclick = async (e) => {
  const start = e.target.closest("[data-start]")?.dataset.start;
  const open = e.target.closest("[data-open]")?.dataset.open;
  const ship = e.target.closest("[data-ship]")?.dataset.ship;
  try {
    if (start) {
      replace(await api(`/api/fulfillment/${start}/start`, { method: "POST" }));
      openPick(start);
    }
    if (open) openPick(open);
    if (ship) {
      replace(await api(`/api/fulfillment/${ship}/ship`, { method: "POST" }));
      beep("ok");
    }
  } catch (err) {
    beep("bad");
    alert(err.message);
    refresh();
  }
};

function replace(order) {
  orders = orders.map((o) => (o.id === order.id ? order : o));
  renderBoard();
}

// ---------- picking ----------
function openPick(id) {
  openId = id;
  $("#pickView").hidden = false;
  $("#flash").hidden = true;
  renderPick();
  $("#scanInput").focus();
}

function closePick() {
  openId = null;
  $("#pickView").hidden = true;
  renderBoard();
}

$("#pickBack").onclick = closePick;

function renderPick() {
  const o = orders.find((x) => x.id === openId);
  if (!o) return closePick();
  $("#pickTitle").textContent = `${no(o)} · yig'ish`;
  $("#pickBar").style.width = `${Math.round((o.boxesPicked / o.boxesNeeded) * 100)}%`;
  $("#pickCount").textContent = `${o.boxesPicked} / ${o.boxesNeeded} quti`;
  $("#pickItems").innerHTML = o.items
    .map((item, index) => {
      const boxes = Array.from({ length: item.boxes }, (_, b) => {
        const got = o.picked[`${index}-${b + 1}`] || 0;
        return `<button class="box ${got >= item.qty ? "done" : ""}" data-item="${index}" data-box="${b + 1}">
          ${b + 1}/${item.boxes}-quti<b>${got} / ${item.qty}</b></button>`;
      }).join("");
      return `<div class="pick-item"><h3>${esc(item.name)}</h3><small>SKU ${item.sku ?? "—"} · ${item.qty} dona × ${item.boxes} quti</small><div class="boxes">${boxes}</div></div>`;
    })
    .join("");
  $("#pickInfo").innerHTML = `
    <dt>Mijoz</dt><dd>${esc(o.name)}</dd>
    <dt>Telefon</dt><dd>${esc(o.phone)}</dd>
    <dt>Turi</dt><dd>${o.orderType === "pickup" ? "Olib ketish" : "Yetkazib berish"}</dd>
    ${o.address ? `<dt>Manzil</dt><dd>${esc(o.address)}</dd>` : ""}
    ${o.comment ? `<dt>Izoh</dt><dd>${esc(o.comment)}</dd>` : ""}`;
  if (o.stage === "ready") flash("ok", "✅ Hammasi yig'ildi! Ekranga qaytib, «Yo'lga chiqarish» ni bosing.");
}

function flash(kind, text) {
  const el = $("#flash");
  el.className = `flash ${kind}`;
  el.textContent = text;
  el.hidden = false;
}

async function pick(body) {
  try {
    const order = await api(`/api/fulfillment/${openId}/pick`, { method: "POST", body });
    replace(order);
    renderPick();
    if (order.stage === "ready") beep("done");
    else {
      beep("ok");
      flash("ok", `✓ ${order.scanned.item}, ${order.scanned.box}-quti`);
    }
  } catch (err) {
    beep("bad");
    flash("bad", `✕ ${err.message}`);
  }
}

$("#scanInput").onkeydown = (e) => {
  if (e.key !== "Enter") return;
  const code = e.target.value.trim();
  e.target.value = "";
  if (code) pick({ code });
};

$("#pickItems").onclick = (e) => {
  const box = e.target.closest("[data-item]");
  if (box && !box.classList.contains("done")) pick({ item: Number(box.dataset.item), box: Number(box.dataset.box) });
};

// Keep the scanner field focused so a scan always lands in it.
document.addEventListener("click", () => {
  if (openId && document.activeElement?.tagName !== "INPUT") $("#scanInput").focus();
});

// ---------- labels ----------
let products = [];

function renderLabels() {
  const q = $("#labelSearch").value.trim().toLowerCase();
  $("#labelList").innerHTML = products
    .filter((p) => !q || p.name.toLowerCase().includes(q) || String(p.sku).includes(q))
    .map(
      (p) => `<div class="label-row">
        <div><b>${esc(p.name)}</b><br><small>SKU ${p.sku ?? "—"} · ${p.boxes ?? 1} quti</small></div>
        <input type="number" min="1" max="200" value="1" aria-label="Necha dona" data-count="${p.id}" />
        <button class="btn" data-print="${p.id}" ${p.sku ? "" : "disabled"}>🏷 Chop etish</button>
      </div>`,
    )
    .join("");
}

$("#labelSearch").oninput = renderLabels;
$("#labelList").onclick = (e) => {
  const id = e.target.closest("[data-print]")?.dataset.print;
  if (!id) return;
  const count = Math.max(1, Math.min(200, Number(document.querySelector(`[data-count="${id}"]`).value) || 1));
  window.open(`/label.html?id=${encodeURIComponent(id)}&count=${count}`, "_blank");
};

document.querySelector(".tabs").onclick = async (e) => {
  const view = e.target.closest("[data-view]")?.dataset.view;
  if (!view) return;
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
  $("#board").hidden = view !== "board";
  $("#labels").hidden = view !== "labels";
  if (view === "labels") {
    products = await api("/api/products").catch(() => []);
    renderLabels();
  }
};

// ---------- boot ----------
function tick() {
  $("#clock").textContent = new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

let timer = null;
function start() {
  $("#pairView").hidden = true;
  $("#boardView").hidden = false;
  $("#soundBtn").hidden = Boolean(audio);
  try {
    $("#screenName").textContent = localStorage.getItem("em_screen_name") || "";
  } catch {}
  tick();
  refresh();
  clearInterval(timer);
  timer = setInterval(() => {
    tick();
    refresh();
  }, POLL_MS);
}

if (getToken()) start();
else showPair();
