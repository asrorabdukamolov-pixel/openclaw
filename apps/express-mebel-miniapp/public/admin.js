// Express Market desktop admin panel. Same API as the mini app; the session token from a one-time
// bot link (/panel) stands in for Telegram's initData.
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const sum = (n) => Math.round(n || 0).toLocaleString("ru-RU").replace(/[\s,]/g, " ");
const when = (ts) => (ts ? new Date(ts).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");
const dayKey = (ts) => new Date(ts + 5 * 3600e3).toISOString().slice(0, 10); // Tashkent day
const DAY = 864e5;

const TOKEN_KEY = "em_admin_token";
const storage = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v);
    } catch {}
  },
};

let token = storage.get(TOKEN_KEY);

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || "GET",
    headers: { "content-type": "application/json", ...(token ? { "x-admin-token": token } : {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) {
    if (!options.quiet) showLogin("Sessiya tugagan yoki ruxsat yo'q. Botga /panel yozib, yangi havola oling.");
    throw new Error(data.error || "Ruxsat yo'q");
  }
  if (!res.ok) throw new Error(data.error || "Xatolik");
  return data;
}

function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 2600);
}

// ---------- shared state ----------
const state = { products: [], info: null, period: 30, orders: new Map() };
const byId = (id) => state.products.find((p) => p.id === id);
const isKit = (p) => p.kind === "kit";
const goods = () => state.products.filter((p) => !isKit(p));
const catName = (id) => state.info?.categories.find((c) => c.id === id)?.name ?? id;

// Orders for the chosen period, cached per period until something changes them.
async function ordersFor(days) {
  if (!state.orders.has(days)) {
    const from = days ? Date.now() - days * DAY : 0;
    state.orders.set(days, await api(from ? `/api/orders?from=${from}` : "/api/orders"));
  }
  return state.orders.get(days);
}

const refreshProducts = async () => (state.products = await api("/api/products?all=1"));
const dropOrders = () => state.orders.clear();

// ---------- order vocabulary ----------
const STAGE = {
  new: ["Qabul qilindi", "teal"],
  picking: ["Tayyorlanmoqda", "warn"],
  ready: ["Tayyor", "warn"],
  shipped: ["Yo'lda", "teal"],
  delivered: ["Yakunlandi", "ok"],
  problem: ["Muammo", "bad"],
  cancelled: ["Bekor qilingan", ""],
};

function orderState(o) {
  if (o.status === "paid_after_cancel") return ["To'lov kech keldi", "bad"];
  if (o.status === "cancelled") return STAGE.cancelled;
  if (o.stage === null) return ["To'lov kutilmoqda", ""];
  return STAGE[o.stage] || [o.stage, ""];
}

const orderGroup = (o) =>
  o.status === "paid_after_cancel" ? "active" : o.status === "cancelled" ? "cancelled" : o.stage === "delivered" ? "done" : "active";
// A sale: not cancelled and either paid by card or a cash order the buyer confirmed.
const isSale = (o) => o.status !== "cancelled" && o.stage !== null;
const pill = ([text, tone]) => `<span class="pill ${tone ? `pill--${tone}` : ""}">${esc(text)}</span>`;
const no = (o) => (o.number ? `#${o.number}` : `#${o.id.slice(-5).toUpperCase()}`);

function csv(rows) {
  return rows.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(";")).join("\r\n");
}

function download(name, rows) {
  const blob = new Blob(["﻿" + csv(rows)], { type: "text/csv;charset=utf-8" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
  a.click();
  URL.revokeObjectURL(a.href);
}

function periodSeg() {
  return `<div class="seg" id="periodSeg">${[
    [7, "7 kun"],
    [30, "30 kun"],
    [90, "90 kun"],
  ]
    .map(([d, label]) => `<button type="button" data-period="${d}" class="${state.period === d ? "on" : ""}">${label}</button>`)
    .join("")}</div>`;
}

function bindPeriod(rerender) {
  $("#periodSeg")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-period]");
    if (!b) return;
    state.period = Number(b.dataset.period);
    rerender();
  });
}

// Daily bars in a fixed-size SVG; values come from the same rows the tables use.
function barChart(points) {
  const W = 760;
  const H = 220;
  const pad = { l: 56, r: 8, t: 10, b: 26 };
  const max = Math.max(1, ...points.map((p) => p.value));
  const step = (W - pad.l - pad.r) / Math.max(points.length, 1);
  const y = (v) => H - pad.b - (v / max) * (H - pad.t - pad.b);
  const ticks = [0, 0.5, 1].map((f) => max * f);
  const label = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)} mln` : v >= 1e3 ? `${Math.round(v / 1e3)} ming` : String(Math.round(v)));
  const every = Math.ceil(points.length / 10);
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Kunlik tushum">
    ${ticks.map((t) => `<line class="grid-line" x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}"/><text x="${pad.l - 6}" y="${y(t) + 4}" text-anchor="end">${label(t)}</text>`).join("")}
    ${points
      .map((p, i) => {
        const h = H - pad.b - y(p.value);
        const x = pad.l + i * step + step * 0.15;
        return `<rect class="bar ${i === points.length - 1 ? "bar--now" : ""}" x="${x}" y="${y(p.value)}" width="${step * 0.7}" height="${Math.max(h, p.value ? 1 : 0)}"><title>${p.day}: ${sum(p.value)} so'm</title></rect>
          ${i % every === 0 ? `<text x="${x + step * 0.35}" y="${H - 8}" text-anchor="middle">${p.day.slice(8)}.${p.day.slice(5, 7)}</text>` : ""}`;
      })
      .join("")}
  </svg></div>`;
}

function dailyPoints(orders, days, value) {
  const today = dayKey(Date.now());
  const keys = Array.from({ length: days }, (_, i) => dayKey(Date.now() - (days - 1 - i) * DAY));
  const map = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const o of orders) if (map[dayKey(o.createdAt)] !== undefined) map[dayKey(o.createdAt)] += value(o);
  return keys.map((day) => ({ day, value: map[day], today: day === today }));
}

function hbars(rows) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return rows.length
    ? `<div class="hbar">${rows
        .map((r) => `<div><div>${esc(r.label)}</div><div class="track"><div class="fill" style="width:${(r.value / max) * 100}%"></div></div></div><div class="num">${r.text}</div>`)
        .join("")}</div>`
    : '<p class="empty">Hali ma\'lumot yo\'q</p>';
}

// ---------- drawer ----------
function openDrawer(title, render) {
  $("#drawerTitle").textContent = title;
  $("#drawer").hidden = false;
  $("#veil").hidden = false;
  render($("#drawerBody"));
}

function closeDrawer() {
  $("#drawer").hidden = true;
  $("#veil").hidden = true;
  $("#drawerBody").innerHTML = "";
}

$("#drawerClose").onclick = closeDrawer;
$("#veil").onclick = closeDrawer;
document.addEventListener("keydown", (e) => e.key === "Escape" && closeDrawer());

// ---------- views ----------
const views = {};

views.dashboard = async (page, tools) => {
  tools.innerHTML = periodSeg();
  bindPeriod(render);
  const orders = await ordersFor(state.period);
  const sales = orders.filter(isSale);
  const revenue = sales.reduce((n, o) => n + o.total, 0);
  const cancelled = orders.filter((o) => o.status === "cancelled" && o.stage !== null);
  const active = (await ordersFor(30)).filter((o) => orderGroup(o) === "active" && o.stage !== null);
  const low = goods().filter((p) => p.stock <= 3).sort((a, b) => a.stock - b.stock);
  const asks = active.filter((o) => o.cancelRequest);
  const refunds = (await ordersFor(90)).filter((o) => o.refund?.status === "pending");
  const noSlot = active.filter((o) => o.stage === "ready" && o.orderType === "delivery" && !o.deliveryLabel);
  const top = topProducts(sales).slice(0, 5);
  const pipeline = ["new", "picking", "ready", "shipped"].map((s) => [s, active.filter((o) => o.stage === s).length]);
  page.innerHTML = `
    <div class="grid cols-4">
      <div class="card kpi"><small>Tushum · ${state.period} kun</small><b>${sum(revenue)} so'm</b><span>yetkazish bilan</span></div>
      <div class="card kpi"><small>Buyurtmalar</small><b>${sales.length}</b><span>bekor qilinganlarsiz</span></div>
      <div class="card kpi"><small>O'rtacha chek</small><b>${sum(sales.length ? revenue / sales.length : 0)} so'm</b><span>&nbsp;</span></div>
      <div class="card kpi"><small>Bekor qilingan</small><b>${cancelled.length}</b><span>${orders.length ? Math.round((cancelled.length / Math.max(1, sales.length + cancelled.length)) * 100) : 0}% buyurtmalardan</span></div>
    </div>
    <div class="grid cols-3" style="margin-top:16px">
      <div class="card span-2"><h3>Kunlik tushum</h3>${barChart(dailyPoints(sales, state.period > 30 ? 30 : state.period, (o) => o.total))}</div>
      <div class="card"><h3>Hozir jarayonda</h3><ul class="list">${pipeline.map(([s, n]) => `<li><span>${pill(STAGE[s])}</span><b>${n}</b></li>`).join("")}</ul></div>
    </div>
    <div class="grid cols-3" style="margin-top:16px">
      <div class="card"><h3>E'tibor talab qiladi</h3><ul class="list">
        <li><span>🙋 Bekor qilish so'rovlari</span><a href="#orders">${asks.length}</a></li>
        <li><span>💳 Pul qaytarish kutilmoqda</span><a href="#accounting">${refunds.length}</a></li>
        <li><span>⏳ Tayyor, vaqt tanlanmagan</span><a href="#orders">${noSlot.length}</a></li>
        <li><span>📦 Kam qolgan mahsulotlar (≤ 3)</span><a href="#stock">${low.length}</a></li>
      </ul></div>
      <div class="card"><h3>Eng ko'p sotilgan · ${state.period} kun</h3>${hbars(top.map((t) => ({ label: `${t.name} × ${t.qty}`, value: t.revenue, text: `${sum(t.revenue)}` })))}</div>
      <div class="card"><h3>Tugayotgan qoldiq</h3><ul class="list">${
        low.slice(0, 8).map((p) => `<li><span>${esc(p.name)}</span>${pill([`${p.stock} ta`, p.stock <= 0 ? "bad" : "warn"])}</li>`).join("") || '<li class="muted">Hammasi yetarli</li>'
      }</ul></div>
    </div>`;
};

function topProducts(sales) {
  const map = new Map();
  for (const o of sales) {
    for (const l of o.lines) {
      const m = map.get(l.id) || { name: l.name, qty: 0, revenue: 0 };
      m.qty += l.qty;
      m.revenue += l.qty * l.price;
      map.set(l.id, m);
    }
  }
  return [...map.values()].sort((a, b) => b.revenue - a.revenue);
}

views.orders = async (page, tools) => {
  let filter = "active";
  let query = "";
  tools.innerHTML = `${periodSeg()} <button class="btn btn--ghost" id="ordersCsv" type="button">⬇️ Excel (CSV)</button>`;
  bindPeriod(render);
  const orders = await ordersFor(state.period);
  const shown = () =>
    orders
      .filter((o) => filter === "all" || orderGroup(o) === filter)
      .filter((o) => !query || `${o.number} ${o.name} ${o.phone}`.toLowerCase().includes(query.toLowerCase()));
  const draw = () => {
    const list = shown();
    $("#orderRows").innerHTML = list.length
      ? list
          .map(
            (o) => `<tr class="click" data-order="${o.id}">
              <td><b>${no(o)}</b></td><td>${when(o.createdAt)}</td>
              <td>${esc(o.name)}<br><span class="muted">${esc(o.phone)}</span></td>
              <td>${esc(o.lines.map((l) => `${l.name} × ${l.qty}`).join(", "))}</td>
              <td class="num">${sum(o.total)}</td>
              <td>${o.payment === "card" ? "💳 Karta" : "💵 Naqd"}</td>
              <td>${pill(orderState(o))}${o.cancelRequest ? " " + pill(["🙋 so'rov", "warn"]) : ""}${o.refund?.status === "pending" ? " " + pill(["💳 qaytarish", "warn"]) : ""}</td>
            </tr>`,
          )
          .join("")
      : '<tr><td colspan="7" class="empty">Buyurtma topilmadi</td></tr>';
    page.querySelectorAll("[data-filter]").forEach((b) => b.classList.toggle("on", b.dataset.filter === filter));
  };
  page.innerHTML = `
    <div class="stack" style="margin-bottom:12px">
      <div class="seg">${[
        ["active", "Faol"],
        ["done", "Yakunlangan"],
        ["cancelled", "Bekor"],
        ["all", "Hammasi"],
      ]
        .map(([k, l]) => `<button type="button" data-filter="${k}">${l}</button>`)
        .join("")}</div>
      <input type="search" id="orderSearch" placeholder="Raqam, ism yoki telefon" style="min-width:260px" />
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>№</th><th>Sana</th><th>Mijoz</th><th>Mahsulotlar</th><th class="num">Summa</th><th>To'lov</th><th>Holat</th></tr></thead>
      <tbody id="orderRows"></tbody>
    </table></div>`;
  draw();
  $("#orderSearch").oninput = (e) => {
    query = e.target.value;
    draw();
  };
  page.onclick = (e) => {
    const f = e.target.closest("[data-filter]");
    if (f) {
      filter = f.dataset.filter;
      draw();
    }
    const row = e.target.closest("[data-order]");
    if (row) openOrder(row.dataset.order);
  };
  $("#ordersCsv").onclick = () =>
    download(`buyurtmalar-${dayKey(Date.now())}.csv`, [
      ["Raqam", "Sana", "Mijoz", "Telefon", "Mahsulotlar", "Mahsulot summasi", "Yetkazish", "Jami", "To'lov", "Holat", "Bekor sababi"],
      ...shown().map((o) => [no(o), when(o.createdAt), o.name, o.phone, o.lines.map((l) => `${l.name} × ${l.qty}`).join(", "), o.goodsTotal, o.deliveryTotal, o.total, o.payment === "card" ? "Karta" : "Naqd", orderState(o)[0], o.cancelReason || ""]),
    ]);
};

function openOrder(id) {
  openDrawer("Buyurtma", async (body) => {
    body.innerHTML = '<p class="empty">Yuklanmoqda…</p>';
    const o = await api(`/api/orders/${id}`);
    $("#drawerTitle").textContent = `${no(o)} · ${orderState(o)[0]}`;
    const d = o.delivery;
    body.innerHTML = `
      <ul class="list">${o.lines.map((l) => `<li><span>${esc(l.name)}${l.kind === "kit" ? ' <span class="pill">komplekt</span>' : ""} × ${l.qty}</span><b>${sum(l.price * l.qty)}</b></li>`).join("")}</ul>
      <dl class="specs" style="margin-top:14px">
        <dt>Mahsulotlar</dt><dd>${sum(o.goodsTotal)} so'm</dd>
        ${d ? `<dt>Yetkazish</dt><dd>${sum(d.total)} so'm${d.km === null ? "" : ` · ${d.km} km`} · ${d.floor}-qavat${d.lift ? ", lift" : ""}</dd>` : ""}
        <dt>Jami</dt><dd><b>${sum(o.total)} so'm</b> · ${o.payment === "card" ? "💳 Karta" : "💵 Naqd"}</dd>
        <dt>Mijoz</dt><dd>${esc(o.name)}, ${esc(o.phone)}</dd>
        <dt>Turi</dt><dd>${o.orderType === "pickup" ? "Olib ketish" : "Yetkazib berish"}</dd>
        ${o.address ? `<dt>Manzil</dt><dd>${esc(o.address)}${o.location ? ` · <a target="_blank" rel="noopener" href="https://maps.google.com/?q=${o.location.lat},${o.location.lon}">xarita</a>` : ""}</dd>` : ""}
        ${o.deliveryLabel ? `<dt>Vaqt</dt><dd>🗓 ${esc(o.deliveryLabel)}</dd>` : ""}
        ${o.comment ? `<dt>Izoh</dt><dd>${esc(o.comment)}</dd>` : ""}
        ${o.refund ? `<dt>Qaytarish</dt><dd>💳 ${sum(o.refund.amount)} so'm · ${o.refund.status === "done" ? "qaytarildi" : "kutilmoqda"}</dd>` : ""}
      </dl>
      ${o.cancelRequest ? `<p class="note">🙋 Mijoz bekor qilishni so'ragan: ${esc(o.cancelRequest.reason)}</p>` : ""}
      <h3 style="margin:16px 0 10px">Ombor terish ro'yxati</h3>
      <ul class="list">${o.picked.map((p) => `<li><span>${esc(p.name)} <span class="muted">SKU ${p.sku ?? "—"}</span></span><span>${p.qty} × ${p.boxes} quti</span></li>`).join("")}</ul>
      <h3 style="margin:16px 0 10px">Tarix</h3>
      <ul class="timeline">${o.timeline.map((t) => `<li><small>${when(t.at)}</small><span>${esc(t.text)}</span></li>`).join("")}</ul>
      <div class="stack" id="orderActs" style="margin-top:18px"></div>`;
    const acts = $("#orderActs", body);
    const can = ["new", "picking", "ready"].includes(o.stage);
    acts.innerHTML = [
      o.cancelRequest ? '<button class="btn btn--danger" data-act="approve">✅ Bekor qilishni tasdiqlash</button><button class="btn btn--ghost" data-act="reject">↩️ So\'rovni rad etish</button>' : "",
      can && !o.cancelRequest ? '<input class="input" id="cancelReason" placeholder="Bekor qilish sababi" style="flex:1;min-width:200px"/><button class="btn btn--ghost" data-act="cancel">❌ Bekor qilish</button>' : "",
      o.refund?.status === "pending" ? '<button class="btn" data-act="refunded">💳 Pul qaytarildi</button>' : "",
    ].join("");
    acts.onclick = async (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (!act) return;
      const call = {
        approve: () => api(`/api/orders/${id}/admin-cancel`, { method: "POST", body: { reason: o.cancelRequest.reason } }),
        reject: () => api(`/api/orders/${id}/reject-cancel`, { method: "POST" }),
        cancel: () => api(`/api/orders/${id}/admin-cancel`, { method: "POST", body: { reason: $("#cancelReason", body).value } }),
        refunded: () => api(`/api/orders/${id}/refunded`, { method: "POST" }),
      }[act];
      try {
        await call();
        toast("Saqlandi");
        dropOrders();
        await refreshProducts();
        openOrder(id);
        render();
      } catch (err) {
        toast(err.message);
      }
    };
  });
}

views.products = async (page, tools) => {
  let query = "";
  let kind = "all";
  tools.innerHTML = `<button class="btn" type="button" data-new="item">＋ Mahsulot / modul</button><button class="btn btn--dark" type="button" data-new="kit">＋ Komplekt</button>`;
  tools.onclick = (e) => {
    const n = e.target.closest("[data-new]");
    if (n) productForm(null, n.dataset.new);
  };
  const statusPill = (p) => (p.draft ? pill(["Qoralama", "warn"]) : p.listed ? pill(["Saytda", "ok"]) : pill(["Saytda yo'q", ""]));
  const draw = () => {
    const q = query.toLowerCase();
    const list = state.products
      .filter((p) => kind === "all" || (kind === "kit" ? isKit(p) : !isKit(p)))
      .filter((p) => !q || `${p.name} ${p.sku ?? ""}`.toLowerCase().includes(q));
    $("#productRows").innerHTML = list.length
      ? list
          .map(
            (p) => `<tr class="click" data-edit="${p.id}">
              <td><img class="thumb" src="${esc(p.images?.[0] || `/img/${p.category}.svg`)}" alt=""/></td>
              <td>${isKit(p) ? '<span class="muted">—</span>' : p.sku ?? "—"}</td>
              <td><b>${esc(p.name)}</b>${isKit(p) ? `<br><span class="muted">${p.parts.length} xil modul</span>` : ""}</td>
              <td>${esc(catName(p.category))}</td>
              <td>${isKit(p) ? pill(["Komplekt", "teal"]) : "Modul / mahsulot"}</td>
              <td class="num">${p.boxes ?? "—"}</td>
              <td class="num">${sum(p.price)}</td>
              <td class="num">${pill([`${p.stock} ta`, p.stock <= 0 ? "bad" : p.stock <= 3 ? "warn" : "ok"])}</td>
              <td>${statusPill(p)}</td>
            </tr>`,
          )
          .join("")
      : '<tr><td colspan="9" class="empty">Mahsulot topilmadi</td></tr>';
    page.querySelectorAll("[data-kind]").forEach((b) => b.classList.toggle("on", b.dataset.kind === kind));
  };
  page.innerHTML = `
    <div class="stack" style="margin-bottom:12px">
      <div class="seg">${[
        ["all", "Hammasi"],
        ["item", "Modul / mahsulot"],
        ["kit", "Komplektlar"],
      ]
        .map(([k, l]) => `<button type="button" data-kind="${k}">${l}</button>`)
        .join("")}</div>
      <input type="search" id="productSearch" placeholder="Nomi yoki SKU" style="min-width:240px" />
      <span class="muted">Jami ${state.products.length} ta</span>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th></th><th>SKU</th><th>Nomi</th><th>Bo'lim</th><th>Turi</th><th class="num">Quti</th><th class="num">Narx</th><th class="num">Qoldiq</th><th>Holat</th></tr></thead>
      <tbody id="productRows"></tbody>
    </table></div>`;
  draw();
  $("#productSearch").oninput = (e) => {
    query = e.target.value;
    draw();
  };
  page.onclick = (e) => {
    const k = e.target.closest("[data-kind]");
    if (k) {
      kind = k.dataset.kind;
      draw();
    }
    const row = e.target.closest("[data-edit]");
    if (row) productForm(row.dataset.edit);
  };
};

function resizeImage(file, max = 1200) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = Object.assign(document.createElement("canvas"), { width: Math.round(img.width * scale), height: Math.round(img.height * scale) });
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => reject(new Error("Rasmni o'qib bo'lmadi"));
    img.src = URL.createObjectURL(file);
  });
}

function productForm(id, newKind = "item") {
  const p = id ? byId(id) : null;
  const kit = p ? isKit(p) : newKind === "kit";
  const images = [...(p?.images || [])].filter((src) => !src.startsWith("/img/"));
  const parts = (p?.components || []).map((c) => ({ ...c }));
  const title = p ? `${kit ? "Komplekt" : "Mahsulot"}: ${p.name}` : kit ? "Yangi komplekt" : "Yangi mahsulot / modul";
  openDrawer(title, (body) => {
    body.innerHTML = `<form id="pForm">
      <div class="field">Rasmlar</div>
      <div class="thumbs" id="thumbs"></div>
      <input type="file" id="fileInput" accept="image/*" multiple hidden />
      <label class="field">Nomi<input class="input" name="name" required value="${esc(p?.name)}" /></label>
      <div class="row2">
        <label class="field">Bo'lim<select name="category">${state.info.categories.map((c) => `<option value="${c.id}" ${p?.category === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></label>
        <label class="field">Narx (so'm)<input class="input" name="price" type="number" min="0" value="${p?.price || ""}" /></label>
      </div>
      <div class="row2">
        <label class="field">Eski narx<input class="input" name="oldPrice" type="number" min="0" value="${p?.oldPrice ?? ""}" placeholder="ixtiyoriy" /></label>
        <label class="field">O'lcham<input class="input" name="size" value="${esc(p?.size)}" placeholder="2400 × 600 × 2100 mm" /></label>
      </div>
      <label class="field">Material<input class="input" name="material" value="${esc(p?.material)}" /></label>
      ${
        kit
          ? `<div class="field">Komplekt tarkibi</div><ul class="list" id="parts"></ul>
             <div class="row2" style="margin-top:8px"><label class="field">Modulni qidiring<input class="input" id="partSearch" type="search" placeholder="Nomi yoki SKU" autocomplete="off" /></label>
             <label class="field">Soni<input class="input" id="partQty" type="number" min="1" max="50" value="1" /></label></div>
             <ul class="list" id="partResults"></ul>
             <div class="row2"><label class="field">Modul yetishmasa<select name="whenShort"><option value="preorder">"Buyurtma asosida" ko'rsatish</option><option value="hide" ${p?.whenShort === "hide" ? "selected" : ""}>Katalogdan yashirish</option></select></label>
             <label class="field">Tayyorlash muddati (kun)<input class="input" name="leadDays" type="number" min="1" max="120" value="${p?.leadDays ?? 10}" /></label></div>`
          : `<div class="row2"><label class="field">Qutilar soni<input class="input" name="boxes" type="number" min="1" max="20" value="${p?.boxes ?? 1}" /></label>
             ${p ? `<div class="field">Omborda<b style="color:var(--ink);font-size:16px">${p.stock} ta</b></div>` : `<label class="field">Boshlang'ich qoldiq<input class="input" name="stock" type="number" min="0" value="0" /></label>`}</div>
             <label class="check"><input type="checkbox" name="standalone" ${p?.standalone === false ? "" : "checked"} /> Katalogda alohida sotiladi</label>`
      }
      <label class="field">Tavsif<textarea name="description" rows="4">${esc(p?.description)}</textarea></label>
      <label class="check"><input type="checkbox" name="isNew" ${p?.isNew ? "checked" : ""} /> "Yangi" belgisi</label>
      <label class="check"><input type="checkbox" name="published" ${p?.draft ? "" : "checked"} /> Saytda ko'rsatish</label>
      <div class="stack"><button class="btn" type="submit">Saqlash</button>${p ? '<button class="btn btn--danger" type="button" data-del>O\'chirish</button>' : ""}</div>
    </form>`;
    const drawThumbs = () => {
      $("#thumbs", body).innerHTML = images.map((src, i) => `<figure><img src="${esc(src)}" alt=""/><button type="button" data-rm="${i}">✕</button></figure>`).join("") + '<button type="button" class="thumb-add" data-pick>＋</button>';
    };
    const drawParts = () => {
      const box = $("#parts", body);
      if (!box) return;
      box.innerHTML =
        parts.map((c, i) => `<li><span>${esc(byId(c.id)?.name ?? "O'chirilgan modul")} × ${c.qty}</span><button type="button" class="btn btn--ghost" data-part-rm="${i}">✕</button></li>`).join("") ||
        '<li class="muted">Hali modul qo\'shilmagan</li>';
    };
    const drawResults = () => {
      const q = $("#partSearch", body).value.trim().toLowerCase();
      const found = q ? goods().filter((m) => `${m.name} ${m.sku ?? ""}`.toLowerCase().includes(q)).slice(0, 6) : [];
      $("#partResults", body).innerHTML = found.map((m) => `<li><span>${esc(m.name)} <span class="muted">SKU ${m.sku ?? "—"} · ${m.boxes ?? 1} quti · ${m.stock} ta</span></span><button type="button" class="btn btn--ghost" data-part-add="${m.id}">＋</button></li>`).join("");
    };
    drawThumbs();
    drawParts();
    if (kit) $("#partSearch", body).oninput = drawResults;
    const fileInput = $("#fileInput", body);
    fileInput.onchange = async () => {
      for (const file of fileInput.files) {
        try {
          toast("Rasm yuklanmoqda…");
          images.push((await api("/api/upload", { method: "POST", body: { dataUrl: await resizeImage(file) } })).url);
          drawThumbs();
        } catch (err) {
          toast(err.message);
        }
      }
      fileInput.value = "";
    };
    body.onclick = async (e) => {
      if (e.target.closest("[data-pick]")) fileInput.click();
      const rm = e.target.closest("[data-rm]");
      if (rm) {
        images.splice(Number(rm.dataset.rm), 1);
        drawThumbs();
      }
      const add = e.target.closest("[data-part-add]");
      if (add) {
        const qty = Math.max(1, Math.min(50, Number($("#partQty", body).value) || 1));
        const same = parts.find((c) => c.id === add.dataset.partAdd);
        same ? (same.qty += qty) : parts.push({ id: add.dataset.partAdd, qty });
        $("#partSearch", body).value = "";
        drawResults();
        drawParts();
      }
      const prm = e.target.closest("[data-part-rm]");
      if (prm) {
        parts.splice(Number(prm.dataset.partRm), 1);
        drawParts();
      }
      if (e.target.closest("[data-del]")) {
        if (!window.confirm(`"${p.name}" o'chirilsinmi?`)) return;
        try {
          await api(`/api/products/${p.id}`, { method: "DELETE" });
          await refreshProducts();
          toast("O'chirildi");
          closeDrawer();
          render();
        } catch (err) {
          toast(err.message);
        }
      }
    };
    $("#pForm", body).onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const common = {
        name: f.get("name"),
        category: f.get("category"),
        price: Number(f.get("price")),
        oldPrice: f.get("oldPrice") ? Number(f.get("oldPrice")) : null,
        size: f.get("size"),
        material: f.get("material"),
        description: f.get("description"),
        isNew: f.has("isNew"),
        draft: !f.has("published"),
        images,
      };
      const payload = kit
        ? { ...common, kind: "kit", components: parts, whenShort: f.get("whenShort"), leadDays: Number(f.get("leadDays")) }
        : { ...common, kind: "item", boxes: Number(f.get("boxes")), standalone: f.has("standalone"), stock: Number(f.get("stock") || 0) };
      try {
        await api(p ? `/api/products/${p.id}` : "/api/products", { method: p ? "PUT" : "POST", body: payload });
        await refreshProducts();
        toast("Saqlandi");
        closeDrawer();
        render();
      } catch (err) {
        toast(err.message);
      }
    };
  });
}

const MOVE_LABEL = { in: ["Kirim", "ok"], out: ["Chiqim", "bad"], sale: ["Sotuv", "teal"], release: ["Qaytdi", ""] };

views.stock = async (page, tools) => {
  let filter = "all";
  tools.innerHTML = '<button class="btn btn--ghost" type="button" id="stockCsv">⬇️ Qoldiq (CSV)</button>';
  const list = goods().sort((a, b) => a.stock - b.stock);
  const total = list.reduce((n, p) => n + p.stock, 0);
  const worth = list.reduce((n, p) => n + p.stock * (p.price || 0), 0);
  const draw = () => {
    const rows = list.filter((p) => (filter === "low" ? p.stock > 0 && p.stock <= 3 : filter === "zero" ? p.stock <= 0 : true));
    $("#stockRows").innerHTML =
      rows
        .map(
          (p) => `<tr class="click" data-move="${p.id}"><td>${p.sku ?? "—"}</td><td><b>${esc(p.name)}</b>${p.standalone === false ? ' <span class="pill">modul</span>' : ""}</td>
            <td class="num">${p.boxes ?? 1}</td><td class="num">${pill([`${p.stock} ta`, p.stock <= 0 ? "bad" : p.stock <= 3 ? "warn" : "ok"])}</td><td class="num">${sum(p.stock * (p.price || 0))}</td></tr>`,
        )
        .join("") || '<tr><td colspan="5" class="empty">Bo\'sh</td></tr>';
    page.querySelectorAll("[data-sf]").forEach((b) => b.classList.toggle("on", b.dataset.sf === filter));
  };
  page.innerHTML = `
    <div class="grid cols-4">
      <div class="card kpi"><small>Jami dona</small><b>${total}</b><span>${list.length} xil mahsulot / modul</span></div>
      <div class="card kpi"><small>Qoldiq qiymati</small><b>${sum(worth)} so'm</b><span>sotuv narxida</span></div>
      <div class="card kpi"><small>Kam qolgan (1–3)</small><b>${list.filter((p) => p.stock > 0 && p.stock <= 3).length}</b><span>&nbsp;</span></div>
      <div class="card kpi"><small>Tugagan</small><b>${list.filter((p) => p.stock <= 0).length}</b><span>&nbsp;</span></div>
    </div>
    <div class="grid cols-3" style="margin-top:16px">
      <div class="span-2">
        <div class="stack" style="margin-bottom:12px"><div class="seg">${[
          ["all", "Hammasi"],
          ["low", "Kam qolgan"],
          ["zero", "Tugagan"],
        ]
          .map(([k, l]) => `<button type="button" data-sf="${k}">${l}</button>`)
          .join("")}</div><span class="muted">Qatorni bosing: kirim / chiqim va tarix</span></div>
        <div class="table-wrap"><table><thead><tr><th>SKU</th><th>Nomi</th><th class="num">Quti</th><th class="num">Qoldiq</th><th class="num">Qiymati</th></tr></thead><tbody id="stockRows"></tbody></table></div>
      </div>
      <div class="card"><h3>Oxirgi harakatlar</h3><ul class="list" id="moves"><li class="muted">Yuklanmoqda…</li></ul></div>
    </div>`;
  draw();
  api("/api/stock").then((moves) => {
    $("#moves").innerHTML =
      moves
        .slice(0, 25)
        .map((m) => `<li><span>${pill(MOVE_LABEL[m.type] || [m.type, ""])} ${esc(m.productName)}<br><span class="muted">${when(m.at)} · ${esc(m.by)}${m.note ? ` · ${esc(m.note)}` : ""}</span></span><b>${m.type === "in" || m.type === "release" ? "+" : "−"}${m.qty}</b></li>`)
        .join("") || '<li class="muted">Hali harakat yo\'q</li>';
  });
  page.onclick = (e) => {
    const sf = e.target.closest("[data-sf]");
    if (sf) {
      filter = sf.dataset.sf;
      draw();
    }
    const row = e.target.closest("[data-move]");
    if (row) stockForm(row.dataset.move);
  };
  $("#stockCsv").onclick = () => download(`qoldiq-${dayKey(Date.now())}.csv`, [["SKU", "Nomi", "Qutilar", "Qoldiq", "Narx", "Qiymati"], ...list.map((p) => [p.sku, p.name, p.boxes ?? 1, p.stock, p.price, p.stock * (p.price || 0)])]);
};

function stockForm(id) {
  const p = byId(id);
  openDrawer(`Ombor: ${p.name}`, (body) => {
    body.innerHTML = `<p class="note">Omborda <b>${p.stock} ta</b>. Kundalik kirim va chiqim ombor ekranida skaner bilan qilinadi; bu yerda faqat tuzatish uchun.</p>
      <form id="mForm" style="margin-top:14px">
        <div class="row2">
          <label class="field">Amal<select name="type"><option value="in">Kirim</option><option value="out">Chiqim</option></select></label>
          <label class="field">Miqdor<input class="input" name="qty" type="number" min="1" required /></label>
        </div>
        <label class="field">Sabab<input class="input" name="note" placeholder="Inventarizatsiya, brak, qaytarish…" required /></label>
        <button class="btn" type="submit">Saqlash</button>
      </form>
      <h3 style="margin:18px 0 10px">Tarix</h3><ul class="list" id="pMoves"><li class="muted">Yuklanmoqda…</li></ul>`;
    api(`/api/stock?productId=${encodeURIComponent(id)}`).then((moves) => {
      $("#pMoves", body).innerHTML =
        moves.map((m) => `<li><span>${pill(MOVE_LABEL[m.type] || [m.type, ""])} ${when(m.at)}<br><span class="muted">${esc(m.by)}${m.note ? ` · ${esc(m.note)}` : ""}</span></span><b>${m.type === "in" || m.type === "release" ? "+" : "−"}${m.qty} → ${m.balance}</b></li>`).join("") ||
        '<li class="muted">Hali harakat yo\'q</li>';
    });
    $("#mForm", body).onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        await api("/api/stock", { method: "POST", body: { productId: id, type: f.get("type"), qty: Number(f.get("qty")), note: f.get("note") } });
        await refreshProducts();
        toast("Saqlandi");
        stockForm(id);
        render();
      } catch (err) {
        toast(err.message);
      }
    };
  });
}

views.finance = async (page, tools) => {
  tools.innerHTML = `${periodSeg()} <button class="btn btn--ghost" type="button" id="finCsv">⬇️ Kunlik hisobot (CSV)</button>`;
  bindPeriod(render);
  const orders = await ordersFor(state.period);
  const sales = orders.filter(isSale);
  const goodsSum = sales.reduce((n, o) => n + o.goodsTotal, 0);
  const delivery = sales.reduce((n, o) => n + o.deliveryTotal, 0);
  const card = sales.filter((o) => o.payment === "card").reduce((n, o) => n + o.total, 0);
  const cashDone = sales.filter((o) => o.payment === "cash" && o.stage === "delivered").reduce((n, o) => n + o.total, 0);
  const cashWait = sales.filter((o) => o.payment === "cash" && o.stage !== "delivered").reduce((n, o) => n + o.total, 0);
  const cancelledSum = orders.filter((o) => o.status === "cancelled" && o.stage !== null).reduce((n, o) => n + o.total, 0);
  const refundsWait = orders.filter((o) => o.refund?.status === "pending").reduce((n, o) => n + o.refund.amount, 0);
  const days = Array.from({ length: state.period }, (_, i) => dayKey(Date.now() - i * DAY));
  const daily = days.map((day) => {
    const list = sales.filter((o) => dayKey(o.createdAt) === day);
    return {
      day,
      count: list.length,
      goods: list.reduce((n, o) => n + o.goodsTotal, 0),
      delivery: list.reduce((n, o) => n + o.deliveryTotal, 0),
      card: list.filter((o) => o.payment === "card").reduce((n, o) => n + o.total, 0),
      cash: list.filter((o) => o.payment === "cash").reduce((n, o) => n + o.total, 0),
    };
  });
  page.innerHTML = `
    <div class="grid cols-4">
      <div class="card kpi"><small>Tushum jami</small><b>${sum(goodsSum + delivery)} so'm</b><span>mahsulot ${sum(goodsSum)} · yetkazish ${sum(delivery)}</span></div>
      <div class="card kpi"><small>💳 Karta (to'langan)</small><b>${sum(card)} so'm</b><span>Click / Payme</span></div>
      <div class="card kpi"><small>💵 Naqd</small><b>${sum(cashDone)} so'm</b><span>olingan · kutilmoqda ${sum(cashWait)}</span></div>
      <div class="card kpi"><small>Bekor / qaytarish</small><b>${sum(cancelledSum)} so'm</b><span>qaytarish kutilmoqda ${sum(refundsWait)}</span></div>
    </div>
    <div class="card" style="margin-top:16px"><h3>Kunlik tushum</h3>${barChart(dailyPoints(sales, Math.min(state.period, 30), (o) => o.total))}</div>
    <div class="table-wrap" style="margin-top:16px"><table>
      <thead><tr><th>Sana</th><th class="num">Buyurtma</th><th class="num">Mahsulot</th><th class="num">Yetkazish</th><th class="num">Karta</th><th class="num">Naqd</th><th class="num">Jami</th></tr></thead>
      <tbody>${daily
        .filter((d) => d.count)
        .map((d) => `<tr><td>${d.day}</td><td class="num">${d.count}</td><td class="num">${sum(d.goods)}</td><td class="num">${sum(d.delivery)}</td><td class="num">${sum(d.card)}</td><td class="num">${sum(d.cash)}</td><td class="num"><b>${sum(d.goods + d.delivery)}</b></td></tr>`)
        .join("") || '<tr><td colspan="7" class="empty">Bu davrda sotuv yo\'q</td></tr>'}</tbody>
    </table></div>
    <p class="muted" style="margin-top:10px">Xarajatlar (zakup, maosh, ijara) va foyda hisobi moliya modulining keyingi bosqichida qo'shiladi.</p>`;
  $("#finCsv").onclick = () => download(`moliya-${dayKey(Date.now())}.csv`, [["Sana", "Buyurtmalar", "Mahsulot", "Yetkazish", "Karta", "Naqd", "Jami"], ...daily.map((d) => [d.day, d.count, d.goods, d.delivery, d.card, d.cash, d.goods + d.delivery])]);
};

views.accounting = async (page, tools) => {
  tools.innerHTML = `${periodSeg()} <button class="btn btn--ghost" type="button" id="accCsv">⬇️ 1C uchun (CSV)</button>`;
  bindPeriod(render);
  const orders = await ordersFor(state.period);
  // Money events, one row each: card payments, cash collected at delivery, refunds.
  const rows = [];
  for (const o of orders) {
    if (o.payment === "card" && o.paidAt) rows.push({ at: o.paidAt, o, type: "Karta to'lovi", amount: o.total });
    if (o.payment === "cash" && o.stage === "delivered") rows.push({ at: o.deliveredAt || o.createdAt, o, type: "Naqd (yetkazildi)", amount: o.total });
    if (o.refund) rows.push({ at: o.cancelledAt || o.createdAt, o, type: o.refund.status === "done" ? "Qaytarildi" : "Qaytarish kutilmoqda", amount: -o.refund.amount });
  }
  rows.sort((a, b) => b.at - a.at);
  const pending = orders.filter((o) => o.refund?.status === "pending");
  page.innerHTML = `
    ${pending.length ? `<div class="card" style="margin-bottom:16px"><h3>💳 Qaytarilishi kerak (${pending.length})</h3><ul class="list">${pending.map((o) => `<li><span>${no(o)} · ${esc(o.name)} · ${when(o.cancelledAt)}</span><span><b>${sum(o.refund.amount)} so'm</b> <button class="btn" data-refund="${o.id}">Qaytarildi</button></span></li>`).join("")}</ul></div>` : ""}
    <div class="table-wrap"><table>
      <thead><tr><th>Sana</th><th>Hujjat</th><th>Kontragent</th><th>Turi</th><th class="num">Summa</th></tr></thead>
      <tbody>${rows.map((r) => `<tr class="click" data-order="${r.o.id}"><td>${when(r.at)}</td><td>Buyurtma ${no(r.o)}</td><td>${esc(r.o.name)}</td><td>${esc(r.type)}</td><td class="num" style="color:${r.amount < 0 ? "var(--bad)" : "inherit"}">${r.amount < 0 ? "−" : ""}${sum(Math.abs(r.amount))}</td></tr>`).join("") || '<tr><td colspan="5" class="empty">Bu davrda pul harakati yo\'q</td></tr>'}</tbody>
    </table></div>
    <p class="muted" style="margin-top:10px">Fiskal cheklar (MXIK) va 1C bilan to'g'ridan-to'g'ri almashuv to'lov provayderi shartnomasidan keyin ulanadi.</p>`;
  page.onclick = async (e) => {
    const r = e.target.closest("[data-refund]");
    if (r) {
      e.stopPropagation();
      try {
        await api(`/api/orders/${r.dataset.refund}/refunded`, { method: "POST" });
        toast("Belgilandi, mijozga xabar ketdi");
        dropOrders();
        render();
      } catch (err) {
        toast(err.message);
      }
      return;
    }
    const row = e.target.closest("[data-order]");
    if (row) openOrder(row.dataset.order);
  };
  $("#accCsv").onclick = () => download(`buxgalteriya-${dayKey(Date.now())}.csv`, [["Sana", "Hujjat", "Kontragent", "Telefon", "Turi", "Summa"], ...rows.map((r) => [when(r.at), no(r.o), r.o.name, r.o.phone, r.type, r.amount])]);
};

// ---------- CRM: customers grouped by phone from their orders ----------
const normPhone = (p) => String(p || "").replace(/\D/g, "").slice(-9);
const SEGMENT = { vip: ["VIP", "ok"], repeat: ["Doimiy", "teal"], new: ["Yangi", ""], lost: ["Uzoq kelmagan", "warn"] };
const VIP_SPEND = 20_000_000;
const LOST_AFTER_DAYS = 90;

function customers(orders) {
  const map = new Map();
  for (const o of [...orders].sort((a, b) => a.createdAt - b.createdAt)) {
    const key = normPhone(o.phone);
    if (!key) continue;
    const c = map.get(key) || { key, name: o.name, phone: o.phone, orders: [], spent: 0, cancelled: 0, first: o.createdAt, last: o.createdAt };
    c.orders.push(o);
    c.name = o.name || c.name;
    c.last = o.createdAt;
    if (isSale(o)) c.spent += o.total;
    if (o.status === "cancelled" && o.stage !== null) c.cancelled++;
    map.set(key, c);
  }
  return [...map.values()].map((c) => {
    const bought = c.orders.filter(isSale).length;
    const segment = c.spent >= VIP_SPEND ? "vip" : Date.now() - c.last > LOST_AFTER_DAYS * DAY && bought ? "lost" : bought >= 2 ? "repeat" : "new";
    return { ...c, bought, segment };
  });
}

views.crm = async (page, tools) => {
  let query = "";
  let seg = "all";
  tools.innerHTML = '<button class="btn btn--ghost" type="button" id="crmCsv">⬇️ Mijozlar bazasi (CSV)</button>';
  const list = customers(await ordersFor(365)).sort((a, b) => b.spent - a.spent);
  const count = (k) => list.filter((c) => c.segment === k).length;
  const shown = () => list.filter((c) => (seg === "all" || c.segment === seg) && (!query || `${c.name} ${c.phone}`.toLowerCase().includes(query.toLowerCase())));
  const draw = () => {
    $("#crmRows").innerHTML =
      shown()
        .map((c) => `<tr class="click" data-cust="${c.key}"><td><b>${esc(c.name)}</b></td><td>${esc(c.phone)}</td><td>${pill(SEGMENT[c.segment])}</td><td class="num">${c.bought}</td><td class="num">${sum(c.spent)}</td><td class="num">${sum(c.bought ? c.spent / c.bought : 0)}</td><td>${when(c.last)}</td><td class="num">${c.cancelled || ""}</td></tr>`)
        .join("") || '<tr><td colspan="8" class="empty">Mijoz topilmadi</td></tr>';
    page.querySelectorAll("[data-seg]").forEach((b) => b.classList.toggle("on", b.dataset.seg === seg));
  };
  const total = list.reduce((n, c) => n + c.spent, 0);
  page.innerHTML = `
    <div class="grid cols-4">
      <div class="card kpi"><small>Mijozlar · 12 oy</small><b>${list.length}</b><span>telefon raqami bo'yicha</span></div>
      <div class="card kpi"><small>Takror xarid qilganlar</small><b>${list.filter((c) => c.bought >= 2).length}</b><span>${list.length ? Math.round((list.filter((c) => c.bought >= 2).length / list.length) * 100) : 0}% mijozlardan</span></div>
      <div class="card kpi"><small>Bir mijozdan o'rtacha</small><b>${sum(list.length ? total / list.length : 0)} so'm</b><span>&nbsp;</span></div>
      <div class="card kpi"><small>VIP (${sum(VIP_SPEND)}+)</small><b>${count("vip")}</b><span>uzoq kelmagan: ${count("lost")}</span></div>
    </div>
    <div class="stack" style="margin:16px 0 12px">
      <div class="seg">${[["all", "Hammasi"], ["vip", "VIP"], ["repeat", "Doimiy"], ["new", "Yangi"], ["lost", "Uzoq kelmagan"]].map(([k, l]) => `<button type="button" data-seg="${k}">${l}</button>`).join("")}</div>
      <input type="search" id="crmSearch" placeholder="Ism yoki telefon" style="min-width:240px" />
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Mijoz</th><th>Telefon</th><th>Segment</th><th class="num">Xaridlar</th><th class="num">Jami</th><th class="num">O'rtacha chek</th><th>Oxirgi buyurtma</th><th class="num">Bekor</th></tr></thead>
      <tbody id="crmRows"></tbody>
    </table></div>
    <p class="muted" style="margin-top:10px">Lidlar voronkasi (Instagram, Telegram, qo'ng'iroqlar), operator izohlari va eslatmalar call-markaz ulanganda shu bo'limga qo'shiladi.</p>`;
  draw();
  $("#crmSearch").oninput = (e) => {
    query = e.target.value;
    draw();
  };
  page.onclick = (e) => {
    const s = e.target.closest("[data-seg]");
    if (s) {
      seg = s.dataset.seg;
      draw();
    }
    const row = e.target.closest("[data-cust]");
    if (!row) return;
    const c = list.find((x) => x.key === row.dataset.cust);
    openDrawer(c.name || c.phone, (body) => {
      body.innerHTML = `<dl class="specs"><dt>Telefon</dt><dd>${esc(c.phone)}</dd><dt>Segment</dt><dd>${pill(SEGMENT[c.segment])}</dd>
        <dt>Birinchi buyurtma</dt><dd>${when(c.first)}</dd><dt>Xaridlar</dt><dd>${c.bought} ta · ${sum(c.spent)} so'm</dd><dt>Bekor qilgan</dt><dd>${c.cancelled} ta</dd></dl>
        <h3 style="margin-bottom:10px">Buyurtmalari</h3>
        <ul class="list">${[...c.orders].reverse().map((o) => `<li data-order="${o.id}" style="cursor:pointer"><span>${no(o)} · ${when(o.createdAt)}<br><span class="muted">${esc(o.lines.map((l) => `${l.name} × ${l.qty}`).join(", "))}</span></span><span>${sum(o.total)} ${pill(orderState(o))}</span></li>`).join("")}</ul>`;
      body.onclick = (ev) => {
        const li = ev.target.closest("[data-order]");
        if (li) openOrder(li.dataset.order);
      };
    });
  };
  $("#crmCsv").onclick = () => download(`mijozlar-${dayKey(Date.now())}.csv`, [["Ism", "Telefon", "Segment", "Xaridlar", "Jami", "Oxirgi buyurtma", "Bekor"], ...shown().map((c) => [c.name, c.phone, SEGMENT[c.segment][0], c.bought, c.spent, when(c.last), c.cancelled])]);
};

// ---------- logistics: what leaves the warehouse and when ----------
views.logistics = async (page, tools) => {
  const active = (await ordersFor(90)).filter((o) => o.orderType === "delivery" && ["picking", "ready", "shipped"].includes(o.stage) && o.status !== "cancelled");
  const slotDay = (o) => (o.deliverySlot ?? "").slice(0, 10);
  const days = [...new Set(active.map(slotDay).filter(Boolean))].sort();
  const waiting = active.filter((o) => o.stage === "ready" && !o.deliveryLabel);
  const card = (o) => `<li data-order="${o.id}" style="cursor:pointer"><span><b>${no(o)}</b> ${esc(o.name)} · ${esc(o.phone)}<br><span class="muted">${esc(o.lines.map((l) => `${l.name} × ${l.qty}`).join(", "))}</span></span><span>${pill(orderState(o))}</span></li>`;
  tools.innerHTML = "";
  page.innerHTML = `
    <div class="grid cols-4">
      <div class="card kpi"><small>Yetkazish kutilmoqda</small><b>${active.filter((o) => o.stage !== "shipped").length}</b><span>terilmoqda yoki tayyor</span></div>
      <div class="card kpi"><small>Vaqt tanlanmagan</small><b>${waiting.length}</b><span>mijozga eslatma boradi</span></div>
      <div class="card kpi"><small>Yo'lda</small><b>${active.filter((o) => o.stage === "shipped").length}</b><span>&nbsp;</span></div>
      <div class="card kpi"><small>Rejalashtirilgan kunlar</small><b>${days.length}</b><span>&nbsp;</span></div>
    </div>
    <div class="grid cols-2" style="margin-top:16px">
      ${days
        .map((d) => {
          const list = active.filter((o) => slotDay(o) === d);
          const windows = [...new Set(list.map((o) => o.deliveryLabel.split(", ").at(-1)))].sort();
          return `<div class="card"><h3>🗓 ${esc(list[0].deliveryLabel.split(", ").slice(0, 2).join(", "))} · ${list.length} ta</h3>${windows
            .map((w) => `<p class="muted" style="margin:8px 0 2px">${w}</p><ul class="list">${list.filter((o) => o.deliveryLabel.endsWith(w)).map(card).join("")}</ul>`)
            .join("")}</div>`;
        })
        .join("") || '<div class="card"><p class="empty">Rejalashtirilgan yetkazish yo\'q</p></div>'}
      <div class="card"><h3>⏳ Tayyor, vaqt tanlanmagan</h3><ul class="list">${waiting.map(card).join("") || '<li class="muted">Yo\'q</li>'}</ul></div>
    </div>
    <p class="muted" style="margin-top:10px">Mashinalar, haydovchilar, og'irlik bo'yicha biriktirish va xaritada marshrut logistika modulining keyingi bosqichida qo'shiladi (TZ: 3-bosqich).</p>`;
  page.onclick = (e) => {
    const li = e.target.closest("[data-order]");
    if (li) openOrder(li.dataset.order);
  };
};

const BANNER_STYLE = { photo: "Rasm", dark: "Qora", teal: "Moviy" };

views.marketing = async (page, tools) => {
  tools.innerHTML = `${periodSeg()} <button class="btn" type="button" id="newBanner">＋ Banner</button>`;
  bindPeriod(render);
  const [orders, banners] = await Promise.all([ordersFor(state.period), api("/api/banners?all=1")]);
  const sales = orders.filter(isSale);
  const byCat = new Map();
  for (const o of sales) for (const l of o.lines) byCat.set(byId(l.id)?.category ?? "—", (byCat.get(byId(l.id)?.category ?? "—") || 0) + l.qty * l.price);
  const reasons = new Map();
  for (const o of orders) if (o.cancelReason) reasons.set(o.cancelReason, (reasons.get(o.cancelReason) || 0) + 1);
  page.innerHTML = `
    <div class="grid cols-3">
      <div class="card"><h3>Bo'limlar bo'yicha sotuv</h3>${hbars([...byCat].sort((a, b) => b[1] - a[1]).map(([c, v]) => ({ label: catName(c), value: v, text: sum(v) })))}</div>
      <div class="card"><h3>Top mahsulotlar</h3>${hbars(topProducts(sales).slice(0, 8).map((t) => ({ label: `${t.name} × ${t.qty}`, value: t.revenue, text: sum(t.revenue) })))}</div>
      <div class="card"><h3>Bekor qilish sabablari</h3>${hbars([...reasons].sort((a, b) => b[1] - a[1]).map(([r, n]) => ({ label: r, value: n, text: `${n} ta` })))}</div>
    </div>
    <div class="card" style="margin-top:16px"><h3>Sotuv kanallari</h3><p class="muted">Hozir barcha buyurtmalar Telegram mini ilovadan keladi (${sales.length} ta). Sayt, mobil ilova, call-markaz va marketpleyslar ulanganda shu yerda kanal bo'yicha taqsimot chiqadi.</p></div>
    <h3 style="margin:22px 0 10px">Bannerlar va aksiyalar</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>Tartib</th><th>Sarlavha</th><th>Ko'rinish</th><th>Havola</th><th>Holat</th><th></th></tr></thead>
      <tbody>${banners.map((b) => `<tr><td>${b.order}</td><td><b>${esc(b.title || "(rasm)")}</b><br><span class="muted">${esc(b.text)}</span></td><td>${BANNER_STYLE[b.style]}</td><td>${b.linkType === "category" ? esc(catName(b.linkId)) : b.linkType === "product" ? esc(byId(b.linkId)?.name ?? "mahsulot") : "—"}</td><td>${b.active ? pill(["Faol", "ok"]) : pill(["Yashirin", ""])}</td>
        <td><div class="stack"><button class="btn btn--ghost" data-toggle="${b.id}" data-active="${b.active}">${b.active ? "Yashirish" : "Yoqish"}</button><button class="btn btn--ghost" data-banner="${b.id}">Tahrirlash</button></div></td></tr>`).join("") || '<tr><td colspan="6" class="empty">Banner yo\'q</td></tr>'}</tbody>
    </table></div>`;
  $("#newBanner").onclick = () => bannerForm(null);
  page.onclick = async (e) => {
    const t = e.target.closest("[data-toggle]");
    if (t) {
      try {
        await api(`/api/banners/${t.dataset.toggle}`, { method: "PUT", body: { active: t.dataset.active !== "true" } });
        render();
      } catch (err) {
        toast(err.message);
      }
    }
    const b = e.target.closest("[data-banner]");
    if (b) bannerForm(banners.find((x) => x.id === b.dataset.banner));
  };
};

function bannerForm(b) {
  let image = b?.image || "";
  openDrawer(b ? "Bannerni tahrirlash" : "Yangi banner", (body) => {
    body.innerHTML = `<form id="bForm">
      <div class="row2">
        <label class="field">Ko'rinish<select name="style">${Object.entries(BANNER_STYLE).map(([k, l]) => `<option value="${k}" ${b?.style === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label class="field">Tartib raqami<input class="input" name="order" type="number" value="${b?.order ?? 1}" /></label>
      </div>
      <label class="field">Sarlavha<input class="input" name="title" maxlength="80" value="${esc(b?.title)}" /></label>
      <label class="field">Matn<input class="input" name="text" maxlength="140" value="${esc(b?.text)}" /></label>
      <div class="field">Rasm</div><div class="thumbs" id="bThumb"></div><input type="file" id="bFile" accept="image/*" hidden />
      <div class="row2">
        <label class="field">Bosilganda<select name="linkType"><option value="none">Hech narsa</option><option value="category" ${b?.linkType === "category" ? "selected" : ""}>Bo'lim</option></select></label>
        <label class="field">Bo'lim<select name="linkId">${state.info.categories.map((c) => `<option value="${c.id}" ${b?.linkId === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></label>
      </div>
      <label class="check"><input type="checkbox" name="active" ${b?.active === false ? "" : "checked"} /> Saytda ko'rsatish</label>
      <div class="stack"><button class="btn" type="submit">Saqlash</button>${b ? '<button class="btn btn--danger" type="button" data-del>O\'chirish</button>' : ""}</div>
    </form>`;
    const drawImg = () => ($("#bThumb", body).innerHTML = image ? `<figure><img src="${esc(image)}" alt=""/><button type="button" data-rm>✕</button></figure>` : '<button type="button" class="thumb-add" data-pick>＋</button>');
    drawImg();
    $("#bFile", body).onchange = async (e) => {
      try {
        image = (await api("/api/upload", { method: "POST", body: { dataUrl: await resizeImage(e.target.files[0], 1600) } })).url;
        drawImg();
      } catch (err) {
        toast(err.message);
      }
    };
    body.onclick = async (e) => {
      if (e.target.closest("[data-pick]")) $("#bFile", body).click();
      if (e.target.closest("[data-rm]")) {
        image = "";
        drawImg();
      }
      if (e.target.closest("[data-del]") && window.confirm("Banner o'chirilsinmi?")) {
        await api(`/api/banners/${b.id}`, { method: "DELETE" });
        closeDrawer();
        render();
      }
    };
    $("#bForm", body).onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const payload = { style: f.get("style"), order: Number(f.get("order")), title: f.get("title"), text: f.get("text"), image, linkType: f.get("linkType"), linkId: f.get("linkId"), active: f.has("active") };
      try {
        await api(b ? `/api/banners/${b.id}` : "/api/banners", { method: b ? "PUT" : "POST", body: payload });
        toast("Saqlandi");
        closeDrawer();
        render();
      } catch (err) {
        toast(err.message);
      }
    };
  });
}

views.staff = async (page, tools) => {
  tools.innerHTML = '<button class="btn" type="button" id="invite">＋ Omborchini taklif qilish</button>';
  const [staff, screens] = await Promise.all([api("/api/staff"), api("/api/screens")]);
  page.innerHTML = `
    <div class="grid cols-2">
      <div class="card"><h3>Xodimlar (${staff.length})</h3><ul class="list">${
        staff.map((m) => `<li><span><b>${esc(m.name)}</b>${m.username ? ` <span class="muted">@${esc(m.username)}</span>` : ""}<br><span class="muted">Omborchi · qo'shilgan ${when(m.addedAt)}</span></span><button class="btn btn--ghost" data-remove="${m.id}" data-name="${esc(m.name)}">O'chirish</button></li>`).join("") ||
        '<li class="muted">Hali xodim yo\'q</li>'
      }</ul><p class="muted" style="margin-top:10px">Adminlar: ${state.info.admins} ta (deploy sozlamasida).</p></div>
      <div class="card"><h3>Ombor ekranlari (${screens.length})</h3><ul class="list">${
        screens.map((s) => `<li><span>🖥 ${esc(s.name)}<br><span class="muted">ulangan ${when(s.createdAt)}</span></span><button class="btn btn--ghost" data-unpair="${s.id}" data-name="${esc(s.name)}">Uzish</button></li>`).join("") || '<li class="muted">Ekran ulanmagan</li>'
      }</ul><p class="muted" style="margin-top:10px">Yangi ekran ulash: mini ilovada ☰ → 🖥 Ombor ekrani → Kod olish.</p></div>
    </div>
    <div class="card" style="margin-top:16px"><h3>HR moduli: keyingi bosqich</h3><p class="muted">Lavozimlar (operator, haydovchi, usta, buxgalter), ishga qabul, davomat, maosh hisobi va ustalar platformasi (tekshiruv, reyting, daromad, bonus) TZ bo'yicha keyingi bosqichlarda shu bo'limga qo'shiladi.</p></div>`;
  $("#invite").onclick = async () => {
    try {
      const { link, expiresAt } = await api("/api/staff/invites", { method: "POST" });
      openDrawer("Taklif havolasi", (body) => {
        body.innerHTML = `<p>Havolani omborchiga yuboring. U Telegram'da bosib <b>Start</b> ni bossa, avtomatik qo'shiladi.</p>
          <p class="note" style="word-break:break-all">${esc(link)}</p><p class="muted">${when(expiresAt)} gacha, bir marta ishlaydi.</p>
          <button class="btn" id="copyLink">Nusxa olish</button>`;
        $("#copyLink", body).onclick = () => navigator.clipboard.writeText(link).then(() => toast("Nusxa olindi"), () => toast("Nusxa olib bo'lmadi, qo'lda belgilang"));
      });
    } catch (err) {
      toast(err.message);
    }
  };
  page.onclick = async (e) => {
    const rm = e.target.closest("[data-remove]");
    const un = e.target.closest("[data-unpair]");
    const target = rm || un;
    if (!target || !window.confirm(`«${target.dataset.name}» ${rm ? "o'chirilsinmi" : "uzilsinmi"}?`)) return;
    try {
      await api(rm ? `/api/staff/${rm.dataset.remove}` : `/api/screens/${un.dataset.unpair}`, { method: "DELETE" });
      toast("Bajarildi");
      render();
    } catch (err) {
      toast(err.message);
    }
  };
};

views.settings = async (page) => {
  const cfg = await api("/api/delivery/settings");
  const info = state.info;
  page.innerHTML = `
    <div class="grid cols-2">
      <div class="card"><h3>🚚 Yetkazish narxlari</h3>
        <form id="dForm">
          <div class="row2">
            <label class="field">1 km narxi (so'm)<input class="input" name="perKm" type="number" min="0" value="${cfg.perKm}" /></label>
            <label class="field">Tushirib berish (so'm)<input class="input" name="unloading" type="number" min="0" value="${cfg.unloading}" /></label>
          </div>
          <div class="row2">
            <label class="field">Liftsiz, har qavat (so'm)<input class="input" name="perFloor" type="number" min="0" value="${cfg.perFloor}" /></label>
            <label class="field">Bepul qavatlar<input class="input" name="freeFloors" type="number" min="0" max="30" value="${cfg.freeFloors}" /></label>
          </div>
          <label class="field">Ombor lokatsiyasi<input class="input" name="warehouse" placeholder="41.311, 69.279 yoki Google Maps havolasi" value="${cfg.warehouse ? `${cfg.warehouse.lat}, ${cfg.warehouse.lon}` : ""}" /></label>
          ${cfg.warehouse ? `<p class="muted"><a target="_blank" rel="noopener" href="https://maps.google.com/?q=${cfg.warehouse.lat},${cfg.warehouse.lon}">Xaritada ko'rish</a></p>` : '<p class="note">⚠️ Ombor lokatsiyasi kiritilmagan: masofa narxi hisoblanmayapti. Google Maps\'da omborni o\'ng tugma bilan bosing, koordinatani nusxalab shu yerga qo\'ying.</p>'}
          <button class="btn" type="submit" style="margin-top:8px">Saqlash</button>
        </form>
      </div>
      <div class="card"><h3>Tizim</h3><dl class="specs">
        <dt>Loyiha</dt><dd>${esc(info.project)}</dd>
        <dt>Bot</dt><dd>${info.bot ? `@${esc(info.bot)}` : "—"}</dd>
        <dt>Mini ilova</dt><dd><a href="${esc(info.webapp)}" target="_blank" rel="noopener">${esc(info.webapp)}</a></dd>
        <dt>Karta to'lovi</dt><dd>${info.cardPayments ? pill(["Yoqilgan", "ok"]) : pill(["O'chiq", "warn"])}</dd>
        <dt>Buyurtmalar guruhi</dt><dd>${info.ordersChat ? "ulangan" : "birinchi adminga keladi"}</dd>
        <dt>Adminlar</dt><dd>${info.admins} ta</dd>
        <dt>Tayyorlash muddati</dt><dd>${info.prepDays} ish kuni</dd>
        <dt>Yetkazish oraliqlari</dt><dd>${info.slots.windows.map((w) => `${w.from}:00–${w.to}:00`).join(", ")} · har biriga ${info.slots.capacity} ta · ${info.slots.daysAhead} kun oldinga</dd>
        <dt>Bo'limlar</dt><dd>${info.categories.map((c) => esc(c.name)).join(", ")}</dd>
      </dl><p class="muted">Bot tokeni, adminlar ro'yxati va to'lov tokeni xavfsizlik uchun faqat Cloud Shell orqali o'zgartiriladi.</p></div>
    </div>`;
  $("#dForm").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const raw = String(f.get("warehouse") || "").trim();
    const m = /(-?\d{1,2}\.\d+)\s*[, ]\s*(-?\d{1,3}\.\d+)/.exec(raw);
    if (raw && !m) return toast("Lokatsiyani tushunmadim: 41.311, 69.279 ko'rinishida yozing");
    const [a, b] = m ? [Number(m[1]), Number(m[2])] : [];
    // Yandex links put longitude first; in Uzbekistan latitude is the smaller number.
    const warehouse = m ? (a > b ? { lat: b, lon: a } : { lat: a, lon: b }) : null;
    try {
      await api("/api/delivery/settings", { method: "PUT", body: { perKm: f.get("perKm"), unloading: f.get("unloading"), perFloor: f.get("perFloor"), freeFloors: f.get("freeFloors"), warehouse } });
      toast("Saqlandi");
      render();
    } catch (err) {
      toast(err.message);
    }
  };
};

const TITLES = {
  dashboard: "Dashboard",
  orders: "Savdo va buyurtmalar",
  crm: "CRM: mijozlar",
  logistics: "Logistika",
  products: "Mahsulotlar (SKU)",
  stock: "Ombor",
  finance: "Moliya",
  accounting: "Buxgalteriya",
  marketing: "Marketing",
  staff: "Xodimlar (HR)",
  settings: "Sozlamalar",
};

async function render() {
  const route = TITLES[location.hash.slice(1)] ? location.hash.slice(1) : "dashboard";
  document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("on", a.dataset.route === route));
  $("#pageTitle").textContent = TITLES[route];
  const page = $("#page");
  const tools = $("#topTools");
  tools.innerHTML = "";
  tools.onclick = null;
  page.onclick = null;
  page.innerHTML = '<p class="empty">Yuklanmoqda…</p>';
  try {
    await views[route](page, tools);
  } catch (err) {
    page.innerHTML = `<p class="empty">${esc(err.message)}</p>`;
  }
}

function showLogin(message) {
  token = null;
  storage.set(TOKEN_KEY, null);
  $("#appView").hidden = true;
  $("#loginView").hidden = false;
  $("#loginError").hidden = !message;
  $("#loginError").textContent = message || "";
}

$("#logoutBtn").onclick = async () => {
  await api("/api/admin/logout", { method: "POST", quiet: true }).catch(() => {});
  showLogin();
};

window.addEventListener("hashchange", () => {
  // A login link pasted into an open panel tab only changes the hash: start over to redeem it.
  if (location.hash.startsWith("#login=")) return location.reload();
  closeDrawer();
  render();
});

(async () => {
  const login = /#login=([a-f0-9]{32})/.exec(location.hash)?.[1];
  if (login) {
    history.replaceState(null, "", "#dashboard");
    try {
      const s = await api("/api/admin/session", { method: "POST", body: { code: login }, quiet: true });
      token = s.token;
      storage.set(TOKEN_KEY, token);
    } catch (err) {
      return showLogin(err.message);
    }
  }
  if (!token) return showLogin();
  try {
    [state.info] = await Promise.all([api("/api/admin/info"), refreshProducts()]);
  } catch (err) {
    return showLogin(err.message);
  }
  $("#whoami").textContent = "Admin";
  $("#loginView").hidden = true;
  $("#appView").hidden = false;
  render();
})();
