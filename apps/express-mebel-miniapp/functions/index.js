// Express Mebel — Telegram Mini App backend on Firebase.
// One HTTPS function serves the mini app API (/api/**, via Hosting rewrite) and the bot webhook.
//
// Config (asked by `firebase deploy` on first run, stored in functions/.env.<project>):
//   BOT_TOKEN      secret, Telegram bot token from @BotFather
//   ADMIN_IDS      Telegram user ids allowed to manage products and stock (comma-separated)
//   WAREHOUSE_IDS  Telegram user ids of warehouse staff (stock in/out only)
//   ORDERS_CHAT_ID chat that receives orders (empty = first admin)

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { onRequest } from "firebase-functions/https";
import { logger } from "firebase-functions";
import { defineSecret, defineString } from "firebase-functions/params";

const BOT_TOKEN = defineSecret("BOT_TOKEN");
const ADMIN_IDS = defineString("ADMIN_IDS", { description: "Admin Telegram user ids, comma-separated" });
const WAREHOUSE_IDS = defineString("WAREHOUSE_IDS", {
  default: "-",
  description: "Warehouse staff Telegram user ids, comma-separated ('-' for none)",
});
const ORDERS_CHAT_ID = defineString("ORDERS_CHAT_ID", {
  default: "-",
  description: "Chat id for new orders ('-' = first admin)",
});

initializeApp();
const db = getFirestore();
const productsCol = db.collection("products");
const movementsCol = db.collection("stockMovements");
const ordersCol = db.collection("orders");
const bannersCol = db.collection("banners");

const PROJECT_ID = process.env.GCLOUD_PROJECT;
const WEBAPP_URL = `https://${PROJECT_ID}.web.app`;

// Sections are fixed by the business: furniture only.
const CATEGORIES = [
  { id: "oshxona", name: "Oshxona" },
  { id: "shkaf", name: "Shkaf" },
  { id: "tumba", name: "Tumba" },
  { id: "parta", name: "Parta" },
  { id: "pufik", name: "Pufik" },
  { id: "krovat", name: "Krovat" },
];
const CATEGORY_IDS = new Set(CATEGORIES.map((c) => c.id));

const idList = (value) =>
  value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && s !== "-");

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- storage (product photos) ----------

function storageUrl(bucket, path, token) {
  const host = process.env.FIREBASE_STORAGE_EMULATOR_HOST
    ? `http://${process.env.FIREBASE_STORAGE_EMULATOR_HOST}`
    : "https://firebasestorage.googleapis.com";
  return `${host}/v0/b/${bucket}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
}

// Only bundled placeholders or images uploaded to this project's bucket are accepted.
function isOwnImage(src) {
  if (src.startsWith("/img/")) return true;
  const prefix = storageUrl(getStorage().bucket().name, "images/", "").split("?")[0];
  return src.startsWith(prefix);
}

async function saveImage(dataUrl) {
  const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(String(dataUrl || ""));
  if (!m) throw new HttpError(400, "Faqat JPG, PNG yoki WEBP rasm");
  const bucket = getStorage().bucket();
  const path = `images/${randomUUID()}.${m[1] === "jpeg" ? "jpg" : m[1]}`;
  const token = randomUUID();
  await bucket.file(path).save(Buffer.from(m[2], "base64"), {
    contentType: `image/${m[1]}`,
    metadata: {
      cacheControl: "public, max-age=31536000, immutable",
      metadata: { firebaseStorageDownloadTokens: token },
    },
  });
  return storageUrl(bucket.name, path, token);
}

// ---------- validation ----------

function cleanProduct(input, existing = {}) {
  const name = String(input.name ?? existing.name ?? "").trim();
  const category = String(input.category ?? existing.category ?? "");
  const price = Math.round(Number(input.price ?? existing.price));
  const oldPriceRaw = input.oldPrice ?? existing.oldPrice;
  const oldPrice = oldPriceRaw ? Math.round(Number(oldPriceRaw)) : null;
  if (!name) throw new HttpError(400, "Nomi kiritilmagan");
  if (!CATEGORY_IDS.has(category)) throw new HttpError(400, "Bo'lim noto'g'ri");
  if (!Number.isFinite(price) || price <= 0) throw new HttpError(400, "Narx noto'g'ri");
  if (oldPrice !== null && (!Number.isFinite(oldPrice) || oldPrice <= price)) {
    throw new HttpError(400, "Eski narx joriy narxdan katta bo'lishi kerak");
  }
  const images = Array.isArray(input.images ?? existing.images)
    ? (input.images ?? existing.images).map(String).filter(isOwnImage).slice(0, 8)
    : [];
  return {
    name: name.slice(0, 120),
    category,
    price,
    oldPrice,
    description: String(input.description ?? existing.description ?? "").slice(0, 2000),
    size: String(input.size ?? existing.size ?? "").slice(0, 120),
    material: String(input.material ?? existing.material ?? "").slice(0, 120),
    isNew: Boolean(input.isNew ?? existing.isNew),
    // Stock changes only through the warehouse journal; new products start at 0.
    stock: existing.stock ?? 0,
    images,
    createdAt: existing.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
}

const BANNER_STYLES = new Set(["photo", "dark", "teal"]);
const BANNER_LINKS = new Set(["none", "product", "category"]);

// Banners: "photo" shows the image edge to edge; "dark"/"teal" are brand text cards with a side image.
function cleanBanner(input, existing = {}) {
  const pick = (key) => input[key] ?? existing[key];
  const style = String(pick("style") ?? "dark");
  const linkType = String(pick("linkType") ?? "none");
  const image = pick("image") ? String(pick("image")) : "";
  const title = String(pick("title") ?? "").trim().slice(0, 80);
  if (!BANNER_STYLES.has(style)) throw new HttpError(400, "Banner ko'rinishi noto'g'ri");
  if (!BANNER_LINKS.has(linkType)) throw new HttpError(400, "Havola turi noto'g'ri");
  if (image && !isOwnImage(image)) throw new HttpError(400, "Rasm noto'g'ri");
  if (style === "photo" && !image) throw new HttpError(400, "Rasmli banner uchun rasm yuklang");
  if (style !== "photo" && !title) throw new HttpError(400, "Sarlavha kiritilmagan");
  const linkId = linkType === "none" ? "" : String(pick("linkId") ?? "");
  if (linkType === "category" && !CATEGORY_IDS.has(linkId)) throw new HttpError(400, "Bo'lim tanlanmagan");
  if (linkType === "product" && !/^[\w-]{1,64}$/.test(linkId)) throw new HttpError(400, "Mahsulot tanlanmagan");
  return {
    style,
    title,
    text: String(pick("text") ?? "").trim().slice(0, 140),
    image,
    linkType,
    linkId,
    active: Boolean(pick("active") ?? true),
    order: Math.round(Number(pick("order"))) || 0,
    createdAt: existing.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
}

const SEED_BANNERS = [
  { style: "dark", title: "Interyeringiz uchun mukammal mebel", text: "Oshxonadan yotoqxonagacha — hammasi bir joyda", image: "/img/oshxona.svg", linkType: "category", linkId: "oshxona", order: 1 },
  { style: "teal", title: "Yangi kolleksiya", text: "Zamonaviy krovat va shkaflar", image: "/img/krovat.svg", linkType: "category", linkId: "krovat", order: 2 },
  { style: "dark", title: "Tez yetkazib berish", text: "Shahar bo'ylab o'rnatib beramiz", image: "/img/shkaf.svg", linkType: "none", linkId: "", order: 3 },
];

function parseLocation(value) {
  if (!value) return null;
  const lat = Number(value.lat);
  const lon = Number(value.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw new HttpError(400, "Joylashuv noto'g'ri");
  }
  return { lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6 };
}

// ---------- stock ----------

// Stock types: "in" (kirim), "out" (chiqim), "sale" (buyurtma). Always called inside a Firestore
// transaction that already read `product`, so concurrent orders cannot oversell the last unit.
function moveStock(t, ref, product, type, qty, note, by) {
  const balance = product.stock + (type === "in" ? qty : -qty);
  t.update(ref, { stock: balance, updatedAt: Date.now() });
  product.stock = balance;
  const movement = {
    productId: ref.id,
    productName: product.name,
    type,
    qty,
    balance,
    note: String(note || "").slice(0, 200),
    by: by || "—",
    at: Date.now(),
  };
  t.set(movementsCol.doc(), movement);
  return movement;
}

const staffName = (user) =>
  user ? [user.first_name, user.last_name].filter(Boolean).join(" ") || String(user.id) : "—";

// ---------- Telegram ----------

// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
function verifyInitData(initData) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(BOT_TOKEN.value()).digest();
  const expected = createHmac("sha256", secret).update(dataCheckString).digest("hex");
  if (!sameSecret(expected, hash)) return null;
  const authDate = Number(params.get("auth_date"));
  if (!authDate || Date.now() / 1000 - authDate > 86400) return null;
  try {
    return JSON.parse(params.get("user") || "null");
  } catch {
    return null;
  }
}

function sameSecret(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function authenticate(req) {
  const user = verifyInitData(req.get("x-telegram-init-data"));
  const id = String(user?.id ?? "");
  const role = !user
    ? null
    : idList(ADMIN_IDS.value()).includes(id)
      ? "admin"
      : idList(WAREHOUSE_IDS.value()).includes(id)
        ? "warehouse"
        : null;
  return { user, role };
}

function requireRole(req, ...roles) {
  const auth = authenticate(req);
  if (!roles.includes(auth.role)) throw new HttpError(403, "Ruxsat yo'q");
  return auth;
}

async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN.value()}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${method}: ${json.description}`);
  return json.result;
}

// Telegram echoes this in X-Telegram-Bot-Api-Secret-Token so only Telegram can call the webhook.
const webhookSecret = () => createHmac("sha256", BOT_TOKEN.value()).update("webhook").digest("hex");

const escapeHtml = (s) =>
  String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const formatSum = (n) => `${Math.round(n).toLocaleString("ru-RU").replace(/\s/g, " ")} so'm`;

// ---------- reverse geocoding ----------

// OpenStreetMap Nominatim usage policy: identify the app and stay at <= 1 request/second.
// The gate is per instance; maxInstances below keeps the total within the policy.
// https://operations.osmfoundation.org/policies/nominatim/
let geocodeGate = Promise.resolve();

function reverseGeocode(lat, lon) {
  const run = geocodeGate.then(async () => {
    const url = new URL("https://nominatim.openstreetmap.org/reverse");
    url.search = new URLSearchParams({ format: "jsonv2", lat, lon, zoom: "18", addressdetails: "1", "accept-language": "uz" });
    const res = await fetch(url, { headers: { "user-agent": "ExpressMebelMiniApp/1.0" }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`geocode ${res.status}`);
    const { address = {}, display_name: full = "" } = await res.json();
    const parts = [
      address.city || address.town || address.village || address.county || address.state,
      address.city_district || address.suburb || address.neighbourhood,
      address.road,
      address.house_number,
    ].filter(Boolean);
    return parts.length >= 2 ? parts.join(", ") : full;
  });
  geocodeGate = run.catch(() => {}).then(() => new Promise((r) => setTimeout(r, 1100)));
  return run;
}

// ---------- routes ----------

async function listProducts() {
  const snap = await productsCol.get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => b.createdAt - a.createdAt);
}

async function handleTelegramUpdate(req, res) {
  const header = req.get("x-telegram-bot-api-secret-token") || "";
  if (!sameSecret(header, webhookSecret())) throw new HttpError(403, "Forbidden");
  const msg = req.body?.message;
  if (msg?.text?.startsWith("/start")) {
    await tg("sendMessage", {
      chat_id: msg.chat.id,
      parse_mode: "HTML",
      text:
        "Assalomu alaykum! 👋\n\n<b>Express Mebel</b> — sifatli mebel tez yetkazib beriladi.\n" +
        "Katalogni ochish uchun quyidagi tugmani bosing.",
      reply_markup: { inline_keyboard: [[{ text: "🛋 Katalogni ochish", web_app: { url: WEBAPP_URL } }]] },
    });
  }
  res.json({ ok: true });
}

// One-time setup after deploy: registers the webhook and menu button, seeds an empty catalog.
// Safe to call repeatedly; it only points the bot at this project's own URLs.
async function handleSetup(res) {
  // Sample data is added once per project; the marker keeps a catalog the admin emptied on
  // purpose from refilling when setup is reopened (e.g. after a token change).
  const seeded = await db.runTransaction(async (t) => {
    const marker = db.collection("meta").doc("setup");
    if ((await t.get(marker)).exists) return { products: false, banners: false };
    const noProducts = (await t.get(productsCol.limit(1))).empty;
    const noBanners = (await t.get(bannersCol.limit(1))).empty;
    if (noProducts) {
      const seed = JSON.parse(readFileSync(new URL("./seed-products.json", import.meta.url), "utf8"));
      for (const { id, ...p } of seed) t.set(productsCol.doc(id), p);
    }
    if (noBanners) {
      for (const b of SEED_BANNERS) t.set(bannersCol.doc(), cleanBanner(b));
    }
    t.set(marker, { seededAt: Date.now() });
    return { products: noProducts, banners: noBanners };
  });
  const webhook = `${WEBAPP_URL}/api/telegram`;
  let bot;
  try {
    bot = await tg("getMe", {});
    await tg("setWebhook", { url: webhook, secret_token: webhookSecret(), allowed_updates: ["message"] });
    await tg("setChatMenuButton", { menu_button: { type: "web_app", text: "Katalog", web_app: { url: WEBAPP_URL } } });
  } catch (err) {
    // Most often a wrong BOT_TOKEN: Telegram answers "Unauthorized".
    throw new HttpError(502, `Telegram bilan ulanib bo'lmadi (${err.message}). BOT_TOKEN ni tekshiring.`);
  }
  res.json({ ok: true, bot: `@${bot.username}`, webapp: WEBAPP_URL, webhook, seeded });
}

async function handleOrder(req, res) {
  const { user } = authenticate(req);
  const body = req.body || {};
  const phone = String(body.phone || "").trim();
  if (!/^\+?[\d\s()-]{7,20}$/.test(phone)) throw new HttpError(400, "Telefon raqam noto'g'ri");
  const location = body.orderType === "pickup" ? null : parseLocation(body.location);
  const wanted = (Array.isArray(body.items) ? body.items : [])
    .map((it) => ({ id: String(it.id || ""), qty: Math.max(1, Math.min(99, Number(it.qty) | 0)) }))
    .filter((it) => /^[\w-]{1,64}$/.test(it.id));
  if (!wanted.length) throw new HttpError(400, "Savat bo'sh");
  const buyer = user ? staffName(user) : String(body.name || "Mijoz").slice(0, 60);

  const items = await db.runTransaction(async (t) => {
    const refs = wanted.map((it) => productsCol.doc(it.id));
    const snaps = await t.getAll(...refs);
    const lines = snaps
      .map((snap, i) => ({ ref: refs[i], product: snap.exists ? snap.data() : null, qty: wanted[i].qty }))
      .filter((l) => l.product);
    if (!lines.length) throw new HttpError(400, "Savat bo'sh");
    const short = lines.find((l) => l.qty > l.product.stock);
    if (short) {
      throw new HttpError(
        409,
        short.product.stock
          ? `«${short.product.name}» omborda faqat ${short.product.stock} ta qoldi`
          : `«${short.product.name}» tugadi`,
      );
    }
    for (const l of lines) moveStock(t, l.ref, l.product, "sale", l.qty, "Buyurtma", buyer);
    t.set(ordersCol.doc(), {
      items: lines.map((l) => ({ id: l.ref.id, name: l.product.name, price: l.product.price, qty: l.qty })),
      total: lines.reduce((n, l) => n + l.product.price * l.qty, 0),
      orderType: body.orderType === "pickup" ? "pickup" : "delivery",
      name: String(body.name || "").slice(0, 100),
      phone,
      address: String(body.address || "").slice(0, 300),
      comment: String(body.comment || "").slice(0, 500),
      location,
      telegramUserId: user?.id ?? null,
      createdAt: Date.now(),
    });
    return lines;
  });

  const total = items.reduce((n, l) => n + l.product.price * l.qty, 0);
  const lines = items.map((l) => `• ${escapeHtml(l.product.name)} × ${l.qty} = ${formatSum(l.product.price * l.qty)}`);
  const who = user
    ? `${escapeHtml(staffName(user))}${user.username ? ` (@${escapeHtml(user.username)})` : ""}`
    : "—";
  const text = [
    "🛒 <b>Yangi buyurtma</b>",
    "",
    ...lines,
    "",
    `<b>Jami:</b> ${formatSum(total)}`,
    `<b>Turi:</b> ${body.orderType === "pickup" ? "Olib ketish" : "Yetkazib berish"}`,
    `<b>Ism:</b> ${escapeHtml(String(body.name || "").slice(0, 100))}`,
    `<b>Telefon:</b> ${escapeHtml(phone)}`,
    body.address ? `<b>Manzil:</b> ${escapeHtml(String(body.address).slice(0, 300))}` : "",
    location
      ? `<b>Xarita:</b> <a href="https://maps.google.com/?q=${location.lat},${location.lon}">Google</a> · <a href="https://yandex.uz/maps/?pt=${location.lon},${location.lat}&z=17&l=map">Yandex</a>`
      : "",
    body.comment ? `<b>Izoh:</b> ${escapeHtml(String(body.comment).slice(0, 500))}` : "",
    `<b>Telegram:</b> ${who}`,
    ...items
      .filter((l) => l.product.stock <= 3)
      .map((l) =>
        l.product.stock
          ? `⚠️ «${escapeHtml(l.product.name)}» omborda ${l.product.stock} ta qoldi`
          : `⛔️ «${escapeHtml(l.product.name)}» tugadi — saytda sotuvdan chiqdi`,
      ),
  ]
    .filter((l) => l !== "")
    .join("\n");

  // The order is already committed; notification failures are logged, not surfaced to the buyer.
  const ordersChat = idList(ORDERS_CHAT_ID.value())[0] || idList(ADMIN_IDS.value())[0];
  try {
    if (ordersChat) {
      const sent = await tg("sendMessage", {
        chat_id: ordersChat,
        text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
      // A native location pin lets the courier open navigation straight from the chat.
      if (location) {
        await tg("sendLocation", {
          chat_id: ordersChat,
          latitude: location.lat,
          longitude: location.lon,
          reply_parameters: { message_id: sent.message_id },
        });
      }
    }
    if (user) {
      await tg("sendMessage", {
        chat_id: user.id,
        parse_mode: "HTML",
        text: `✅ Buyurtmangiz qabul qilindi!\n\n${lines.join("\n")}\n\n<b>Jami:</b> ${formatSum(total)}\n\nTez orada operatorimiz siz bilan bog'lanadi.`,
      });
    }
  } catch (err) {
    logger.error("order notification failed", err);
  }
  res.status(201).json({ ok: true, total });
}

async function route(req, res) {
  const path = req.path;
  const method = req.method;

  if (path === "/api/telegram" && method === "POST") return handleTelegramUpdate(req, res);
  if (path === "/api/setup" && method === "GET") return handleSetup(res);

  if (path === "/api/config" && method === "GET") {
    const { user, role } = authenticate(req);
    return res.json({ categories: CATEGORIES, role, user });
  }

  if (path === "/api/products" && method === "GET") return res.json(await listProducts());

  if (path === "/api/products" && method === "POST") {
    const { user } = requireRole(req, "admin");
    const body = req.body || {};
    const ref = productsCol.doc();
    const product = cleanProduct(body);
    const initial = Math.min(Math.floor(Number(body.stock)) || 0, 100000);
    await db.runTransaction(async (t) => {
      t.set(ref, product);
      if (initial > 0) moveStock(t, ref, product, "in", initial, "Boshlang'ich qoldiq", staffName(user));
    });
    return res.status(201).json({ id: ref.id, ...product });
  }

  const match = path.match(/^\/api\/products\/([\w-]{1,64})$/);
  if (match) {
    const ref = productsCol.doc(match[1]);
    if (method === "GET") {
      const snap = await ref.get();
      if (!snap.exists) throw new HttpError(404, "Mahsulot topilmadi");
      return res.json({ id: snap.id, ...snap.data() });
    }
    requireRole(req, "admin");
    if (method === "PUT") {
      const product = await db.runTransaction(async (t) => {
        const snap = await t.get(ref);
        if (!snap.exists) throw new HttpError(404, "Mahsulot topilmadi");
        const next = cleanProduct(req.body || {}, snap.data());
        t.set(ref, next);
        return next;
      });
      return res.json({ id: ref.id, ...product });
    }
    if (method === "DELETE") {
      await ref.delete();
      return res.json({ ok: true });
    }
  }

  if (path === "/api/banners" && method === "GET") {
    // Admins also get hidden banners so they can switch them back on.
    const all = req.query.all === "1" && authenticate(req).role === "admin";
    const snap = await bannersCol.get();
    const list = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((b) => all || b.active)
      .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
    return res.json(list);
  }

  if (path === "/api/banners" && method === "POST") {
    requireRole(req, "admin");
    const ref = bannersCol.doc();
    const banner = cleanBanner(req.body || {});
    await ref.set(banner);
    return res.status(201).json({ id: ref.id, ...banner });
  }

  const bannerMatch = path.match(/^\/api\/banners\/([\w-]{1,64})$/);
  if (bannerMatch && (method === "PUT" || method === "DELETE")) {
    requireRole(req, "admin");
    const ref = bannersCol.doc(bannerMatch[1]);
    if (method === "DELETE") {
      await ref.delete();
      return res.json({ ok: true });
    }
    const banner = await db.runTransaction(async (t) => {
      const snap = await t.get(ref);
      if (!snap.exists) throw new HttpError(404, "Banner topilmadi");
      const next = cleanBanner(req.body || {}, snap.data());
      t.set(ref, next);
      return next;
    });
    return res.json({ id: ref.id, ...banner });
  }

  if (path === "/api/upload" && method === "POST") {
    requireRole(req, "admin");
    return res.status(201).json({ url: await saveImage(req.body?.dataUrl) });
  }

  if (path === "/api/geocode" && method === "GET") {
    const loc = parseLocation({ lat: req.query.lat, lon: req.query.lon });
    if (!loc) throw new HttpError(400, "Joylashuv yo'q");
    try {
      return res.json({ address: await reverseGeocode(loc.lat, loc.lon) });
    } catch (err) {
      logger.warn("geocode failed", err);
      throw new HttpError(502, "Manzilni aniqlab bo'lmadi, qo'lda yozing");
    }
  }

  if (path === "/api/stock" && method === "GET") {
    requireRole(req, "admin", "warehouse");
    const productId = req.query.productId ? String(req.query.productId) : "";
    // Per-product history filters in memory to avoid a composite index (productId + at).
    const snap = productId
      ? await movementsCol.where("productId", "==", productId).get()
      : await movementsCol.orderBy("at", "desc").limit(100).get();
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => b.at - a.at);
    return res.json(list.slice(0, 100));
  }

  if (path === "/api/stock" && method === "POST") {
    const { user } = requireRole(req, "admin", "warehouse");
    const body = req.body || {};
    if (body.type !== "in" && body.type !== "out") throw new HttpError(400, "Amal turi noto'g'ri");
    const qty = Number(body.qty);
    if (!Number.isInteger(qty) || qty <= 0 || qty > 100000) throw new HttpError(400, "Miqdor noto'g'ri");
    const ref = productsCol.doc(String(body.productId || "-"));
    const result = await db.runTransaction(async (t) => {
      const snap = await t.get(ref);
      if (!snap.exists) throw new HttpError(404, "Mahsulot topilmadi");
      const product = snap.data();
      if (body.type === "out" && qty > product.stock) throw new HttpError(400, `Omborda faqat ${product.stock} ta bor`);
      const movement = moveStock(t, ref, product, body.type, qty, body.note, staffName(user));
      return { product: { id: ref.id, ...product }, movement };
    });
    return res.status(201).json(result);
  }

  if (path === "/api/orders" && method === "POST") return handleOrder(req, res);

  throw new HttpError(404, "Topilmadi");
}

export const api = onRequest(
  {
    region: "europe-west1",
    secrets: [BOT_TOKEN],
    invoker: "public",
    memory: "256MiB",
    maxInstances: 3,
    timeoutSeconds: 60,
  },
  async (req, res) => {
    res.set("cache-control", "no-store");
    try {
      await route(req, res);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) logger.error(err);
      if (!res.headersSent) res.status(status).json({ error: status === 500 ? "Xatolik yuz berdi" : err.message });
    }
  },
);
