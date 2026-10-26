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

// Browser admin access: open /?admin=<ADMIN_TOKEN> once; the token is remembered on this device.
const params = new URLSearchParams(location.search);
if (params.has("admin")) {
  try {
    localStorage.setItem("em_admin", params.get("admin"));
  } catch {}
  history.replaceState(null, "", location.pathname);
}
const adminToken = (() => {
  try {
    return localStorage.getItem("em_admin") || "";
  } catch {
    return "";
  }
})();

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-telegram-init-data": tg?.initData || "",
      "x-admin-token": adminToken,
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
  isAdmin: false,
  query: "",
  orderType: load("em_order_type", null),
  cart: load("em_cart", {}),
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
const BANNERS = [
  {
    cls: "",
    title: "Interyeringiz uchun mukammal mebel",
    text: "Oshxonadan yotoqxonagacha — hammasi bir joyda",
    img: "/img/oshxona.svg",
  },
  { cls: "banner--teal", title: "Yangi kolleksiya", text: "Zamonaviy krovat va shkaflar", img: "/img/krovat.svg" },
  { cls: "", title: "Tez yetkazib berish", text: "Shahar bo'ylab o'rnatib beramiz", img: "/img/shkaf.svg" },
];

function renderBanners() {
  const wrap = $("#banners");
  wrap.innerHTML = BANNERS.map(
    (b) => `<article class="banner ${b.cls}">
      <div class="motif"><i></i><i></i><i></i></div>
      <div><h3>${b.title}</h3><p>${b.text}</p></div>
      <img src="${b.img}" alt="" />
    </article>`,
  ).join("");
  $("#dots").innerHTML = BANNERS.map((_, i) => `<i class="${i ? "" : "on"}"></i>`).join("");
  let index = 0;
  wrap.addEventListener(
    "scroll",
    () => {
      const i = Math.round(wrap.scrollLeft / (wrap.firstElementChild.offsetWidth + 12));
      if (i === index) return;
      index = i;
      [...$("#dots").children].forEach((d, j) => d.classList.toggle("on", j === i));
    },
    { passive: true },
  );
  setInterval(() => {
    if (document.hidden) return;
    const next = (index + 1) % BANNERS.length;
    wrap.scrollTo({ left: next * (wrap.firstElementChild.offsetWidth + 12), behavior: "smooth" });
  }, 5000);
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
      ${p.inStock ? `<button class="add ${qty ? "in" : ""}" data-add="${p.id}" aria-label="Savatga">${qty || "+"}</button>` : '<span class="out">Sotuvda yo\'q</span>'}
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
  if (qty <= 0) delete state.cart[id];
  else state.cart[id] = Math.min(99, qty);
  save("em_cart", state.cart);
  renderCatalog();
  renderCartFab();
}

function cartLines() {
  return Object.entries(state.cart)
    .map(([id, qty]) => ({ p: byId(id), qty }))
    .filter((l) => l.p && l.p.inStock);
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
        <dt>Holati</dt><dd>${p.inStock ? "Sotuvda bor" : "Sotuvda yo'q"}</dd>
      </dl>
      ${p.description ? `<p class="desc">${esc(p.description)}</p>` : ""}
      <div class="buy-row">
        ${
          !p.inStock
            ? '<button class="btn" disabled>Sotuvda yo\'q</button>'
            : qty
              ? `<div class="stepper"><button data-q="-1">−</button><span>${qty}</span><button data-q="1">+</button></div>
                 <button class="btn btn--dark" data-go="cart">Savatga o'tish</button>`
              : '<button class="btn" data-q="1">Savatga qo\'shish</button>'
        }
      </div>
      ${state.isAdmin ? `<div style="margin-top:12px"><button class="btn btn--ghost" data-edit="${p.id}">✏️ Tahrirlash</button></div>` : ""}`;
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
    };
  };
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

function checkoutSheet(body) {
  const user = tg?.initDataUnsafe?.user;
  const draft = load("em_checkout", {});
  const type = state.orderType || "delivery";
  const total = cartLines().reduce((n, l) => n + l.qty * l.p.price, 0);
  body.innerHTML = `<h3>Buyurtmani rasmiylashtirish</h3>
    <div class="seg">
      <button class="${type === "delivery" ? "on" : ""}" data-type="delivery">Yetkazib berish</button>
      <button class="${type === "pickup" ? "on" : ""}" data-type="pickup">Olib ketish</button>
    </div>
    <form id="orderForm">
      <label class="field">Ism<input name="name" required value="${esc(draft.name || [user?.first_name, user?.last_name].filter(Boolean).join(" "))}" /></label>
      <label class="field">Telefon raqam<input name="phone" type="tel" required placeholder="+998 90 123 45 67" value="${esc(draft.phone || "+998 ")}" /></label>
      ${type === "delivery" ? `<label class="field">Manzil<textarea name="address" rows="2" required placeholder="Shahar, ko'cha, uy">${esc(draft.address || "")}</textarea></label>` : ""}
      <label class="field">Izoh<textarea name="comment" rows="2" placeholder="Qavat, lift, qulay vaqt..."></textarea></label>
      <div class="total"><span>Jami</span><span>${sum(total)} so'm</span></div>
      <button class="btn" type="submit">Tasdiqlash</button>
    </form>`;
  body.onclick = (e) => {
    const seg = e.target.closest("[data-type]");
    if (!seg) return;
    state.orderType = seg.dataset.type;
    save("em_order_type", state.orderType);
    renderHeader();
    drawSheet();
  };
  body.querySelector("form").onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button[type=submit]");
    const data = Object.fromEntries(new FormData(e.target));
    save("em_checkout", { name: data.name, phone: data.phone, address: data.address });
    btn.disabled = true;
    try {
      await api("/api/orders", {
        method: "POST",
        body: { ...data, orderType: type, items: cartLines().map((l) => ({ id: l.p.id, qty: l.qty })) },
      });
      tg?.HapticFeedback?.notificationOccurred("success");
      state.cart = {};
      save("em_cart", state.cart);
      renderCatalog();
      sheetStack = [successSheet];
      drawSheet();
    } catch (err) {
      tg?.HapticFeedback?.notificationOccurred("error");
      toast(err.message);
      btn.disabled = false;
    }
  };
}

function successSheet(body) {
  body.innerHTML = `<div style="text-align:center;padding:20px 0">
      <div style="font-size:56px">✅</div>
      <h3>Buyurtma qabul qilindi!</h3>
      <p class="desc">Tez orada operatorimiz siz bilan bog'lanadi.</p>
    </div>
    <button class="btn" data-close>Yaxshi</button>`;
  body.onclick = (e) => e.target.closest("[data-close]") && closeAll();
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
          <div><div class="line-name">${esc(p.name)}</div><small>${sum(p.price)} so'm ${p.inStock ? "" : "· sotuvda yo'q"}</small></div>
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
        <label class="field">Tavsif<textarea name="description" rows="4">${esc(p?.description)}</textarea></label>
        <label class="check"><input type="checkbox" name="isNew" ${p?.isNew ? "checked" : ""} /> "Yangi" belgisi</label>
        <label class="check"><input type="checkbox" name="inStock" ${p?.inStock ?? true ? "checked" : ""} /> Sotuvda bor</label>
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
        description: f.get("description"),
        isNew: f.has("isNew"),
        inStock: f.has("inStock"),
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
    ...(state.isAdmin ? [["admin", "⚙️  Mahsulotlarni boshqarish"]] : []),
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
$("#avatarBtn").onclick = () => (state.isAdmin ? openSheet(adminSheet) : openSheet(cartSheet));
$("#backdrop").onclick = closeAll;
tg?.BackButton?.onClick(back);
window.addEventListener("scroll", onScroll, { passive: true });

// ---------- boot ----------
async function reload() {
  state.products = await api("/api/products");
  renderCatalog();
  renderCartFab();
}

(async () => {
  renderHeader();
  renderBanners();
  try {
    const config = await api("/api/config");
    state.categories = config.categories;
    state.isAdmin = config.isAdmin;
    await reload();
  } catch (err) {
    toast(err.message);
  }
})();
