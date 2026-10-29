const tg = window.Telegram?.WebApp;
const $ = (sel) => document.querySelector(sel);

// ---------- Telegram setup ----------
if (tg) {
  tg.ready();
  tg.expand();
  tg.setHeaderColor?.("#008E9B");
  tg.setBackgroundColor?.("#FFFFFF");
  tg.setBottomBarColor?.("#FFFFFF");
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-telegram-init-data": tg?.initData || "",
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Xatolik yuz berdi");
  return data;
}

// ---------- state ----------
const state = {
  categories: [],
  products: [],
  role: null, // "admin" | "warehouse" | null
  query: "",
  orderType: load("em_order_type", null),
  cart: load("em_cart", {}),
  banners: [],
};

function load(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

const sum = (n) => Math.round(n).toLocaleString("ru-RU").replace(/[\s,]/g, " ");
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const byId = (id) => state.products.find((p) => p.id === id);
const isAdmin = () => state.role === "admin";
const isStaff = () => state.role !== null;
const cover = (p) => p.images?.[0] || `/img/${p.category}.svg`;
const haptic = (type = "light") => tg?.HapticFeedback?.impactOccurred(type);

function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 2200);
}

// ---------- header ----------
function renderHeader() {
  const user = tg?.initDataUnsafe?.user;
  const avatar = $("#avatar");
  if (user?.photo_url) {
    $("#avatarBtn").style.backgroundImage = `url("${user.photo_url}")`;
    avatar.textContent = "";
  } else if (user) {
    avatar.textContent = (user.first_name?.[0] || "") + (user.last_name?.[0] || "");
  }
  $("#orderTypeLabel").textContent =
    state.orderType === "pickup" ? "Olib ketish" : state.orderType === "delivery" ? "Yetkazib berish" : "Buyurtma turi";
}

// ---------- banners ----------
function bannerHtml(b) {
  const link = b.linkType === "none" ? "" : `data-link="${b.linkType}:${esc(b.linkId)}"`;
  if (b.style === "photo") {
    return `<article class="banner banner--photo" ${link}>
      <img src="${esc(b.image)}" alt="${esc(b.title)}" />
      ${b.title || b.text ? `<div class="banner-caption"><h3>${esc(b.title)}</h3>${b.text ? `<p>${esc(b.text)}</p>` : ""}</div>` : ""}
    </article>`;
  }
  return `<article class="banner ${b.style === "teal" ? "banner--teal" : ""}" ${link}>
      <div class="motif"><i></i><i></i><i></i></div>
      <div><h3>${esc(b.title)}</h3>${b.text ? `<p>${esc(b.text)}</p>` : ""}</div>
      ${b.image ? `<img src="${esc(b.image)}" alt="" />` : ""}
    </article>`;
}

let bannerIndex = 0;

function renderBanners() {
  const wrap = $("#banners");
  const list = state.banners;
  wrap.hidden = $("#dots").hidden = list.length === 0;
  wrap.innerHTML = list.map(bannerHtml).join("");
  $("#dots").innerHTML = list.length > 1 ? list.map((_, i) => `<i class="${i ? "" : "on"}"></i>`).join("") : "";
  bannerIndex = 0;
  wrap.scrollLeft = 0;
}

function setupBanners() {
  const wrap = $("#banners");
  const step = () => wrap.firstElementChild.offsetWidth + 12;
  wrap.addEventListener(
    "scroll",
    () => {
      if (!wrap.firstElementChild) return;
      const i = Math.round(wrap.scrollLeft / step());
      if (i === bannerIndex) return;
      bannerIndex = i;
      [...$("#dots").children].forEach((d, j) => d.classList.toggle("on", j === i));
    },
    { passive: true },
  );
  setInterval(() => {
    if (document.hidden || state.banners.length < 2) return;
    const next = (bannerIndex + 1) % state.banners.length;
    wrap.scrollTo({ left: next * step(), behavior: "smooth" });
  }, 5000);
  wrap.onclick = (e) => {
    const [type, id] = (e.target.closest("[data-link]")?.dataset.link || "").split(":");
    if (type === "product" && byId(id)) openSheet(productSheet(id));
    if (type === "category") document.querySelector(`[data-tab="${id}"]`)?.click();
  };
}

// ---------- catalog ----------
function visibleProducts() {
  const q = state.query.trim().toLowerCase();
  if (!q) return state.products;
  return state.products.filter((p) => `${p.name} ${p.description} ${p.material}`.toLowerCase().includes(q));
}

function cardHtml(p) {
  const qty = state.cart[p.id] || 0;
  const pct = p.oldPrice ? Math.round((1 - p.price / p.oldPrice) * 100) : 0;
  return `<div class="card" data-open="${p.id}">
    <div class="card-media">
      <img src="${esc(cover(p))}" alt="" loading="lazy" />
      ${p.isNew ? '<span class="badge">Yangi</span>' : ""}
      ${pct ? `<span class="discount">-${pct}%</span>` : ""}
      ${p.stock > 0 ? `<button class="add ${qty ? "in" : ""}" data-add="${p.id}" aria-label="Savatga">${qty || "+"}</button>` : '<span class="out">Sotuvda yo\'q</span>'}
    </div>
    <div class="price-row"><span class="price">${sum(p.price)}</span>${p.oldPrice ? `<span class="old">${sum(p.oldPrice)}</span>` : ""}</div>
    <div class="name">${esc(p.name)}</div>
  </div>`;
}

function renderCatalog() {
  const list = visibleProducts();
  const groups = state.categories
    .map((c) => ({ ...c, items: list.filter((p) => p.category === c.id) }))
    .filter((g) => g.items.length);
  $("#tabs").innerHTML = groups.map((g, i) => `<button class="tab ${i ? "" : "on"}" data-tab="${g.id}">${g.name}</button>`).join("");
  $("#sections").innerHTML = groups
    .map((g) => `<section class="section" id="sec-${g.id}"><h2>${g.name}</h2><div class="grid">${g.items.map(cardHtml).join("")}</div></section>`)
    .join("");
  $("#empty").hidden = groups.length > 0;
  $("#tabsWrap").hidden = groups.length === 0;
}

function setActiveTab(id) {
  const tabs = [...document.querySelectorAll(".tab")];
  tabs.forEach((t) => t.classList.toggle("on", t.dataset.tab === id));
  const active = tabs.find((t) => t.dataset.tab === id);
  if (active) {
    const strip = $("#tabs");
    strip.scrollTo({ left: active.offsetLeft - strip.offsetLeft - 24, behavior: "smooth" });
  }
}

let tabLock = 0;
function onScroll() {
  if (Date.now() < tabLock) return;
  const offset = $(".topbar").offsetHeight + $("#tabsWrap").offsetHeight + 20;
  let current = null;
  for (const sec of document.querySelectorAll(".section")) {
    if (sec.getBoundingClientRect().top - offset <= 0) current = sec.id.slice(4);
  }
  // The last sections can never reach the top, so the page bottom selects the last tab.
  if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) {
    current = [...document.querySelectorAll(".section")].at(-1)?.id.slice(4);
  }
  current ??= document.querySelector(".section")?.id.slice(4);
  if (current && !document.querySelector(`.tab.on[data-tab="${current}"]`)) setActiveTab(current);
}

function stepTab(dir) {
  const tabs = [...document.querySelectorAll(".tab")];
  const i = tabs.findIndex((t) => t.classList.contains("on"));
  tabs[Math.max(0, Math.min(tabs.length - 1, i + dir))]?.click();
}

// ---------- cart ----------
function setQty(id, qty) {
  const stock = byId(id)?.stock ?? 0;
  if (qty > stock) {
    tg?.HapticFeedback?.notificationOccurred("warning");
    toast(`Omborda faqat ${stock} ta bor`);
    qty = stock;
  }
  if (qty <= 0) delete state.cart[id];
  else state.cart[id] = qty;
  save("em_cart", state.cart);
  renderCatalog();
  renderCartFab();
}

function cartLines() {
  return Object.entries(state.cart)
    .map(([id, qty]) => ({ p: byId(id), qty }))
    .filter((l) => l.p && l.p.stock > 0)
    .map((l) => ({ ...l, qty: Math.min(l.qty, l.p.stock) }));
}

function renderCartFab() {
  const lines = cartLines();
  const count = lines.reduce((n, l) => n + l.qty, 0);
  const total = lines.reduce((n, l) => n + l.qty * l.p.price, 0);
  $("#cartFab").hidden = count === 0 || !$("#sheet").hidden;
  $("#cartCount").textContent = count;
  $("#cartTotal").textContent = `${sum(total)} so'm`;
}

// ---------- sheet ----------
let sheetStack = [];

function openSheet(render) {
  sheetStack.push(render);
  drawSheet();
}

function drawSheet() {
  const render = sheetStack.at(-1);
  const open = Boolean(render);
  $("#sheet").hidden = !open;
  $("#backdrop").hidden = !open && $("#drawer").hidden;
  if (open) {
    $("#sheetBody").innerHTML = "";
    render($("#sheetBody"));
    $("#sheetBody").scrollTop = 0;
  }
  if (tg?.BackButton) open ? tg.BackButton.show() : tg.BackButton.hide();
  renderCartFab();
}

function back() {
  if (!$("#drawer").hidden) return closeDrawer();
  sheetStack.pop();
  drawSheet();
}

function closeAll() {
  sheetStack = [];
  closeDrawer();
  drawSheet();
}

function productSheet(id) {
  return (body) => {
    const p = byId(id);
    if (!p) return back();
    const qty = state.cart[p.id] || 0;
    const imgs = p.images?.length ? p.images : [cover(p)];
    body.innerHTML = `
      <div class="detail-media">${imgs.map((src) => `<img src="${esc(src)}" alt="" />`).join("")}</div>
      <div class="detail-name">${esc(p.name)}</div>
      <div class="price-row" style="justify-content:flex-start;gap:12px">
        <span class="price" style="font-size:24px">${sum(p.price)} so'm</span>
        ${p.oldPrice ? `<span class="old">${sum(p.oldPrice)}</span>` : ""}
      </div>
      <dl class="specs">
        ${p.size ? `<dt>O'lcham</dt><dd>${esc(p.size)}</dd>` : ""}
        ${p.material ? `<dt>Material</dt><dd>${esc(p.material)}</dd>` : ""}
        ${(p.boxes ?? 1) > 1 ? `<dt>Qadoq</dt><dd>${p.boxes} ta qutida</dd>` : ""}
        <dt>Holati</dt><dd>${stockLabel(p)}</dd>
      </dl>
      ${p.description ? `<p class="desc">${esc(p.description)}</p>` : ""}
      <div class="buy-row">
        ${
          p.stock <= 0
            ? '<button class="btn" disabled>Sotuvda yo\'q</button>'
            : qty
              ? `<div class="stepper"><button data-q="-1">−</button><span>${qty}</span><button data-q="1">+</button></div>
                 <button class="btn btn--dark" data-go="cart">Savatga o'tish</button>`
              : '<button class="btn" data-q="1">Savatga qo\'shish</button>'
        }
      </div>
      ${
        isStaff()
          ? `<div class="stack" style="margin-top:12px">
              <button class="btn btn--ghost" data-stock="${p.id}">📦 Ombor: ${p.stock} ta</button>
              ${isAdmin() ? `<button class="btn btn--ghost" data-edit="${p.id}">✏️ Tahrirlash</button>` : ""}
            </div>`
          : ""
      }`;
    body.onclick = (e) => {
      const q = e.target.closest("[data-q]");
      if (q) {
        haptic();
        setQty(p.id, qty + Number(q.dataset.q));
        drawSheet();
      }
      if (e.target.closest("[data-go=cart]")) openSheet(cartSheet);
      const edit = e.target.closest("[data-edit]");
      if (edit) openSheet(productForm(edit.dataset.edit));
      const stock = e.target.closest("[data-stock]");
      if (stock) openSheet(stockSheet(stock.dataset.stock));
    };
  };
}

function stockLabel(p) {
  if (p.stock <= 0) return "Sotuvda yo'q";
  if (p.stock <= 3) return `Sotuvda bor · faqat ${p.stock} ta qoldi`;
  return "Sotuvda bor";
}

function cartSheet(body) {
  const lines = cartLines();
  if (!lines.length) {
    body.innerHTML = `<h3>Savat</h3><p class="empty">Savat bo'sh</p><button class="btn" data-close>Katalogga qaytish</button>`;
    body.onclick = (e) => e.target.closest("[data-close]") && closeAll();
    return;
  }
  const total = lines.reduce((n, l) => n + l.qty * l.p.price, 0);
  body.innerHTML = `<h3>Savat</h3>
    ${lines
      .map(
        ({ p, qty }) => `<div class="line">
          <img src="${esc(cover(p))}" alt="" />
          <div><div class="line-name">${esc(p.name)}</div><div class="line-price">${sum(p.price * qty)} so'm</div></div>
          <div class="stepper"><button data-id="${p.id}" data-q="-1">−</button><span>${qty}</span><button data-id="${p.id}" data-q="1">+</button></div>
        </div>`,
      )
      .join("")}
    <div class="total"><span>Jami</span><span>${sum(total)} so'm</span></div>
    <button class="btn" data-go="checkout">Buyurtma berish</button>`;
  body.onclick = (e) => {
    const q = e.target.closest("[data-q]");
    if (q) {
      haptic();
      setQty(q.dataset.id, (state.cart[q.dataset.id] || 0) + Number(q.dataset.q));
      drawSheet();
    }
    if (e.target.closest("[data-go=checkout]")) openSheet(checkoutSheet);
  };
}

// Checkout fields live here so switching delivery/pickup (a re-render) keeps what was typed.
let checkout = null;

function checkoutDraft() {
  if (checkout) return checkout;
  const user = tg?.initDataUnsafe?.user;
  const saved = load("em_checkout", {});
  checkout = {
    name: saved.name || [user?.first_name, user?.last_name].filter(Boolean).join(" "),
    phone: saved.phone || "+998 ",
    address: saved.address || "",
    comment: "",
    location: saved.location || null,
    payment: canPayByCard() ? "card" : "cash",
  };
  return checkout;
}

// Card payments run through Telegram's invoice window (Bot API 6.1+), so they need the app opened in Telegram.
const canPayByCard = () => Boolean(state.cardPayments && tg?.initData && tg.isVersionAtLeast?.("6.1"));

function openInvoice(link) {
  return new Promise((resolve) => tg.openInvoice(link, resolve));
}

// Telegram contact sharing (Bot API 6.9+): one tap instead of typing the number.
function requestPhone() {
  return new Promise((resolve, reject) => {
    tg.requestContact((shared, res) => {
      const phone = shared && res?.status === "sent" ? res.responseUnsafe?.contact?.phone_number : null;
      phone ? resolve(phone.startsWith("+") ? phone : `+${phone}`) : reject(new Error("Raqam yuborilmadi"));
    });
  });
}

// Telegram LocationManager (Bot API 8.0+) asks inside Telegram; browsers fall back to geolocation.
function requestLocation() {
  const lm = tg?.LocationManager;
  if (lm && tg.isVersionAtLeast?.("8.0")) {
    return new Promise((resolve, reject) => {
      const get = () =>
        lm.getLocation((data) => {
          if (data) return resolve({ lat: data.latitude, lon: data.longitude });
          if (lm.isAccessRequested && !lm.isAccessGranted) {
            tg.showConfirm?.("Joylashuvga ruxsat berilmagan. Sozlamalarni ochaymi?", (ok) => ok && lm.openSettings());
          }
          reject(new Error("Joylashuvni aniqlab bo'lmadi"));
        });
      lm.isInited ? get() : lm.init(() => (lm.isLocationAvailable ? get() : reject(new Error("Qurilmada joylashuv o'chiq"))));
    });
  }
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Qurilmada joylashuv o'chiq"));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => reject(new Error("Joylashuvga ruxsat berilmadi")),
      { enableHighAccuracy: true, timeout: 15000 },
    );
  });
}

const mapLink = (loc) => `https://maps.google.com/?q=${loc.lat},${loc.lon}`;

function checkoutSheet(body) {
  const d = checkoutDraft();
  const type = state.orderType || "delivery";
  const total = cartLines().reduce((n, l) => n + l.qty * l.p.price, 0);
  const canShareContact = Boolean(tg?.requestContact && tg.isVersionAtLeast?.("6.9"));
  body.innerHTML = `<h3>Buyurtmani rasmiylashtirish</h3>
    <div class="seg">
      <button type="button" class="${type === "delivery" ? "on" : ""}" data-type="delivery">Yetkazib berish</button>
      <button type="button" class="${type === "pickup" ? "on" : ""}" data-type="pickup">Olib ketish</button>
    </div>
    <form id="orderForm">
      <label class="field">Ism<input name="name" required value="${esc(d.name)}" /></label>
      <div class="field">
        <label for="phoneInput">Telefon raqam</label>
        <input id="phoneInput" name="phone" type="tel" required placeholder="+998 90 123 45 67" value="${esc(d.phone)}" />
        ${canShareContact ? '<button type="button" class="auto-btn" data-auto="phone">📱 Telegram raqamimni yuborish</button>' : ""}
      </div>
      ${
        type === "delivery"
          ? `<div class="field">
              <label for="addressInput">Manzil</label>
              <button type="button" class="auto-btn auto-btn--main" data-auto="location">📍 Joylashuvimni aniqlash</button>
              ${
                d.location
                  ? `<div class="loc-chip">✅ Joylashuv biriktirildi · <a href="${mapLink(d.location)}" target="_blank" rel="noopener">xaritada ko'rish</a> <button type="button" data-auto="clear-location" aria-label="Olib tashlash">✕</button></div>`
                  : ""
              }
              <textarea id="addressInput" name="address" rows="2" required placeholder="Shahar, ko'cha, uy">${esc(d.address)}</textarea>
              <small class="hint">Xonadon, podyezd va qavatni ham yozing</small>
            </div>`
          : ""
      }
      <label class="field">Izoh<textarea name="comment" rows="2" placeholder="Lift bor/yo'q, qulay vaqt...">${esc(d.comment)}</textarea></label>
      ${
        canPayByCard()
          ? `<div class="field">To'lov usuli</div>
            <div class="seg">
              <button type="button" class="${d.payment === "card" ? "on" : ""}" data-pay="card">💳 Karta orqali</button>
              <button type="button" class="${d.payment === "cash" ? "on" : ""}" data-pay="cash">💵 Qabul qilganda</button>
            </div>`
          : ""
      }
      <div class="total"><span>Jami</span><span>${sum(total)} so'm</span></div>
      <button class="btn" type="submit">${d.payment === "card" && canPayByCard() ? "To'lovga o'tish" : "Tasdiqlash"}</button>
    </form>`;
  const form = body.querySelector("form");
  form.oninput = (e) => {
    if (e.target.name) d[e.target.name] = e.target.value;
  };
  body.onclick = async (e) => {
    const seg = e.target.closest("[data-type]");
    if (seg) {
      state.orderType = seg.dataset.type;
      save("em_order_type", state.orderType);
      renderHeader();
      return drawSheet();
    }
    const pay = e.target.closest("[data-pay]");
    if (pay) {
      d.payment = pay.dataset.pay;
      return drawSheet();
    }
    const auto = e.target.closest("[data-auto]")?.dataset.auto;
    if (auto === "clear-location") {
      d.location = null;
      return drawSheet();
    }
    if (auto === "phone") {
      try {
        d.phone = await requestPhone();
        haptic();
        drawSheet();
      } catch (err) {
        toast(err.message);
      }
    }
    if (auto === "location") {
      const btn = e.target.closest("[data-auto]");
      btn.disabled = true;
      btn.textContent = "📍 Aniqlanmoqda…";
      try {
        d.location = await requestLocation();
        const { address } = await api(`/api/geocode?lat=${d.location.lat}&lon=${d.location.lon}`).catch(() => ({}));
        if (address) d.address = address;
        else toast("Joylashuv biriktirildi, manzilni qo'lda yozing");
        haptic();
      } catch (err) {
        toast(err.message);
      }
      drawSheet();
    }
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button[type=submit]");
    const data = Object.fromEntries(new FormData(e.target));
    const location = type === "delivery" ? d.location : null;
    save("em_checkout", { name: data.name, phone: data.phone, address: data.address, location });
    const payment = canPayByCard() ? d.payment : "cash";
    btn.disabled = true;
    try {
      const order = await api("/api/orders", {
        method: "POST",
        body: { ...data, location, payment, orderType: type, items: cartLines().map((l) => ({ id: l.p.id, qty: l.qty })) },
      });
      if (order.invoiceLink) {
        const status = await openInvoice(order.invoiceLink);
        // "pending" means the provider is still confirming: the bot's receipt arrives once it is paid.
        if (status === "cancelled" || status === "failed") {
          await api(`/api/orders/${order.orderId}/cancel`, { method: "POST" }).catch(() => {});
          await reload().catch(() => {});
          toast(status === "failed" ? "To'lov o'tmadi. Qaytadan urinib ko'ring" : "To'lov bekor qilindi");
          btn.disabled = false;
          return;
        }
        order.paid = status === "paid";
        order.pending = status === "pending";
      }
      tg?.HapticFeedback?.notificationOccurred("success");
      state.cart = {};
      save("em_cart", state.cart);
      checkout = null;
      renderCatalog();
      sheetStack = [successSheet(order)];
      drawSheet();
    } catch (err) {
      tg?.HapticFeedback?.notificationOccurred("error");
      toast(err.message);
      // Stock may have changed since the catalog loaded; refresh so the cart clamps to it.
      await reload().catch(() => {});
      drawSheet();
    }
  };
}

function successSheet(order) {
  const note = order.paid
    ? "💳 To'lov qabul qilindi. Chek botga yuborildi."
    : order.pending
      ? "To'lov tasdiqlanmoqda. Tasdiqlangach, bot xabar beradi."
      : "Tez orada operatorimiz siz bilan bog'lanadi.";
  return (body) => {
    body.innerHTML = `<div style="text-align:center;padding:20px 0">
        <div style="font-size:56px">${order.pending ? "⏳" : "✅"}</div>
        <h3>Buyurtma qabul qilindi!</h3>
        <p class="desc">${note}</p>
      </div>
      <button class="btn" data-close>Yaxshi</button>`;
    body.onclick = (e) => e.target.closest("[data-close]") && closeAll();
  };
}

function orderTypeSheet(body) {
  body.innerHTML = `<h3>Buyurtma turi</h3>
    <div class="stack">
      <button class="btn ${state.orderType === "delivery" ? "" : "btn--ghost"}" data-type="delivery">🚚 Yetkazib berish</button>
      <button class="btn ${state.orderType === "pickup" ? "" : "btn--ghost"}" data-type="pickup">🏬 Do'kondan olib ketish</button>
    </div>`;
  body.onclick = (e) => {
    const b = e.target.closest("[data-type]");
    if (!b) return;
    state.orderType = b.dataset.type;
    save("em_order_type", state.orderType);
    renderHeader();
    back();
  };
}

// ---------- admin ----------
function adminSheet(body) {
  const catName = Object.fromEntries(state.categories.map((c) => [c.id, c.name]));
  body.innerHTML = `<h3>Mahsulotlar (${state.products.length})</h3>
    <button class="btn" data-new style="margin-bottom:10px">＋ Yangi mahsulot qo'shish</button>
    <label class="field"><input id="adminSearch" type="search" placeholder="Qidirish" /></label>
    <div id="adminList"></div>`;
  const list = body.querySelector("#adminList");
  const draw = (q = "") => {
    list.innerHTML = state.products
      .filter((p) => p.name.toLowerCase().includes(q.toLowerCase()))
      .map(
        (p) => `<button class="admin-item" data-edit="${p.id}">
          <img src="${esc(cover(p))}" alt="" />
          <div><div class="line-name">${esc(p.name)}</div><small>${p.sku ? `SKU ${p.sku} · ` : ""}${sum(p.price)} so'm · omborda ${p.stock} ta</small></div>
          <span class="chip">${catName[p.category] || p.category}</span>
        </button>`,
      )
      .join("");
  };
  draw();
  body.querySelector("#adminSearch").oninput = (e) => draw(e.target.value);
  body.onclick = (e) => {
    if (e.target.closest("[data-new]")) openSheet(productForm(null));
    const edit = e.target.closest("[data-edit]");
    if (edit) openSheet(productForm(edit.dataset.edit));
  };
}

// Downscale before upload so phone photos stay small for Telegram's webview.
function resizeImage(file, max = 1200) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => reject(new Error("Rasmni o'qib bo'lmadi"));
    img.src = URL.createObjectURL(file);
  });
}

function productForm(id) {
  const p = id ? byId(id) : null;
  const images = [...(p?.images || [])].filter((src) => !src.startsWith("/img/"));
  return (body) => {
    body.innerHTML = `<h3>${p ? "Mahsulotni tahrirlash" : "Yangi mahsulot"}</h3>
      <form id="productForm">
        <div class="field">Rasmlar</div>
        <div class="thumbs" id="thumbs"></div>
        <input type="file" id="fileInput" accept="image/*" multiple hidden />
        <label class="field">Nomi<input name="name" required value="${esc(p?.name)}" /></label>
        <label class="field">Bo'lim
          <select name="category" required>
            ${state.categories.map((c) => `<option value="${c.id}" ${p?.category === c.id ? "selected" : ""}>${c.name}</option>`).join("")}
          </select>
        </label>
        <div class="row2">
          <label class="field">Narx (so'm)<input name="price" type="number" inputmode="numeric" min="1" required value="${p?.price ?? ""}" /></label>
          <label class="field">Eski narx<input name="oldPrice" type="number" inputmode="numeric" min="0" placeholder="ixtiyoriy" value="${p?.oldPrice ?? ""}" /></label>
        </div>
        <div class="row2">
          <label class="field">O'lcham<input name="size" placeholder="120 × 60 × 75 sm" value="${esc(p?.size)}" /></label>
          <label class="field">Material<input name="material" placeholder="LDSP, MDF" value="${esc(p?.material)}" /></label>
        </div>
        <label class="field">Qutilar soni (1 dona nechta qutida keladi)<input name="boxes" type="number" inputmode="numeric" min="1" max="20" required value="${p?.boxes ?? 1}" /></label>
        <label class="field">Tavsif<textarea name="description" rows="4">${esc(p?.description)}</textarea></label>
        <label class="check"><input type="checkbox" name="isNew" ${p?.isNew ? "checked" : ""} /> "Yangi" belgisi</label>
        ${
          p
            ? `<p class="field">Omborda: <b>${p.stock} ta</b>. Qoldiq "📦 Ombor" bo'limida kirim/chiqim orqali o'zgaradi.</p>`
            : `<label class="field">Boshlang'ich qoldiq (dona)<input name="stock" type="number" inputmode="numeric" min="0" value="0" /></label>`
        }
        <div class="stack">
          <button class="btn" type="submit">Saqlash</button>
          ${p ? '<button class="btn btn--danger" type="button" data-del>O\'chirish</button>' : ""}
        </div>
      </form>`;
    const thumbs = body.querySelector("#thumbs");
    const fileInput = body.querySelector("#fileInput");
    const drawThumbs = () => {
      thumbs.innerHTML =
        images.map((src, i) => `<div class="thumb" style="background-image:url('${esc(src)}')"><button type="button" data-rm="${i}">✕</button></div>`).join("") +
        '<button type="button" class="thumb-add" data-pick>＋</button>';
    };
    drawThumbs();

    fileInput.onchange = async () => {
      for (const file of fileInput.files) {
        try {
          toast("Rasm yuklanmoqda…");
          const { url } = await api("/api/upload", { method: "POST", body: { dataUrl: await resizeImage(file) } });
          images.push(url);
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
      if (e.target.closest("[data-del]")) {
        const ok = await confirmDialog(`"${p.name}" o'chirilsinmi?`);
        if (!ok) return;
        try {
          await api(`/api/products/${p.id}`, { method: "DELETE" });
          await reload();
          toast("O'chirildi");
          sheetStack = sheetStack.filter((r) => r === adminSheet);
          drawSheet();
        } catch (err) {
          toast(err.message);
        }
      }
    };

    body.querySelector("form").onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const payload = {
        name: f.get("name"),
        category: f.get("category"),
        price: Number(f.get("price")),
        oldPrice: f.get("oldPrice") ? Number(f.get("oldPrice")) : null,
        size: f.get("size"),
        material: f.get("material"),
        boxes: Number(f.get("boxes")),
        description: f.get("description"),
        isNew: f.has("isNew"),
        stock: Number(f.get("stock") || 0),
        images,
      };
      const btn = e.target.querySelector("button[type=submit]");
      btn.disabled = true;
      try {
        await api(p ? `/api/products/${p.id}` : "/api/products", { method: p ? "PUT" : "POST", body: payload });
        await reload();
        tg?.HapticFeedback?.notificationOccurred("success");
        toast("Saqlandi");
        back();
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
      }
    };
  };
}

// ---------- banners (admin) ----------
const BANNER_STYLE_LABEL = { photo: "Rasm", dark: "Qora", teal: "Moviy" };

function bannersSheet(body) {
  body.innerHTML = `<h3>Bannerlar va aksiyalar</h3>
    <p class="hint" style="margin:-6px 0 12px">Bosh sahifaning tepasidagi aylanuvchi bannerlar. Tartib raqami kichigi birinchi chiqadi.</p>
    <button class="btn" data-new style="margin-bottom:10px">＋ Yangi banner</button>
    <div id="bannerList"><p class="empty">Yuklanmoqda…</p></div>`;
  api("/api/banners?all=1")
    .then((list) => {
      body.querySelector("#bannerList").innerHTML = list.length
        ? list
            .map(
              (b) => `<button class="admin-item" data-edit="${b.id}" data-banner='${esc(JSON.stringify(b))}'>
                ${b.image ? `<img src="${esc(b.image)}" alt="" />` : `<span class="banner-swatch banner-swatch--${b.style}"></span>`}
                <div><div class="line-name">${esc(b.title || "(sarlavhasiz)")}</div><small>№${b.order} · ${BANNER_STYLE_LABEL[b.style]}</small></div>
                <span class="chip ${b.active ? "" : "chip--off"}">${b.active ? "Faol" : "Yashirin"}</span>
              </button>`,
            )
            .join("")
        : '<p class="empty">Hali banner yo\'q</p>';
    })
    .catch((err) => (body.querySelector("#bannerList").innerHTML = `<p class="empty">${esc(err.message)}</p>`));
  body.onclick = (e) => {
    if (e.target.closest("[data-new]")) openSheet(bannerForm(null));
    const item = e.target.closest("[data-banner]");
    if (item) openSheet(bannerForm(JSON.parse(item.dataset.banner)));
  };
}

function bannerForm(existing) {
  const b = { style: "photo", title: "", text: "", image: "", linkType: "none", linkId: "", active: true, order: state.banners.length + 1, ...existing };
  return (body) => {
    const productOptions = state.products
      .map((p) => `<option value="${p.id}" ${b.linkType === "product" && b.linkId === p.id ? "selected" : ""}>${esc(p.name)}</option>`)
      .join("");
    const categoryOptions = state.categories
      .map((c) => `<option value="${c.id}" ${b.linkType === "category" && b.linkId === c.id ? "selected" : ""}>${c.name}</option>`)
      .join("");
    body.innerHTML = `<h3>${existing ? "Bannerni tahrirlash" : "Yangi banner"}</h3>
      <div class="banners banner-preview">${bannerHtml({ ...b, title: b.title || "Sarlavha", image: b.image || (b.style === "photo" ? "/img/mark.svg" : "") })}</div>
      <form id="bannerForm">
        <div class="field">Ko'rinishi</div>
        <div class="seg seg--3">
          ${["photo", "dark", "teal"].map((st) => `<button type="button" class="${b.style === st ? "on" : ""}" data-style="${st}">${BANNER_STYLE_LABEL[st]}</button>`).join("")}
        </div>
        <div class="field">
          ${b.style === "photo" ? "Rasm (gorizontal, taxminan 2:1 — masalan 1200×600)" : "Yon rasm (ixtiyoriy, fonsiz PNG yaxshi)"}
          <div class="thumbs">
            ${b.image ? `<div class="thumb" style="background-image:url('${esc(b.image)}')"><button type="button" data-rm>✕</button></div>` : '<button type="button" class="thumb-add" data-pick>＋</button>'}
          </div>
          <input type="file" id="bannerFile" accept="image/*" hidden />
        </div>
        <label class="field">Sarlavha${b.style === "photo" ? " (ixtiyoriy, rasm ustida chiqadi)" : ""}<input name="title" maxlength="80" value="${esc(b.title)}" placeholder="Masalan: Oshxonalarga -20% chegirma" /></label>
        <label class="field">Matn (ixtiyoriy)<input name="text" maxlength="140" value="${esc(b.text)}" placeholder="Aksiya 30-noyabrgacha" /></label>
        <label class="field">Bosilganda
          <select name="linkType">
            <option value="none" ${b.linkType === "none" ? "selected" : ""}>Hech narsa</option>
            <option value="category" ${b.linkType === "category" ? "selected" : ""}>Bo'limni ochish</option>
            <option value="product" ${b.linkType === "product" ? "selected" : ""}>Mahsulotni ochish</option>
          </select>
        </label>
        ${b.linkType === "category" ? `<label class="field">Bo'lim<select name="linkId">${categoryOptions}</select></label>` : ""}
        ${b.linkType === "product" ? `<label class="field">Mahsulot<select name="linkId">${productOptions}</select></label>` : ""}
        <label class="field">Tartib raqami<input name="order" type="number" inputmode="numeric" value="${b.order}" /></label>
        <label class="check"><input type="checkbox" name="active" ${b.active ? "checked" : ""} /> Saytda ko'rsatish</label>
        <div class="stack">
          <button class="btn" type="submit">Saqlash</button>
          ${existing ? '<button class="btn btn--danger" type="button" data-del>O\'chirish</button>' : ""}
        </div>
      </form>`;
    const form = body.querySelector("form");
    // Keep typed values when the form re-renders (style/link switches, image upload).
    const sync = () => {
      const f = new FormData(form);
      Object.assign(b, {
        title: f.get("title"),
        text: f.get("text"),
        linkType: f.get("linkType"),
        linkId: f.get("linkId") ?? "",
        order: Number(f.get("order")) || 0,
        active: f.has("active"),
      });
    };
    form.onchange = (e) => {
      if (e.target.name !== "linkType") return;
      sync();
      b.linkId = "";
      drawSheet();
    };
    const fileInput = body.querySelector("#bannerFile");
    fileInput.onchange = async () => {
      const file = fileInput.files[0];
      if (!file) return;
      sync();
      try {
        toast("Rasm yuklanmoqda…");
        const { url } = await api("/api/upload", { method: "POST", body: { dataUrl: await resizeImage(file, 1400) } });
        b.image = url;
        drawSheet();
      } catch (err) {
        toast(err.message);
      }
    };
    body.onclick = async (e) => {
      const st = e.target.closest("[data-style]");
      if (st) {
        sync();
        b.style = st.dataset.style;
        return drawSheet();
      }
      if (e.target.closest("[data-pick]")) fileInput.click();
      if (e.target.closest("[data-rm]")) {
        sync();
        b.image = "";
        drawSheet();
      }
      if (e.target.closest("[data-del]")) {
        if (!(await confirmDialog("Banner o'chirilsinmi?"))) return;
        try {
          await api(`/api/banners/${existing.id}`, { method: "DELETE" });
          await reload();
          toast("O'chirildi");
          back();
        } catch (err) {
          toast(err.message);
        }
      }
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      sync();
      const btn = form.querySelector("button[type=submit]");
      btn.disabled = true;
      const { id, createdAt, updatedAt, ...payload } = b;
      // A select defaults to its first option; take it when the admin did not touch it.
      if (payload.linkType !== "none" && !payload.linkId) payload.linkId = form.querySelector("[name=linkId]")?.value || "";
      try {
        await api(existing ? `/api/banners/${existing.id}` : "/api/banners", { method: existing ? "PUT" : "POST", body: payload });
        await reload();
        tg?.HapticFeedback?.notificationOccurred("success");
        toast("Saqlandi");
        back();
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
      }
    };
  };
}

// ---------- warehouse screens (admin) ----------
function screensSheet(body) {
  let pairing = null;
  const screenUrl = `${location.origin}/ombor.html`;
  const draw = (list) => {
    body.innerHTML = `<h3>Ombor ekrani</h3>
      <p class="hint" style="margin:-6px 0 14px">Ombordagi kompyuter yoki planshetda brauzerni oching:<br><b>${esc(screenUrl)}</b><br>So'ng shu yerda olingan kodni kiriting.</p>
      <label class="field">Ekran nomi<input id="screenName" maxlength="40" value="Ombor ekrani" /></label>
      <button class="btn" data-code style="margin-bottom:12px">Kod olish</button>
      ${
        pairing
          ? `<div class="invite" style="text-align:center">
              <div class="pair-code">${esc(pairing.code)}</div>
              <small class="hint">Kod 10 daqiqa amal qiladi (${when(pairing.expiresAt)} gacha) va bir marta ishlatiladi</small>
            </div>`
          : ""
      }
      <h4 class="sub">Ulangan ekranlar</h4>
      <div>${
        list === null
          ? '<p class="empty">Yuklanmoqda…</p>'
          : list.length
            ? list
                .map(
                  (sc) => `<div class="move">
                    <span class="staff-avatar">🖥</span>
                    <div><div class="line-name">${esc(sc.name)}</div><small>Ulangan: ${when(sc.createdAt)}</small></div>
                    <button class="stock stock--zero" data-unpair="${sc.id}" data-name="${esc(sc.name)}">Uzish</button>
                  </div>`,
                )
                .join("")
            : '<p class="empty">Hali ekran ulanmagan</p>'
      }</div>`;
  };
  const load = () =>
    api("/api/screens")
      .then(draw)
      .catch((err) => toast(err.message));
  draw(null);
  load();
  body.onclick = async (e) => {
    if (e.target.closest("[data-code]")) {
      try {
        pairing = await api("/api/screens/pair-code", { method: "POST", body: { name: body.querySelector("#screenName").value } });
        haptic();
        load();
      } catch (err) {
        toast(err.message);
      }
    }
    const un = e.target.closest("[data-unpair]");
    if (un) {
      if (!(await confirmDialog(`«${un.dataset.name}» uzilsinmi? Ekran qayta kod so'raydi.`))) return;
      try {
        await api(`/api/screens/${un.dataset.unpair}`, { method: "DELETE" });
        toast("Uzildi");
        load();
      } catch (err) {
        toast(err.message);
      }
    }
  };
}

// ---------- staff (admin) ----------
const STAFF_ROLE_LABEL = { warehouse: "Omborchi" };

function shareInvite(link) {
  const text = "Express Mebel omborchisi sifatida qo'shilish uchun havolani bosing va botda Start ni bosing:";
  const url = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`;
  if (tg?.openTelegramLink) tg.openTelegramLink(url);
  else window.open(url, "_blank");
}

function staffSheet(body) {
  let invite = null;
  const draw = (list) => {
    body.innerHTML = `<h3>Xodimlar</h3>
      <p class="hint" style="margin:-6px 0 14px">Omborchi taklif havolasini bosib, botda <b>Start</b> ni bossa, avtomatik qo'shiladi. Havola 24 soat va faqat bir marta ishlaydi.</p>
      <button class="btn" data-invite style="margin-bottom:12px">＋ Omborchini taklif qilish</button>
      ${
        invite
          ? `<div class="invite">
              <div class="invite-link" id="inviteLink">${esc(invite.link)}</div>
              <div class="row2">
                <button class="btn" data-share>📤 Yuborish</button>
                <button class="btn btn--ghost" data-copy>Nusxalash</button>
              </div>
              <small class="hint">Amal qiladi: ${when(invite.expiresAt)} gacha</small>
            </div>`
          : ""
      }
      <h4 class="sub">Omborchilar</h4>
      <div>${
        list === null
          ? '<p class="empty">Yuklanmoqda…</p>'
          : list.length
            ? list
                .map(
                  (m) => `<div class="move">
                    <span class="staff-avatar">${esc((m.name || "?")[0])}</span>
                    <div>
                      <div class="line-name">${esc(m.name)}${m.username ? ` <small>@${esc(m.username)}</small>` : ""}</div>
                      <small>${STAFF_ROLE_LABEL[m.role] || m.role} · ${when(m.addedAt)}</small>
                    </div>
                    <button class="stock stock--zero" data-remove="${m.id}" data-name="${esc(m.name)}">O'chirish</button>
                  </div>`,
                )
                .join("")
            : '<p class="empty">Hali omborchi yo\'q</p>'
      }</div>`;
  };
  const load = () =>
    api("/api/staff")
      .then(draw)
      .catch((err) => toast(err.message));
  draw(null);
  load();
  body.onclick = async (e) => {
    if (e.target.closest("[data-invite]")) {
      try {
        invite = await api("/api/staff/invites", { method: "POST" });
        haptic();
        load();
      } catch (err) {
        toast(err.message);
      }
    }
    if (e.target.closest("[data-share]")) shareInvite(invite.link);
    if (e.target.closest("[data-copy]")) {
      try {
        await navigator.clipboard.writeText(invite.link);
        toast("Nusxalandi");
      } catch {
        getSelection().selectAllChildren(body.querySelector("#inviteLink"));
        toast("Havolani belgilab nusxalang");
      }
    }
    const rm = e.target.closest("[data-remove]");
    if (rm) {
      if (!(await confirmDialog(`${rm.dataset.name} xodimlar ro'yxatidan o'chirilsinmi?`))) return;
      try {
        await api(`/api/staff/${rm.dataset.remove}`, { method: "DELETE" });
        toast("O'chirildi");
        load();
      } catch (err) {
        toast(err.message);
      }
    }
  };
}

// ---------- warehouse ----------
const MOVE_LABEL = { in: "Kirim", out: "Chiqim", sale: "Sotuv", release: "Bron qaytdi" };
const ADDS_STOCK = new Set(["in", "release"]);
const when = (ts) =>
  new Date(ts).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

function stockChip(n) {
  const level = n <= 0 ? "zero" : n <= 3 ? "low" : "ok";
  return `<span class="stock stock--${level}">${n} ta</span>`;
}

function movementsHtml(list, withName) {
  if (!list.length) return '<p class="empty">Hali harakat yo\'q</p>';
  return list
    .map(
      (m) => `<div class="move">
        <span class="move-qty move-qty--${ADDS_STOCK.has(m.type) ? "in" : "out"}">${ADDS_STOCK.has(m.type) ? "+" : "−"}${m.qty}</span>
        <div>
          <div class="line-name">${MOVE_LABEL[m.type]}${withName ? ` · ${esc(m.productName)}` : ""}</div>
          <small>${when(m.at)} · ${esc(m.by)}${m.note ? ` · ${esc(m.note)}` : ""}</small>
        </div>
        <small>qoldiq ${m.balance}</small>
      </div>`,
    )
    .join("");
}

function warehouseSheet(body) {
  const empty = state.products.filter((p) => p.stock <= 0).length;
  const low = state.products.filter((p) => p.stock > 0 && p.stock <= 3).length;
  body.innerHTML = `<h3>Ombor</h3>
    <div class="stat-row">
      <div><b>${state.products.reduce((n, p) => n + p.stock, 0)}</b><small>jami dona</small></div>
      <div><b>${low}</b><small>kam qolgan</small></div>
      <div><b>${empty}</b><small>tugagan</small></div>
    </div>
    <label class="field"><input id="stockSearch" type="search" placeholder="Mahsulotni qidirish" /></label>
    <div id="stockList"></div>
    <h4 class="sub">Oxirgi harakatlar</h4>
    <div id="stockLog"><p class="empty">Yuklanmoqda…</p></div>`;
  const list = body.querySelector("#stockList");
  const draw = (q = "") => {
    list.innerHTML = [...state.products]
      .filter((p) => p.name.toLowerCase().includes(q.toLowerCase()))
      .sort((a, b) => a.stock - b.stock)
      .map(
        (p) => `<button class="admin-item" data-stock="${p.id}">
          <img src="${esc(cover(p))}" alt="" />
          <div><div class="line-name">${esc(p.name)}</div><small>${sum(p.price)} so'm</small></div>
          ${stockChip(p.stock)}
        </button>`,
      )
      .join("");
  };
  draw();
  body.querySelector("#stockSearch").oninput = (e) => draw(e.target.value);
  api("/api/stock")
    .then((log) => (body.querySelector("#stockLog").innerHTML = movementsHtml(log.slice(0, 30), true)))
    .catch((err) => (body.querySelector("#stockLog").innerHTML = `<p class="empty">${esc(err.message)}</p>`));
  body.onclick = (e) => {
    const item = e.target.closest("[data-stock]");
    if (item) openSheet(stockSheet(item.dataset.stock));
  };
}

function stockSheet(id) {
  let type = "in";
  return (body) => {
    const p = byId(id);
    if (!p) return back();
    body.innerHTML = `<h3>${esc(p.name)}</h3>
      <div class="stock-now">Omborda <b>${p.stock}</b> ta ${p.stock <= 0 ? "· saytda sotilmaydi" : ""}</div>
      <div class="seg">
        <button type="button" class="${type === "in" ? "on" : ""}" data-type="in">＋ Kirim</button>
        <button type="button" class="${type === "out" ? "on" : ""}" data-type="out">− Chiqim</button>
      </div>
      <form id="stockForm">
        <label class="field">Miqdor (dona)<input name="qty" type="number" inputmode="numeric" min="1" ${type === "out" ? `max="${p.stock}"` : ""} required /></label>
        <label class="field">Izoh<input name="note" placeholder="${type === "in" ? "Sexdan keldi, partiya №…" : "Brak, ko'rgazmaga, qaytarildi…"}" /></label>
        <button class="btn" type="submit">${type === "in" ? "Kirimni saqlash" : "Chiqimni saqlash"}</button>
      </form>
      <h4 class="sub">Harakatlar tarixi</h4>
      <div id="moveLog"><p class="empty">Yuklanmoqda…</p></div>`;
    api(`/api/stock?productId=${encodeURIComponent(p.id)}`)
      .then((log) => (body.querySelector("#moveLog").innerHTML = movementsHtml(log, false)))
      .catch((err) => (body.querySelector("#moveLog").innerHTML = `<p class="empty">${esc(err.message)}</p>`));
    body.onclick = (e) => {
      const seg = e.target.closest("[data-type]");
      if (!seg) return;
      type = seg.dataset.type;
      drawSheet();
    };
    body.querySelector("form").onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const btn = e.target.querySelector("button[type=submit]");
      btn.disabled = true;
      try {
        await api("/api/stock", {
          method: "POST",
          body: { productId: p.id, type, qty: Number(f.get("qty")), note: f.get("note") },
        });
        await reload();
        tg?.HapticFeedback?.notificationOccurred("success");
        toast(type === "in" ? "Kirim saqlandi" : "Chiqim saqlandi");
        drawSheet();
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
      }
    };
  };
}

function confirmDialog(message) {
  if (tg?.showConfirm && tg.isVersionAtLeast?.("6.2")) return new Promise((r) => tg.showConfirm(message, r));
  return Promise.resolve(window.confirm(message));
}

// ---------- drawer ----------
function openDrawer() {
  const items = [
    ["cart", "🛒  Savat"],
    ["type", "🚚  Buyurtma turi"],
    ...state.categories.map((c) => [`cat:${c.id}`, c.name]),
    ...(isStaff() ? [["stock", "📦  Ombor"]] : []),
    ...(isAdmin()
      ? [
          ["admin", "⚙️  Mahsulotlarni boshqarish"],
          ["banners", "🖼  Bannerlar va aksiyalar"],
          ["staff", "👥  Xodimlar"],
          ["screens", "🖥  Ombor ekrani"],
        ]
      : []),
  ];
  $("#drawerNav").innerHTML = items.map(([k, label]) => `<button data-k="${k}">${label}</button>`).join("");
  $("#drawer").hidden = false;
  $("#backdrop").hidden = false;
  tg?.BackButton?.show();
}

function closeDrawer() {
  $("#drawer").hidden = true;
  $("#backdrop").hidden = $("#sheet").hidden;
  if (tg?.BackButton && $("#sheet").hidden) tg.BackButton.hide();
}

$("#drawerNav").onclick = (e) => {
  const k = e.target.closest("[data-k]")?.dataset.k;
  if (!k) return;
  closeDrawer();
  if (k === "cart") openSheet(cartSheet);
  if (k === "type") openSheet(orderTypeSheet);
  if (k === "admin") openSheet(adminSheet);
  if (k === "stock") openSheet(warehouseSheet);
  if (k === "banners") openSheet(bannersSheet);
  if (k === "staff") openSheet(staffSheet);
  if (k === "screens") openSheet(screensSheet);
  if (k.startsWith("cat:")) document.querySelector(`[data-tab="${k.slice(4)}"]`)?.click();
};

// ---------- events ----------
$("#sections").onclick = (e) => {
  const add = e.target.closest("[data-add]");
  if (add) {
    e.stopPropagation();
    haptic();
    setQty(add.dataset.add, (state.cart[add.dataset.add] || 0) + 1);
    return;
  }
  const card = e.target.closest("[data-open]");
  if (card) openSheet(productSheet(card.dataset.open));
};

$("#tabs").onclick = (e) => {
  const tab = e.target.closest("[data-tab]");
  if (!tab) return;
  setActiveTab(tab.dataset.tab);
  tabLock = Date.now() + 700;
  $(`#sec-${tab.dataset.tab}`).scrollIntoView({ behavior: "smooth" });
};

$("#tabsPrev").onclick = () => stepTab(-1);
$("#tabsNext").onclick = () => stepTab(1);
$("#search").oninput = (e) => {
  state.query = e.target.value;
  renderCatalog();
};
$("#cartFab").onclick = () => openSheet(cartSheet);
$("#orderTypeBtn").onclick = () => openSheet(orderTypeSheet);
$("#menuBtn").onclick = openDrawer;
$("#avatarBtn").onclick = () => openSheet(isAdmin() ? adminSheet : isStaff() ? warehouseSheet : cartSheet);
$("#backdrop").onclick = closeAll;
tg?.BackButton?.onClick(back);
window.addEventListener("scroll", onScroll, { passive: true });

// ---------- boot ----------
async function reload() {
  [state.products, state.banners] = await Promise.all([api("/api/products"), api("/api/banners")]);
  renderBanners();
  renderCatalog();
  renderCartFab();
}

(async () => {
  renderHeader();
  setupBanners();
  try {
    const config = await api("/api/config");
    state.categories = config.categories;
    state.role = config.role;
    state.cardPayments = config.cardPayments;
    await reload();
  } catch (err) {
    toast(err.message);
  }
})();
