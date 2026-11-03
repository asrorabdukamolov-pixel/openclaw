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
  if (o.deliveryHold && o.stage === "ready") return ["Topshirilmadi: qaror kerak", "bad"];
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
  const [orders, complaints, cash] = await Promise.all([ordersFor(state.period), api("/api/complaints"), api(`/api/cash?from=${Date.now() - DAY}`)]);
  const sales = orders.filter(isSale);
  const revenue = sales.reduce((n, o) => n + o.total, 0);
  const cancelled = orders.filter((o) => o.status === "cancelled" && o.stage !== null);
  const active = (await ordersFor(30)).filter((o) => orderGroup(o) === "active" && o.stage !== null);
  const low = goods().filter((p) => p.stock <= 3).sort((a, b) => a.stock - b.stock);
  const asks = active.filter((o) => o.cancelRequest);
  const refunds = (await ordersFor(90)).filter((o) => o.refund?.status === "pending");
  const noSlot = active.filter((o) => o.stage === "ready" && o.orderType === "delivery" && !o.deliveryLabel && !o.deliveryHold);
  const held = active.filter((o) => o.stage === "ready" && o.deliveryHold);
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
        <li><span>🚚 Topshirilmadi, qaror kerak</span><a href="#logistics">${held.length}</a></li>
        <li><span>💵 Kassaga topshirilmagan naqd</span><a href="#cash">${sum(cash.pending.reduce((n, g) => n + g.total, 0))}</a></li>
        <li><span>🛠 Faol shikoyatlar</span><a href="#complaints">${complaints.filter((c) => ["open", "in_progress"].includes(c.status)).length}</a></li>
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
        ${o.failedAttempts?.length ? `<dt>Topshirilmadi</dt><dd>${o.failedAttempts.length} marta${o.retryFees ? ` · qayta yetkazish ${sum(o.retryFees)} so'm` : ""}</dd>` : ""}
        ${o.cashCollected ? `<dt>Haydovchi oldi</dt><dd>💵 ${sum(o.cashCollected)} so'm naqd</dd>` : ""}
        ${o.refund ? `<dt>Qaytarish</dt><dd>💳 ${sum(o.refund.amount)} so'm · ${o.refund.status === "done" ? "qaytarildi" : "kutilmoqda"}</dd>` : ""}
      </dl>
      ${o.cancelRequest ? `<p class="note">🙋 Mijoz bekor qilishni so'ragan: ${esc(o.cancelRequest.reason)}</p>` : ""}
      ${o.deliveryHold && o.stage === "ready" ? `<p class="note">⚠️ Mebel ${o.failedAttempts.length} marta topshirilmadi va omborga qaytdi. Mijoz bilan gaplashing: qayta yetkazish yoki bekor qilish.</p>` : ""}
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
      o.deliveryHold && o.stage === "ready" ? '<button class="btn" data-act="retry">🚚 Qayta yetkazish (mijozga kalendar boradi)</button>' : "",
    ].join("");
    acts.onclick = async (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (!act) return;
      const call = {
        approve: () => api(`/api/orders/${id}/admin-cancel`, { method: "POST", body: { reason: o.cancelRequest.reason } }),
        reject: () => api(`/api/orders/${id}/reject-cancel`, { method: "POST" }),
        cancel: () => api(`/api/orders/${id}/admin-cancel`, { method: "POST", body: { reason: $("#cancelReason", body).value } }),
        refunded: () => api(`/api/orders/${id}/refunded`, { method: "POST" }),
        retry: () => api(`/api/orders/${id}/retry-delivery`, { method: "POST" }),
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

// ---------- Excel: the catalog export doubles as the import template ----------
// Columns are matched by header text, so their order may change. The server decides everything:
// the panel only turns the sheet into rows and shows the dry-run report before the real import.
const XLSX_SRC = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
const XLS_COLUMNS = [
  ["id", "ID", "Bazadagi raqami. Yangi mahsulotda bo'sh qoldiring, bor mahsulotda o'zgartirmang."],
  ["sku", "SKU", "Shtrix-kod raqami. Yangi mahsulotga tizim o'zi beradi; komplektda bo'lmaydi."],
  ["kind", "Turi", "«Mahsulot» yoki «Komplekt». Mavjud mahsulotning turi o'zgarmaydi."],
  ["name", "Nomi", "Majburiy. Bir xil nom ikki marta bo'lmasin."],
  ["category", "Bo'lim", "Oshxona, Shkaf, Tumba, Parta, Pufik yoki Krovat."],
  ["price", "Narx", "So'mda. Saytda ko'rinadigan mahsulot uchun majburiy."],
  ["oldPrice", "Eski narx", "Chegirma uchun: narxdan katta bo'lsin. Bo'sh = chegirma yo'q."],
  ["stock", "Qoldiq", "Ombordagi soni. O'zgarsa, ombor jurnaliga «Excel import» bo'lib yoziladi. Komplektda yozilmaydi."],
  ["boxes", "Qutilar soni", "Bitta mahsulot nechta qutida (har qutiga alohida yorliq)."],
  ["supplierId", "Ta'minotchi", "Fabrika / ta'minotchi nomi, Zakup → Ta'minotchilar'dagidek. Komplektda yozilmaydi."],
  ["minStock", "Minimal qoldiq", "Qoldiq shundan kam bo'lsa, Zakup «Buyurtma berish kerak» ro'yxatiga chiqadi."],
  ["cost", "Tannarx", "Bitta mahsulotning kirim narxi, so'm (faqat adminlar ko'radi). Foyda hisobi shundan. Komplektda yozilmaydi: modullardan hisoblanadi."],
  ["weight", "Og'irligi, kg", "Bitta mahsulot qadog'i bilan, kg. Logistika mashina sig'imini shu bo'yicha hisoblaydi. Komplektda yozilmaydi."],
  ["size", "O'lcham", "Masalan: 120×60×75 sm"],
  ["material", "Material", "Masalan: LDSP 16 mm"],
  ["description", "Tavsif", "Mijoz ko'radigan matn."],
  ["standalone", "Alohida sotiladi", "«ha» yoki «yo'q». «yo'q» = faqat komplekt ichida ishlatiladigan modul."],
  ["isNew", "Yangi belgisi", "«ha» yoki «yo'q»"],
  ["draft", "Qoralama", "«ha» = saytda ko'rinmaydi."],
  ["components", "Komplekt tarkibi", "Faqat komplekt uchun: SKU×soni, nuqta-vergul bilan. Masalan: 100003×2; 100004×1. SKU o'rniga modul nomi ham bo'ladi."],
  ["whenShort", "Modul yetishmasa", "Komplekt uchun: «buyurtma» (oldindan buyurtma) yoki «yashirish»."],
  ["leadDays", "Tayyorlash kunlari", "Komplekt oldindan buyurtmada necha kunda tayyor bo'ladi."],
];
const XLS_ACTION = { create: ["Yangi", "ok"], update: ["Yangilanadi", "teal"], same: ["O'zgarishsiz", ""], error: ["Xato", "bad"] };
let xlsxReady;
const loadXlsx = () =>
  (xlsxReady ??= new Promise((resolve, reject) => {
    const el = Object.assign(document.createElement("script"), { src: XLSX_SRC, onload: () => resolve(window.XLSX) });
    el.onerror = () => {
      xlsxReady = null;
      reject(new Error("Excel kutubxonasi yuklanmadi: internetni tekshiring"));
    };
    document.head.append(el);
  }));
const yesNo = (v) => (v ? "ha" : "yo'q");

async function exportCatalog() {
  const XLSX = await loadXlsx();
  [, state.suppliers] = await Promise.all([refreshProducts(), api("/api/suppliers")]);
  const rows = state.products.map((p) => {
    const kit = isKit(p);
    const cells = {
      id: p.id, sku: kit ? "" : p.sku ?? "", kind: kit ? "Komplekt" : "Mahsulot", name: p.name, category: catName(p.category),
      price: p.price, oldPrice: p.oldPrice ?? "", stock: kit ? "" : p.stock, boxes: kit ? "" : p.boxes ?? 1, cost: kit ? "" : p.cost ?? "", supplierId: kit ? "" : (state.suppliers ?? []).find((x) => x.id === p.supplierId)?.name ?? "", minStock: kit ? "" : p.minStock ?? "", weight: kit ? "" : p.weight ?? "",
      size: p.size ?? "", material: p.material ?? "", description: p.description ?? "",
      standalone: kit ? "" : yesNo(p.standalone !== false), isNew: yesNo(p.isNew), draft: yesNo(p.draft),
      components: kit ? p.parts.map((c) => `${c.sku ?? c.name}×${c.qty}`).join("; ") : "",
      whenShort: kit ? (p.whenShort === "hide" ? "yashirish" : "buyurtma") : "", leadDays: kit ? p.leadDays ?? "" : "",
    };
    return XLS_COLUMNS.map(([key]) => cells[key]);
  });
  const sheet = XLSX.utils.aoa_to_sheet([XLS_COLUMNS.map(([, label]) => label), ...rows]);
  sheet["!cols"] = XLS_COLUMNS.map(([key]) => ({ wch: { name: 34, description: 40, components: 34, id: 22 }[key] ?? 13 }));
  const help = XLSX.utils.aoa_to_sheet([["Ustun", "Nima yoziladi"], ...XLS_COLUMNS.map(([, label, text]) => [label, text]),
    [], ["Qoida", "Fayldagi har bir qator: ID, SKU yoki nomi bo'yicha topilgan mahsulotni yangilaydi, topilmasa yangisini qo'shadi. Faylda yo'q mahsulotlar o'chirilmaydi. Rasmlar panelda alohida yuklanadi."]]);
  help["!cols"] = [{ wch: 20 }, { wch: 110 }];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Mahsulotlar");
  XLSX.utils.book_append_sheet(book, help, "Yo'riqnoma");
  XLSX.writeFile(book, `katalog-${dayKey(Date.now())}.xlsx`);
}

async function readSheetRows(file) {
  const XLSX = await loadXlsx();
  const book = XLSX.read(await file.arrayBuffer());
  const sheet = book.Sheets["Mahsulotlar"] ?? book.Sheets[book.SheetNames[0]];
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: true });
  const norm = (t) => String(t).trim().toLowerCase().replace(/[‘’`ʻʼ]/g, "'");
  const head = (grid[0] ?? []).map(norm);
  const index = XLS_COLUMNS.map(([key, label]) => [key, head.indexOf(norm(label))]).filter(([, i]) => i >= 0);
  if (!index.some(([key]) => key === "name")) throw new Error("Birinchi qatorda «Nomi» ustuni topilmadi. Shablonni «⬇️ Excel» tugmasidan oling.");
  return grid
    .map((cells, i) => ({ cells, line: i + 1 }))
    .slice(1)
    .filter(({ cells }) => cells.some((c) => String(c).trim() !== ""))
    .map(({ cells, line }) => Object.fromEntries([["line", line], ...index.map(([key, i]) => [key, cells[i]])]));
}

async function importCatalog() {
  const input = Object.assign(document.createElement("input"), { type: "file", accept: ".xlsx,.xls,.csv" });
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const rows = await readSheetRows(file);
      const report = await api("/api/products/import", { method: "POST", body: { rows } });
      showImportReport(file.name, rows, report);
    } catch (err) {
      toast(err.message);
    }
  };
  input.click();
}

function showImportReport(fileName, rows, report) {
  const { counts } = report;
  const shown = report.rows.filter((r) => r.action !== "same");
  openDrawer(`Excel: ${fileName}`, (body) => {
    body.innerHTML = `
      <div class="seg" style="margin-bottom:14px">${Object.entries(XLS_ACTION).map(([k, [label]]) => `<button type="button" disabled>${label}: ${counts[k]}</button>`).join("")}</div>
      ${counts.error ? `<p class="note">⚠️ ${counts.error} ta qatorda xato bor. Excel'da tuzatib, faylni qayta yuklang: xato bor paytda hech narsa saqlanmaydi.</p>` : ""}
      <ul class="list">${shown.map((r) => `<li><span><b>${r.line}-qator</b> · ${esc(r.name || "—")}${r.sku ? ` <span class="muted">SKU ${r.sku}</span>` : ""}<br><span class="${r.errors.length ? "" : "muted"}">${esc((r.errors.length ? r.errors : r.changes).join(" · ") || (r.action === "create" ? (r.kind === "kit" ? "yangi komplekt" : "yangi mahsulot") : ""))}</span></span><span>${pill(XLS_ACTION[r.action])}</span></li>`).join("") || '<li><span class="muted">Hech narsa o\'zgarmaydi</span></li>'}</ul>
      <button class="btn" type="button" id="importGo" style="margin-top:16px" ${counts.error || !(counts.create + counts.update) ? "disabled" : ""}>Tasdiqlash: ${counts.create} ta yangi, ${counts.update} ta yangilanadi</button>`;
    $("#importGo").onclick = async (e) => {
      e.target.disabled = true;
      try {
        await api("/api/products/import", { method: "POST", body: { rows, apply: true } });
        await refreshProducts();
        toast("Katalog yangilandi");
        closeDrawer();
        render();
      } catch (err) {
        e.target.disabled = false;
        toast(err.message);
      }
    };
  });
}

views.products = async (page, tools) => {
  let query = "";
  let kind = "all";
  tools.innerHTML = `<button class="btn btn--ghost" type="button" data-xls="export">⬇️ Excel</button><button class="btn btn--ghost" type="button" data-xls="import">⬆️ Exceldan yuklash</button><button class="btn" type="button" data-new="item">＋ Mahsulot / modul</button><button class="btn btn--dark" type="button" data-new="kit">＋ Komplekt</button>`;
  tools.onclick = (e) => {
    const n = e.target.closest("[data-new]");
    if (n) productForm(null, n.dataset.new);
    const x = e.target.closest("[data-xls]");
    if (x) (x.dataset.xls === "export" ? exportCatalog() : importCatalog()).catch((err) => toast(err.message));
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
    body.innerHTML = `<form autocomplete="off" id="pForm">
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
             <label class="field">Tannarx, so'm (faqat adminlar ko'radi)<input class="input" name="cost" type="number" min="0" value="${p?.cost ?? ""}" placeholder="foyda hisobi uchun" /></label>
             <label class="field">Og'irligi, kg (qadoq bilan, ixtiyoriy)<input class="input" name="weight" type="number" min="0" step="0.1" value="${p?.weight ?? ""}" placeholder="logistika uchun" /></label>
             <div class="row2"><label class="field">Ta'minotchi<select name="supplierId"><option value="">— tanlanmagan —</option>${(state.suppliers ?? []).map((x) => `<option value="${x.id}" ${p?.supplierId === x.id ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></label>
             <label class="field">Minimal qoldiq (shundan kam bo'lsa — zakup)<input class="input" name="minStock" type="number" min="0" value="${p?.minStock ?? ""}" /></label></div>
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
        : { ...common, kind: "item", boxes: Number(f.get("boxes")), weight: f.get("weight") || null, cost: f.get("cost") === "" ? null : f.get("cost"), supplierId: f.get("supplierId") || null, minStock: f.get("minStock") === "" ? null : f.get("minStock"), standalone: f.has("standalone"), stock: Number(f.get("stock") || 0) };
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
      <form autocomplete="off" id="mForm" style="margin-top:14px">
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

// ---------- purchasing: what to reorder, purchase orders, suppliers ----------
const PO_STATE = { draft: ["Qoralama", ""], sent: ["Yuborilgan", "teal"], partial: ["Qisman keldi", "warn"], received: ["Qabul qilindi", "ok"], cancelled: ["Bekor", ""] };
const REORDER_DAYS = 30;
let purchaseTab = "need";

// Reorder: cover the supplier's lead time plus a month of sales, never below twice the minimum.
function reorderPlan(orders, purchases) {
  const sold = new Map();
  for (const o of orders.filter(isSale)) for (const u of o.units ?? []) sold.set(u.id, (sold.get(u.id) || 0) + u.qty);
  const onOrder = new Map();
  for (const po of purchases.filter((x) => ["draft", "sent", "partial"].includes(x.status))) for (const l of po.lines) onOrder.set(l.productId, (onOrder.get(l.productId) || 0) + l.qty - l.received);
  return goods()
    .map((p) => {
      const daily = (sold.get(p.id) || 0) / REORDER_DAYS;
      const lead = (state.suppliers ?? []).find((x) => x.id === p.supplierId)?.leadDays ?? 7;
      const coming = onOrder.get(p.id) || 0;
      const trigger = Math.max(p.minStock ?? 0, Math.ceil(daily * lead));
      const target = Math.max((p.minStock ?? 0) * 2, Math.ceil(daily * (lead + 30)));
      const suggest = Math.max(0, target - p.stock - coming);
      const daysLeft = daily ? Math.floor(p.stock / daily) : null;
      return { p, daily, lead, coming, suggest, daysLeft, need: p.stock + coming <= trigger && suggest > 0 };
    })
    .filter((r) => r.need)
    .sort((a, b) => (a.daysLeft ?? 999) - (b.daysLeft ?? 999));
}

views.purchases = async (page, tools) => {
  const [purchases, orders, suppliers] = await Promise.all([api("/api/purchases"), ordersFor(REORDER_DAYS), api("/api/suppliers")]);
  state.suppliers = suppliers;
  const plan = reorderPlan(orders, purchases);
  const open = purchases.filter((x) => ["sent", "partial"].includes(x.status));
  const debt = purchases.filter((x) => x.status !== "cancelled").reduce((n, x) => n + x.debt, 0);
  tools.innerHTML = `<div class="seg">${[["need", `Buyurtma berish kerak (${plan.length})`], ["orders", "Zakup buyurtmalari"], ["suppliers", "Ta'minotchilar"]].map(([k, l]) => `<button type="button" data-pt="${k}" class="${k === purchaseTab ? "on" : ""}">${l}</button>`).join("")}</div>`;
  tools.onclick = (e) => {
    const b = e.target.closest("[data-pt]");
    if (!b) return;
    purchaseTab = b.dataset.pt;
    render();
  };
  const kpis = `<div class="grid cols-4">
      <div class="card kpi"><small>Buyurtma berish kerak</small><b>${plan.length}</b><span>mahsulot / modul</span></div>
      <div class="card kpi"><small>Yo'ldagi zakup</small><b>${open.length}</b><span>${open.filter((x) => x.expectedAt < Date.now()).length} tasi kechikmoqda</span></div>
      <div class="card kpi"><small>Ta'minotchilarga qarz</small><b>${sum(debt)} so'm</b><span>&nbsp;</span></div>
      <div class="card kpi"><small>Ta'minotchilar</small><b>${suppliers.length}</b><span>&nbsp;</span></div>
    </div>`;
  if (purchaseTab === "suppliers") {
    page.innerHTML = `${kpis}<div class="card" style="margin-top:16px"><h3>🏭 Ta'minotchilar</h3><ul class="list">${
      suppliers
        .map((x) => {
          const mine = purchases.filter((po) => po.supplierId === x.id && po.status !== "cancelled");
          return `<li data-sup="${x.id}" style="cursor:pointer"><span><b>${esc(x.name)}</b>${x.phone ? ` · ${esc(x.phone)}` : ""}${x.contact ? ` · ${esc(x.contact)}` : ""}<br><span class="muted">yetkazish ${x.leadDays} kun · ${mine.length} ta zakup · ${goods().filter((p) => p.supplierId === x.id).length} ta mahsulot</span></span><b>${mine.reduce((n, po) => n + po.debt, 0) ? `qarz ${sum(mine.reduce((n, po) => n + po.debt, 0))}` : ""}</b></li>`;
        })
        .join("") || '<li class="muted">Hali ta\'minotchi yo\'q</li>'
    }</ul><button class="btn" type="button" id="newSup" style="margin-top:12px">＋ Ta'minotchi</button>
    <p class="muted" style="margin-top:10px">Mahsulotga ta'minotchini mahsulot formasida yoki Excel'dagi «Ta'minotchi» ustunida biriktiring.</p></div>`;
    page.onclick = (e) => {
      const li = e.target.closest("[data-sup]");
      if (li || e.target.closest("#newSup")) supplierForm(suppliers.find((x) => x.id === li?.dataset.sup));
    };
    return;
  }
  if (purchaseTab === "orders") {
    page.innerHTML = `${kpis}<div class="table-wrap" style="margin-top:16px"><table><thead><tr><th>№</th><th>Ta'minotchi</th><th>Sana</th><th>Kutilmoqda</th><th class="num">Jami</th><th class="num">Keldi</th><th class="num">Qarz</th><th>Holat</th></tr></thead><tbody>${
      purchases
        .map((po) => {
          const ordered = po.lines.reduce((n, l) => n + l.qty, 0);
          const got = po.lines.reduce((n, l) => n + l.received, 0);
          const late = ["sent", "partial"].includes(po.status) && po.expectedAt < Date.now();
          return `<tr class="click" data-po="${po.id}"><td><b>PO-${po.number}</b></td><td>${esc(po.supplierName)}</td><td>${when(po.createdAt)}</td><td>${["sent", "partial"].includes(po.status) ? `<span style="color:${late ? "#c0392b" : "inherit"}">${when(po.expectedAt)}</span>` : "—"}</td><td class="num">${sum(po.total)}</td><td class="num">${got}/${ordered}</td><td class="num">${po.debt ? sum(po.debt) : "—"}</td><td>${pill(late ? ["Kechikmoqda", "bad"] : PO_STATE[po.status])}</td></tr>`;
        })
        .join("") || '<tr><td colspan="8" class="empty">Hali zakup yo\'q</td></tr>'
    }</tbody></table></div>`;
    page.onclick = (e) => {
      const row = e.target.closest("[data-po]");
      if (row) purchaseDrawer(purchases.find((x) => x.id === row.dataset.po));
    };
    return;
  }
  const groups = new Map();
  for (const r of plan) {
    const key = r.p.supplierId && suppliers.some((x) => x.id === r.p.supplierId) ? r.p.supplierId : "";
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  page.innerHTML = `${kpis}
    <p class="muted" style="margin-top:12px">Hisob: oxirgi ${REORDER_DAYS} kun sotuvi, ta'minotchining yetkazish muddati va «Minimal qoldiq». Tavsiya = muddat + 30 kunlik sotuv (kamida minimal qoldiqning 2 baravari) − qoldiq − yo'ldagi zakup.</p>
    ${
      [...groups]
        .map(([sid, rows]) => {
          const supName = suppliers.find((x) => x.id === sid)?.name;
          return `<div class="card" style="margin-top:16px" data-group="${sid}"><h3>${sid ? `🏭 ${esc(supName)}` : "⚠️ Ta'minotchi tanlanmagan"}</h3>
            <div class="table-wrap"><table><thead><tr><th></th><th>SKU</th><th>Mahsulot</th><th class="num">Qoldiq</th><th class="num">Yo'lda</th><th class="num">Kunlik sotuv</th><th class="num">Yetadi</th><th class="num">Soni</th><th class="num">Narxi (tannarx)</th></tr></thead><tbody>${rows
              .map((r) => `<tr><td><input type="checkbox" data-pick="${r.p.id}" checked ${sid ? "" : "disabled"}/></td><td>${r.p.sku ?? "—"}</td><td><b>${esc(r.p.name)}</b>${r.p.minStock != null ? `<br><span class="muted">minimal ${r.p.minStock}</span>` : ""}</td><td class="num">${pill([`${r.p.stock}`, r.p.stock <= 0 ? "bad" : "warn"])}</td><td class="num">${r.coming || "—"}</td><td class="num">${r.daily ? r.daily.toFixed(1) : "—"}</td><td class="num">${r.daysLeft === null ? "—" : `${r.daysLeft} kun`}</td><td class="num"><input class="input" style="width:90px" type="number" min="1" data-qty="${r.p.id}" value="${r.suggest}"/></td><td class="num"><input class="input" style="width:120px" type="number" min="0" data-cost="${r.p.id}" value="${r.p.cost ?? ""}" placeholder="so'm"/></td></tr>`)
              .join("")}</tbody></table></div>
            ${sid ? `<button class="btn" type="button" data-make="${sid}" style="margin-top:10px">📝 Zakup buyurtmasi yaratish</button>` : `<p class="note" style="margin-top:10px">Bu mahsulotlarga ta'minotchi biriktiring (Mahsulotlar → mahsulot → «Ta'minotchi» yoki Excel), keyin buyurtma tuzish mumkin.</p>`}</div>`;
        })
        .join("") || '<div class="card" style="margin-top:16px"><p class="empty">Hozircha hamma mahsulot yetarli 👍</p></div>'
    }`;
  page.onclick = async (e) => {
    const make = e.target.closest("[data-make]");
    if (!make) return;
    const card = make.closest("[data-group]");
    const lines = [...card.querySelectorAll("[data-pick]:checked")].map((c) => ({ productId: c.dataset.pick, qty: card.querySelector(`[data-qty="${c.dataset.pick}"]`).value, cost: card.querySelector(`[data-cost="${c.dataset.pick}"]`).value || 0 }));
    try {
      const po = await api("/api/purchases", { method: "POST", body: { supplierId: make.dataset.make, lines } });
      toast(`PO-${po.number} yaratildi`);
      purchaseTab = "orders";
      render();
      purchaseDrawer(po);
    } catch (err) {
      toast(err.message);
    }
  };
};

function poText(po) {
  return [`Express Market — zakup PO-${po.number}`, `Ta'minotchi: ${po.supplierName}`, "", ...po.lines.map((l, i) => `${i + 1}. ${l.name}${l.sku ? ` (SKU ${l.sku})` : ""} — ${l.qty} ta${l.cost ? ` × ${sum(l.cost)}` : ""}`), "", `Jami: ${sum(po.total)} so'm`].join("\n");
}

function purchaseDrawer(po) {
  openDrawer(`Zakup PO-${po.number}`, (body) => {
    const receiving = ["sent", "partial"].includes(po.status);
    body.innerHTML = `<p>${pill(PO_STATE[po.status])} <b>${esc(po.supplierName)}</b> · ${when(po.createdAt)}${po.sentAt ? ` · yuborilgan ${when(po.sentAt)}` : ""}</p>
      <div class="table-wrap"><table><thead><tr><th>Mahsulot</th><th class="num">Buyurtma</th><th class="num">Keldi</th><th class="num">Narx</th>${receiving ? '<th class="num">Hozir keldi</th>' : ""}</tr></thead><tbody>${po.lines
        .map((l) => `<tr><td>${esc(l.name)}<br><span class="muted">SKU ${l.sku ?? "—"}</span></td><td class="num">${l.qty}</td><td class="num">${l.received}</td><td class="num">${sum(l.cost)}</td>${receiving ? `<td class="num"><input class="input" style="width:80px" type="number" min="0" max="${l.qty - l.received}" data-rcv="${l.productId}" value="${l.qty - l.received}"/></td>` : ""}</tr>`)
        .join("")}</tbody></table></div>
      <dl class="specs" style="margin-top:12px"><dt>Jami</dt><dd><b>${sum(po.total)} so'm</b></dd><dt>To'langan</dt><dd>${sum(po.paid)} so'm${po.payments.length ? ` (${po.payments.map((x) => `${x.from === "cash" ? "kassa" : "bank"} ${sum(x.amount)}`).join(", ")})` : ""}</dd><dt>Qarz</dt><dd>${sum(po.debt)} so'm</dd>${receiving ? `<dt>Kutilmoqda</dt><dd>${when(po.expectedAt)}</dd>` : ""}</dl>
      <div class="stack" style="margin-top:12px">
        ${po.status === "draft" ? '<button class="btn" type="button" data-pa="send">📤 Yuborildi deb belgilash</button>' : ""}
        <button class="btn btn--ghost" type="button" data-pa="copy">📋 Matnni nusxalash (fabrikaga)</button>
        ${receiving ? '<button class="btn" type="button" data-pa="receive">📦 Qabul qilish (qoldiqqa qo\'shish)</button>' : ""}
        ${["draft", "sent"].includes(po.status) && po.lines.every((l) => !l.received) ? '<button class="btn btn--ghost" type="button" data-pa="cancel">Bekor qilish</button>' : ""}
      </div>
      ${
        po.debt && po.status !== "cancelled"
          ? `<h3 style="margin:16px 0 8px">To'lov</h3><div class="row2"><label class="field">Summa<input class="input" id="payAmount" type="number" min="1" value="${po.debt}"/></label><label class="field">Qayerdan<select id="payFrom"><option value="bank">🏦 Bank (o'tkazma)</option><option value="cash">💵 Kassadan naqd</option></select></label></div><button class="btn btn--ghost" type="button" data-pa="pay">💸 To'lovni yozish</button>`
          : ""
      }
      ${po.lines.some((l) => l.received) ? `<h3 style="margin:16px 0 8px">🏷 Yorliqlar</h3><ul class="list">${po.lines.filter((l) => l.received).map((l) => `<li><span>${esc(l.name)}</span><a class="btn btn--ghost" target="_blank" rel="noopener" href="/label.html?id=${encodeURIComponent(l.productId)}&count=${l.received}">Chop etish (${l.received})</a></li>`).join("")}</ul>` : ""}`;
    body.onclick = async (e) => {
      const act = e.target.closest("[data-pa]")?.dataset.pa;
      if (!act) return;
      if (act === "copy") return navigator.clipboard.writeText(poText(po)).then(() => toast("Nusxa olindi: fabrikaga yuboring"), () => toast("Nusxa olib bo'lmadi"));
      if (act === "cancel" && !window.confirm(`PO-${po.number} bekor qilinsinmi?`)) return;
      const payload = {
        send: {},
        cancel: {},
        receive: { lines: [...body.querySelectorAll("[data-rcv]")].map((x) => ({ productId: x.dataset.rcv, qty: x.value })) },
        pay: { amount: $("#payAmount", body)?.value, from: $("#payFrom", body)?.value },
      }[act];
      try {
        const next = await api(`/api/purchases/${po.id}/${act}`, { method: "POST", body: payload });
        toast({ send: "Yuborilgan deb belgilandi", cancel: "Bekor qilindi", receive: "Qoldiqqa qo'shildi", pay: "To'lov yozildi" }[act]);
        if (act === "receive") await refreshProducts();
        render();
        purchaseDrawer(next);
      } catch (err) {
        toast(err.message);
      }
    };
  });
}

function supplierForm(x) {
  openDrawer(x ? x.name : "Yangi ta'minotchi", (body) => {
    body.innerHTML = `<form id="supForm" autocomplete="off">
      <label class="field">Nomi (fabrika)<input class="input" name="supName" required value="${esc(x?.name)}" /></label>
      <div class="row2"><label class="field">Telefon<input class="input" name="supPhone" value="${esc(x?.phone)}" /></label>
      <label class="field">Mas'ul shaxs<input class="input" name="supContact" value="${esc(x?.contact)}" /></label></div>
      <label class="field">Yetkazish muddati, kun (buyurtmadan omborgacha)<input class="input" name="supLead" type="number" min="1" max="180" value="${x?.leadDays ?? 7}" /></label>
      <label class="field">Izoh<input class="input" name="supNote" value="${esc(x?.note)}" /></label>
      <button class="btn" type="submit" style="margin-top:10px">Saqlash</button></form>`;
    $("#supForm", body).onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        await api(x ? `/api/suppliers/${x.id}` : "/api/suppliers", { method: x ? "PUT" : "POST", body: { name: f.get("supName"), phone: f.get("supPhone"), contact: f.get("supContact"), leadDays: f.get("supLead"), note: f.get("supNote") } });
        toast("Saqlandi");
        closeDrawer();
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
  const from = Date.now() - state.period * DAY;
  const [orders, cash] = await Promise.all([ordersFor(state.period), api(`/api/cash?from=${from}`)]);
  const sales = orders.filter(isSale);
  const goodsSum = sales.reduce((n, o) => n + o.goodsTotal, 0);
  // Cost of goods from today's product costs; a kit costs its modules. Lines without a cost are counted, not guessed.
  const unitCost = (id) => {
    const p = byId(id);
    if (!p) return null;
    if (!isKit(p)) return p.cost ?? null;
    const parts = (p.components ?? []).map((c) => [byId(c.id)?.cost, c.qty]);
    return parts.every(([v]) => v != null) ? parts.reduce((n, [v, q]) => n + v * q, 0) : null;
  };
  let cogs = 0;
  const noCost = new Set();
  for (const o of sales) for (const l of o.lines) {
    const c = unitCost(l.id);
    if (c === null) noCost.add(l.name);
    else cogs += c * l.qty;
  }
  const expenses = cash.entries.filter((e) => e.type === "out" && !cash.categories.notExpense.includes(e.category));
  const expenseSum = expenses.reduce((n, e) => n + e.amount, 0);
  const byCategory = Object.entries(cash.categories.out)
    .map(([k, label]) => ({ label, value: expenses.filter((e) => e.category === k).reduce((n, e) => n + e.amount, 0) }))
    .filter((x) => x.value)
    .map((x) => ({ ...x, text: sum(x.value) }));
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
    <div class="grid cols-4" style="margin-top:16px">
      <div class="card kpi"><small>Tannarx (sotilgan)</small><b>${sum(cogs)} so'm</b><span>${noCost.size ? `${noCost.size} ta mahsulotda tannarx yo'q` : "hamma mahsulotda bor"}</span></div>
      <div class="card kpi"><small>Yalpi foyda</small><b>${sum(goodsSum - cogs)} so'm</b><span>${goodsSum ? Math.round(((goodsSum - cogs) / goodsSum) * 100) : 0}% marja (mahsulotdan)</span></div>
      <div class="card kpi"><small>Xarajatlar</small><b>${sum(expenseSum)} so'm</b><span>kassadan · ${expenses.length} ta</span></div>
      <div class="card kpi"><small>Sof foyda</small><b>${sum(goodsSum + delivery - cogs - expenseSum)} so'm</b><span>tushum − tannarx − xarajat</span></div>
    </div>
    ${noCost.size ? `<p class="note" style="margin-top:12px">⚠️ Tannarx kiritilmagan: ${esc([...noCost].slice(0, 6).join(", "))}${noCost.size > 6 ? "…" : ""}. Mahsulotlar → mahsulotni ochib «Tannarx» ni kiriting yoki Excel'dagi «Tannarx» ustunini to'ldiring. Ungacha foyda yuqori ko'rinadi.</p>` : ""}
    <div class="grid cols-2" style="margin-top:16px">
      <div class="card"><h3>Kunlik tushum</h3>${barChart(dailyPoints(sales, Math.min(state.period, 30), (o) => o.total))}</div>
      <div class="card"><h3>Xarajatlar kategoriya bo'yicha</h3>${byCategory.length ? hbars(byCategory) : '<p class="muted">Bu davrda xarajat kiritilmagan. Kassa → Chiqim.</p>'}</div>
    </div>
    <div class="table-wrap" style="margin-top:16px"><table>
      <thead><tr><th>Sana</th><th class="num">Buyurtma</th><th class="num">Mahsulot</th><th class="num">Yetkazish</th><th class="num">Karta</th><th class="num">Naqd</th><th class="num">Jami</th></tr></thead>
      <tbody>${daily
        .filter((d) => d.count)
        .map((d) => `<tr><td>${d.day}</td><td class="num">${d.count}</td><td class="num">${sum(d.goods)}</td><td class="num">${sum(d.delivery)}</td><td class="num">${sum(d.card)}</td><td class="num">${sum(d.cash)}</td><td class="num"><b>${sum(d.goods + d.delivery)}</b></td></tr>`)
        .join("") || '<tr><td colspan="7" class="empty">Bu davrda sotuv yo\'q</td></tr>'}</tbody>
    </table></div>
    <p class="muted" style="margin-top:10px">Tushum buyurtma sanasi bo'yicha; xarajatlar Kassa daftaridan. Tannarx mahsulotning hozirgi tannarxidan hisoblanadi.</p>`;
  $("#finCsv").onclick = () => download(`moliya-${dayKey(Date.now())}.csv`, [["Sana", "Buyurtmalar", "Mahsulot", "Yetkazish", "Karta", "Naqd", "Jami"], ...daily.map((d) => [d.day, d.count, d.goods, d.delivery, d.card, d.cash, d.goods + d.delivery])]);
};

// ---------- cash desk: accept drivers' and shop cash, book income and expenses ----------
views.cash = async (page, tools) => {
  tools.innerHTML = `${periodSeg()} <button class="btn btn--ghost" type="button" id="cashCsv">⬇️ Kassa daftari (CSV)</button>`;
  bindPeriod(render);
  const data = await api(`/api/cash?from=${Date.now() - state.period * DAY}`);
  const cats = { ...data.categories.in, ...data.categories.out };
  const pendingTotal = data.pending.reduce((n, g) => n + g.total, 0);
  const today = data.entries.filter((e) => dayKey(e.at) === dayKey(Date.now()));
  const outToday = today.filter((e) => e.type === "out").reduce((n, e) => n + e.amount, 0);
  const inToday = today.filter((e) => e.type === "in").reduce((n, e) => n + e.amount, 0);
  page.innerHTML = `
    <div class="grid cols-4">
      <div class="card kpi"><small>💵 Kassadagi qoldiq</small><b>${sum(data.balance)} so'm</b><span>hozir</span></div>
      <div class="card kpi"><small>Qabul qilinmagan naqd</small><b>${sum(pendingTotal)} so'm</b><span>${data.pending.length} ta odamda</span></div>
      <div class="card kpi"><small>Bugun kirim</small><b>${sum(inToday)} so'm</b><span>&nbsp;</span></div>
      <div class="card kpi"><small>Bugun chiqim</small><b>${sum(outToday)} so'm</b><span>&nbsp;</span></div>
    </div>
    <div class="grid cols-2" style="margin-top:16px">
      <div class="card"><h3>🚚 Haydovchi va do'kondagi naqd</h3><ul class="list">${
        data.pending
          .map((g) => `<li><span><b>${esc(g.name)}</b><br><span class="muted">${g.orders.length} ta buyurtma · eng eskisi ${when(Math.min(...g.orders.map((o) => o.at)))}</span></span><span style="display:flex;gap:10px;align-items:center"><b>${sum(g.total)}</b><button class="btn" type="button" data-settle="${esc(g.holder)}">Qabul qilish</button></span></li>`)
          .join("") || '<li class="muted">Hamma naqd kassaga topshirilgan</li>'
      }</ul><p class="muted" style="margin-top:10px">Haydovchi «Topshirdim» bosganda olgan naqdi shu yerga tushadi. Pulni sanab, «Qabul qilish» ni bosing: haydovchiga botda tasdiq boradi.</p></div>
      <div class="card"><h3>➕ Kirim / ➖ Chiqim</h3>
        <form id="entryForm" autocomplete="off">
          <div class="row2">
            <label class="field">Turi<select name="type" id="eType"><option value="out">➖ Chiqim (xarajat)</option><option value="in">➕ Kirim</option></select></label>
            <label class="field">Kategoriya<select name="category" id="eCat"></select></label>
          </div>
          <label class="field">Summa, so'm<input class="input" name="amount" type="number" min="1" required /></label>
          <label class="field">Izoh (nima uchun, kimga)<input class="input" name="note" required placeholder="Masalan: oktyabr ijarasi, Ali — avans" /></label>
          <button class="btn" type="submit" style="margin-top:8px">Saqlash</button>
        </form>
        <p class="muted" style="margin-top:10px">Yozuvlar o'chirilmaydi: xato bo'lsa, teskari yozuv kiriting (masalan, ortiqcha chiqim bo'lsa — kirim).</p></div>
    </div>
    <div class="table-wrap" style="margin-top:16px"><table>
      <thead><tr><th>Vaqt</th><th>Turi</th><th>Kategoriya</th><th>Kimdan / izoh</th><th class="num">Summa</th><th class="num">Farq</th><th class="num">Qoldiq</th><th>Kiritdi</th></tr></thead>
      <tbody>${
        data.entries
          .map((e) => `<tr><td>${when(e.at)}</td><td>${e.type === "in" ? pill(["Kirim", "ok"]) : pill(["Chiqim", "bad"])}</td><td>${esc(cats[e.category] ?? e.category)}</td><td>${esc([e.holderName, e.note].filter(Boolean).join(" · "))}${e.orderIds?.length ? ` <span class="muted">(${e.orderIds.length} ta buyurtma)</span>` : ""}</td><td class="num"><b>${e.type === "in" ? "+" : "−"}${sum(e.amount)}</b></td><td class="num">${e.diff ? `<span style="color:${e.diff < 0 ? "#c0392b" : "inherit"}">${e.diff > 0 ? "+" : ""}${sum(e.diff)}</span>` : ""}</td><td class="num">${sum(e.balanceAfter)}</td><td>${esc(e.by)}</td></tr>`)
          .join("") || '<tr><td colspan="8" class="empty">Bu davrda yozuv yo\'q</td></tr>'
      }</tbody></table></div>`;
  const fillCats = () => {
    const list = $("#eType").value === "in" ? { other_in: data.categories.in.other_in } : Object.fromEntries(Object.entries(data.categories.out).filter(([k]) => k !== "refund"));
    $("#eCat").innerHTML = Object.entries(list).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join("");
  };
  fillCats();
  $("#eType").onchange = fillCats;
  $("#entryForm").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api("/api/cash/entries", { method: "POST", body: { type: f.get("type"), category: f.get("category"), amount: f.get("amount"), note: f.get("note") } });
      toast("Saqlandi");
      render();
    } catch (err) {
      toast(err.message);
    }
  };
  page.onclick = (e) => {
    const b = e.target.closest("[data-settle]");
    if (b) settleDrawer(data.pending.find((g) => g.holder === b.dataset.settle));
  };
  $("#cashCsv").onclick = () =>
    download(`kassa-${dayKey(Date.now())}.csv`, [
      ["Vaqt", "Turi", "Kategoriya", "Kimdan", "Izoh", "Summa", "Kutilgan", "Farq", "Qoldiq", "Kiritdi"],
      ...data.entries.map((e) => [when(e.at), e.type === "in" ? "Kirim" : "Chiqim", cats[e.category] ?? e.category, e.holderName ?? "", e.note ?? "", e.type === "in" ? e.amount : -e.amount, e.expected ?? "", e.diff ?? "", e.balanceAfter, e.by]),
    ]);
};

function settleDrawer(g) {
  openDrawer(`Naqdni qabul qilish: ${g.name}`, (body) => {
    body.innerHTML = `<p class="muted">Pulni sanang. Hammasini birdan yoki tanlangan buyurtmalarni qabul qiling.</p>
      <ul class="list">${g.orders.map((o) => `<li><label class="check" style="flex:1"><input type="checkbox" data-o="${o.id}" data-amount="${o.amount}" checked/> <span><b>#${o.number ?? "—"}</b> ${esc(o.name)}<br><span class="muted">${when(o.at)}${o.by ? ` · ${esc(o.by)}` : ""}</span></span></label><b>${sum(o.amount)}</b></li>`).join("")}</ul>
      <p style="margin-top:12px">Kutilgan: <b id="sExpected"></b></p>
      <label class="field">Qo'lga olingan summa, so'm<input class="input" id="sReceived" type="number" min="0" /></label>
      <label class="field">Izoh (summa farq qilsa majburiy)<input class="input" id="sNote" placeholder="Masalan: 50 000 kam — keyingi kuni beradi" /></label>
      <button class="btn" type="button" id="sGo" style="margin-top:8px">✅ Kassaga qabul qilish</button>`;
    const picked = () => [...body.querySelectorAll("[data-o]:checked")];
    const update = () => {
      const expected = picked().reduce((n, x) => n + Number(x.dataset.amount), 0);
      $("#sExpected", body).textContent = `${sum(expected)} so'm`;
      $("#sReceived", body).value = expected;
    };
    update();
    body.onchange = (e) => {
      if (e.target.matches("[data-o]")) update();
    };
    $("#sGo", body).onclick = async () => {
      try {
        await api("/api/cash/settle", { method: "POST", body: { orderIds: picked().map((x) => x.dataset.o), received: $("#sReceived", body).value, note: $("#sNote", body).value } });
        toast("Kassaga qabul qilindi");
        closeDrawer();
        dropOrders();
        render();
      } catch (err) {
        toast(err.message);
      }
    };
  });
}

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
// One customer = every order sharing a phone number or a Telegram account, so a buyer who
// switches numbers (or writes the same number differently) never shows up twice.
function customers(orders, rules) {
  const byKey = new Map();
  const list = new Set();
  for (const o of [...orders].sort((a, b) => a.createdAt - b.createdAt)) {
    const keys = [normPhone(o.phone) && `p${normPhone(o.phone)}`, o.customerId && `t${o.customerId}`].filter(Boolean);
    if (!keys.length) continue;
    const found = [...new Set(keys.map((k) => byKey.get(k)).filter(Boolean))];
    const c = found[0] || { key: keys[0], keys: new Set(), phones: new Map(), name: o.name, orders: [], spent: 0, cancelled: 0 };
    for (const other of found.slice(1)) {
      c.orders.push(...other.orders);
      other.keys.forEach((k) => c.keys.add(k));
      other.phones.forEach((ph, k) => c.phones.set(k, ph));
      list.delete(other);
    }
    c.orders.push(o);
    c.name = o.name || c.name;
    if (normPhone(o.phone)) c.phones.set(normPhone(o.phone), o.phone);
    keys.forEach((k) => c.keys.add(k));
    for (const k of c.keys) byKey.set(k, c);
    list.add(c);
  }
  const lostAfter = rules.lostAfterDays * DAY;
  return [...list].map((c) => {
    const orders = c.orders.sort((a, b) => a.createdAt - b.createdAt);
    const sales = orders.filter(isSale);
    const spent = sales.reduce((n, o) => n + o.total, 0);
    const last = orders.at(-1).createdAt;
    const vip = spent >= rules.vipSpend;
    const lost = sales.length > 0 && Date.now() - last > lostAfter && (!vip || rules.vipLapse);
    const segment = lost ? "lost" : vip ? "vip" : sales.length >= rules.repeatOrders ? "repeat" : "new";
    return {
      ...c,
      orders,
      phone: [...c.phones.values()].reverse().join(", "),
      bought: sales.length,
      spent,
      vip,
      cancelled: orders.filter((o) => o.status === "cancelled" && o.stage !== null).length,
      first: orders[0].createdAt,
      last,
      segment,
    };
  });
}

const segmentPill = (c) => pill(c.segment === "lost" && c.vip ? ["Uzoq kelmagan · VIP", "warn"] : SEGMENT[c.segment]);

views.crm = async (page, tools) => {
  let query = "";
  let seg = "all";
  tools.innerHTML = '<button class="btn btn--ghost" type="button" id="crmCsv">⬇️ Mijozlar bazasi (CSV)</button>';
  const [orders, rules] = await Promise.all([ordersFor(365), api("/api/crm/segments")]);
  const list = customers(orders, rules).sort((a, b) => b.spent - a.spent);
  const count = (k) => list.filter((c) => c.segment === k).length;
  const shown = () => list.filter((c) => (seg === "all" || c.segment === seg) && (!query || `${c.name} ${c.phone}`.toLowerCase().includes(query.toLowerCase())));
  const draw = () => {
    $("#crmRows").innerHTML =
      shown()
        .map((c) => `<tr class="click" data-cust="${c.key}"><td><b>${esc(c.name)}</b></td><td>${esc(c.phone)}</td><td>${segmentPill(c)}</td><td class="num">${c.bought}</td><td class="num">${sum(c.spent)}</td><td class="num">${sum(c.bought ? c.spent / c.bought : 0)}</td><td>${when(c.last)}</td><td class="num">${c.cancelled || ""}</td></tr>`)
        .join("") || '<tr><td colspan="8" class="empty">Mijoz topilmadi</td></tr>';
    page.querySelectorAll("[data-seg]").forEach((b) => b.classList.toggle("on", b.dataset.seg === seg));
  };
  const total = list.reduce((n, c) => n + c.spent, 0);
  page.innerHTML = `
    <div class="grid cols-4">
      <div class="card kpi"><small>Mijozlar · 12 oy</small><b>${list.length}</b><span>telefon va Telegram bo'yicha, dublsiz</span></div>
      <div class="card kpi"><small>Takror xarid qilganlar</small><b>${list.filter((c) => c.bought >= 2).length}</b><span>${list.length ? Math.round((list.filter((c) => c.bought >= 2).length / list.length) * 100) : 0}% mijozlardan</span></div>
      <div class="card kpi"><small>Bir mijozdan o'rtacha</small><b>${sum(list.length ? total / list.length : 0)} so'm</b><span>&nbsp;</span></div>
      <div class="card kpi"><small>VIP (${sum(rules.vipSpend)}+)</small><b>${count("vip")}</b><span>uzoq kelmagan: ${count("lost")}</span></div>
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
      body.innerHTML = `<dl class="specs"><dt>Telefon</dt><dd>${esc(c.phone)}</dd><dt>Segment</dt><dd>${segmentPill(c)}</dd>
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
// ---------- logistics: plan a day's routes ----------
// Pick a day, tick that day's delivery orders, choose a driver and a vehicle: the server orders the
// stops (morning window first, nearest next) and the driver works the route in the mini app.
const FAIL_TEXT = { absent: "uyda yo'q", no_answer: "telefonni ko'tarmadi", no_address: "manzil topilmadi", refused: "qabul qilmadi", no_money: "pul yetmadi" };
const ROUTE_STATUS = { planned: ["Rejada", ""], started: ["Yo'lda", "teal"], done: ["Tugadi", "ok"] };
const kg = (n) => `${Math.round(n * 10) / 10} kg`;
let logisticsDate = null;

function routeLoad(stops) {
  return {
    boxes: stops.reduce((n, o) => n + o.boxes, 0),
    weight: stops.reduce((n, o) => n + (o.weight ?? 0), 0),
    unknown: stops.filter((o) => o.weight === null).length,
  };
}

function capacityNote(load, vehicle) {
  if (!vehicle) return "";
  const over = [];
  if (vehicle.capacityKg && load.weight > vehicle.capacityKg) over.push(`og'irlik ${kg(load.weight)} > ${kg(vehicle.capacityKg)}`);
  if (vehicle.capacityBoxes && load.boxes > vehicle.capacityBoxes) over.push(`qutilar ${load.boxes} > ${vehicle.capacityBoxes}`);
  return over.length ? `<p class="note">⚠️ Mashinaga sig'maydi: ${over.join(", ")}</p>` : "";
}

const stopLine = (o, i) =>
  `<li data-order="${o.id}" style="cursor:pointer"><span>${i === undefined ? "" : `<b>${i + 1}.</b> `}<b>${no(o)}</b> ${esc(o.name)} · ${esc((o.deliveryLabel || "").split(", ").at(-1))}<br><span class="muted">${esc(o.address || "manzil yo'q")}${o.location ? "" : " · 📍 lokatsiya yo'q"} · ${o.boxes} quti${o.weight ? ` · ${kg(o.weight)}` : ""}${o.toCollect ? ` · naqd ${sum(o.toCollect)}` : ""}</span></span><span>${o.handedAt ? pill(["Topshirildi", "ok"]) : o.lastFail && !o.routeId ? pill([`Topshirilmadi: ${FAIL_TEXT[o.lastFail.reason]}`, "bad"]) : pill(orderState(o))}</span></li>`;

views.logistics = async (page, tools) => {
  const days = Array.from({ length: 8 }, (_, i) => dayKey(Date.now() + i * DAY));
  logisticsDate ??= days[0];
  tools.innerHTML = `<div class="seg">${days.map((d, i) => `<button type="button" data-day="${d}" class="${d === logisticsDate ? "on" : ""}">${i === 0 ? "Bugun" : i === 1 ? "Ertaga" : d.slice(5).split("-").reverse().join(".")}</button>`).join("")}</div>`;
  tools.onclick = (e) => {
    const b = e.target.closest("[data-day]");
    if (!b) return;
    logisticsDate = b.dataset.day;
    render();
  };
  const [plan, recent] = await Promise.all([api(`/api/logistics?date=${logisticsDate}`), ordersFor(90)]);
  const held = recent.filter((o) => o.stage === "ready" && o.deliveryHold && o.status !== "cancelled");
  const free = plan.orders.filter((o) => !o.routeId && ["new", "picking", "ready"].includes(o.stage));
  const vehicles = plan.vehicles.filter((v) => v.active !== false);
  const byOrder = new Map([...plan.orders, ...plan.returned].map((o) => [o.id, o]));
  const routeCard = (r) => {
    const stops = r.orderIds.map((id) => byOrder.get(id)).filter(Boolean);
    const load = routeLoad(stops);
    const pts = stops.filter((o) => o.location).map((o) => `${o.location.lat},${o.location.lon}`);
    const origin = plan.warehouse ? `${plan.warehouse.lat},${plan.warehouse.lon}` : pts.shift();
    const map = pts.length ? `https://www.google.com/maps/dir/${[origin, ...pts].filter(Boolean).join("/")}` : null;
    return `<div class="card"><h3>🚚 ${esc(r.driverName)} · ${esc(r.vehicleName)} ${pill(ROUTE_STATUS[r.status])}</h3>
      <p class="muted">${stops.length} ta manzil · ${load.boxes} quti · ${kg(load.weight)}${load.unknown ? ` (${load.unknown} tasida og'irlik yo'q)` : ""}${r.km ? ` · ~${r.km} km` : ""}</p>
      ${capacityNote(load, plan.vehicles.find((v) => v.id === r.vehicleId))}
      <ul class="list">${stops.map(stopLine).join("")}</ul>
      <div class="stack" style="margin-top:10px">${map ? `<a class="btn btn--ghost" target="_blank" rel="noopener" href="${esc(map)}">🗺 Xaritada marshrut</a>` : ""}${r.status === "planned" ? `<button class="btn btn--ghost" type="button" data-drop="${r.id}">Reysni bekor qilish</button>` : ""}</div></div>`;
  };
  page.innerHTML = `
    <div class="grid cols-4">
      <div class="card kpi"><small>${esc(plan.dateLabel)}: yetkazish</small><b>${plan.orders.length}</b><span>shu kunga vaqt tanlangan</span></div>
      <div class="card kpi"><small>Reysga biriktirilmagan</small><b>${free.length}</b><span>${free.filter((o) => o.stage !== "ready").length} tasi hali omborda terilmoqda</span></div>
      <div class="card kpi"><small>Reyslar</small><b>${plan.routes.length}</b><span>${plan.routes.filter((r) => r.status === "started").length} tasi yo'lda</span></div>
      <div class="card kpi"><small>Haydovchi / mashina</small><b>${plan.drivers.length} / ${vehicles.length}</b><span>&nbsp;</span></div>
    </div>
    ${plan.warehouse ? "" : '<p class="note" style="margin-top:12px">⚠️ Ombor lokatsiyasi kiritilmagan: marshrut tartibi va km taxminiy. Sozlamalar → Yetkazish narxlari.</p>'}
    <div class="grid cols-2" style="margin-top:16px">
      <div class="card"><h3>📦 Reys tuzish</h3>
        ${
          free.length
            ? `<ul class="list" id="freeList">${free.map((o) => `<li><label class="check" style="flex:1"><input type="checkbox" data-pick="${o.id}" checked /> <span><b>${no(o)}</b> ${esc(o.name)} · ${esc((o.deliveryLabel || "").split(", ").at(-1))}<br><span class="muted">${esc(o.address || "")} · ${o.boxes} quti${o.weight ? ` · ${kg(o.weight)}` : ""}${o.toCollect ? ` · 💵 naqd ${sum(o.toCollect)}` : " · 💳 to'langan"}</span></span></label>${pill(orderState(o))}</li>`).join("")}</ul>
               <div class="row2" style="margin-top:12px">
                 <label class="field">Haydovchi<select id="rDriver">${plan.drivers.map((d) => `<option value="${d.id}">${esc(d.name)}${d.cashAllowed ? " · 💵 naqd" : " · faqat onlayn"}</option>`).join("")}</select></label>
                 <label class="field">Mashina<select id="rVehicle">${vehicles.map((v) => `<option value="${v.id}">${esc([v.name, v.plate].filter(Boolean).join(" · "))}</option>`).join("")}</select></label>
               </div>
               <p class="muted" id="rLoad"></p>
               ${plan.drivers.length && vehicles.length ? '<button class="btn" type="button" id="makeRoute">Reys yaratish</button>' : `<p class="note">${plan.drivers.length ? "" : "Haydovchi yo'q: Xodimlar (HR) → ＋ Haydovchini taklif qilish. "}${vehicles.length ? "" : "Mashina yo'q: pastda ＋ Mashina."}</p>`}`
            : '<p class="empty">Bu kun uchun biriktiriladigan buyurtma yo\'q</p>'
        }
      </div>
      ${plan.routes.map(routeCard).join("")}
    </div>
    ${held.length ? `<div class="card" style="margin-top:16px"><h3>⚠️ Topshirilmadi, qaror kerak (${held.length})</h3><ul class="list">${held.map((o) => `<li data-order="${o.id}" style="cursor:pointer"><span><b>${no(o)}</b> ${esc(o.name)} · ${esc(o.phone)}<br><span class="muted">${o.failedAttempts.length} marta topshirilmadi · oxirgisi: ${esc(FAIL_TEXT[o.failedAttempts.at(-1)?.reason] ?? "")}</span></span>${pill(orderState(o))}</li>`).join("")}</ul></div>` : ""}
    <div class="grid cols-2" style="margin-top:16px">
      <div class="card"><h3>🚐 Mashinalar</h3><ul class="list">${
        plan.vehicles.map((v) => `<li data-vehicle="${v.id}" style="cursor:pointer"><span><b>${esc(v.name)}</b> ${esc(v.plate)}<br><span class="muted">${v.capacityKg ? kg(v.capacityKg) : "sig'imi kiritilmagan"}${v.capacityBoxes ? ` · ${v.capacityBoxes} quti` : ""}</span></span>${v.active === false ? pill(["O'chirilgan", ""]) : pill(["Faol", "ok"])}</li>`).join("") || '<li class="muted">Hali mashina yo\'q</li>'
      }</ul><button class="btn btn--ghost" type="button" id="newVehicle" style="margin-top:10px">＋ Mashina</button></div>
      <div class="card"><h3>👷 Haydovchilar</h3><ul class="list">${plan.drivers.map((d) => `<li><span><b>${esc(d.name)}</b>${d.username ? ` <span class="muted">@${esc(d.username)}</span>` : ""}<br><span class="muted">${esc(DRIVER_TRUST(d))}</span></span></li>`).join("") || '<li class="muted">Hali haydovchi yo\'q</li>'}</ul>
        <p class="muted" style="margin-top:10px">Yangi haydovchilar haydovchi botida ro'yxatdan o'tadi, HR Xodimlar bo'limida tasdiqlaydi. Reyslar haydovchi botiga va ilovadagi ☰ → 🚚 Reyslarim'ga keladi.</p></div>
    </div>`;
  const picked = () => [...page.querySelectorAll("[data-pick]:checked")].map((x) => byOrder.get(x.dataset.pick));
  const showLoad = () => {
    const el = $("#rLoad");
    if (!el) return;
    const load = routeLoad(picked());
    const driver = plan.drivers.find((d) => d.id === $("#rDriver").value);
    const cash = picked().filter((o) => o.toCollect > 0);
    const cashNote = driver && !driver.cashAllowed && cash.length ? `<p class="note">⚠️ ${esc(driver.name)} naqd pul ololmaydi: ${cash.map(no).join(", ")} naqd to'lovli. Ularni olib tashlang yoki naqd ruxsati bor haydovchini tanlang.</p>` : "";
    el.innerHTML = `Tanlandi: ${picked().length} ta · ${load.boxes} quti · ${kg(load.weight)}${load.unknown ? ` (${load.unknown} tasida og'irlik kiritilmagan)` : ""}${capacityNote(load, vehicles.find((v) => v.id === $("#rVehicle").value))}${cashNote}`;
  };
  showLoad();
  page.onchange = showLoad;
  page.onclick = async (e) => {
    const li = e.target.closest("[data-order]");
    if (li) return openOrder(li.dataset.order);
    const v = e.target.closest("[data-vehicle]");
    if (v || e.target.closest("#newVehicle")) return vehicleForm(plan.vehicles.find((x) => x.id === v?.dataset.vehicle));
    const drop = e.target.closest("[data-drop]");
    const make = e.target.closest("#makeRoute");
    if (drop && !window.confirm("Reys bekor qilinsinmi? Buyurtmalar yana biriktirilmaganlar ro'yxatiga qaytadi.")) return;
    if (!drop && !make) return;
    try {
      if (drop) await api(`/api/routes/${drop.dataset.drop}`, { method: "DELETE" });
      else await api("/api/routes", { method: "POST", body: { orderIds: picked().map((o) => o.id), driverId: $("#rDriver").value, vehicleId: $("#rVehicle").value } });
      toast(drop ? "Reys bekor qilindi" : "Reys yaratildi, haydovchiga xabar ketdi");
      dropOrders();
      render();
    } catch (err) {
      toast(err.message);
    }
  };
};

function vehicleForm(v) {
  openDrawer(v ? "Mashina" : "Yangi mashina", (body) => {
    body.innerHTML = `<form autocomplete="off" id="vForm" autocomplete="off">
      <label class="field">Nomi / rusumi<input class="input" name="vehicleName" autocomplete="off" required value="${esc(v?.name)}" placeholder="Isuzu NPR, Labo, Damas" /></label>
      <label class="field">Davlat raqami<input class="input" name="vehiclePlate" autocomplete="off" value="${esc(v?.plate)}" placeholder="01 A 123 BC" /></label>
      <div class="row2">
        <label class="field">Yuk ko'tarish, kg<input class="input" name="capacityKg" type="number" min="1" value="${v?.capacityKg ?? ""}" /></label>
        <label class="field">Sig'imi, quti<input class="input" name="capacityBoxes" type="number" min="1" value="${v?.capacityBoxes ?? ""}" /></label>
      </div>
      <label class="check"><input type="checkbox" name="active" ${v?.active === false ? "" : "checked"} /> Faol (reysga tanlanadi)</label>
      <div class="stack" style="margin-top:12px"><button class="btn" type="submit">Saqlash</button>${v ? '<button class="btn btn--ghost" type="button" id="vDel">O\'chirish</button>' : ""}</div>
    </form>`;
    $("#vForm").onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        await api(v ? `/api/vehicles/${v.id}` : "/api/vehicles", { method: v ? "PUT" : "POST", body: { name: f.get("vehicleName"), plate: f.get("vehiclePlate"), capacityKg: f.get("capacityKg"), capacityBoxes: f.get("capacityBoxes"), active: f.has("active") } });
        toast("Saqlandi");
        closeDrawer();
        render();
      } catch (err) {
        toast(err.message);
      }
    };
    if (v) {
      $("#vDel").onclick = async () => {
        if (!window.confirm(`«${v.name}» o'chirilsinmi?`)) return;
        await api(`/api/vehicles/${v.id}`, { method: "DELETE" }).catch((err) => toast(err.message));
        closeDrawer();
        render();
      };
    }
  });
}

// ---------- complaints: tasks with a 24-hour deadline ----------
const COMPLAINT_TYPES = { broken: "Singan / shikastlangan", missing: "Qism yetishmaydi", wrong: "Boshqa mahsulot keldi", assembly: "Yig'ishda muammo", quality: "Sifat / nuqson", other: "Boshqa" };
const RESOLUTIONS = {
  part: "Qism yuboriladi",
  replace: "Almashtiriladi",
  master: "Usta yuboriladi",
  refund_partial: "Qisman pul qaytarish",
  refund_full: "To'liq pul qaytarish",
  advice: "Maslahat, hal bo'ldi",
  reject: "Asossiz",
};
const COMPLAINT_STATE = { open: ["Yangi", "warn"], in_progress: ["Ishda", "teal"], resolved: ["Hal qilindi", "ok"], closed: ["Yopildi", "ok"] };
const overdue = (c) => ["open", "in_progress"].includes(c.status) && c.dueAt < Date.now();
const complaintPill = (c) => (overdue(c) ? pill(["Muddati o'tdi", "bad"]) : pill(COMPLAINT_STATE[c.status]));
let complaintFilter = "active";

views.complaints = async (page, tools) => {
  const list = await api("/api/complaints");
  const active = list.filter((c) => ["open", "in_progress"].includes(c.status));
  const rated = list.filter((c) => c.rating);
  const solved = list.filter((c) => c.resolution);
  const hours = solved.length ? solved.reduce((n, c) => n + (c.resolution.at - c.submittedAt), 0) / solved.length / 3600e3 : 0;
  const byType = Object.entries(COMPLAINT_TYPES).map(([k, label]) => ({ label, value: list.filter((c) => c.type === k).length })).filter((x) => x.value);
  // Which products draw complaints: the order lines behind each complaint.
  const orders = new Map((await ordersFor(365)).map((o) => [o.id, o]));
  const byProduct = new Map();
  for (const c of list) for (const l of orders.get(c.orderId)?.lines ?? []) byProduct.set(l.name, (byProduct.get(l.name) || 0) + 1);
  const topProducts = [...byProduct].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([label, value]) => ({ label, value, text: `${value} ta` }));
  tools.innerHTML = `<div class="seg">${[["active", "Faol"], ["resolved", "Hal qilingan"], ["all", "Hammasi"]].map(([k, l]) => `<button type="button" data-cf="${k}" class="${k === complaintFilter ? "on" : ""}">${l}</button>`).join("")}</div>`;
  tools.onclick = (e) => {
    const b = e.target.closest("[data-cf]");
    if (!b) return;
    complaintFilter = b.dataset.cf;
    render();
  };
  const shown = list.filter((c) => complaintFilter === "all" || (complaintFilter === "active" ? ["open", "in_progress"].includes(c.status) : ["resolved", "closed"].includes(c.status)));
  page.innerHTML = `
    <div class="grid cols-4">
      <div class="card kpi"><small>Faol shikoyatlar</small><b>${active.length}</b><span>${active.filter((c) => c.status === "open").length} tasi hali olinmagan</span></div>
      <div class="card kpi"><small>Muddati o'tgan</small><b>${list.filter(overdue).length}</b><span>javob muddati 24 soat</span></div>
      <div class="card kpi"><small>O'rtacha hal qilish</small><b>${solved.length ? `${Math.round(hours)} soat` : "—"}</b><span>${solved.length} ta yechim</span></div>
      <div class="card kpi"><small>Mijoz bahosi</small><b>${rated.length ? (rated.reduce((n, c) => n + c.rating, 0) / rated.length).toFixed(1) : "—"} ⭐</b><span>${rated.length} ta baho</span></div>
    </div>
    <div class="table-wrap" style="margin-top:16px"><table><thead><tr><th>№</th><th>Buyurtma</th><th>Mijoz</th><th>Turi</th><th>Muammo</th><th>Muddat</th><th>Mas'ul</th><th>Holat</th></tr></thead><tbody>${
      shown
        .map((c) => `<tr class="click" data-cmp="${c.id}"><td><b>S-${c.number}</b></td><td>#${c.orderNumber ?? "—"}</td><td>${esc(c.name)}<br><span class="muted">${esc(c.phone)}</span></td><td>${esc(COMPLAINT_TYPES[c.type] ?? "—")}</td><td>${esc(c.text.slice(0, 60))}${c.photos.length ? ` <span class="muted">📷${c.photos.length}</span>` : ""}</td><td>${when(c.dueAt)}</td><td>${esc(c.assignee ?? "—")}</td><td>${complaintPill(c)}${c.rating ? ` ${c.rating}⭐` : ""}</td></tr>`)
        .join("") || '<tr><td colspan="8" class="empty">Shikoyat yo\'q</td></tr>'
    }</tbody></table></div>
    <div class="grid cols-2" style="margin-top:16px">
      <div class="card"><h3>Turlar bo'yicha</h3>${byType.length ? hbars(byType.map((x) => ({ ...x, text: `${x.value} ta` }))) : '<p class="muted">Ma\'lumot yo\'q</p>'}</div>
      <div class="card"><h3>Ko'p shikoyat olgan mahsulotlar</h3>${topProducts.length ? hbars(topProducts) : '<p class="muted">Ma\'lumot yo\'q</p>'}<p class="muted" style="margin-top:8px">Fabrika bilan gaplashish uchun dalil: qaysi mahsulotda qaysi muammo takrorlanadi.</p></div>
    </div>`;
  page.onclick = (e) => {
    const row = e.target.closest("[data-cmp]");
    if (row) complaintDrawer(list.find((c) => c.id === row.dataset.cmp));
  };
};

function complaintDrawer(c) {
  openDrawer(`Shikoyat S-${c.number}`, (body) => {
    const open = ["open", "in_progress"].includes(c.status);
    body.innerHTML = `
      <p>${complaintPill(c)} <b>${esc(COMPLAINT_TYPES[c.type] ?? "")}</b></p>
      <p style="white-space:pre-wrap">${esc(c.text)}</p>
      ${c.photos.length ? `<div class="doc-photos">${c.photos.map((u, i) => `<a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt="Rasm ${i + 1}"/></a>`).join("")}</div>` : ""}
      <dl class="specs" style="margin-top:14px">
        <dt>Mijoz</dt><dd>${esc(c.name)}, ${esc(c.phone)}</dd>
        <dt>Buyurtma</dt><dd><a href="#" data-open-order="${c.orderId}">#${c.orderNumber ?? "—"}</a></dd>
        <dt>Yuborilgan</dt><dd>${when(c.submittedAt)} · javob muddati ${when(c.dueAt)}</dd>
        <dt>Mas'ul</dt><dd>${esc(c.assignee ?? "—")}</dd>
        ${c.resolution ? `<dt>Yechim</dt><dd>${esc(RESOLUTIONS[c.resolution.kind])}${c.resolution.amount ? ` · ${sum(c.resolution.amount)} so'm` : ""}${c.resolution.note ? ` · ${esc(c.resolution.note)}` : ""}</dd>` : ""}
        ${c.rating ? `<dt>Baho</dt><dd>${"⭐".repeat(c.rating)}</dd>` : ""}
      </dl>
      ${c.history.length ? `<h3 style="margin:16px 0 8px">Tarix</h3><ul class="timeline">${c.history.map((h) => `<li><small>${when(h.at)} · ${esc(h.by)}</small><span>${esc(h.text)}</span></li>`).join("")}</ul>` : ""}
      ${
        open
          ? `${c.status === "open" ? '<button class="btn" type="button" data-cact="take" style="margin-top:12px">🙋 Ishga olish</button>' : ""}
             <div class="stack" style="margin-top:12px"><input class="input" id="cMsg" placeholder="Mijozga xabar (bot orqali boradi)" style="flex:1"/><button class="btn btn--ghost" type="button" data-cact="message">Yuborish</button></div>
             <h3 style="margin:16px 0 8px">Yechim</h3>
             <div class="row2"><label class="field">Yechim<select id="cKind">${Object.entries(RESOLUTIONS).map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select></label>
             <label class="field">Qaytariladigan summa (qisman)<input class="input" id="cAmount" type="number" min="0" placeholder="faqat qisman qaytarishda"/></label></div>
             <label class="field">Izoh mijozga<input class="input" id="cNote" placeholder="Masalan: yangi eshik 2 kunda yetkaziladi"/></label>
             <button class="btn" type="button" data-cact="resolve" style="margin-top:8px">✅ Yechimni saqlash va mijozga yuborish</button>
             <p class="muted">Pul qaytarishda summa Buxgalteriyadagi "Pul qaytarish kutilmoqda" ro'yxatiga tushadi. Mijozdan baho so'raladi.</p>`
          : ""
      }`;
    body.onclick = async (e) => {
      const ord = e.target.closest("[data-open-order]");
      if (ord) {
        e.preventDefault();
        return openOrder(ord.dataset.openOrder);
      }
      const act = e.target.closest("[data-cact]")?.dataset.cact;
      if (!act) return;
      const payload = { take: {}, message: { text: $("#cMsg", body)?.value }, resolve: { kind: $("#cKind", body)?.value, amount: $("#cAmount", body)?.value, note: $("#cNote", body)?.value } }[act];
      try {
        const next = await api(`/api/complaints/${c.id}/${act}`, { method: "POST", body: payload });
        toast(act === "message" ? "Mijozga yuborildi" : "Saqlandi");
        dropOrders();
        complaintDrawer(next);
        if (act !== "message") render();
      } catch (err) {
        toast(err.message);
      }
    };
  });
}

// ---------- assembly masters ----------
const MJOB_STATE = { requested: ["Taklif", "warn"], accepted: ["Qabul qildi", "teal"], started: ["Ishlamoqda", "teal"], done: ["To'lov kutilmoqda", "warn"], paid: ["To'landi", "ok"], declined: ["Rad etdi", ""], cancelled: ["Bekor", ""] };

const masterPhotos = (photos = {}, admin = false) =>
  `<div class="doc-photos">${[["face", "Rasm"], ...(admin ? [["passport", "Pasport"]] : [])]
    .filter(([k]) => photos[k])
    .map(([k, label]) => `<a href="${esc(photos[k])}" target="_blank" rel="noopener"><img src="${esc(photos[k])}" alt="${label}"/><small>${label}</small></a>`)
    .join("")}${(photos.samples ?? []).map((u, i) => `<a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt=""/><small>Namuna ${i + 1}</small></a>`).join("")}</div>`;

function masterApplicationDrawer(a) {
  openDrawer("Usta arizasi", (body) => {
    body.innerHTML = `${masterPhotos(a.photos, true)}
      <dl class="specs" style="margin-top:14px">
        <dt>Ism</dt><dd>${esc(a.name)}</dd><dt>Telefon</dt><dd>${esc(a.phone)}${a.username ? ` · @${esc(a.username)}` : ""}</dd>
        <dt>Tumanlar</dt><dd>${esc(a.districts.join(", "))}</dd><dt>Tajriba</dt><dd>${a.experience} yil</dd>
        <dt>O'zi haqida</dt><dd>${esc(a.about)}</dd><dt>Karta</dt><dd>${esc(a.cardMasked)} · ${esc(a.holder)}</dd>
      </dl>
      <div class="stack" style="margin-top:14px"><button class="btn" type="button" id="mOk">✅ Tasdiqlash</button></div>
      <div class="stack" style="margin-top:10px"><input class="input" id="mReason" placeholder="Rad etish sababi" style="flex:1"/><button class="btn btn--ghost" type="button" id="mNo">Rad etish</button></div>`;
    const act = (path, payload) => async () => {
      try {
        await api(`/api/master-applications/${a.id}/${path}`, { method: "POST", body: payload() });
        toast(path === "approve" ? "Usta qabul qilindi" : "Rad etildi");
        closeDrawer();
        render();
      } catch (err) {
        toast(err.message);
      }
    };
    $("#mOk", body).onclick = act("approve", () => ({}));
    $("#mNo", body).onclick = act("reject", () => ({ reason: $("#mReason", body).value }));
  });
}

views.masters = async (page, tools) => {
  const [masters, jobs] = await Promise.all([api("/api/masters/all"), api("/api/assembly/jobs")]);
  const month = Date.now() - 30 * DAY;
  const paid = jobs.filter((j) => j.status === "paid");
  const monthPaid = paid.filter((j) => j.paidAt >= month);
  const unpaid = masters.reduce((n, m) => n + m.admin.unpaid, 0);
  tools.innerHTML = "";
  page.innerHTML = `
    <div class="grid cols-4">
      <div class="card kpi"><small>Faol ustalar</small><b>${masters.filter((m) => m.admin.status === "active").length}</b><span>${masters.filter((m) => m.admin.status === "blocked").length} tasi bloklangan</span></div>
      <div class="card kpi"><small>Yig'ish ishlari · 30 kun</small><b>${monthPaid.length}</b><span>${jobs.filter((j) => ["requested", "accepted", "started"].includes(j.status)).length} tasi jarayonda</span></div>
      <div class="card kpi"><small>Komissiya daromadi · 30 kun</small><b>${sum(monthPaid.reduce((n, j) => n + j.fee - j.masterAmount, 0))} so'm</b><span>yig'ish tushumi ${sum(monthPaid.reduce((n, j) => n + j.fee, 0))}</span></div>
      <div class="card kpi"><small>Ustalarga to'lanadi</small><b>${sum(unpaid)} so'm</b><span>${jobs.filter((j) => j.status === "done").length} ta ish mijoz to'lovini kutmoqda</span></div>
    </div>
    <div class="table-wrap" style="margin-top:16px"><table><thead><tr><th>Usta</th><th>Tumanlar</th><th class="num">Reyting</th><th class="num">Ishlar</th><th class="num">Ishlagan</th><th class="num">To'lanadi</th><th>Holat</th></tr></thead><tbody>${
      masters
        .sort((a, b) => b.admin.unpaid - a.admin.unpaid || (b.rating ?? 0) - (a.rating ?? 0))
        .map((m) => `<tr class="click" data-master="${m.id}"><td><b>${esc(m.name)}</b><br><span class="muted">${esc(m.admin.phone)}</span></td><td>${esc(m.districts.join(", "))}</td><td class="num">${m.rating ? `⭐ ${m.rating} (${m.ratingCount})` : "—"}</td><td class="num">${m.jobsDone}</td><td class="num">${sum(m.admin.earned)}</td><td class="num"><b>${m.admin.unpaid ? sum(m.admin.unpaid) : "—"}</b></td><td>${m.admin.status === "active" ? pill(["Faol", "ok"]) : pill(["Bloklangan", "bad"])}</td></tr>`)
        .join("") || '<tr><td colspan="7" class="empty">Hali usta yo\'q. Ustalar usta botida ro\'yxatdan o\'tadi, HR Xodimlar bo\'limida tasdiqlaydi.</td></tr>'
    }</tbody></table></div>
    <h3 style="margin:20px 0 10px">Yig'ish ishlari</h3>
    <div class="table-wrap"><table><thead><tr><th>№</th><th>Sana</th><th>Usta</th><th>Mijoz</th><th>Buyurtma</th><th class="num">Narx</th><th class="num">Komissiya</th><th>Baho</th><th>Holat</th></tr></thead><tbody>${
      jobs
        .map((j) => `<tr><td>#${j.number}</td><td>${esc(j.date)}</td><td>${esc(j.masterName)}</td><td>${esc(j.customerName)}<br><span class="muted">${esc(j.customerPhone)}</span></td><td>#${j.orderNumber ?? "—"}</td><td class="num">${sum(j.fee)}</td><td class="num">${sum(j.fee - j.masterAmount)}</td><td>${j.rating ? `${"⭐".repeat(j.rating)}${j.review ? `<br><span class="muted">${esc(j.review)}</span>` : ""}` : "—"}</td><td>${pill(MJOB_STATE[j.status])}${j.donePhoto ? ` <a href="${esc(j.donePhoto)}" target="_blank" rel="noopener">📷</a>` : ""}</td></tr>`)
        .join("") || '<tr><td colspan="9" class="empty">Hali ish yo\'q</td></tr>'
    }</tbody></table></div>`;
  page.onclick = (e) => {
    const row = e.target.closest("[data-master]");
    if (row) masterDrawer(masters.find((m) => m.id === row.dataset.master));
  };
};

function masterDrawer(m) {
  openDrawer(m.name, (body) => {
    body.innerHTML = `${masterPhotos({ ...m.photosAll, face: m.photo, passport: m.admin.passport, samples: m.samples }, true)}
      <dl class="specs" style="margin-top:14px">
        <dt>Telefon</dt><dd>${esc(m.admin.phone)}${m.admin.username ? ` · @${esc(m.admin.username)}` : ""}</dd>
        <dt>Tumanlar</dt><dd>${esc(m.districts.join(", "))}</dd><dt>Tajriba</dt><dd>${m.experience} yil</dd>
        <dt>Reyting</dt><dd>${m.rating ? `⭐ ${m.rating} (${m.ratingCount} baho)` : "—"} · ${m.jobsDone} ta ish</dd>
        <dt>Ishlagan</dt><dd>${sum(m.admin.earned)} so'm</dd>
        <dt>Karta</dt><dd><b>${esc(m.admin.card.replace(/(\d{4})(?=\d)/g, "$1 "))}</b> · ${esc(m.admin.holder)} <button class="btn btn--ghost" type="button" id="copyCard">Nusxa</button></dd>
      </dl>
      ${
        m.admin.unpaid
          ? `<div class="note" style="margin-top:12px">💳 Ustaga to'lanadi: <b>${sum(m.admin.unpaid)} so'm</b>. Kartaga o'tkazgach, «O'tkazildi» ni bosing — ustaga botda xabar boradi.</div>
             <button class="btn" type="button" id="payout" style="margin-top:8px">✅ ${sum(m.admin.unpaid)} so'm o'tkazildi</button>`
          : '<p class="muted" style="margin-top:12px">To\'lanadigan summa yo\'q.</p>'
      }
      <div class="stack" style="margin-top:14px">${m.admin.status === "active" ? '<button class="btn btn--ghost" type="button" data-mact="block">⛔ Bloklash</button>' : '<button class="btn" type="button" data-mact="unblock">✅ Faollashtirish</button>'}</div>`;
    $("#copyCard", body).onclick = () => navigator.clipboard.writeText(m.admin.card).then(() => toast("Karta raqami nusxalandi"), () => toast("Nusxa olib bo'lmadi"));
    body.onclick = async (e) => {
      const act = e.target.closest("#payout") ? "payout" : e.target.closest("[data-mact]")?.dataset.mact;
      if (!act) return;
      if (act === "block" && !window.confirm(`${m.name} bloklansinmi? Mijozlar uni ko'rmaydi.`)) return;
      try {
        await api(`/api/masters/${m.id}/${act}`, { method: "POST" });
        toast({ payout: "To'lov yozildi", block: "Bloklandi", unblock: "Faollashtirildi" }[act]);
        closeDrawer();
        render();
      } catch (err) {
        toast(err.message);
      }
    };
  });
}

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
    body.innerHTML = `<form autocomplete="off" id="bForm">
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

// ---------- HR: driver applications and trust ----------
// Contract drivers carry prepaid orders only; HR may let a staff driver collect cash.
const DRIVER_TRUST = (m) =>
  m.employment === "staff" ? `Shtatda · ${m.cashAllowed ? "💵 naqd ruxsat" : "faqat onlayn to'lov"}` : m.employment === "contract" ? "Alohida · faqat onlayn to'lov" : "HR qarori kerak · faqat onlayn to'lov";

const docPhotos = (photos = {}) =>
  `<div class="doc-photos">${[["withCar", "Mashina oldida"], ["passport", "Pasport"], ["license", "Prava"], ["techpass", "Texpasport"], ["carFront", "Oldi (raqam)"], ["carBack", "Orqasi (raqam)"], ["carLeft", "Chap yoni"], ["carRight", "O'ng yoni"]]
    .map(([k, label]) => (photos[k] ? `<a href="${esc(photos[k])}" target="_blank" rel="noopener"><img src="${esc(photos[k])}" alt="${label}"/><small>${label}</small></a>` : ""))
    .join("")}</div>`;

const trustFields = (m) => `
  <div style="display:grid;gap:6px;margin-top:14px"><b>Ish turi</b>
    <label class="check"><input type="radio" name="employment" value="staff" ${m.employment === "staff" ? "checked" : ""}/> Shtatda (kompaniya xodimi)</label>
    <label class="check"><input type="radio" name="employment" value="contract" ${m.employment !== "staff" ? "checked" : ""}/> Alohida (yollanma, o'z mashinasi bilan)</label>
  </div>
  <label class="check" style="margin-top:8px"><input type="checkbox" name="cashAllowed" ${m.cashAllowed ? "checked" : ""} ${m.employment === "staff" ? "" : "disabled"}/> 💵 Naqd pul olishga ruxsat (naqd to'lovli buyurtmalar biriktiriladi)</label>
  <p class="muted">Naqd ruxsatini faqat shtatdagi va ishonchli haydovchiga bering. Ruxsatsiz haydovchiga tizim faqat oldindan to'langan buyurtmalarni biriktiradi.</p>`;

function bindTrust(form) {
  const sync = () => {
    const staffJob = form.querySelector("[name=employment]:checked")?.value === "staff";
    const cash = form.querySelector("[name=cashAllowed]");
    cash.disabled = !staffJob;
    if (!staffJob) cash.checked = false;
  };
  form.onchange = sync;
  sync();
  return () => ({ employment: form.querySelector("[name=employment]:checked").value, cashAllowed: form.querySelector("[name=cashAllowed]").checked });
}

function applicationDrawer(a) {
  openDrawer("Haydovchi arizasi", (body) => {
    body.innerHTML = `${docPhotos(a.photos)}
      <dl class="specs" style="margin-top:14px">
        <dt>Ism</dt><dd>${esc(a.name)}</dd><dt>Telefon</dt><dd>${esc(a.phone)}${a.username ? ` · @${esc(a.username)}` : ""}</dd>
        <dt>Mashina</dt><dd>${esc(a.car)} · ${esc(a.plate)} · ${a.capacityKg} kg</dd><dt>Yuborilgan</dt><dd>${when(a.submittedAt)}</dd>
      </dl>
      <form id="trustForm">${trustFields({ employment: "contract" })}</form>
      <div class="stack" style="margin-top:14px"><button class="btn" type="button" id="appOk">✅ Tasdiqlash</button></div>
      <div class="stack" style="margin-top:10px"><input class="input" id="rejectReason" placeholder="Rad etish sababi" style="flex:1"/><button class="btn btn--ghost" type="button" id="appNo">Rad etish</button></div>`;
    const trust = bindTrust($("#trustForm", body));
    const act = (path, payload) => async () => {
      try {
        await api(`/api/driver-applications/${a.id}/${path}`, { method: "POST", body: payload() });
        toast(path === "approve" ? "Qabul qilindi, haydovchiga xabar ketdi" : "Rad etildi");
        closeDrawer();
        render();
      } catch (err) {
        toast(err.message);
      }
    };
    $("#appOk", body).onclick = act("approve", trust);
    $("#appNo", body).onclick = act("reject", () => ({ reason: $("#rejectReason", body).value }));
  });
}

function driverDrawer(m) {
  openDrawer(m.name, (body) => {
    body.innerHTML = `${m.photos ? docPhotos(m.photos) : ""}
      <dl class="specs" style="margin-top:14px"><dt>Telefon</dt><dd>${esc(m.phone || "—")}${m.username ? ` · @${esc(m.username)}` : ""}</dd><dt>Holat</dt><dd>${esc(DRIVER_TRUST(m))}</dd><dt>Qo'shilgan</dt><dd>${when(m.addedAt)}${m.approvedBy ? ` · ${esc(m.approvedBy)}` : ""}</dd></dl>
      <form id="trustForm">${trustFields(m)}</form>
      <button class="btn" type="button" id="trustSave" style="margin-top:12px">Saqlash</button>`;
    const trust = bindTrust($("#trustForm", body));
    $("#trustSave", body).onclick = async () => {
      try {
        await api(`/api/staff/${m.id}/trust`, { method: "PUT", body: trust() });
        toast("Saqlandi");
        closeDrawer();
        render();
      } catch (err) {
        toast(err.message);
      }
    };
  });
}

// ---------- HR: payroll, attendance, payments ----------
let hrMonth = null;
const PAY_TYPES = { advance: "Avans", salary: "Oylik", bonus: "Bonus" };
// An advance larger than what has accrued so far shows as overpaid, not as a negative debt.
const balanceCell = (n) => (n < 0 ? `<b style="color:#c0392b">${sum(-n)}</b><br><span class="muted">ortiqcha berilgan</span>` : `<b>${sum(n)}</b>`);
const hhmm = (ts) => (ts ? new Date(ts + 5 * 3600e3).toISOString().slice(11, 16) : "—");

function employeeForm(e) {
  openDrawer(e ? e.name : "Yangi xodim (oylikli)", (body) => {
    body.innerHTML = `<form id="empForm" autocomplete="off">
      <label class="field">Ism-familiya<input class="input" name="empName" required value="${esc(e?.name)}" /></label>
      <div class="row2"><label class="field">Lavozim<input class="input" name="empPos" value="${esc(e?.position)}" placeholder="Omborchi, operator, buxgalter" /></label>
      <label class="field">Telefon<input class="input" name="empPhone" value="${esc(e?.phone)}" /></label></div>
      <label class="field">Oylik (qat'iy, so'm)<input class="input" name="empSalary" type="number" min="0" step="10000" required value="${e?.salary ?? ""}" /></label>
      ${e ? `<label class="check"><input type="checkbox" name="empActive" ${e.active === false ? "" : "checked"}/> Ishlayapti</label>` : ""}
      <button class="btn" type="submit" style="margin-top:10px">Saqlash</button></form>
      <p class="muted" style="margin-top:10px">Saqlagach, xodim kartasidan «Telegram'ni ulash» havolasini oling: xodim uni bosib, botda «📍 Keldim / Ketdim» bilan keldi-ketdini belgilaydi.</p>`;
    $("#empForm", body).onsubmit = async (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target);
      try {
        await api(e ? `/api/hr/employees/${e.id}` : "/api/hr/employees", { method: e ? "PUT" : "POST", body: { name: f.get("empName"), position: f.get("empPos"), phone: f.get("empPhone"), salary: f.get("empSalary"), active: e ? f.has("empActive") : true } });
        toast("Saqlandi");
        closeDrawer();
        render();
      } catch (err) {
        toast(err.message);
      }
    };
  });
}

function payForm(row) {
  return `<h3 style="margin:16px 0 8px">💸 To'lov berish (${hrMonth})</h3>
    <div class="row2"><label class="field">Turi<select id="pType">${Object.entries(PAY_TYPES).map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select></label>
    <label class="field">Summa<input class="input" id="pAmount" type="number" min="1" value="${Math.max(0, row.balance)}" /></label></div>
    <div class="row2"><label class="field">Qayerdan<select id="pFrom"><option value="card">💳 Kartaga (bank)</option><option value="cash">💵 Kassadan naqd</option></select></label>
    <label class="field">Izoh<input class="input" id="pNote" /></label></div>
    <button class="btn" type="button" id="pGo">Berildi deb yozish</button>`;
}

async function personDrawer(row) {
  if (row.kind === "master") {
    location.hash = "#masters";
    return;
  }
  openDrawer(row.name, async (body) => {
    body.innerHTML = '<p class="empty">Yuklanmoqda…</p>';
    const d = await api(`/api/hr/person?key=${encodeURIComponent(row.key)}&month=${hrMonth}`);
    const head = `<div class="grid cols-2" style="gap:10px"><div class="card kpi"><small>Hisoblangan</small><b>${sum(row.accrued + row.bonus)}</b><span>${esc(row.work)}</span></div><div class="card kpi"><small>Berilishi kerak</small><b>${balanceCell(row.balance)}</b><span>berilgan ${sum(row.paid)}</span></div></div>`;
    const payments = `<h3 style="margin:16px 0 8px">To'lovlar tarixi</h3><ul class="list">${d.payments.map((p) => `<li><span>${PAY_TYPES[p.type]} · ${p.month}<br><span class="muted">${when(p.at)} · ${p.from === "cash" ? "kassadan" : "kartaga"} · ${esc(p.by)}${p.note ? ` · ${esc(p.note)}` : ""}</span></span><b>${sum(p.amount)}</b></li>`).join("") || '<li class="muted">Hali to\'lov yo\'q</li>'}</ul>`;
    if (d.kind === "emp") {
      const e = d.employee;
      body.innerHTML = `${head}
        <dl class="specs" style="margin-top:12px"><dt>Lavozim</dt><dd>${esc(e.position || "—")}</dd><dt>Oylik</dt><dd>${sum(e.salary)} so'm · soatiga ${sum(row.detail.rate)}</dd><dt>Telegram</dt><dd>${e.telegramId ? `ulangan${e.username ? ` · @${esc(e.username)}` : ""}` : '<button class="btn btn--ghost" type="button" id="empLink">🔗 Ulash havolasini olish</button>'}</dd></dl>
        <button class="btn btn--ghost" type="button" id="empEdit" style="margin-top:8px">✏️ Tahrirlash</button>
        <h3 style="margin:16px 0 8px">Keldi-ketdi · ${hrMonth}</h3>
        <div class="table-wrap"><table><thead><tr><th>Sana</th><th>Keldi</th><th>Ketdi</th><th class="num">Soat</th><th>Izoh</th></tr></thead><tbody>${
          d.attendance.map((a) => `<tr><td>${a.date}</td><td>${hhmm(a.inAt)}${a.lateMin ? ` <span style="color:#c0392b">+${a.lateMin} daq</span>` : ""}</td><td>${a.outAt ? hhmm(a.outAt) : '<span class="muted">bosilmagan</span>'}</td><td class="num">${a.hours}</td><td>${a.corrected ? `✏️ ${esc(a.corrected.note)}` : ""}</td></tr>`).join("") || '<tr><td colspan="5" class="empty">Bu oy belgilanmagan</td></tr>'
        }</tbody></table></div>
        <details style="margin-top:10px"><summary>✏️ Kunni tuzatish (unutilgan ketdi, tizimdan tashqari kun)</summary>
          <div class="row2"><label class="field">Sana<input class="input" type="date" id="aDate" value="${dayKey(Date.now())}"/></label><label class="field">Izoh (majburiy)<input class="input" id="aNote"/></label></div>
          <div class="row2"><label class="field">Keldi<input class="input" type="time" id="aIn" value="${d.settings.start}"/></label><label class="field">Ketdi<input class="input" type="time" id="aOut" value="${d.settings.end}"/></label></div>
          <button class="btn btn--ghost" type="button" id="aSave">Saqlash</button></details>
        ${payForm(row)}${payments}`;
      $("#empEdit", body).onclick = () => employeeForm(e);
      if ($("#empLink", body)) {
        $("#empLink", body).onclick = async () => {
          const { link } = await api(`/api/hr/employees/${e.id}/invite`, { method: "POST" });
          navigator.clipboard.writeText(link).catch(() => {});
          $("#empLink", body).outerHTML = `<span style="word-break:break-all">${esc(link)}</span><br><span class="muted">Nusxalandi. Xodimga yuboring (24 soat amal qiladi).</span>`;
        };
      }
      $("#aSave", body).onclick = async () => {
        try {
          await api("/api/hr/attendance", { method: "POST", body: { employeeId: e.id, date: $("#aDate", body).value, in: $("#aIn", body).value, out: $("#aOut", body).value, note: $("#aNote", body).value } });
          toast("Saqlandi");
          closeDrawer();
          render();
        } catch (err) {
          toast(err.message);
        }
      };
    } else {
      body.innerHTML = `${head}
        <h3 style="margin:16px 0 8px">Yetkazishlar · ${hrMonth}</h3>
        <div class="table-wrap"><table><thead><tr><th>Sana</th><th>Buyurtma</th><th class="num">km</th><th class="num">Yetkazish puli</th><th class="num">Haydovchiga</th><th>Baho</th></tr></thead><tbody>${
          d.deliveries.map((o) => `<tr><td>${when(o.at)}</td><td>#${o.number} ${esc(o.name)}</td><td class="num">${o.km ?? "—"}</td><td class="num">${sum(o.fee)}</td><td class="num"><b>${sum(o.pay)}</b></td><td>${o.rating ? "⭐".repeat(o.rating) : "—"}</td></tr>`).join("") || '<tr><td colspan="6" class="empty">Bu oy yetkazish yo\'q</td></tr>'
        }</tbody></table></div>
        <h3 style="margin:16px 0 8px">📸 Reklama hisobotlari</h3><ul class="list">${d.ads.map((r) => `<li><span>${r.month}</span>${pill(r.status === "approved" ? [`+${sum(r.amount)}`, "ok"] : r.status === "pending" ? ["Ko'rib chiqilmoqda", "warn"] : r.status === "rejected" ? ["Rad etilgan", "bad"] : ["Yuborilmagan", ""])}</li>`).join("") || '<li class="muted">Hali yo\'q</li>'}</ul>
        ${payForm(row)}${payments}`;
    }
    $("#pGo", body).onclick = async () => {
      try {
        await api("/api/hr/pay", { method: "POST", body: { key: row.key, name: row.name, month: hrMonth, type: $("#pType", body).value, amount: $("#pAmount", body).value, from: $("#pFrom", body).value, note: $("#pNote", body).value } });
        toast("To'lov yozildi");
        closeDrawer();
        render();
      } catch (err) {
        toast(err.message);
      }
    };
  });
}

function adDrawer(r) {
  openDrawer(`Reklama hisoboti: ${r.driverName ?? ""}`, (body) => {
    body.innerHTML = `<p>${r.month} · ${when(r.submittedAt)}</p>
      <div class="doc-photos">${[["front", "Oldidan"], ["back", "Orqasidan"], ["left", "Chap"], ["right", "O'ng"]].map(([k, l]) => `<a href="${esc(r.photos[k])}" target="_blank" rel="noopener"><img src="${esc(r.photos[k])}" alt="${l}"/><small>${l}</small></a>`).join("")}</div>
      <div class="stack" style="margin-top:14px"><button class="btn" type="button" id="adOk">✅ Tasdiqlash (bonus qo'shiladi)</button></div>
      <div class="stack" style="margin-top:10px"><input class="input" id="adReason" placeholder="Rad etish sababi" style="flex:1"/><button class="btn btn--ghost" type="button" id="adNo">Rad etish</button></div>`;
    const act = (path, payload) => async () => {
      try {
        await api(`/api/hr/ad-reports/${encodeURIComponent(r.id)}/${path}`, { method: "POST", body: payload() });
        toast(path === "approve" ? "Tasdiqlandi" : "Rad etildi");
        closeDrawer();
        render();
      } catch (err) {
        toast(err.message);
      }
    };
    $("#adOk", body).onclick = act("approve", () => ({}));
    $("#adNo", body).onclick = act("reject", () => ({ reason: $("#adReason", body).value }));
  });
}

views.staff = async (page, tools) => {
  hrMonth ??= dayKey(Date.now()).slice(0, 7);
  const months = Array.from({ length: 4 }, (_, i) => { const d = new Date(Date.now() + 5 * 3600e3); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - i); return d.toISOString().slice(0, 7); });
  tools.innerHTML = `<select class="input" id="hrMonth" style="width:auto">${months.map((m) => `<option ${m === hrMonth ? "selected" : ""}>${m}</option>`).join("")}</select><button class="btn" type="button" id="newEmp">＋ Xodim (oylikli)</button><button class="btn btn--ghost" type="button" data-invite="warehouse">＋ Omborchi</button><button class="btn btn--ghost" type="button" data-invite="driver">＋ Haydovchi</button>`;
  const [staff, screens, apps, masterApps, pay, ads] = await Promise.all([api("/api/staff"), api("/api/screens"), api("/api/driver-applications"), api("/api/master-applications"), api(`/api/hr/summary?month=${hrMonth}`), api("/api/hr/ad-reports")]);
  const totals = pay.rows.reduce((t, r) => ({ accrued: t.accrued + r.accrued + r.bonus, paid: t.paid + r.paid, balance: t.balance + r.balance }), { accrued: 0, paid: 0, balance: 0 });
  page.innerHTML = `
    <div class="grid cols-4">
      <div class="card kpi"><small>Hisoblangan · ${hrMonth}</small><b>${sum(totals.accrued)} so'm</b><span>oylik, yetkazish, ishlar, bonus</span></div>
      <div class="card kpi"><small>Berilgan</small><b>${sum(totals.paid)} so'm</b><span>avans va oylik</span></div>
      <div class="card kpi"><small>Berilishi kerak</small><b>${sum(totals.balance)} so'm</b><span>bugungi holat</span></div>
      <div class="card kpi"><small>Oy normasi</small><b>${pay.normHours} soat</b><span>${pay.settings.start}–${pay.settings.end}</span></div>
    </div>
    ${
      ads.length
        ? `<div class="card" style="margin-top:16px"><h3>📸 Reklama hisobotlari (${ads.length})</h3><ul class="list">${ads.map((r) => `<li data-ad="${esc(r.id)}" style="cursor:pointer"><span><b>${esc(r.driverName ?? r.driverId)}</b> · ${r.month}<br><span class="muted">${when(r.submittedAt)} · 4 ta rasm</span></span>${pill(["Ko'rib chiqish", "warn"])}</li>`).join("")}</ul></div>`
        : ""
    }
    <div class="table-wrap" style="margin-top:16px"><table><thead><tr><th>Xodim</th><th>Lavozim</th><th>Ishlagan</th><th class="num">Hisoblangan</th><th class="num">Bonus</th><th class="num">Berilgan</th><th class="num">Berilishi kerak</th></tr></thead><tbody>${
      pay.rows
        .filter((r) => r.active || r.accrued || r.paid)
        .map((r) => `<tr class="click" data-person="${esc(r.key)}"><td><b>${esc(r.name)}</b>${r.kind === "employee" && !r.linked ? '<br><span class="muted">⚠️ Telegram ulanmagan</span>' : ""}</td><td>${esc(r.position)}</td><td>${esc(r.work)}</td><td class="num">${sum(r.accrued)}</td><td class="num">${r.bonus ? sum(r.bonus) : "—"}</td><td class="num">${r.paid ? sum(r.paid) : "—"}</td><td class="num">${balanceCell(r.balance)}</td></tr>`)
        .join("") || '<tr><td colspan="7" class="empty">Hali xodim yo\'q. «＋ Xodim (oylikli)» bilan qo\'shing.</td></tr>'
    }</tbody></table></div>
    <p class="muted" style="margin-top:8px">Oylik ishlagan soat bo'yicha: oylik ÷ oy normasi (${pay.normHours} soat) × ishlagan soat. Haydovchi: yetkazish pulidan komissiyadan keyingi qismi + tasdiqlangan reklama bonusi. Usta: to'langan ishlardagi ulushi.</p>
    <div style="margin-top:16px"></div>
    ${
      apps.length
        ? `<div class="card" style="margin-bottom:16px"><h3>🆕 Haydovchi arizalari (${apps.length})</h3><ul class="list">${apps
            .map((a) => `<li data-app="${a.id}" style="cursor:pointer"><span style="display:flex;gap:12px;align-items:center"><img class="thumb" src="${esc(a.photos?.withCar)}" alt=""/><span><b>${esc(a.name)}</b> · ${esc(a.phone)}<br><span class="muted">${esc(a.car)} · ${esc(a.plate)} · ${a.capacityKg} kg · ${when(a.submittedAt)}</span></span></span>${pill(["Ko'rib chiqish", "warn"])}</li>`)
            .join("")}</ul></div>`
        : ""
    }
    ${
      masterApps.length
        ? `<div class="card" style="margin-bottom:16px"><h3>🔧 Usta arizalari (${masterApps.length})</h3><ul class="list">${masterApps
            .map((a) => `<li data-mapp="${a.id}" style="cursor:pointer"><span style="display:flex;gap:12px;align-items:center"><img class="thumb" src="${esc(a.photos?.face)}" alt=""/><span><b>${esc(a.name)}</b> · ${esc(a.phone)}<br><span class="muted">${esc(a.districts.join(", "))} · ${a.experience} yil · ${when(a.submittedAt)}</span></span></span>${pill(["Ko'rib chiqish", "warn"])}</li>`)
            .join("")}</ul></div>`
        : ""
    }
    <div class="grid cols-2">
      <div class="card"><h3>Xodimlar (${staff.length})</h3><ul class="list">${
        staff.map((m) => `<li ${m.role === "driver" ? `data-driver="${m.id}" style="cursor:pointer"` : ""}><span><b>${esc(m.name)}</b>${m.username ? ` <span class="muted">@${esc(m.username)}</span>` : ""}<br><span class="muted">${m.role === "driver" ? `Haydovchi · ${DRIVER_TRUST(m)}` : "Omborchi"} · qo'shilgan ${when(m.addedAt)}</span></span><button class="btn btn--ghost" data-remove="${m.id}" data-name="${esc(m.name)}">O'chirish</button></li>`).join("") ||
        '<li class="muted">Hali xodim yo\'q</li>'
      }</ul><p class="muted" style="margin-top:10px">Adminlar: ${state.info.admins} ta (deploy sozlamasida).</p></div>
      <div class="card"><h3>Ombor ekranlari (${screens.length})</h3><ul class="list">${
        screens.map((s) => `<li><span>🖥 ${esc(s.name)}<br><span class="muted">ulangan ${when(s.createdAt)}</span></span><button class="btn btn--ghost" data-unpair="${s.id}" data-name="${esc(s.name)}">Uzish</button></li>`).join("") || '<li class="muted">Ekran ulanmagan</li>'
      }</ul><p class="muted" style="margin-top:10px">Yangi ekran ulash: mini ilovada ☰ → 🖥 Ombor ekrani → Kod olish.</p></div>
    </div>
`;
  $("#hrMonth").onchange = (e) => {
    hrMonth = e.target.value;
    render();
  };
  tools.onclick = async (e) => {
    if (e.target.closest("#newEmp")) return employeeForm(null);
    const role = e.target.closest("[data-invite]")?.dataset.invite;
    if (!role) return;
    try {
      const { link, expiresAt } = await api("/api/staff/invites", { method: "POST", body: { role } });
      openDrawer("Taklif havolasi", (body) => {
        body.innerHTML = `<p>Havolani ${role === "driver" ? "haydovchiga" : "omborchiga"} yuboring. U Telegram'da bosib <b>Start</b> ni bossa, avtomatik qo'shiladi.</p>
          <p class="note" style="word-break:break-all">${esc(link)}</p><p class="muted">${when(expiresAt)} gacha, bir marta ishlaydi.</p>
          <button class="btn" id="copyLink">Nusxa olish</button>`;
        $("#copyLink", body).onclick = () => navigator.clipboard.writeText(link).then(() => toast("Nusxa olindi"), () => toast("Nusxa olib bo'lmadi, qo'lda belgilang"));
      });
    } catch (err) {
      toast(err.message);
    }
  };
  page.onclick = async (e) => {
    const person = e.target.closest("[data-person]");
    if (person) return personDrawer(pay.rows.find((r) => r.key === person.dataset.person));
    const adRow = e.target.closest("[data-ad]");
    if (adRow) return adDrawer(ads.find((r) => r.id === adRow.dataset.ad));
    const app = e.target.closest("[data-app]");
    if (app) return applicationDrawer(apps.find((a) => a.id === app.dataset.app));
    const mapp = e.target.closest("[data-mapp]");
    if (mapp) return masterApplicationDrawer(masterApps.find((a) => a.id === mapp.dataset.mapp));
    const rm = e.target.closest("[data-remove]");
    const un = e.target.closest("[data-unpair]");
    const drv = e.target.closest("[data-driver]");
    if (drv && !rm) return driverDrawer(staff.find((m) => m.id === drv.dataset.driver));
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
  const [cfg, seg, asm, hrs] = await Promise.all([api("/api/delivery/settings"), api("/api/crm/segments"), api("/api/assembly/settings"), api("/api/hr/settings")]);
  const info = state.info;
  page.innerHTML = `
    <div class="grid cols-2">
      <div class="card"><h3>🚚 Yetkazish narxlari</h3>
        <form autocomplete="off" id="dForm">
          <div class="row2">
            <label class="field">1 km narxi (so'm)<input class="input" name="perKm" type="number" min="0" value="${cfg.perKm}" /></label>
            <label class="field">Kompaniya komissiyasi, yetkazishdan %<input class="input" name="commission" type="number" min="0" max="100" step="0.5" value="${cfg.commission}" /></label>
          </div>
          <div class="row2">
            <label class="field">Uy ichigacha tushirish, 1 kg (so'm)<input class="input" name="unloadingPerKg" type="number" min="0" step="50" value="${cfg.unloadingPerKg}" /></label>
            <label class="field">Tushirishning eng kam narxi (so'm)<input class="input" name="unloadingMin" type="number" min="0" step="1000" value="${cfg.unloadingMin}" /></label>
          </div>
          <label class="field">Og'irligi kiritilmagan mahsulot bo'lsa: savdodan %<input class="input" name="unloadingPercent" type="number" min="0" max="100" step="0.1" value="${cfg.unloadingPercent}" /></label>
          <div class="row2">
            <label class="field">Liftsiz, har qavat (so'm)<input class="input" name="perFloor" type="number" min="0" value="${cfg.perFloor}" /></label>
            <label class="field">Bepul qavatlar<input class="input" name="freeFloors" type="number" min="0" max="30" value="${cfg.freeFloors}" /></label>
          </div>
          <div class="row2">
            <label class="field">Qayta yetkazish narxi (so'm, 0 = bepul)<input class="input" name="retryFee" type="number" min="0" value="${cfg.retryFee}" /></label>
            <label class="field">Topshirish urinishlari<input class="input" name="maxAttempts" type="number" min="1" max="5" value="${cfg.maxAttempts}" /></label>
          </div>
          <p class="muted">Mijoz uyda bo'lmasa yoki puli yetmasa, mebel omborga qaytadi va mijoz yangi vaqt tanlaydi. Urinishlar tugasa, buyurtma "qaror kerak" bo'ladi. Qarzga berilmaydi.</p>
          <label class="field">Ombor lokatsiyasi<input class="input" name="warehouse" placeholder="41.311, 69.279 yoki Google Maps havolasi" value="${cfg.warehouse ? `${cfg.warehouse.lat}, ${cfg.warehouse.lon}` : ""}" /></label>
          ${cfg.warehouse ? `<p class="muted"><a target="_blank" rel="noopener" href="https://maps.google.com/?q=${cfg.warehouse.lat},${cfg.warehouse.lon}">Xaritada ko'rish</a></p>` : '<p class="note">⚠️ Ombor lokatsiyasi kiritilmagan: masofa narxi hisoblanmayapti. Google Maps\'da omborni o\'ng tugma bilan bosing, koordinatani nusxalab shu yerga qo\'ying.</p>'}
          <button class="btn" type="submit" style="margin-top:8px">Saqlash</button>
        </form>
      </div>
      <div class="card"><h3>👥 Mijoz segmentlari</h3>
        <form autocomplete="off" id="sForm">
          <div class="row2">
            <label class="field">VIP: jami xarid, so'mdan<input class="input" name="vipSpend" type="number" min="1" step="1000" value="${seg.vipSpend}" /></label>
            <label class="field">Doimiy: kamida xaridlar soni<input class="input" name="repeatOrders" type="number" min="2" max="100" value="${seg.repeatOrders}" /></label>
          </div>
          <label class="field">Uzoq kelmagan: oxirgi buyurtmadan keyin, kun<input class="input" name="lostAfterDays" type="number" min="7" max="3650" value="${seg.lostAfterDays}" /></label>
          <label class="check"><input type="checkbox" name="vipLapse" ${seg.vipLapse ? "checked" : ""} /> VIP mijoz ham shuncha kun kelmasa «Uzoq kelmagan · VIP» ga o'tadi</label>
          <p class="muted">Segmentlar oxirgi 12 oydagi buyurtmalardan avtomatik hisoblanadi. Tartib: Uzoq kelmagan → VIP → Doimiy → Yangi. Bitta telefon raqami yoki bitta Telegram akkaunti = bitta mijoz.</p>
          <button class="btn" type="submit" style="margin-top:8px">Saqlash</button>
        </form>
      </div>
      <div class="card"><h3>👥 HR: ish vaqti va keldi-ketdi</h3>
        <form id="hForm" autocomplete="off">
          <div class="field">Ish kunlari<div class="stack" style="margin-top:6px">${[[1, "Du"], [2, "Se"], [3, "Ch"], [4, "Pa"], [5, "Ju"], [6, "Sh"], [0, "Ya"]].map(([d, l]) => `<label class="check"><input type="checkbox" name="wd" value="${d}" ${hrs.workDays.includes(d) ? "checked" : ""}/> ${l}</label>`).join("")}</div></div>
          <div class="row2"><label class="field">Ish boshlanishi<input class="input" name="start" type="time" value="${hrs.start}" /></label><label class="field">Ish tugashi<input class="input" name="end" type="time" value="${hrs.end}" /></label></div>
          <div class="row2"><label class="field">Keldi-ketdi radiusi, m<input class="input" name="radius" type="number" min="30" max="5000" value="${hrs.radius}" /></label><label class="field">Reklama bonusi (haydovchi, oyiga)<input class="input" name="adBonus" type="number" min="0" step="10000" value="${hrs.adBonus}" /></label></div>
          <label class="field">Ofis lokatsiyasi (ixtiyoriy; ombordan tashqari ish joyi)<input class="input" name="office" placeholder="41.311, 69.279" value="${hrs.office ? `${hrs.office.lat}, ${hrs.office.lon}` : ""}" /></label>
          <p class="muted">Xodim botda «📍 Keldim / Ketdim» bosganda joylashuvi ombor yoki ofisdan shu radius ichida bo'lishi kerak. Oylik: oylik ÷ oy normasi × ishlagan soat.</p>
          <button class="btn" type="submit" style="margin-top:8px">Saqlash</button>
        </form>
      </div>
      <div class="card"><h3>🔧 Yig'ish xizmati (ustalar)</h3>
        <form id="aForm" autocomplete="off">
          <div class="row2">
            <label class="field">Yig'ish narxi, mebel narxidan %<input class="input" name="percent" type="number" min="0" max="100" step="0.5" value="${asm.percent}" /></label>
            <label class="field">Eng kam yig'ish narxi, so'm<input class="input" name="minFee" type="number" min="0" step="1000" value="${asm.minFee}" /></label>
          </div>
          <label class="field">Kompaniya komissiyasi, yig'ish narxidan %<input class="input" name="commission" type="number" min="0" max="100" step="0.5" value="${asm.commission}" /></label>
          <p class="muted">Masalan: 10 000 000 so'mlik mebel → yig'ish ${sum(Math.max(asm.minFee, Math.round((10_000_000 * asm.percent) / 100 / 1000) * 1000))} so'm, ustaga ${sum(Math.max(asm.minFee, Math.round((10_000_000 * asm.percent) / 100 / 1000) * 1000) * (1 - asm.commission / 100))} so'm. Yangi qoidalar yangi ishlarga qo'llanadi.</p>
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
  $("#hForm").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const raw = String(f.get("office") || "").trim();
    const m = /(-?\d{1,2}\.\d+)\s*[, ]\s*(-?\d{1,3}\.\d+)/.exec(raw);
    if (raw && !m) return toast("Ofis lokatsiyasini 41.311, 69.279 ko'rinishida yozing");
    try {
      await api("/api/hr/settings", { method: "PUT", body: { workDays: f.getAll("wd").map(Number), start: f.get("start"), end: f.get("end"), radius: f.get("radius"), adBonus: f.get("adBonus"), office: m ? { lat: Number(m[1]), lon: Number(m[2]) } : null } });
      toast("Saqlandi");
      render();
    } catch (err) {
      toast(err.message);
    }
  };
  $("#aForm").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api("/api/assembly/settings", { method: "PUT", body: { percent: f.get("percent"), minFee: f.get("minFee"), commission: f.get("commission") } });
      toast("Saqlandi");
      render();
    } catch (err) {
      toast(err.message);
    }
  };
  $("#sForm").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api("/api/crm/segments", { method: "PUT", body: { vipSpend: f.get("vipSpend"), repeatOrders: f.get("repeatOrders"), lostAfterDays: f.get("lostAfterDays"), vipLapse: f.has("vipLapse") } });
      toast("Saqlandi");
      render();
    } catch (err) {
      toast(err.message);
    }
  };
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
      await api("/api/delivery/settings", { method: "PUT", body: { perKm: f.get("perKm"), commission: f.get("commission"), unloadingPerKg: f.get("unloadingPerKg"), unloadingPercent: f.get("unloadingPercent"), unloadingMin: f.get("unloadingMin"), perFloor: f.get("perFloor"), freeFloors: f.get("freeFloors"), retryFee: f.get("retryFee"), maxAttempts: f.get("maxAttempts"), warehouse } });
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
  complaints: "Shikoyatlar",
  masters: "Ustalar",
  products: "Mahsulotlar (SKU)",
  stock: "Ombor",
  purchases: "Zakup",
  finance: "Moliya",
  cash: "Kassa",
  accounting: "Buxgalteriya",
  marketing: "Marketing",
  staff: "Xodimlar (HR)",
  settings: "Sozlamalar",
};

async function render() {
  const route = TITLES[location.hash.slice(1)] ? location.hash.slice(1) : "dashboard";
  document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("on", a.dataset.route === route));
  $("#pageTitle").textContent = TITLES[route];
  // Fresh page and toolbar nodes per render: a slower earlier view still loading writes into the
  // detached old nodes instead of over the page the user switched to.
  const page = $("#page").cloneNode(false);
  const tools = $("#topTools").cloneNode(false);
  $("#page").replaceWith(page);
  $("#topTools").replaceWith(tools);
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
    [state.info, , state.suppliers] = await Promise.all([api("/api/admin/info"), refreshProducts(), api("/api/suppliers")]);
  } catch (err) {
    return showLogin(err.message);
  }
  $("#whoami").textContent = "Admin";
  $("#loginView").hidden = true;
  $("#appView").hidden = false;
  render();
})();
