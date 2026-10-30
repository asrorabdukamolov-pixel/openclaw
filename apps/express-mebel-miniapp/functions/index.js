// Express Mebel — Telegram Mini App backend on Firebase.
// One HTTPS function serves the mini app API (/api/**, via Hosting rewrite) and the bot webhook.
//
// Config (asked by `firebase deploy` on first run, stored in functions/.env.<project>):
//   BOT_TOKEN      secret, Telegram bot token from @BotFather
//   ADMIN_IDS      Telegram user ids allowed to manage products and stock (comma-separated)
//   ORDERS_CHAT_ID chat that receives orders (empty = first admin)
//   PAYMENT_PROVIDER_TOKEN secret, Telegram Payments provider token from @BotFather ('-' = cards off)
// Warehouse staff join through one-time invite links from the admin panel (Firestore `staff`).

import { createHash, createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { onRequest } from "firebase-functions/https";
import { onSchedule } from "firebase-functions/scheduler";
import { logger } from "firebase-functions";
import { defineSecret, defineString } from "firebase-functions/params";

const BOT_TOKEN = defineSecret("BOT_TOKEN");
const PAYMENT_PROVIDER_TOKEN = defineSecret("PAYMENT_PROVIDER_TOKEN");
const ADMIN_IDS = defineString("ADMIN_IDS", { description: "Admin Telegram user ids, comma-separated" });
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
const staffCol = db.collection("staff");
const invitesCol = db.collection("staffInvites");
const screensCol = db.collection("screens");
const pairingsCol = db.collection("screenPairings");
const countersRef = db.collection("meta").doc("counters");

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

const KIT_SHORT = new Set(["preorder", "hide"]);
const MAX_KIT_PARTS = 40;

// Kits ("komplekt") are what the catalog sells as one product, e.g. a kitchen of a dozen modules.
// They hold no stock or barcode of their own: availability comes from the modules (`components`),
// which are ordinary products with a SKU and boxes. Components are checked against the database by
// the route that saves the kit (`checkKitParts`).
function cleanKitParts(raw) {
  const qtyById = new Map();
  for (const c of Array.isArray(raw) ? raw : []) {
    const id = String(c?.id || "");
    const qty = Math.round(Number(c?.qty));
    if (!/^[\w-]{1,64}$/.test(id) || !(qty >= 1 && qty <= 50)) throw new HttpError(400, "Komplekt tarkibi noto'g'ri");
    qtyById.set(id, (qtyById.get(id) || 0) + qty);
  }
  if (!qtyById.size) throw new HttpError(400, "Komplektga kamida bitta modul qo'shing");
  if (qtyById.size > MAX_KIT_PARTS) throw new HttpError(400, `Komplektda ${MAX_KIT_PARTS} xildan ko'p modul bo'lmasin`);
  return [...qtyById].map(([id, qty]) => ({ id, qty }));
}

function cleanProduct(input, existing = {}) {
  // The kind is chosen once, at creation; products saved before kits existed are items.
  const kind = existing.createdAt ? (existing.kind ?? "item") : input.kind === "kit" ? "kit" : "item";
  const name = String(input.name ?? existing.name ?? "").trim();
  const category = String(input.category ?? existing.category ?? "");
  // A draft is a product the warehouse registered; it stays off the catalog until an admin prices
  // and publishes it, so only published products need a price.
  const draft = Boolean(input.draft ?? existing.draft ?? false);
  const price = Math.round(Number(input.price ?? existing.price ?? 0)) || 0;
  const oldPriceRaw = input.oldPrice ?? existing.oldPrice;
  const oldPrice = oldPriceRaw ? Math.round(Number(oldPriceRaw)) : null;
  if (!name) throw new HttpError(400, "Nomi kiritilmagan");
  if (!CATEGORY_IDS.has(category)) throw new HttpError(400, "Bo'lim noto'g'ri");
  if (price < 0 || (!draft && price <= 0)) throw new HttpError(400, "Narx kiritilmagan: saytda ko'rsatish uchun narx kerak");
  if (oldPrice !== null && (!Number.isFinite(oldPrice) || oldPrice <= price)) {
    throw new HttpError(400, "Eski narx joriy narxdan katta bo'lishi kerak");
  }
  const images = Array.isArray(input.images ?? existing.images)
    ? (input.images ?? existing.images).map(String).filter(isOwnImage).slice(0, 8)
    : [];
  const common = {
    name: name.slice(0, 120),
    category,
    price,
    oldPrice,
    description: String(input.description ?? existing.description ?? "").slice(0, 2000),
    size: String(input.size ?? existing.size ?? "").slice(0, 120),
    material: String(input.material ?? existing.material ?? "").slice(0, 120),
    isNew: Boolean(input.isNew ?? existing.isNew),
    draft,
    images,
    createdAt: existing.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
  if (kind === "kit") {
    const whenShort = String(input.whenShort ?? existing.whenShort ?? "preorder");
    if (!KIT_SHORT.has(whenShort)) throw new HttpError(400, "Modul yetishmaganda nima qilish noto'g'ri");
    return {
      ...common,
      kind,
      components: cleanKitParts(input.components ?? existing.components),
      whenShort,
      leadDays: Math.min(120, Math.max(1, Math.round(Number(input.leadDays ?? existing.leadDays ?? 10)) || 10)),
    };
  }
  return {
    ...common,
    kind,
    // Modules that only make sense inside a kit stay off the catalog but keep their stock and labels.
    standalone: Boolean(input.standalone ?? existing.standalone ?? true),
    // Packages per unit: each box gets its own barcode label and is scanned when picking.
    boxes: Math.min(20, Math.max(1, Math.round(Number(input.boxes ?? existing.boxes ?? 1)) || 1)),
    sku: existing.sku ?? null,
    // Stock changes only through the warehouse journal; new products start at 0.
    stock: existing.stock ?? 0,
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

// Stock types: "in" (kirim), "out" (chiqim), "sale" (buyurtma), "release" (to'lanmagan bron qaytdi). Always called inside a Firestore
// transaction that already read `product`, so concurrent orders cannot oversell the last unit.
function moveStock(t, ref, product, type, qty, note, by) {
  const balance = product.stock + (type === "in" || type === "release" ? qty : -qty);
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

const isAdminId = (id) => idList(ADMIN_IDS.value()).includes(String(id));

// Admins come from deploy config; everyone else's role is their `staff` document (invite links).
async function authenticate(req) {
  const user = verifyInitData(req.get("x-telegram-init-data"));
  if (!user) return { user: null, role: null };
  if (isAdminId(user.id)) return { user, role: "admin" };
  const staff = await staffCol.doc(String(user.id)).get();
  return { user, role: staff.exists ? staff.data().role : null };
}

async function requireRole(req, ...roles) {
  const auth = await authenticate(req);
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

let botUsername = null;
function getBotUsername() {
  botUsername ??= tg("getMe", {})
    .then((bot) => bot.username)
    .catch((err) => {
      botUsername = null;
      throw err;
    });
  return botUsername;
}

// Telegram echoes this in X-Telegram-Bot-Api-Secret-Token so only Telegram can call the webhook.
const webhookSecret = () => createHmac("sha256", BOT_TOKEN.value()).update("webhook").digest("hex");

const ordersChat = () => idList(ORDERS_CHAT_ID.value())[0] || idList(ADMIN_IDS.value())[0];

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

// A kit's availability is its scarcest module: floor(module stock / modules per kit).
function withKitStock(kit, byId) {
  const parts = kit.components.map((c) => ({ ...c, product: byId.get(c.id) }));
  const missing = parts.some((c) => !c.product);
  const stock = missing ? 0 : Math.min(...parts.map((c) => Math.floor(c.product.stock / c.qty)));
  return {
    ...kit,
    stock,
    boxes: missing ? null : parts.reduce((n, c) => n + c.qty * (c.product.boxes ?? 1), 0),
    parts: parts.map((c) => ({
      id: c.id,
      qty: c.qty,
      name: c.product?.name ?? "O'chirilgan modul",
      sku: c.product?.sku ?? null,
      boxes: c.product?.boxes ?? null,
      stock: c.product?.stock ?? 0,
    })),
    preorderDays: stock <= 0 && kit.whenShort === "preorder" ? kit.leadDays : null,
  };
}

// `listed` = shown to buyers. Staff get everything (drafts, kit-only modules) with the same flag,
// so the mini app filters its catalog the way the server filters for buyers.
async function listProducts({ staff = false } = {}) {
  const snap = await productsCol.get();
  const raw = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const byId = new Map(raw.filter((p) => p.kind !== "kit").map((p) => [p.id, p]));
  return raw
    .map((p) => (p.kind === "kit" ? withKitStock(p, byId) : p))
    .map((p) => ({
      ...p,
      listed: !p.draft && (p.kind === "kit" ? p.stock > 0 || p.whenShort === "preorder" : p.standalone !== false),
    }))
    .filter((p) => staff || p.listed)
    .sort((a, b) => b.createdAt - a.createdAt);
}

// Kit modules must exist and be ordinary products (a kit inside a kit would hide its boxes).
async function checkKitParts(t, components) {
  const snaps = await t.getAll(...components.map((c) => productsCol.doc(c.id)));
  const bad = snaps.find((s) => !s.exists || s.data().kind === "kit");
  if (bad) throw new HttpError(400, bad.exists ? `«${bad.data().name}» komplekt, uni modul qilib bo'lmaydi` : "Komplektdagi modul topilmadi");
}

// Staff (admin, omborchi) and paired warehouse screens see drafts; buyers never do.
async function isStaffRequest(req) {
  if (await screenFromToken(req)) return true;
  const { role } = await authenticate(req);
  return role === "admin" || role === "warehouse";
}

async function handleTelegramUpdate(req, res) {
  const header = req.get("x-telegram-bot-api-secret-token") || "";
  if (!sameSecret(header, webhookSecret())) throw new HttpError(403, "Forbidden");
  const msg = req.body?.message;
  if (req.body?.pre_checkout_query) {
    await handlePreCheckout(req.body.pre_checkout_query);
    return res.json({ ok: true });
  }
  if (msg?.successful_payment) {
    await handleSuccessfulPayment(msg);
    return res.json({ ok: true });
  }
  if (req.body?.callback_query) {
    await handleCallback(req.body.callback_query);
    return res.json({ ok: true });
  }
  const invite = /^\/start inv_([a-f0-9]{24})$/.exec(msg?.text || "");
  // Replies are best-effort: a failed send must not make Telegram retry an invite already used.
  try {
    if (invite && msg.chat.type === "private") {
      await tg("sendMessage", { chat_id: msg.chat.id, parse_mode: "HTML", ...(await joinStaff(msg.from, invite[1])) });
    } else if (msg?.text?.startsWith("/start")) {
      await tg("sendMessage", {
        chat_id: msg.chat.id,
        parse_mode: "HTML",
        text:
          "Assalomu alaykum! 👋\n\n<b>Express Mebel</b> — sifatli mebel tez yetkazib beriladi.\n" +
          "Katalogni ochish uchun quyidagi tugmani bosing.",
        reply_markup: { inline_keyboard: [[{ text: "🛋 Katalogni ochish", web_app: { url: WEBAPP_URL } }]] },
      });
    }
  } catch (err) {
    logger.error("telegram update failed", err);
  }
  res.json({ ok: true });
}

const ROLE_LABEL = { warehouse: "omborchi" };
const INVITE_TTL_MS = 24 * 60 * 60 * 1000;

// Redeems a one-time invite: the Telegram account that opens it becomes staff with the invite's role.
async function joinStaff(from, code) {
  const openApp = { inline_keyboard: [[{ text: "🛋 Ilovani ochish", web_app: { url: WEBAPP_URL } }]] };
  if (isAdminId(from.id)) {
    return { text: "Siz allaqachon adminsiz, taklif kerak emas.", reply_markup: openApp };
  }
  const result = await db.runTransaction(async (t) => {
    const ref = invitesCol.doc(code);
    const snap = await t.get(ref);
    const inv = snap.data();
    if (!snap.exists || inv.usedAt || inv.expiresAt < Date.now()) return null;
    t.set(staffCol.doc(String(from.id)), {
      role: inv.role,
      name: staffName(from),
      username: from.username || "",
      addedAt: Date.now(),
      invitedBy: inv.createdBy,
    });
    t.update(ref, { usedAt: Date.now(), usedBy: from.id });
    return inv;
  });
  if (!result) {
    return { text: "⚠️ Taklif havolasi eskirgan yoki allaqachon ishlatilgan. Admindan yangisini so'rang." };
  }
  await tg("sendMessage", {
    chat_id: result.createdBy,
    text: `✅ ${staffName(from)}${from.username ? ` (@${from.username})` : ""} ${ROLE_LABEL[result.role]} sifatida qo'shildi.`,
  }).catch((err) => logger.warn("invite notice failed", err));
  return {
    text: `✅ Siz Express Mebel'ga <b>${ROLE_LABEL[result.role]}</b> sifatida qo'shildingiz.\n\nIlovani oching → ☰ → 📦 Ombor.`,
    reply_markup: openApp,
  };
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
  await assignMissingSkus();
  const webhook = `${WEBAPP_URL}/api/telegram`;
  let bot;
  try {
    bot = await tg("getMe", {});
    await tg("setWebhook", { url: webhook, secret_token: webhookSecret(), allowed_updates: ["message", "pre_checkout_query", "callback_query"] });
    await tg("setChatMenuButton", { menu_button: { type: "web_app", text: "Katalog", web_app: { url: WEBAPP_URL } } });
  } catch (err) {
    // Most often a wrong BOT_TOKEN: Telegram answers "Unauthorized".
    throw new HttpError(502, `Telegram bilan ulanib bo'lmadi (${err.message}). BOT_TOKEN ni tekshiring.`);
  }
  res.json({ ok: true, bot: `@${bot.username}`, webapp: WEBAPP_URL, webhook, seeded });
}

const FIRST_SKU = 100000;
const FIRST_ORDER_NO = 1000;

// Products created before barcodes existed get a SKU here; reopening setup is a no-op once all have one.
async function assignMissingSkus() {
  await db.runTransaction(async (t) => {
    const counters = (await t.get(countersRef)).data() || {};
    const missing = (await t.get(productsCol)).docs.filter((d) => d.data().sku == null && d.data().kind !== "kit");
    if (!missing.length) return;
    let sku = counters.sku ?? FIRST_SKU;
    missing.sort((a, b) => a.data().createdAt - b.data().createdAt);
    for (const d of missing) t.update(d.ref, { sku: ++sku, boxes: d.data().boxes ?? 1 });
    t.set(countersRef, { sku }, { merge: true });
  });
}

const REGION = "europe-west1";
const PAY_WINDOW_MS = 30 * 60 * 1000;
// Telegram Payments amounts are in the currency's smallest unit; UZS has two decimal places.
const UZS_MINOR = 100;

const cardsEnabled = () => PAYMENT_PROVIDER_TOKEN.value().trim().length > 1;

async function handleOrder(req, res) {
  const { user } = await authenticate(req);
  const body = req.body || {};
  const phone = String(body.phone || "").trim();
  if (!/^\+?[\d\s()-]{7,20}$/.test(phone)) throw new HttpError(400, "Telefon raqam noto'g'ri");
  const location = body.orderType === "pickup" ? null : parseLocation(body.location);
  const payment = body.payment === "card" ? "card" : "cash";
  if (payment === "card" && !cardsEnabled()) throw new HttpError(400, "Karta orqali to'lov hali yoqilmagan");
  // The invoice opens inside Telegram and the receipt goes to the buyer's chat.
  if (payment === "card" && !user) throw new HttpError(400, "Karta orqali to'lash uchun ilovani Telegram'da oching");
  const wanted = (Array.isArray(body.items) ? body.items : [])
    .map((it) => ({ id: String(it.id || ""), qty: Math.max(1, Math.min(99, Number(it.qty) | 0)) }))
    .filter((it) => /^[\w-]{1,64}$/.test(it.id));
  if (!wanted.length) throw new HttpError(400, "Savat bo'sh");
  const buyer = user ? staffName(user) : String(body.name || "Mijoz").slice(0, 60);
  const orderRef = ordersCol.doc();

  // Stock is reserved for card orders too, so the last unit cannot be sold twice while the buyer pays.
  const order = await db.runTransaction(async (t) => {
    const counters = (await t.get(countersRef)).data() || {};
    const refs = wanted.map((it) => productsCol.doc(it.id));
    const snaps = await t.getAll(...refs);
    const lines = snaps
      .map((snap, i) => ({ ref: refs[i], product: snap.exists ? snap.data() : null, qty: wanted[i].qty }))
      .filter((l) => l.product && !l.product.draft && l.product.standalone !== false);
    if (!lines.length) throw new HttpError(400, "Savat bo'sh");
    const pick = await pickPlan(t, lines);
    const short = pick.find((m) => m.qty > m.product.stock);
    if (short) {
      const left = short.product.stock ? `omborda faqat ${short.product.stock} ta qoldi` : "tugadi";
      throw new HttpError(
        409,
        short.kits.length
          ? `«${short.kits.join("», «")}» shuncha miqdorda yo'q: «${short.product.name}» moduli ${left}`
          : `«${short.product.name}» ${left}`,
      );
    }
    for (const m of pick) moveStock(t, m.ref, m.product, "sale", m.qty, m.kits.length ? `Buyurtma: ${m.kits.join(", ")}` : "Buyurtma", buyer);
    const data = {
      number: (counters.order ?? FIRST_ORDER_NO) + 1,
      // What the buyer bought (kits stay one line) ...
      items: lines.map((l) => ({
        id: l.ref.id,
        name: l.product.name,
        price: l.product.price,
        qty: l.qty,
        kind: l.product.kind === "kit" ? "kit" : "item",
      })),
      // ... and what the warehouse picks: physical modules with their boxes, kits expanded and merged.
      pick: pick.map((m) => ({ id: m.ref.id, name: m.product.name, qty: m.qty, sku: m.product.sku ?? null, boxes: m.product.boxes ?? 1 })),
      total: lines.reduce((n, l) => n + l.product.price * l.qty, 0),
      lowStock: pick.filter((m) => m.product.stock <= 3).map((m) => ({ name: m.product.name, stock: m.product.stock })),
      orderType: body.orderType === "pickup" ? "pickup" : "delivery",
      payment,
      status: payment === "card" ? "awaiting_payment" : "new",
      // Fulfillment stage: a card order reaches the warehouse screen only once it is paid.
      stage: payment === "card" ? null : "new",
      picked: {},
      name: String(body.name || "").slice(0, 100),
      phone,
      address: String(body.address || "").slice(0, 300),
      comment: String(body.comment || "").slice(0, 500),
      location,
      telegramUserId: user?.id ?? null,
      telegramUsername: user?.username ?? "",
      createdAt: Date.now(),
    };
    t.set(countersRef, { order: data.number }, { merge: true });
    t.set(orderRef, data);
    return data;
  });

  if (payment === "cash") {
    await notifyOrder(orderRef.id, order);
    return res.status(201).json({ ok: true, orderId: orderRef.id, total: order.total });
  }
  try {
    const invoiceLink = await tg("createInvoiceLink", {
      title: "Express Mebel buyurtmasi",
      description: order.items.map((i) => `${i.name} × ${i.qty}`).join(", ").slice(0, 255),
      payload: orderRef.id,
      provider_token: PAYMENT_PROVIDER_TOKEN.value(),
      currency: "UZS",
      prices: order.items.map((i) => ({ label: `${i.name} × ${i.qty}`.slice(0, 64), amount: i.price * i.qty * UZS_MINOR })),
    });
    return res.status(201).json({ ok: true, orderId: orderRef.id, total: order.total, invoiceLink });
  } catch (err) {
    logger.error("createInvoiceLink failed", err);
    await releaseOrder(orderRef.id, ["awaiting_payment"], "To'lov oynasi ochilmadi");
    throw new HttpError(502, "To'lov oynasini ochib bo'lmadi. Keyinroq urinib ko'ring yoki naqd tanlang.");
  }
}

// Physical modules an order needs: kits expanded into their components, the same module merged
// across lines so its stock is checked once. Reads only, so it runs before the transaction writes.
async function pickPlan(t, lines) {
  const kitParts = lines.filter((l) => l.product.kind === "kit").flatMap((l) => l.product.components);
  const partIds = [...new Set(kitParts.map((c) => c.id))];
  const partSnaps = partIds.length ? await t.getAll(...partIds.map((id) => productsCol.doc(id))) : [];
  const parts = new Map(partSnaps.filter((s) => s.exists).map((s) => [s.id, s.data()]));
  const plan = new Map();
  const add = (ref, product, qty, kitName) => {
    const m = plan.get(ref.id) || { ref, product, qty: 0, kits: [] };
    m.qty += qty;
    if (kitName && !m.kits.includes(kitName)) m.kits.push(kitName);
    plan.set(ref.id, m);
  };
  for (const l of lines) {
    if (l.product.kind !== "kit") {
      add(l.ref, l.product, l.qty);
      continue;
    }
    for (const c of l.product.components) {
      const product = parts.get(c.id);
      if (!product) throw new HttpError(409, `«${l.product.name}» tarkibidagi modul topilmadi, admin bilan bog'laning`);
      add(productsCol.doc(c.id), product, c.qty * l.qty, l.product.name);
    }
  }
  return [...plan.values()];
}

// Orders placed before kits existed have no `pick`; their items were the physical products.
const pickLines = (order) => order.pick ?? order.items;

// Returns reserved stock of an unpaid order and marks it cancelled. Only orders whose status is in
// `fromStatuses` are touched, so a paid order can never be released.
async function releaseOrder(orderId, fromStatuses, reason) {
  return db.runTransaction(async (t) => {
    const ref = ordersCol.doc(orderId);
    const snap = await t.get(ref);
    if (!snap.exists || !fromStatuses.includes(snap.data().status)) return false;
    const order = snap.data();
    const lines = pickLines(order);
    const refs = lines.map((i) => productsCol.doc(i.id));
    const products = await t.getAll(...refs);
    products.forEach((p, i) => {
      if (p.exists) moveStock(t, refs[i], p.data(), "release", lines[i].qty, reason, "Tizim");
    });
    t.update(ref, { status: "cancelled", cancelledAt: Date.now(), cancelReason: reason });
    return true;
  });
}

async function notifyOrder(id, order) {
  const lines = order.items.map((i) => `• ${escapeHtml(i.name)} × ${i.qty} = ${formatSum(i.price * i.qty)}`);
  const who = order.telegramUserId
    ? `${escapeHtml(order.name)}${order.telegramUsername ? ` (@${escapeHtml(order.telegramUsername)})` : ""}`
    : "—";
  const { location } = order;
  const text = [
    `🛒 <b>Yangi buyurtma #${order.number}</b>`,
    "",
    ...lines,
    "",
    `<b>Jami:</b> ${formatSum(order.total)}`,
    `<b>To'lov:</b> ${order.payment === "card" ? "💳 Karta orqali — TO'LANGAN" : "💵 Qabul qilganda"}`,
    `<b>Turi:</b> ${order.orderType === "pickup" ? "Olib ketish" : "Yetkazib berish"}`,
    `<b>Ism:</b> ${escapeHtml(order.name)}`,
    `<b>Telefon:</b> ${escapeHtml(order.phone)}`,
    order.address ? `<b>Manzil:</b> ${escapeHtml(order.address)}` : "",
    location
      ? `<b>Xarita:</b> <a href="https://maps.google.com/?q=${location.lat},${location.lon}">Google</a> · <a href="https://yandex.uz/maps/?pt=${location.lon},${location.lat}&z=17&l=map">Yandex</a>`
      : "",
    order.comment ? `<b>Izoh:</b> ${escapeHtml(order.comment)}` : "",
    `<b>Telegram:</b> ${who}`,
    ...order.lowStock.map((l) =>
      l.stock
        ? `⚠️ «${escapeHtml(l.name)}» omborda ${l.stock} ta qoldi`
        : `⛔️ «${escapeHtml(l.name)}» tugadi — saytda sotuvdan chiqdi`,
    ),
  ]
    .filter((l) => l !== "")
    .join("\n");

  // The order is already committed; notification failures are logged, not surfaced to the buyer.
  const chat = ordersChat();
  try {
    if (chat) {
      const sent = await tg("sendMessage", {
        chat_id: chat,
        text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
      // A native location pin lets the courier open navigation straight from the chat.
      if (location) {
        await tg("sendLocation", {
          chat_id: chat,
          latitude: location.lat,
          longitude: location.lon,
          reply_parameters: { message_id: sent.message_id },
        });
      }
    }
    if (order.telegramUserId) {
      const paid = order.payment === "card" ? "\n💳 To'lov qabul qilindi." : "";
      await tg("sendMessage", {
        chat_id: order.telegramUserId,
        parse_mode: "HTML",
        text: `✅ Buyurtmangiz #${order.number} qabul qilindi!${paid}\n\n${lines.join("\n")}\n\n<b>Jami:</b> ${formatSum(order.total)}\n\nMebel tayyor bo'lgach, yetkazish vaqtini tanlashingizni so'raymiz.`,
      });
    }
  } catch (err) {
    logger.error("order notification failed", err);
  }
}

// Telegram asks before charging; it must be answered within 10 seconds.
async function handlePreCheckout(query) {
  const ok = await db.runTransaction(async (t) => {
    const ref = ordersCol.doc(String(query.invoice_payload));
    const snap = await t.get(ref);
    const order = snap.data();
    const valid =
      snap.exists &&
      order.status === "awaiting_payment" &&
      order.telegramUserId === query.from.id &&
      query.currency === "UZS" &&
      query.total_amount === order.total * UZS_MINOR;
    if (valid) t.update(ref, { status: "paying", payingAt: Date.now() });
    return valid;
  });
  await tg("answerPreCheckoutQuery", {
    pre_checkout_query_id: query.id,
    ok,
    ...(ok ? {} : { error_message: "Buyurtma muddati o'tgan yoki bekor qilingan. Iltimos, qaytadan buyurtma bering." }),
  });
}

async function handleSuccessfulPayment(msg) {
  const pay = msg.successful_payment;
  const ref = ordersCol.doc(String(pay.invoice_payload));
  const result = await db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (!snap.exists) return null;
    const order = snap.data();
    if (order.status === "paid") return { order, duplicate: true };
    // A payment can still land after the release job cancelled the order; keep the money's trail
    // and tell the admins instead of silently re-reserving stock that may be gone.
    const status = order.status === "cancelled" ? "paid_after_cancel" : "paid";
    t.update(ref, {
      status,
      ...(status === "paid" ? { stage: "new", stageAt: Date.now() } : {}),
      paidAt: Date.now(),
      paidAmount: pay.total_amount / UZS_MINOR,
      telegramChargeId: pay.telegram_payment_charge_id,
      providerChargeId: pay.provider_payment_charge_id,
    });
    return { order: { ...order, status } };
  });
  if (!result || result.duplicate) return;
  if (result.order.status === "paid") return notifyOrder(ref.id, result.order);
  await tg("sendMessage", {
    chat_id: ordersChat(),
    text: `⚠️ To'lov bron bekor qilingandan keyin keldi: buyurtma ${ref.id}, ${formatSum(result.order.total)}. Omborni tekshirib, mijoz bilan bog'laning.`,
  });
}

// ---------- fulfillment (warehouse screen) ----------

const ACTIVE_STAGES = ["new", "picking", "ready", "shipped"];
const AUTO_CLOSE_MS = 5 * 24 * 60 * 60 * 1000;
const boxCode = (sku, box) => `EM${sku}-${box}`;
const boxesNeeded = (order) => pickLines(order).reduce((n, i) => n + i.qty * (i.boxes ?? 1), 0);
const boxesPicked = (order) => Object.values(order.picked || {}).reduce((n, c) => n + c, 0);

// Screens are browser pages paired once with a code from the admin panel; they hold a long token
// whose SHA-256 names their `screens` document, so the database never stores the token itself.
const tokenId = (token) => createHash("sha256").update(token).digest("hex");

async function screenFromToken(req) {
  const token = req.get("x-screen-token");
  if (!token || token.length < 32) return null;
  const snap = await screensCol.doc(tokenId(token)).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

async function requireFulfillment(req) {
  const screen = await screenFromToken(req);
  if (screen) return { actor: `🖥 ${screen.name}` };
  const { user, role } = await authenticate(req);
  if (role !== "admin" && role !== "warehouse") throw new HttpError(403, "Ruxsat yo'q");
  return { actor: staffName(user) };
}

function fulfillmentView(id, o) {
  return {
    id,
    number: o.number ?? null,
    stage: o.stage,
    stageAt: o.stageAt ?? o.createdAt,
    createdAt: o.createdAt,
    orderType: o.orderType,
    payment: o.payment,
    name: o.name,
    phone: o.phone,
    address: o.address,
    comment: o.comment,
    deliveryLabel: o.deliveryLabel ?? null,
    slotOther: Boolean(o.slotOther),
    lines: o.items.map((i) => ({ name: i.name, qty: i.qty, kind: i.kind ?? "item" })),
    items: pickLines(o).map((i) => ({ name: i.name, qty: i.qty, sku: i.sku, boxes: i.boxes ?? 1 })),
    picked: o.picked || {},
    boxesNeeded: boxesNeeded(o),
    boxesPicked: boxesPicked(o),
  };
}

const ORDER_LABEL = (o) => (o.number ? `#${o.number}` : "");

// ---------- order history ----------
const ORDER_LIST_LIMIT = 300;

function orderSummary(id, o) {
  return {
    id,
    number: o.number ?? null,
    createdAt: o.createdAt,
    status: o.status,
    stage: o.stage ?? null,
    payment: o.payment,
    orderType: o.orderType,
    total: o.total,
    name: o.name,
    phone: o.phone,
    lines: o.items.map((i) => ({ id: i.id, name: i.name, qty: i.qty, price: i.price, kind: i.kind ?? "item" })),
    deliveryLabel: o.deliveryLabel ?? null,
    cancelRequest: o.cancelRequest ?? null,
    refund: o.refund ?? null,
  };
}

// Full card for the archive: who did what and when, in order.
function orderDetail(id, o) {
  const steps = [
    ["createdAt", "Buyurtma berildi"],
    ["paidAt", "To'lov qabul qilindi"],
    ["pickingAt", `Terish boshlandi${o.pickingBy ? ` · ${o.pickingBy}` : ""}`],
    ["readyAt", "Tayyor"],
    ["slotChosenAt", `Yetkazish vaqti tanlandi${o.deliveryLabel ? `: ${o.deliveryLabel}` : ""}`],
    ["shippedAt", `Jo'natildi${o.shippedBy ? ` · ${o.shippedBy}` : ""}`],
    ["deliveredAt", o.autoClosed ? "Avtomatik yopildi" : "Mijoz qabul qildi"],
    ["problemAt", "Mijoz muammo bildirdi"],
    ["cancelledAt", `Bekor qilindi${o.cancelledBy ? ` · ${o.cancelledBy}` : ""}${o.cancelReason ? `: ${o.cancelReason}` : ""}`],
  ];
  return {
    ...orderSummary(id, o),
    address: o.address,
    comment: o.comment,
    location: o.location ?? null,
    picked: pickLines(o).map((i) => ({ name: i.name, qty: i.qty, sku: i.sku ?? null, boxes: i.boxes ?? 1 })),
    timeline: steps.filter(([key]) => o[key]).map(([key, text]) => ({ at: o[key], text })).sort((a, b) => a.at - b.at),
  };
}

// ---------- delivery slots ----------
// When a delivery order is ready the buyer picks a window from the bot. A slot key is
// "<YYYY-MM-DD>_<start hour>" in Tashkent time (UTC+5 all year, no DST).
const TZ_OFFSET_MS = 5 * 60 * 60 * 1000;
const DELIVERY_WINDOWS = [
  { from: 10, to: 13 },
  { from: 14, to: 18 },
];
// Orders one window can take: one vehicle run. Raise it when more vehicles drive.
const SLOT_CAPACITY = 4;
// The buyer's own calendar reaches this far; the quick offer takes the earliest free windows.
const SLOT_DAYS_AHEAD = 30;
const SLOTS_OFFERED = 4;
const SLOT_REMIND_MS = 3 * 60 * 60 * 1000;
const SLOT_ESCALATE_MS = 24 * 60 * 60 * 1000;
const MONTHS = ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr"];
const WEEKDAYS = ["yakshanba", "dushanba", "seshanba", "chorshanba", "payshanba", "juma", "shanba"];
const WEEKDAYS_SHORT = ["Ya", "Du", "Se", "Ch", "Pa", "Ju", "Sh"];
const SUNDAY = 0;

const tashkentDay = (ms) => new Date(ms + TZ_OFFSET_MS).toISOString().slice(0, 10);
const hh = (h) => `${String(h).padStart(2, "0")}:00`;
const dayShort = (date) => `${date.getUTCDate()}-${MONTHS[date.getUTCMonth()].slice(0, 3)}`;

// Working days from tomorrow up to SLOT_DAYS_AHEAD, as "YYYY-MM-DD".
function deliveryDays() {
  const today = new Date(`${tashkentDay(Date.now())}T00:00:00Z`).getTime();
  return Array.from({ length: SLOT_DAYS_AHEAD }, (_, i) => new Date(today + (i + 1) * 864e5))
    .filter((d) => d.getUTCDay() !== SUNDAY)
    .map((d) => d.toISOString().slice(0, 10));
}

// Valid keys only: a known window on a working day inside the horizon.
function parseSlot(key) {
  const m = /^(\d{4}-\d{2}-\d{2})_(\d{1,2})$/.exec(String(key));
  const window = m && DELIVERY_WINDOWS.find((w) => w.from === Number(m[2]));
  if (!window || !deliveryDays().includes(m[1])) return null;
  const date = new Date(`${m[1]}T00:00:00Z`);
  const time = `${hh(window.from)}–${hh(window.to)}`;
  return {
    key: m[0],
    day: m[1],
    label: `${date.getUTCDate()}-${MONTHS[date.getUTCMonth()]}, ${WEEKDAYS[date.getUTCDay()]}, ${time}`,
    short: `${dayShort(date)} ${time}`,
    time,
  };
}

// Free windows over the whole horizon. Keys sort by date, so one range query covers it.
async function freeSlots() {
  const days = deliveryDays();
  const taken = await ordersCol.where("deliverySlot", ">=", days[0]).where("deliverySlot", "<", `${days.at(-1)}~`).get();
  const count = {};
  for (const d of taken.docs) count[d.data().deliverySlot] = (count[d.data().deliverySlot] || 0) + 1;
  return days
    .flatMap((day) => DELIVERY_WINDOWS.map((w) => parseSlot(`${day}_${w.from}`)))
    .filter((s) => (count[s.key] || 0) < SLOT_CAPACITY);
}

const slotButton = (id, s, text) => ({ text, callback_data: `slot:${id}:${s.key}` });
const pairs = (list) => Array.from({ length: Math.ceil(list.length / 2) }, (_, i) => list.slice(i * 2, i * 2 + 2));

// First offer: the earliest free windows, plus the buyer's own calendar.
async function slotKeyboard(id) {
  const quick = (await freeSlots()).slice(0, SLOTS_OFFERED);
  return {
    inline_keyboard: [
      ...pairs(quick.map((s) => slotButton(id, s, s.short))),
      [{ text: "🗓 Boshqa kunni tanlash", callback_data: `slot:${id}:cal` }],
    ],
  };
}

// The buyer's calendar: every working day with a free window, four to a row.
async function calendarKeyboard(id) {
  const free = await freeSlots();
  const days = [...new Set(free.map((s) => s.day))];
  const buttons = days.map((day) => {
    const date = new Date(`${day}T00:00:00Z`);
    return { text: `${dayShort(date)} ${WEEKDAYS_SHORT[date.getUTCDay()]}`, callback_data: `slot:${id}:d${day}` };
  });
  const rows = Array.from({ length: Math.ceil(buttons.length / 4) }, (_, i) => buttons.slice(i * 4, i * 4 + 4));
  rows.push([{ text: "📞 Operator bilan kelishish", callback_data: `slot:${id}:op` }]);
  return { inline_keyboard: rows };
}

async function dayKeyboard(id, day) {
  const free = (await freeSlots()).filter((s) => s.day === day);
  return {
    inline_keyboard: [
      ...pairs(free.map((s) => slotButton(id, s, s.time))),
      [{ text: "◀️ Boshqa kun", callback_data: `slot:${id}:cal` }],
    ],
  };
}

// Books a window inside a transaction so a full window cannot be overbooked by two buyers at once.
async function bookSlot(id, key) {
  const slot = parseSlot(key);
  if (!slot) return { error: "Bu vaqt endi mavjud emas, yangisini tanlang", retry: true };
  const ref = ordersCol.doc(id);
  return db.runTransaction(async (t) => {
    const o = (await t.get(ref)).data();
    if (o.stage !== "ready") return { error: "Bu buyurtma uchun vaqt tanlab bo'lmaydi" };
    const taken = await t.get(ordersCol.where("deliverySlot", "==", slot.key));
    const others = taken.docs.filter((d) => d.id !== id).length;
    if (others >= SLOT_CAPACITY) return { error: "Bu vaqt band bo'lib qoldi, boshqasini tanlang", retry: true };
    t.update(ref, { deliverySlot: slot.key, deliveryLabel: slot.label, slotChosenAt: Date.now(), slotOther: false });
    return { order: o, slot };
  });
}

// Slot buttons edit their own message while the buyer browses (calendar, day, back), so the chat
// keeps one picker; booking or handing over to the operator closes it.
async function handleSlotCallback(q, id, arg) {
  const snap = await ordersCol.doc(id).get();
  const o = snap.data();
  if (!snap.exists || o.telegramUserId !== q.from.id) return { answer: "Buyurtma topilmadi", close: true };
  if (o.stage !== "ready" || o.orderType !== "delivery") return { answer: "Bu buyurtma uchun vaqt tanlab bo'lmaydi", close: true };
  const chat = q.message?.chat.id ?? q.from.id;
  const show = async (text, reply_markup) => {
    if (q.message) await tg("editMessageText", { chat_id: chat, message_id: q.message.message_id, text, reply_markup });
    else await tg("sendMessage", { chat_id: chat, text, reply_markup });
    return { answer: "" };
  };
  if (arg === "cal") return show("🗓 Qulay kunni tanlang:", await calendarKeyboard(id));
  const day = /^d(\d{4}-\d{2}-\d{2})$/.exec(arg)?.[1];
  if (day) {
    const date = new Date(`${day}T00:00:00Z`);
    return show(`🗓 ${date.getUTCDate()}-${MONTHS[date.getUTCMonth()]}, ${WEEKDAYS[date.getUTCDay()]}. Soatni tanlang:`, await dayKeyboard(id, day));
  }
  if (arg === "op") {
    await ordersCol.doc(id).update({ slotOther: true, slotOtherAt: Date.now() });
    await tg("sendMessage", { chat_id: ordersChat(), text: `📞 ${ORDER_LABEL(o)}: mijoz yetkazish kunini operator bilan kelishmoqchi. ${o.name}, ${o.phone}` });
    await tg("sendMessage", { chat_id: chat, text: "Operatorimiz siz bilan bog'lanib, qulay kunni kelishadi." });
    return { answer: "Operator bog'lanadi", close: true };
  }
  const r = await bookSlot(id, arg);
  if (r.error && !r.retry) return { answer: r.error, close: true };
  // A stale or full window: show the current free ones in place.
  if (r.retry) {
    await show(`${r.error}:`, await slotKeyboard(id));
    return { answer: r.error };
  }
  await tg("sendMessage", {
    chat_id: chat,
    text: `🗓 Yetkazish vaqti: ${r.slot.label}.\nKuryer yo'lga chiqqanda xabar beramiz.`,
  });
  await tg("sendMessage", { chat_id: ordersChat(), text: `🗓 ${ORDER_LABEL(r.order)}: mijoz yetkazish vaqtini tanladi — ${r.slot.label}.` }).catch((err) =>
    logger.warn("slot notice failed", err),
  );
  return { answer: "Vaqt band qilindi", close: true };
}

// Every stage change is announced to the buyer; shipped also carries the accept / problem buttons.
async function notifyStage(id, o) {
  if (!o.telegramUserId) return;
  const no = ORDER_LABEL(o);
  const pickup = o.orderType === "pickup";
  const text = {
    picking: `📦 Buyurtmangiz ${no} omborda tayyorlanmoqda.`,
    ready: pickup
      ? `✅ Buyurtmangiz ${no} tayyor, do'kondan olib ketishingiz mumkin.`
      : `✅ Mebelingiz ${no} tayyor! Qachon yetkazib beraylik? Qulay vaqtni tanlang:`,
    shipped: pickup
      ? `🏬 Buyurtmangiz ${no} sizga topshirildi. Hammasi joyidami?`
      : `🚚 Buyurtmangiz ${no} yo'lga chiqdi! Qabul qilganingizda pastdagi tugmani bosing.`,
    delivered: `🎉 Rahmat! Buyurtma ${no} yakunlandi. Express Mebel'ni tanlaganingiz uchun rahmat.`,
  }[o.stage];
  if (!text) return;
  const buttons =
    o.stage === "shipped"
      ? {
          inline_keyboard: [
            [{ text: "✅ Qabul qildim", callback_data: `acc:${id}` }],
            [{ text: "⚠️ Muammo bor", callback_data: `prob:${id}` }],
          ],
        }
      : o.stage === "ready" && !pickup
        ? await slotKeyboard(id)
        : undefined;
  await tg("sendMessage", { chat_id: o.telegramUserId, text, reply_markup: buttons }).catch((err) =>
    logger.warn("stage notice failed", err),
  );
}

// Moves an order between stages inside a transaction; `allowed` is the stage it must currently be in.
async function setStage(id, allowed, next, patch = {}) {
  const ref = ordersCol.doc(id);
  const order = await db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (!snap.exists) throw new HttpError(404, "Buyurtma topilmadi");
    const o = snap.data();
    if (!allowed.includes(o.stage)) throw new HttpError(409, "Buyurtma bu bosqichda emas, ekranni yangilang");
    const update = { stage: next, stageAt: Date.now(), [`${next}At`]: Date.now(), ...patch };
    t.update(ref, update);
    return { ...o, ...update };
  });
  await notifyStage(id, order);
  return order;
}

// One scan (or a manual tick) adds one box; the order turns "ready" the moment every box is in.
async function pickBox(id, body, actor) {
  const ref = ordersCol.doc(id);
  const result = await db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (!snap.exists) throw new HttpError(404, "Buyurtma topilmadi");
    const o = snap.data();
    if (o.stage !== "picking") throw new HttpError(409, "Avval yig'ishni boshlang");
    const items = pickLines(o);
    let index;
    let box;
    const scanned = /^EM(\d{4,9})-(\d{1,2})$/i.exec(String(body.code || "").trim());
    if (scanned) {
      const sku = Number(scanned[1]);
      box = Number(scanned[2]);
      index = items.findIndex((i) => i.sku === sku);
      if (index === -1) throw new HttpError(409, "Bu mahsulot shu buyurtmada yo'q");
    } else if (body.code) {
      throw new HttpError(400, "Shtrix-kod tanilmadi");
    } else {
      index = Number(body.item);
      box = Number(body.box);
      if (!items[index]) throw new HttpError(400, "Mahsulot noto'g'ri");
    }
    const item = items[index];
    if (!(box >= 1 && box <= (item.boxes ?? 1))) throw new HttpError(409, `Bu mahsulotda ${item.boxes ?? 1} ta quti bor`);
    const key = `${index}-${box}`;
    const count = (o.picked || {})[key] || 0;
    if (count >= item.qty) throw new HttpError(409, `«${item.name}» ${box}-qutisi allaqachon skanerlangan`);
    const picked = { ...(o.picked || {}), [key]: count + 1 };
    const next = { ...o, picked };
    const done = boxesPicked(next) >= boxesNeeded(next);
    const update = { picked, lastPickBy: actor, ...(done ? { stage: "ready", stageAt: Date.now(), readyAt: Date.now() } : {}) };
    t.update(ref, update);
    return { order: { ...o, ...update }, item: item.name, box, done };
  });
  if (result.done) await notifyStage(id, result.order);
  return result;
}

// ---------- cancellation ----------
// Every order ships from stock, so one rule fits all: the buyer cancels alone until the warehouse
// starts picking; once boxes are picked an admin confirms (they go back on the shelves); a shipped
// order is a return, not a cancellation. A paid card order leaves a refund task for the admin,
// since Click/Payme refunds are made in the provider's cabinet.
const CANCEL_REASONS = {
  hasty: "Shoshilib buyurtma berdim",
  cheaper: "Arzonroq topdim",
  slow: "Kutish uzoq",
  change: "Boshqa mahsulot tanlayman",
  other: "Boshqa sabab",
};
const SELF_CANCEL_STAGES = ["new"];
const ADMIN_CANCEL_STAGES = ["new", "picking", "ready"];

async function cancelOrder(id, { stages, reason, by }) {
  const ref = ordersCol.doc(id);
  const result = await db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (!snap.exists) throw new HttpError(404, "Buyurtma topilmadi");
    const o = snap.data();
    if (!stages.includes(o.stage)) throw new HttpError(409, "Buyurtmani bu bosqichda bekor qilib bo'lmaydi");
    const lines = pickLines(o);
    const refs = lines.map((i) => productsCol.doc(i.id));
    const products = await t.getAll(...refs);
    products.forEach((p, i) => {
      if (p.exists) moveStock(t, refs[i], p.data(), "release", lines[i].qty, `Bekor qilindi ${ORDER_LABEL(o)}`, by);
    });
    const paid = o.status === "paid";
    const update = {
      status: "cancelled",
      stage: "cancelled",
      stageAt: Date.now(),
      cancelledAt: Date.now(),
      cancelledFromStage: o.stage,
      cancelReason: reason,
      cancelledBy: by,
      cancelRequest: null,
      ...(paid ? { refund: { status: "pending", amount: o.paidAmount ?? o.total } } : {}),
    };
    t.update(ref, update);
    return { ...o, ...update };
  });
  const picked = result.cancelledFromStage !== "new";
  const refund = result.refund ? `\n💳 Kartaga ${formatSum(result.refund.amount)} qaytarish kerak (Click/Payme kabinetida), so'ng ☰ → Buyurtmalar → "Pul qaytarildi".` : "";
  await tg("sendMessage", {
    chat_id: ordersChat(),
    text: `❌ ${ORDER_LABEL(result)} bekor qilindi (${by}).\nSabab: ${reason}${picked ? "\n📦 Terilgan qutilarni polkaga qaytaring." : ""}${refund}`,
  }).catch((err) => logger.warn("cancel notice failed", err));
  if (result.telegramUserId) {
    await tg("sendMessage", {
      chat_id: result.telegramUserId,
      text: `❌ Buyurtmangiz ${ORDER_LABEL(result)} bekor qilindi.${result.refund ? `\n💳 ${formatSum(result.refund.amount)} kartangizga qaytariladi, qaytarilganda xabar beramiz.` : ""}`,
    }).catch((err) => logger.warn("cancel buyer notice failed", err));
  }
  return result;
}

// The buyer's cancel: immediate before picking, otherwise a request the admins confirm.
async function buyerCancel(id, userId, code) {
  const reason = CANCEL_REASONS[code];
  if (!reason) throw new HttpError(400, "Sabab noto'g'ri");
  const snap = await ordersCol.doc(id).get();
  const o = snap.data();
  if (!snap.exists || o.telegramUserId !== userId) throw new HttpError(404, "Buyurtma topilmadi");
  if (o.stage === "cancelled") throw new HttpError(409, "Buyurtma allaqachon bekor qilingan");
  if (SELF_CANCEL_STAGES.includes(o.stage)) {
    await cancelOrder(id, { stages: SELF_CANCEL_STAGES, reason, by: "Mijoz" });
    return { cancelled: true };
  }
  if (!ADMIN_CANCEL_STAGES.includes(o.stage)) {
    throw new HttpError(409, "Jo'natilgan buyurtmani bekor qilib bo'lmaydi. Qaytarish uchun \"Muammo bor\" tugmasini bosing yoki operatorga yozing.");
  }
  if (o.cancelRequest) return { requested: true };
  await ordersCol.doc(id).update({ cancelRequest: { reason, at: Date.now() } });
  await tg("sendMessage", {
    chat_id: ordersChat(),
    text: `🙋 ${ORDER_LABEL(o)}: mijoz bekor qilmoqchi (buyurtma omborda: ${o.stage === "ready" ? "tayyor" : "terilmoqda"}).\nSabab: ${reason}\n${o.name}, ${o.phone}`,
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Bekor qilishni tasdiqlash", callback_data: `cana:${id}` }],
        [{ text: "↩️ Rad etish (buyurtma davom etadi)", callback_data: `canx:${id}` }],
      ],
    },
  });
  return { requested: true };
}

async function rejectCancel(id, by) {
  const ref = ordersCol.doc(id);
  const o = (await ref.get()).data();
  if (!o?.cancelRequest) throw new HttpError(409, "Bekor qilish so'rovi yo'q");
  await ref.update({ cancelRequest: null, cancelRejectedBy: by, cancelRejectedAt: Date.now() });
  if (o.telegramUserId) {
    await tg("sendMessage", {
      chat_id: o.telegramUserId,
      text: `↩️ ${ORDER_LABEL(o)} bo'yicha bekor qilish so'rovi qabul qilinmadi, buyurtma davom etadi. Savollar bo'lsa, operatorimiz bog'lanadi.`,
    }).catch(() => {});
  }
}

// The admins' buttons on a buyer's cancel request in the orders chat. Buyers cancel from
// "Mening buyurtmalarim" in the mini app; the receipt deliberately carries no cancel button.
async function handleCancelCallback(q, action, id) {
  if (!isAdminId(q.from.id)) return { answer: "Faqat admin" };
  const by = `Admin ${staffName(q.from)}`;
  if (action === "cana") {
    const o = (await ordersCol.doc(id).get()).data();
    await cancelOrder(id, { stages: ADMIN_CANCEL_STAGES, reason: o?.cancelRequest?.reason ?? "Admin bekor qildi", by });
    return { answer: "Bekor qilindi", close: true };
  }
  await rejectCancel(id, by);
  return { answer: "Rad etildi, buyurtma davom etadi", close: true };
}

async function handleCallback(q) {
  const [action, id, slotKey] = String(q.data || "").split(":");
  let answer = "";
  // The buttons go away once the buyer's order is closed, whoever's press closed it.
  let closeButtons = false;
  try {
    if (action === "slot") {
      const r = await handleSlotCallback(q, id || "-", slotKey);
      answer = r.answer;
      closeButtons = Boolean(r.close);
      return;
    }
    if (action === "cana" || action === "canx") {
      // Refusals (wrong stage, already cancelled) answer on the button instead of failing the webhook.
      const r = await handleCancelCallback(q, action, id || "-").catch((err) => {
        if (!(err instanceof HttpError)) throw err;
        return { answer: err.message.slice(0, 190), close: true };
      });
      answer = r.answer;
      closeButtons = Boolean(r.close);
      return;
    }
    const snap = await ordersCol.doc(id || "-").get();
    const o = snap.data();
    if (!snap.exists || o.telegramUserId !== q.from.id) {
      answer = "Buyurtma topilmadi";
    } else if (o.stage !== "shipped") {
      answer = "Bu buyurtma allaqachon yopilgan";
      closeButtons = true;
    } else if (action === "acc") {
      await setStage(id, ["shipped"], "delivered");
      answer = "Rahmat! Buyurtma yakunlandi";
      closeButtons = true;
    } else if (action === "prob") {
      await setStage(id, ["shipped"], "problem");
      answer = "Operator tez orada bog'lanadi";
      closeButtons = true;
      await tg("sendMessage", {
        chat_id: ordersChat(),
        text: `⚠️ Mijoz ${ORDER_LABEL(o)} buyurtma bo'yicha muammo bildirdi.\n${o.name}, ${o.phone}\nMijoz bilan bog'laning.`,
      });
      await tg("sendMessage", { chat_id: q.from.id, text: "Xabaringiz qabul qilindi. Operatorimiz tez orada siz bilan bog'lanadi." });
    }
  } finally {
    if (q.message && closeButtons) {
      await tg("editMessageReplyMarkup", {
        chat_id: q.message.chat.id,
        message_id: q.message.message_id,
        reply_markup: { inline_keyboard: [] },
      }).catch(() => {});
    }
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: answer }).catch(() => {});
  }
}

// Scanned receiving / write-off: `scans` maps a box label to how many times it was scanned. A unit
// counts only when every one of its boxes is present, so a shkaf with a missing box is not stocked.
async function applyScans(body, actor) {
  if (body.type !== "in" && body.type !== "out") throw new HttpError(400, "Amal turi noto'g'ri");
  const note = String(body.note || "").trim();
  if (body.type === "out" && !note) throw new HttpError(400, "Chiqim sababini yozing");
  const bySku = new Map();
  for (const [code, rawCount] of Object.entries(body.scans || {})) {
    const m = /^EM(\d{4,9})-(\d{1,2})$/i.exec(code);
    const count = Math.floor(Number(rawCount));
    if (!m || !(count > 0 && count <= 10000)) throw new HttpError(400, `Shtrix-kod noto'g'ri: ${code}`);
    const boxes = bySku.get(Number(m[1])) || {};
    boxes[Number(m[2])] = (boxes[Number(m[2])] || 0) + count;
    bySku.set(Number(m[1]), boxes);
  }
  if (!bySku.size) throw new HttpError(400, "Hech narsa skanerlanmagan");
  // Firestore "in" queries take at most 30 values.
  if (bySku.size > 30) throw new HttpError(400, "Bir martada 30 xil mahsulotdan ko'p bo'lmasin");
  return db.runTransaction(async (t) => {
    const snap = await t.get(productsCol.where("sku", "in", [...bySku.keys()]));
    const found = new Map(snap.docs.map((d) => [d.data().sku, d]));
    const plan = [...bySku].map(([sku, boxes]) => {
      const doc = found.get(sku);
      if (!doc) throw new HttpError(400, `SKU ${sku} bazada yo'q`);
      const p = doc.data();
      const total = p.boxes ?? 1;
      const extra = Object.keys(boxes).find((b) => Number(b) < 1 || Number(b) > total);
      if (extra) throw new HttpError(400, `«${p.name}» da ${total} ta quti bor, ${extra}-quti noto'g'ri`);
      const units = Math.min(...Array.from({ length: total }, (_, i) => boxes[i + 1] || 0));
      if (body.type === "out" && units > p.stock) throw new HttpError(400, `«${p.name}» omborda faqat ${p.stock} ta bor`);
      return { doc, p, units };
    });
    const results = plan.map(({ doc, p, units }) => {
      if (units > 0) moveStock(t, doc.ref, p, body.type, units, note || "Skaner orqali kirim", actor);
      return { id: doc.id, name: p.name, units, stock: p.stock };
    });
    if (results.every((r) => r.units === 0)) throw new HttpError(400, "Birorta ham to'liq to'plam yo'q: barcha qutilarni skanerlang");
    return { results };
  });
}

const PAIR_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIR_TTL_MS = 10 * 60 * 1000;

async function handleFulfillment(req, res, path, method) {
  if (path === "/api/screens/pair-code" && method === "POST") {
    const { user } = await requireRole(req, "admin");
    const code = Array.from({ length: 8 }, () => PAIR_ALPHABET[randomInt(PAIR_ALPHABET.length)]).join("");
    const name = String(req.body?.name || "Ombor ekrani").trim().slice(0, 40) || "Ombor ekrani";
    const expiresAt = Date.now() + PAIR_TTL_MS;
    await pairingsCol.doc(code).set({ name, createdBy: user.id, expiresAt });
    return res.status(201).json({ code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt });
  }
  if (path === "/api/screens/pair" && method === "POST") {
    const code = String(req.body?.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code.length !== 8) throw new HttpError(400, "Kod noto'g'ri");
    const token = randomUUID() + randomUUID();
    const name = await db.runTransaction(async (t) => {
      const ref = pairingsCol.doc(code);
      const snap = await t.get(ref);
      if (!snap.exists || snap.data().expiresAt < Date.now()) return null;
      t.delete(ref);
      t.set(screensCol.doc(tokenId(token)), { name: snap.data().name, createdBy: snap.data().createdBy, createdAt: Date.now() });
      return snap.data().name;
    });
    if (!name) throw new HttpError(400, "Kod noto'g'ri yoki muddati o'tgan");
    return res.status(201).json({ token, name });
  }
  if (path === "/api/screens" && method === "GET") {
    await requireRole(req, "admin");
    const snap = await screensCol.get();
    return res.json(snap.docs.map((d) => ({ id: d.id, name: d.data().name, createdAt: d.data().createdAt })));
  }
  const screenMatch = path.match(/^\/api\/screens\/([a-f0-9]{64})$/);
  if (screenMatch && method === "DELETE") {
    await requireRole(req, "admin");
    await screensCol.doc(screenMatch[1]).delete();
    return res.json({ ok: true });
  }

  if (path === "/api/fulfillment" && method === "GET") {
    await requireFulfillment(req);
    const snap = await ordersCol.where("stage", "in", ACTIVE_STAGES).get();
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const list = snap.docs
      .map((d) => fulfillmentView(d.id, d.data()))
      .filter((o) => o.stage !== "shipped" || o.stageAt > dayAgo)
      .sort((a, b) => a.createdAt - b.createdAt);
    return res.json(list);
  }
  const m = path.match(/^\/api\/fulfillment\/([\w-]{1,64})\/(start|pick|ship)$/);
  if (m && method === "POST") {
    const { actor } = await requireFulfillment(req);
    const [, id, action] = m;
    if (action === "start") {
      const o = await setStage(id, ["new"], "picking", { pickingBy: actor });
      return res.json(fulfillmentView(id, o));
    }
    if (action === "ship") {
      const o = await setStage(id, ["ready"], "shipped", { shippedBy: actor });
      return res.json(fulfillmentView(id, o));
    }
    const r = await pickBox(id, req.body || {}, actor);
    return res.json({ ...fulfillmentView(id, r.order), scanned: { item: r.item, box: r.box } });
  }
  return null;
}

async function route(req, res) {
  const path = req.path;
  const method = req.method;

  if (path === "/api/telegram" && method === "POST") return handleTelegramUpdate(req, res);
  if (path === "/api/setup" && method === "GET") return handleSetup(res);

  if (path === "/api/config" && method === "GET") {
    const { user, role } = await authenticate(req);
    return res.json({ categories: CATEGORIES, role, user, cardPayments: cardsEnabled() });
  }

  if (path === "/api/products" && method === "GET") {
    const staff = req.query.all === "1" && (await isStaffRequest(req));
    return res.json(await listProducts({ staff }));
  }

  if (path === "/api/products/draft" && method === "POST") {
    const { actor } = await requireFulfillment(req);
    const ref = productsCol.doc();
    const body = req.body || {};
    const product = cleanProduct({ ...body, kind: "item", draft: true, price: 0, oldPrice: null, isNew: false, images: [] });
    await db.runTransaction(async (t) => {
      const counters = (await t.get(countersRef)).data() || {};
      product.sku = (counters.sku ?? FIRST_SKU) + 1;
      t.set(countersRef, { sku: product.sku }, { merge: true });
      t.set(ref, { ...product, createdBy: actor });
    });
    const admin = idList(ADMIN_IDS.value())[0];
    if (admin) {
      await tg("sendMessage", {
        chat_id: admin,
        text: `🆕 ${actor} yangi mahsulot qo'shdi: «${product.name}» (SKU ${product.sku}, ${product.boxes} quti).\nSaytda chiqishi uchun narx va rasmni kiriting: ☰ → ⚙️ Mahsulotlarni boshqarish.`,
      }).catch((err) => logger.warn("draft notice failed", err));
    }
    return res.status(201).json({ id: ref.id, ...product });
  }

  if (path === "/api/stock/scan" && method === "POST") {
    const { actor } = await requireFulfillment(req);
    return res.status(201).json(await applyScans(req.body || {}, actor));
  }

  if (path === "/api/products" && method === "POST") {
    const { user } = await requireRole(req, "admin");
    const body = req.body || {};
    const ref = productsCol.doc();
    const product = cleanProduct(body);
    const initial = Math.min(Math.floor(Number(body.stock)) || 0, 100000);
    await db.runTransaction(async (t) => {
      if (product.kind === "kit") {
        await checkKitParts(t, product.components);
        t.set(ref, product);
        return;
      }
      const counters = (await t.get(countersRef)).data() || {};
      product.sku = (counters.sku ?? FIRST_SKU) + 1;
      t.set(countersRef, { sku: product.sku }, { merge: true });
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
      if (!snap.exists || (snap.data().draft && !(await isStaffRequest(req)))) throw new HttpError(404, "Mahsulot topilmadi");
      return res.json({ id: snap.id, ...snap.data() });
    }
    await requireRole(req, "admin");
    if (method === "PUT") {
      const product = await db.runTransaction(async (t) => {
        const snap = await t.get(ref);
        if (!snap.exists) throw new HttpError(404, "Mahsulot topilmadi");
        const next = cleanProduct(req.body || {}, snap.data());
        if (next.kind === "kit") await checkKitParts(t, next.components);
        // update, not set: keeps fields the form does not own (createdBy of warehouse drafts).
        t.update(ref, next);
        return next;
      });
      return res.json({ id: ref.id, ...product });
    }
    if (method === "DELETE") {
      await db.runTransaction(async (t) => {
        const kits = await t.get(productsCol.where("kind", "==", "kit"));
        const usedIn = kits.docs.filter((d) => d.data().components.some((c) => c.id === ref.id)).map((d) => d.data().name);
        if (usedIn.length) throw new HttpError(409, `Bu modul komplektlarda bor: «${usedIn.join("», «")}». Avval komplektdan olib tashlang`);
        t.delete(ref);
      });
      return res.json({ ok: true });
    }
  }

  if (path === "/api/banners" && method === "GET") {
    // Admins also get hidden banners so they can switch them back on.
    const all = req.query.all === "1" && (await authenticate(req)).role === "admin";
    const snap = await bannersCol.get();
    const list = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((b) => all || b.active)
      .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
    return res.json(list);
  }

  if (path === "/api/banners" && method === "POST") {
    await requireRole(req, "admin");
    const ref = bannersCol.doc();
    const banner = cleanBanner(req.body || {});
    await ref.set(banner);
    return res.status(201).json({ id: ref.id, ...banner });
  }

  const bannerMatch = path.match(/^\/api\/banners\/([\w-]{1,64})$/);
  if (bannerMatch && (method === "PUT" || method === "DELETE")) {
    await requireRole(req, "admin");
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
    await requireRole(req, "admin");
    return res.status(201).json({ url: await saveImage(req.body?.dataUrl) });
  }

  if (path === "/api/staff" && method === "GET") {
    await requireRole(req, "admin");
    const snap = await staffCol.get();
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => b.addedAt - a.addedAt);
    return res.json(list);
  }

  if (path === "/api/staff/invites" && method === "POST") {
    const { user } = await requireRole(req, "admin");
    const code = randomUUID().replace(/-/g, "").slice(0, 24);
    const expiresAt = Date.now() + INVITE_TTL_MS;
    await invitesCol.doc(code).set({ role: "warehouse", createdBy: user.id, createdAt: Date.now(), expiresAt });
    const link = `https://t.me/${await getBotUsername()}?start=inv_${code}`;
    return res.status(201).json({ link, expiresAt });
  }

  const staffMatch = path.match(/^\/api\/staff\/(\d{1,20})$/);
  if (staffMatch && method === "DELETE") {
    await requireRole(req, "admin");
    await staffCol.doc(staffMatch[1]).delete();
    return res.json({ ok: true });
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
    await requireRole(req, "admin", "warehouse");
    const productId = req.query.productId ? String(req.query.productId) : "";
    // Per-product history filters in memory to avoid a composite index (productId + at).
    const snap = productId
      ? await movementsCol.where("productId", "==", productId).get()
      : await movementsCol.orderBy("at", "desc").limit(100).get();
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => b.at - a.at);
    return res.json(list.slice(0, 100));
  }

  if (path === "/api/stock" && method === "POST") {
    const { user } = await requireRole(req, "admin", "warehouse");
    const body = req.body || {};
    if (body.type !== "in" && body.type !== "out") throw new HttpError(400, "Amal turi noto'g'ri");
    const qty = Number(body.qty);
    if (!Number.isInteger(qty) || qty <= 0 || qty > 100000) throw new HttpError(400, "Miqdor noto'g'ri");
    const ref = productsCol.doc(String(body.productId || "-"));
    const result = await db.runTransaction(async (t) => {
      const snap = await t.get(ref);
      if (!snap.exists) throw new HttpError(404, "Mahsulot topilmadi");
      const product = snap.data();
      if (product.kind === "kit") throw new HttpError(400, "Komplekt qoldig'i modullaridan hisoblanadi: modullarni kirim qiling");
      if (body.type === "out" && qty > product.stock) throw new HttpError(400, `Omborda faqat ${product.stock} ta bor`);
      const movement = moveStock(t, ref, product, body.type, qty, body.note, staffName(user));
      return { product: { id: ref.id, ...product }, movement };
    });
    return res.status(201).json(result);
  }

  if (path === "/api/orders" && method === "POST") return handleOrder(req, res);

  if (path === "/api/orders" && method === "GET") {
    await requireRole(req, "admin");
    const snap = await ordersCol.orderBy("createdAt", "desc").limit(ORDER_LIST_LIMIT).get();
    return res.json(snap.docs.map((d) => orderSummary(d.id, d.data())));
  }

  if (path === "/api/orders/mine" && method === "GET") {
    const { user } = await authenticate(req);
    if (!user) throw new HttpError(401, "Ilovani Telegram'da oching");
    const snap = await ordersCol.where("telegramUserId", "==", user.id).get();
    const list = snap.docs
      .map((d) => orderSummary(d.id, d.data()))
      // Unpaid card checkouts the buyer abandoned are noise in their history.
      .filter((o) => o.stage !== null || o.status === "paid_after_cancel")
      .sort((a, b) => b.createdAt - a.createdAt);
    return res.json(list.slice(0, ORDER_LIST_LIMIT));
  }

  const orderMatch = path.match(/^\/api\/orders\/([\w-]{1,64})(?:\/(buyer-cancel|admin-cancel|reject-cancel|refunded))?$/);
  if (orderMatch && orderMatch[1] !== "mine") {
    const [, id, action] = orderMatch;
    const { user, role } = await authenticate(req);
    if (!action && method === "GET") {
      const snap = await ordersCol.doc(id).get();
      if (!snap.exists || !(role === "admin" || (user && snap.data().telegramUserId === user.id))) throw new HttpError(404, "Buyurtma topilmadi");
      return res.json(orderDetail(id, snap.data()));
    }
    if (action === "buyer-cancel" && method === "POST") {
      if (!user) throw new HttpError(401, "Ilovani Telegram'da oching");
      return res.json(await buyerCancel(id, user.id, String(req.body?.reason || "")));
    }
    if (role !== "admin") throw new HttpError(403, "Ruxsat yo'q");
    const by = `Admin ${staffName(user)}`;
    if (action === "admin-cancel" && method === "POST") {
      const reason = String(req.body?.reason || "").trim().slice(0, 200);
      if (!reason) throw new HttpError(400, "Sababni yozing");
      return res.json(orderDetail(id, await cancelOrder(id, { stages: ADMIN_CANCEL_STAGES, reason, by })));
    }
    if (action === "reject-cancel" && method === "POST") {
      await rejectCancel(id, by);
      return res.json({ ok: true });
    }
    if (action === "refunded" && method === "POST") {
      const ref = ordersCol.doc(id);
      const o = await db.runTransaction(async (t) => {
        const order = (await t.get(ref)).data();
        if (order?.refund?.status !== "pending") throw new HttpError(409, "Qaytariladigan to'lov yo'q");
        const refund = { ...order.refund, status: "done", doneAt: Date.now(), doneBy: by };
        t.update(ref, { refund });
        return { ...order, refund };
      });
      if (o.telegramUserId) {
        await tg("sendMessage", { chat_id: o.telegramUserId, text: `💳 ${ORDER_LABEL(o)}: ${formatSum(o.refund.amount)} kartangizga qaytarildi.` }).catch(() => {});
      }
      return res.json(orderDetail(id, o));
    }
  }

  if (path.startsWith("/api/fulfillment") || path.startsWith("/api/screens")) {
    const handled = await handleFulfillment(req, res, path, method);
    if (handled !== null) return handled;
  }

  // The buyer closed the payment window without paying: give the reserved stock back right away.
  const cancelMatch = path.match(/^\/api\/orders\/([\w-]{1,64})\/cancel$/);
  if (cancelMatch && method === "POST") {
    const { user } = await authenticate(req);
    const snap = await ordersCol.doc(cancelMatch[1]).get();
    if (!user || !snap.exists || snap.data().telegramUserId !== user.id) throw new HttpError(404, "Buyurtma topilmadi");
    await releaseOrder(cancelMatch[1], ["awaiting_payment"], "To'lov qilinmadi");
    return res.json({ ok: true });
  }

  throw new HttpError(404, "Topilmadi");
}

export const api = onRequest(
  {
    region: REGION,
    secrets: [BOT_TOKEN, PAYMENT_PROVIDER_TOKEN],
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

// Card orders that were never paid hold stock; return it after the payment window. "paying" means
// Telegram approved the checkout but no payment arrived, so it gets a longer grace period.
export const releaseUnpaid = onSchedule(
  { schedule: "every 10 minutes", region: REGION },
  async () => {
    const now = Date.now();
    const snap = await ordersCol.where("status", "in", ["awaiting_payment", "paying"]).get();
    for (const doc of snap.docs) {
      const { status, createdAt, payingAt } = doc.data();
      const expired =
        status === "awaiting_payment" ? createdAt < now - PAY_WINDOW_MS : payingAt < now - 2 * PAY_WINDOW_MS;
      if (expired) await releaseOrder(doc.id, [status], "To'lov muddati o'tdi");
    }
  },
);

// Ready delivery orders without a chosen window: remind the buyer once, then hand it to the operator.
export const remindSlots = onSchedule(
  { schedule: "every 60 minutes", region: REGION, secrets: [BOT_TOKEN] },
  async () => {
    const now = Date.now();
    const snap = await ordersCol.where("stage", "==", "ready").get();
    for (const doc of snap.docs) {
      const o = doc.data();
      if (o.orderType !== "delivery" || o.deliverySlot || o.slotOther || !o.telegramUserId) continue;
      try {
        if (!o.slotEscalatedAt && o.readyAt < now - SLOT_ESCALATE_MS) {
          await tg("sendMessage", { chat_id: ordersChat(), text: `⏳ ${ORDER_LABEL(o)}: mijoz 24 soatda yetkazish vaqtini tanlamadi. ${o.name}, ${o.phone}\nQo'ng'iroq qiling.` });
          await doc.ref.update({ slotEscalatedAt: now });
        } else if (!o.slotRemindedAt && o.readyAt < now - SLOT_REMIND_MS) {
          await tg("sendMessage", {
            chat_id: o.telegramUserId,
            text: `🔔 Mebelingiz ${ORDER_LABEL(o)} omborda tayyor turibdi. Yetkazish vaqtini tanlang:`,
            reply_markup: await slotKeyboard(doc.id),
          });
          await doc.ref.update({ slotRemindedAt: now });
        }
      } catch (err) {
        logger.warn("slot reminder failed", err);
      }
    }
  },
);

// Buyers often forget "Qabul qildim"; shipped orders close themselves after a few days.
export const closeShipped = onSchedule(
  { schedule: "every 6 hours", region: REGION, secrets: [BOT_TOKEN] },
  async () => {
    const cutoff = Date.now() - AUTO_CLOSE_MS;
    const snap = await ordersCol.where("stage", "==", "shipped").get();
    for (const doc of snap.docs) {
      if (doc.data().stageAt >= cutoff) continue;
      await setStage(doc.id, ["shipped"], "delivered", { autoClosed: true }).catch((err) => logger.warn("auto close failed", err));
    }
  },
);
