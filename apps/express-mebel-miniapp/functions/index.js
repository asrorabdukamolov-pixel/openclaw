// Express Market — Telegram Mini App backend on Firebase.
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
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { onRequest } from "firebase-functions/https";
import { onSchedule } from "firebase-functions/scheduler";
import { logger } from "firebase-functions";
import { defineSecret, defineString } from "firebase-functions/params";
import { createMasters } from "./masters.js";
import { createHr } from "./hr.js";

const BOT_TOKEN = defineSecret("BOT_TOKEN");
const PAYMENT_PROVIDER_TOKEN = defineSecret("PAYMENT_PROVIDER_TOKEN");
// The drivers' own bot (registration and route work); a separate BotFather bot.
const DRIVER_BOT_TOKEN = defineSecret("DRIVER_BOT_TOKEN");
// The assembly masters' bot (registration and jobs); see masters.js.
const MASTER_BOT_TOKEN = defineSecret("MASTER_BOT_TOKEN");
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
const adminLoginsCol = db.collection("adminLogins");
const adminSessionsCol = db.collection("adminSessions");
const vehiclesCol = db.collection("vehicles");
const routesCol = db.collection("routes");
const applicationsCol = db.collection("driverApplications");
const complaintsCol = db.collection("complaints");
const cashbookCol = db.collection("cashbook");
const cashRef = db.collection("meta").doc("cash");
const suppliersCol = db.collection("suppliers");
const purchasesCol = db.collection("purchases");
const countersRef = db.collection("meta").doc("counters");
const deliveryRef = db.collection("meta").doc("delivery");
const segmentsRef = db.collection("meta").doc("segments");

const PROJECT_ID = process.env.GCLOUD_PROJECT;
// A project can serve the app from an extra Hosting site (a branded web.app name); WEBAPP_URL in
// functions/.env.<projectId> names it. Without it the project's default site is used.
const WEBAPP_URL = process.env.WEBAPP_URL || `https://${PROJECT_ID}.web.app`;

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
  return saveBuffer(Buffer.from(m[2], "base64"), `images/${randomUUID()}.${m[1] === "jpeg" ? "jpg" : m[1]}`, `image/${m[1]}`);
}

// Stored files are read through their unguessable download-token URL, never listed publicly.
async function saveBuffer(buffer, path, contentType) {
  const bucket = getStorage().bucket();
  const token = randomUUID();
  await bucket.file(path).save(buffer, {
    contentType,
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

function cleanMinStock(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Math.round(Number(value));
  if (!(n >= 0 && n <= 100000)) throw new HttpError(400, "Minimal qoldiq noto'g'ri");
  return n;
}

function cleanCost(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Math.round(Number(value));
  if (!(n >= 0 && n <= 1_000_000_000)) throw new HttpError(400, "Tannarx noto'g'ri");
  return n;
}

function cleanWeight(value) {
  if (value === null || value === undefined || value === "") return null;
  const kg = Math.round(Number(value) * 10) / 10;
  if (!(kg > 0 && kg <= 5000)) throw new HttpError(400, "Og'irlik noto'g'ri (kg)");
  return kg;
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
  const weight = cleanWeight(input.weight === undefined ? existing.weight : input.weight);
  // Unloading is priced per kg, so a product on sale must say what it weighs (warehouse drafts may wait).
  if (!draft && !weight) throw new HttpError(400, "Og'irligini kiriting (kg, qadog'i bilan): tushirish narxi shundan hisoblanadi");
  return {
    ...common,
    kind,
    // Modules that only make sense inside a kit stay off the catalog but keep their stock and labels.
    standalone: Boolean(input.standalone ?? existing.standalone ?? true),
    // Packages per unit: each box gets its own barcode label and is scanned when picking.
    boxes: Math.min(20, Math.max(1, Math.round(Number(input.boxes ?? existing.boxes ?? 1)) || 1)),
    // Purchase cost per unit for profit reports; only admins ever see it.
    cost: cleanCost(input.cost === undefined ? existing.cost : input.cost),
    // Reordering: who supplies it and the stock level that should trigger a purchase.
    supplierId: input.supplierId === undefined ? (existing.supplierId ?? null) : String(input.supplierId || "").slice(0, 64) || null,
    minStock: cleanMinStock(input.minStock === undefined ? existing.minStock : input.minStock),
    // Packed weight per unit, kg: unloading price and the vehicle's load limit both use it.
    weight,
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

// ---------- delivery price ----------
// Price = distance from the warehouse × per-km rate + unloading (every delivery needs a loader)
// + carrying up the stairs above the first free floors when there is no lift. Admins edit the
// rates in the mini app; these defaults apply until they do.
// Unloading into the home scales with the load: a percent of the goods with a floor. The driver
// keeps the delivery fee minus the company commission.
const DELIVERY_DEFAULTS = {
  perKm: 1500,
  // Unloading into the home is priced by the load's packed weight.
  unloadingPerKg: 500,
  perFloor: 20000,
  freeFloors: 2,
  commission: 20,
  warehouse: null,
  retryFee: 0,
  maxAttempts: 2,
};
// Straight-line distance understates city roads; this factor approximates the driven route.
const ROAD_FACTOR = 1.3;

// CRM segment thresholds. The panel derives segments from orders; admins tune these in Sozlamalar.
const SEGMENT_DEFAULTS = { vipSpend: 20_000_000, repeatOrders: 2, lostAfterDays: 90, vipLapse: true };

async function segmentSettings() {
  return { ...SEGMENT_DEFAULTS, ...(await segmentsRef.get()).data() };
}

function cleanSegmentSettings(input) {
  const int = (v, min, max, name) => {
    const n = Math.round(Number(v));
    if (!(n >= min && n <= max)) throw new HttpError(400, `${name} noto'g'ri`);
    return n;
  };
  return {
    vipSpend: int(input.vipSpend, 1, 10_000_000_000, "VIP summasi"),
    repeatOrders: int(input.repeatOrders, 2, 100, "Doimiy uchun xaridlar soni"),
    lostAfterDays: int(input.lostAfterDays, 7, 3650, "Kunlar soni"),
    vipLapse: input.vipLapse === true,
    updatedAt: Date.now(),
  };
}

async function deliverySettings() {
  return { ...DELIVERY_DEFAULTS, ...(await deliveryRef.get()).data() };
}

function cleanDeliverySettings(input) {
  const money = (v, name) => {
    const n = Math.round(Number(v));
    if (!(n >= 0 && n <= 10_000_000)) throw new HttpError(400, `${name} noto'g'ri`);
    return n;
  };
  const percent = (v, name) => {
    const n = Math.round(Number(v) * 10) / 10;
    if (!(n >= 0 && n <= 100)) throw new HttpError(400, `${name}: 0–100 %`);
    return n;
  };
  const floors = Math.round(Number(input.freeFloors));
  if (!(floors >= 0 && floors <= 30)) throw new HttpError(400, "Bepul qavatlar soni noto'g'ri");
  return {
    perKm: money(input.perKm, "1 km narxi"),
    unloadingPerKg: money(input.unloadingPerKg ?? DELIVERY_DEFAULTS.unloadingPerKg, "Tushirish, 1 kg narxi"),
    commission: percent(input.commission ?? DELIVERY_DEFAULTS.commission, "Yetkazish komissiyasi"),
    perFloor: money(input.perFloor, "Qavat narxi"),
    freeFloors: floors,
    warehouse: input.warehouse ? parseLocation(input.warehouse) : null,
    // A failed hand-over (buyer away, short of cash) costs this much for the next trip; 0 = free.
    retryFee: money(input.retryFee ?? DELIVERY_DEFAULTS.retryFee, "Qayta yetkazish narxi"),
    maxAttempts: Math.min(5, Math.max(1, Math.round(Number(input.maxAttempts ?? DELIVERY_DEFAULTS.maxAttempts)) || DELIVERY_DEFAULTS.maxAttempts)),
    updatedAt: Date.now(),
  };
}

function distanceKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h)) * ROAD_FACTOR;
}

const roundSum = (n) => Math.round(n / 1000) * 1000;

function quoteDelivery(settings, input, weight) {
  const location = parseLocation(input.location);
  if (!location) throw new HttpError(400, "Yetkazish narxini hisoblash uchun joylashuvni yuboring (📍 tugmasi)");
  const floor = Math.round(Number(input.floor));
  if (!(floor >= 1 && floor <= 40)) throw new HttpError(400, "Qavatni kiriting");
  const lift = Boolean(input.lift);
  // Without a warehouse pin the distance part is unknown; the rest still applies and admins are told.
  const km = settings.warehouse ? Math.round(distanceKm(settings.warehouse, location) * 10) / 10 : null;
  const distance = km === null ? 0 : roundSum(km * settings.perKm);
  const stairs = lift ? 0 : Math.max(0, floor - settings.freeFloors) * settings.perFloor;
  // Every sellable product carries its weight; a piece saved before that rule simply adds nothing.
  const unloading = roundSum((weight ?? 0) * settings.unloadingPerKg);
  return { km, distance, unloading, weight, floor, lift, stairs, total: distance + unloading + stairs };
}

// ---------- stock ----------

// Packed weight of a cart in kg, kits counted by their modules.
async function cartWeight(items) {
  if (!items.length) return 0;
  const snaps = await db.getAll(...items.map((i) => productsCol.doc(String(i.id || "-"))));
  const parts = [];
  for (const [k, x] of snaps.entries()) {
    if (!x.exists) continue;
    const qty = Math.max(0, Math.round(Number(items[k].qty)) || 0);
    const p = x.data();
    if (p.kind === "kit") for (const c of p.components) parts.push({ id: c.id, qty: c.qty * qty });
    else parts.push({ weight: p.weight, qty });
  }
  const kitIds = [...new Set(parts.filter((x) => x.id).map((x) => x.id))];
  const mods = kitIds.length ? new Map((await db.getAll(...kitIds.map((id) => productsCol.doc(id)))).map((x) => [x.id, x.data()?.weight])) : new Map();
  let kg = 0;
  for (const x of parts) kg += ((x.id ? mods.get(x.id) : x.weight) ?? 0) * x.qty;
  return Math.round(kg * 10) / 10;
}

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
  const secret = createHmac("sha256", "WebAppData").update(BOT_TOKEN.value().trim()).digest();
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
// The desktop admin panel has no Telegram initData: an admin opens it once through a one-time link
// from the bot, which becomes a session token. Sessions only work while the user is still in
// ADMIN_IDS, so removing an admin from the config also locks their panel.
async function adminFromSession(req) {
  const token = req.get("x-admin-token");
  if (!token || token.length < 32) return null;
  const snap = await adminSessionsCol.doc(tokenId(token)).get();
  const s = snap.data();
  if (!snap.exists || s.expiresAt < Date.now() || !isAdminId(s.userId)) return null;
  return { id: s.userId, first_name: s.name };
}

async function authenticate(req) {
  const panelUser = await adminFromSession(req);
  if (panelUser) return { user: panelUser, role: "admin" };
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

const tg = (method, body) => callTelegram(BOT_TOKEN.value(), method, body);

// Tokens are pasted into Secret Manager by hand; a trailing newline or space there makes Telegram
// answer "Not Found", so every bot call trims the token it is given.
async function callTelegram(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token.trim()}/${method}`, {
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
    const res = await fetch(url, { headers: { "user-agent": "ExpressMarketMiniApp/1.0" }, signal: AbortSignal.timeout(8000) });
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
    weight: missing || parts.some((c) => !c.product.weight) ? null : Math.round(parts.reduce((n, c) => n + c.qty * c.product.weight, 0) * 10) / 10,
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

// The purchase cost stays with admins: buyers, warehouse staff and screens get products without it.
function withoutCost(p) {
  const { cost, ...rest } = p;
  return rest;
}

// Kit modules must exist and be ordinary products (a kit inside a kit would hide its boxes).
async function checkKitParts(t, components) {
  const snaps = await t.getAll(...components.map((c) => productsCol.doc(c.id)));
  const bad = snaps.find((s) => !s.exists || s.data().kind === "kit");
  if (bad) throw new HttpError(400, bad.exists ? `«${bad.data().name}» komplekt, uni modul qilib bo'lmaydi` : "Komplektdagi modul topilmadi");
}

// ---------- Excel import ----------
// The panel parses the spreadsheet and posts plain rows; every rule lives here so a dry run and the
// real import judge rows the same way. A row updates the product its ID, SKU or (failing both) exact
// name points at, otherwise it creates one, so re-uploading an edited export never duplicates.
// Products missing from the file are left alone: the import never deletes.
const IMPORT_MAX_ROWS = 1000;
const IMPORT_CHUNK = 100;
const IMPORT_FIELDS = {
  name: "nomi",
  category: "bo'lim",
  price: "narx",
  oldPrice: "eski narx",
  boxes: "qutilar",
  weight: "og'irlik",
  cost: "tannarx",
  minStock: "minimal qoldiq",
  supplierId: "ta'minotchi",
  size: "o'lcham",
  material: "material",
  description: "tavsif",
  standalone: "alohida sotiladi",
  isNew: "yangi belgisi",
  draft: "qoralama",
  whenShort: "modul yetishmasa",
  leadDays: "tayyorlash kunlari",
};

const blank = (v) => v === undefined || v === null || String(v).trim() === "";
const importText = (v) => (blank(v) ? undefined : String(v).trim());
function importNumber(v, label) {
  if (blank(v)) return undefined;
  const n = Number(String(v).replace(/[\s ']/g, "").replace(",", "."));
  if (!Number.isFinite(n)) throw new Error(`${label}: son emas («${v}»)`);
  return n;
}
function importFlag(v, label) {
  if (blank(v)) return undefined;
  const t = String(v).trim().toLowerCase();
  if (["ha", "xa", "yes", "true", "1", "+", "✓"].includes(t)) return true;
  if (["yo'q", "yoq", "yo‘q", "no", "false", "0", "-"].includes(t)) return false;
  throw new Error(`${label}: «ha» yoki «yo'q» yozing`);
}
const importCategory = (v) => {
  const t = String(v ?? "").trim().toLowerCase();
  return CATEGORIES.find((c) => c.id === t || c.name.toLowerCase() === t)?.id ?? t;
};
// "100003×2; Pastki shkaf 60 x 1" -> [{ ref, qty }]; a six-digit ref is a SKU, anything else a name.
function importParts(v) {
  return String(v ?? "")
    .split(/[;\n]+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const m = /^(.*?)(?:\s*[x×*]\s*(\d+))?$/i.exec(p);
      return { ref: m[1].trim(), qty: m[2] ? Number(m[2]) : 1 };
    });
}

async function importProducts(rows, { apply, actor }) {
  if (!Array.isArray(rows) || !rows.length) throw new HttpError(400, "Faylda mahsulot qatorlari yo'q");
  if (rows.length > IMPORT_MAX_ROWS) throw new HttpError(400, `Bir martada ${IMPORT_MAX_ROWS} qatordan ko'p bo'lmasin`);
  const all = (await productsCol.get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  const byId = new Map(all.map((p) => [p.id, p]));
  const suppliers = (await suppliersCol.get()).docs;
  const supplierByName = new Map(suppliers.map((d) => [d.data().name.trim().toLowerCase(), d.id]));
  const supplierName = new Map(suppliers.map((d) => [d.id, d.data().name]));
  const bySku = new Map(all.filter((p) => p.sku != null).map((p) => [String(p.sku), p]));
  const nameKey = (kind, name) => `${kind}:${String(name).trim().toLowerCase()}`;
  const byName = new Map(all.map((p) => [nameKey(p.kind ?? "item", p.name), p]));

  // Pass 1: match each row to a product and collect its fields; kits resolve their modules after
  // every row is known, so a kit may use modules created by the same file.
  const plan = [];
  const seenNames = new Set();
  const seenIds = new Set();
  for (const raw of rows) {
    const line = Number(raw.line) || plan.length + 2;
    const errors = [];
    const kind = /komplekt|kit/i.test(String(raw.kind ?? "")) ? "kit" : "item";
    let existing = null;
    if (!blank(raw.id)) {
      existing = byId.get(String(raw.id).trim()) ?? null;
      if (!existing) errors.push(`ID «${raw.id}» bazada yo'q`);
    } else if (!blank(raw.sku)) {
      existing = bySku.get(String(raw.sku).trim()) ?? null;
      if (!existing) errors.push(`SKU ${raw.sku} bazada yo'q. Yangi mahsulot uchun SKU ni bo'sh qoldiring`);
    } else if (!blank(raw.name)) {
      existing = byName.get(nameKey(kind, raw.name)) ?? null;
    }
    if (existing && (existing.kind ?? "item") !== kind) errors.push("Turini o'zgartirib bo'lmaydi (mahsulot ↔ komplekt)");
    if (existing && seenIds.has(existing.id)) errors.push("Bu mahsulot faylda ikki marta bor");
    if (existing) seenIds.add(existing.id);
    const name = importText(raw.name) ?? existing?.name;
    if (name) {
      const key = nameKey(kind, name);
      if (seenNames.has(key)) errors.push(`«${name}» nomi faylda ikki marta bor`);
      seenNames.add(key);
      const owner = byName.get(key);
      if (owner && existing && owner.id !== existing.id) errors.push(`«${name}» nomli boshqa mahsulot bor (SKU ${owner.sku ?? "—"})`);
    }
    const input = { kind };
    let stock;
    try {
      for (const [field, label] of Object.entries(IMPORT_FIELDS)) {
        const v = raw[field];
        if (["price", "oldPrice", "boxes", "weight", "cost", "minStock", "leadDays"].includes(field)) input[field] = importNumber(v, label);
        else if (field === "supplierId") {
          if (blank(v)) continue;
          const id = supplierByName.get(String(v).trim().toLowerCase());
          if (!id) throw new Error(`Ta'minotchi topilmadi: «${v}». Avval Zakup → Ta'minotchilar'ga qo'shing`);
          input[field] = id;
        }
        else if (["standalone", "isNew", "draft"].includes(field)) input[field] = importFlag(v, label);
        else if (field === "category") input[field] = blank(v) ? undefined : importCategory(v);
        else if (field === "whenShort") input[field] = blank(v) ? undefined : /yash|hide/i.test(String(v)) ? "hide" : "preorder";
        else input[field] = importText(v);
      }
      // An emptied "Eski narx" cell clears the old price on an update.
      if (existing && blank(raw.oldPrice) && raw.oldPrice !== undefined) input.oldPrice = 0;
      stock = importNumber(raw.stock, "qoldiq");
      if (stock !== undefined && kind === "kit") stock = undefined;
      if (stock !== undefined && !(Number.isInteger(stock) && stock >= 0 && stock <= 100000)) throw new Error("qoldiq: 0 dan katta butun son bo'lsin");
    } catch (err) {
      errors.push(err.message);
    }
    const parts = kind === "kit" && !blank(raw.components) ? importParts(raw.components) : null;
    if (kind === "kit" && !existing && !parts) errors.push("Komplekt tarkibi yozilmagan");
    plan.push({ line, kind, existing, input, stock, parts, errors, id: existing?.id ?? productsCol.doc().id });
  }

  // Pass 2: resolve kit modules, then validate every row with the same rules as the panel form.
  const itemsByName = new Map(plan.filter((r) => r.kind === "item").map((r) => [String(r.input.name ?? r.existing?.name ?? "").toLowerCase(), r.id]));
  for (const p of all) if ((p.kind ?? "item") === "item" && !itemsByName.has(p.name.toLowerCase())) itemsByName.set(p.name.toLowerCase(), p.id);
  for (const r of plan) {
    if (r.parts) {
      r.input.components = r.parts.map(({ ref, qty }) => {
        const id = /^\d{6}$/.test(ref) ? bySku.get(ref)?.id : itemsByName.get(ref.toLowerCase());
        if (!id || byId.get(id)?.kind === "kit") r.errors.push(`Modul topilmadi: «${ref}»`);
        return { id: id ?? "-", qty };
      });
    }
    if (r.errors.length) continue;
    try {
      r.next = cleanProduct(r.input, r.existing ?? {});
    } catch (err) {
      r.errors.push(err.message);
      continue;
    }
    r.changes = [];
    if (r.existing) {
      // Compare against the stored product as the form would save it, so fields older products
      // never had (defaults) do not show up as changes.
      let base = r.existing;
      try {
        base = cleanProduct({}, r.existing);
      } catch {
        // A warehouse draft without a price cannot pass the form rules; compare it as stored.
      }
      const show = (v) => (v === true ? "ha" : v === false ? "yo'q" : v ?? "—");
      for (const [field, label] of Object.entries(IMPORT_FIELDS)) {
        const before = base[field] ?? null;
        const after = r.next[field] ?? null;
        if (r.kind === "item" && ["whenShort", "leadDays"].includes(field)) continue;
        if (r.kind === "kit" && ["boxes", "weight", "cost", "minStock", "supplierId", "standalone"].includes(field)) continue;
        const named = (v) => (field === "supplierId" && v ? supplierName.get(v) ?? v : v);
        if (JSON.stringify(before) !== JSON.stringify(after)) r.changes.push(`${label}: ${show(named(before))} → ${show(named(after))}`);
      }
      if (r.kind === "kit" && JSON.stringify(r.existing.components) !== JSON.stringify(r.next.components)) r.changes.push("komplekt tarkibi");
    }
    if (r.stock !== undefined && r.stock !== (r.existing?.stock ?? 0)) r.changes.push(`qoldiq: ${r.existing?.stock ?? 0} → ${r.stock}`);
  }

  const action = (r) => (r.errors.length ? "error" : !r.existing ? "create" : r.changes.length ? "update" : "same");
  const report = plan.map((r) => ({
    line: r.line,
    action: action(r),
    kind: r.kind,
    name: r.next?.name ?? r.input.name ?? r.existing?.name ?? "",
    sku: r.existing?.sku ?? null,
    errors: r.errors,
    changes: r.changes ?? [],
  }));
  const counts = Object.fromEntries(["create", "update", "same", "error"].map((a) => [a, report.filter((r) => r.action === a).length]));
  if (!apply) return { counts, rows: report };
  if (counts.error) throw new HttpError(400, `Faylda ${counts.error} ta xato bor: avval tuzating`);

  // Items before kits: a kit's new modules must exist before the kit points at them.
  const work = plan.filter((r) => action(r) === "create" || action(r) === "update").sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "item" ? -1 : 1));
  for (let i = 0; i < work.length; i += IMPORT_CHUNK) {
    const chunk = work.slice(i, i + IMPORT_CHUNK);
    await db.runTransaction(async (t) => {
      const refs = chunk.map((r) => productsCol.doc(r.id));
      const [counterSnap, ...snaps] = await t.getAll(countersRef, ...refs);
      let sku = counterSnap.data()?.sku ?? FIRST_SKU;
      chunk.forEach((r, k) => {
        const ref = refs[k];
        const fresh = snaps[k].exists ? snaps[k].data() : null;
        const product = { ...r.next };
        if (fresh) {
          product.stock = fresh.stock ?? 0;
          t.update(ref, product);
        } else {
          if (product.kind === "item") product.sku = ++sku;
          t.set(ref, { ...product, createdBy: actor });
        }
        if (r.stock === undefined || product.kind === "kit") return;
        const delta = r.stock - product.stock;
        if (delta) moveStock(t, ref, product, delta > 0 ? "in" : "out", Math.abs(delta), "Excel import", actor);
      });
      t.set(countersRef, { sku }, { merge: true });
    });
  }
  return { counts, rows: report };
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
  const employeeLink = /^\/start emp_([a-f0-9]{20})$/.exec(msg?.text || "");
  try {
    if (employeeLink && msg.chat.type === "private") {
      await hr.linkEmployee(msg, employeeLink[1]);
    } else if (msg?.location && msg.chat.type === "private" && (await hr.handleLocation(msg))) {
      // An employee's check-in or check-out.
    } else if (invite && msg.chat.type === "private") {
      await tg("sendMessage", { chat_id: msg.chat.id, parse_mode: "HTML", ...(await joinStaff(msg.from, invite[1])) });
    } else if (msg?.text === "/panel" && msg.chat.type === "private" && isAdminId(msg.from.id)) {
      const { url } = await createAdminLogin(msg.from);
      await tg("sendMessage", {
        chat_id: msg.chat.id,
        text: "💻 Boshqaruv paneli: havolani kompyuter brauzerida oching. U 10 daqiqa va bir marta ishlaydi.",
        reply_markup: { inline_keyboard: [[{ text: "💻 Panelni ochish", url }]] },
      });
    } else if (msg && msg.chat.type === "private" && (!msg.text?.startsWith("/") || msg.text === "/skip") && (await masters.collectReview(msg))) {
      // A master review after the rating buttons.
    } else if (msg && msg.chat.type === "private" && !msg.text?.startsWith("/") && (await collectComplaint(msg))) {
      // A complaint draft took the message (its text or a photo).
    } else if (msg?.text?.startsWith("/start")) {
      await tg("sendMessage", {
        chat_id: msg.chat.id,
        parse_mode: "HTML",
        text:
          "Assalomu alaykum! 👋\n\n<b>Express Market</b> — ombordagi tayyor mebel onlayn do'koni: uyingizgacha tez yetkazamiz.\n" +
          "Katalogni ochish uchun quyidagi tugmani bosing.",
        reply_markup: { inline_keyboard: [[{ text: "🛋 Katalogni ochish", web_app: { url: WEBAPP_URL } }]] },
      });
    }
  } catch (err) {
    logger.error("telegram update failed", err);
  }
  res.json({ ok: true });
}

const ADMIN_LOGIN_TTL_MS = 10 * 60 * 1000;
const ADMIN_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

async function createAdminLogin(user) {
  const code = randomUUID().replace(/-/g, "");
  await adminLoginsCol.doc(code).set({ userId: user.id, name: staffName(user), expiresAt: Date.now() + ADMIN_LOGIN_TTL_MS });
  // The code rides in the hash so it never reaches server logs or the Referer header.
  return { url: `${WEBAPP_URL}/admin.html#login=${code}`, expiresAt: Date.now() + ADMIN_LOGIN_TTL_MS };
}

async function redeemAdminLogin(code) {
  const token = randomUUID() + randomUUID();
  const session = await db.runTransaction(async (t) => {
    const ref = adminLoginsCol.doc(code);
    const snap = await t.get(ref);
    const login = snap.data();
    if (!snap.exists || login.expiresAt < Date.now() || !isAdminId(login.userId)) return null;
    t.delete(ref);
    const data = { userId: login.userId, name: login.name, createdAt: Date.now(), expiresAt: Date.now() + ADMIN_SESSION_TTL_MS };
    t.set(adminSessionsCol.doc(tokenId(token)), data);
    return data;
  });
  if (!session) throw new HttpError(400, "Havola eskirgan yoki ishlatilgan. Botga /panel yozib yangisini oling");
  return { token, name: session.name, expiresAt: session.expiresAt };
}

const ROLE_LABEL = { warehouse: "omborchi", driver: "haydovchi" };
const ROLE_HOME = { warehouse: "☰ → 📦 Ombor", driver: "☰ → 🚚 Reyslarim" };
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
    text: `✅ Siz Express Market'ga <b>${ROLE_LABEL[result.role]}</b> sifatida qo'shildingiz.\n\nIlovani oching → ${ROLE_HOME[result.role]}.`,
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
  res.json({ ok: true, bot: `@${bot.username}`, driverBot: await setupDriverBot(), masterBot: await masters.setupMasterBot(), webapp: WEBAPP_URL, webhook, seeded });
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

// Secrets copied between projects through a file can carry a trailing newline, which Telegram
// rejects as an invalid provider token; the token itself never contains whitespace.
const providerToken = () => PAYMENT_PROVIDER_TOKEN.value().trim();
const cardsEnabled = () => providerToken().length > 1;

async function handleOrder(req, res) {
  const { user } = await authenticate(req);
  const body = req.body || {};
  const phone = String(body.phone || "").trim();
  if (!/^\+?[\d\s()-]{7,20}$/.test(phone)) throw new HttpError(400, "Telefon raqam noto'g'ri");
  const pickup = body.orderType === "pickup";
  const location = pickup ? null : parseLocation(body.location);
  const rates = pickup ? null : await deliverySettings();
  // Location and floor are checked before stock is touched; the price needs the goods total below.
  if (rates) quoteDelivery(rates, body, 0);
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
    // Weight from the physical modules the warehouse will pick.
    const weight = Math.round(pick.reduce((n, m) => n + m.qty * (m.product.weight ?? 0), 0) * 10) / 10;
    const delivery = rates ? quoteDelivery(rates, body, weight) : null;
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
      pick: pick.map((m) => ({ id: m.ref.id, name: m.product.name, qty: m.qty, sku: m.product.sku ?? null, boxes: m.product.boxes ?? 1, weight: m.product.weight ?? null })),
      goodsTotal: lines.reduce((n, l) => n + l.product.price * l.qty, 0),
      delivery,
      total: lines.reduce((n, l) => n + l.product.price * l.qty, 0) + (delivery?.total ?? 0),
      lowStock: pick.filter((m) => m.product.stock <= 3).map((m) => ({ name: m.product.name, stock: m.product.stock })),
      orderType: pickup ? "pickup" : "delivery",
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
      title: "Express Market buyurtmasi",
      description: order.items.map((i) => `${i.name} × ${i.qty}`).join(", ").slice(0, 255),
      payload: orderRef.id,
      provider_token: providerToken(),
      currency: "UZS",
      prices: [
        ...order.items.map((i) => ({ label: `${i.name} × ${i.qty}`.slice(0, 64), amount: i.price * i.qty * UZS_MINOR })),
        ...(order.delivery ? [{ label: "Yetkazib berish", amount: order.delivery.total * UZS_MINOR }] : []),
      ],
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

function deliveryLines(d) {
  if (!d) return [];
  return [
    `• Yetkazish${d.km === null ? "" : ` (${d.km} km)`} = ${formatSum(d.distance)}`,
    `• Tushirib berish = ${formatSum(d.unloading)}`,
    d.stairs ? `• ${d.floor}-qavat, liftsiz = ${formatSum(d.stairs)}` : "",
  ].filter(Boolean);
}

async function notifyOrder(id, order) {
  const lines = [
    ...order.items.map((i) => `• ${escapeHtml(i.name)} × ${i.qty} = ${formatSum(i.price * i.qty)}`),
    ...deliveryLines(order.delivery),
  ];
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
    `<b>Turi:</b> ${order.orderType === "pickup" ? "Olib ketish" : `Yetkazib berish${order.delivery ? `, ${order.delivery.floor}-qavat, ${order.delivery.lift ? "lift bor" : "liftsiz"}` : ""}`}`,
    order.delivery && order.delivery.km === null ? "⚠️ Ombor lokatsiyasi kiritilmagan: masofa narxi hisoblanmadi (☰ → 🚚 Yetkazish narxlari)." : "",
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
        text: `✅ Buyurtmangiz #${order.number} qabul qilindi!${paid}\n\n${lines.join("\n")}\n\n<b>Jami:</b> ${formatSum(order.total)}\n\n${readinessText(order)}`,
      });
    }
  } catch (err) {
    logger.error("order notification failed", err);
  }
}

// Telegram asks before charging; it must be answered within 10 seconds.
async function handlePreCheckout(query) {
  if (String(query.invoice_payload).startsWith("due:")) return handleDuePreCheckout(query);
  if (String(query.invoice_payload).startsWith("asm:")) return masters.preCheckout(query);
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
  if (String(pay.invoice_payload).startsWith("due:")) return handleDuePaid(pay);
  if (String(pay.invoice_payload).startsWith("asm:")) return masters.paid(pay);
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
// Once the driver marks the hand-over, a buyer who stays silent has a day to report a problem.
const HANDED_CLOSE_MS = 24 * 60 * 60 * 1000;
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
const ORDER_REPORT_LIMIT = 3000;

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
    goodsTotal: o.goodsTotal ?? o.total,
    deliveryTotal: o.delivery?.total ?? 0,
    paidAt: o.paidAt ?? null,
    deliveredAt: o.deliveredAt ?? null,
    cancelledAt: o.cancelledAt ?? null,
    cancelReason: o.cancelReason ?? null,
    name: o.name,
    phone: o.phone,
    // The buyer's Telegram account: the CRM merges orders placed with different phone numbers.
    customerId: o.telegramUserId ?? null,
    lines: o.items.map((i) => ({ id: i.id, name: i.name, qty: i.qty, price: i.price, kind: i.kind ?? "item" })),
    // Physical modules sold (kits expanded): the reorder report counts sales speed from these.
    units: pickLines(o).map((l) => ({ id: l.id, qty: l.qty })),
    deliverySlot: o.deliverySlot ?? null,
    deliveryLabel: o.deliveryLabel ?? null,
    cancelRequest: o.cancelRequest ?? null,
    refund: o.refund ?? null,
    routeId: o.routeId ?? null,
    handedAt: o.handedAt ?? null,
    failedAttempts: o.failedAttempts ?? [],
    deliveryHold: o.deliveryHold ?? false,
    retryFees: o.retryFees ?? 0,
    cashCollected: o.cashCollected ?? null,
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
    ["handedAt", `Haydovchi topshirdi${o.handedBy ? ` · ${o.handedBy}` : ""}`],
    ["deliveredAt", o.autoClosed ? "Avtomatik yopildi" : "Mijoz qabul qildi"],
    ["problemAt", "Mijoz muammo bildirdi"],
    ["cancelledAt", `Bekor qilindi${o.cancelledBy ? ` · ${o.cancelledBy}` : ""}${o.cancelReason ? `: ${o.cancelReason}` : ""}`],
  ];
  return {
    ...orderSummary(id, o),
    address: o.address,
    comment: o.comment,
    location: o.location ?? null,
    goodsTotal: o.goodsTotal ?? o.total,
    delivery: o.delivery ?? null,
    picked: pickLines(o).map((i) => ({ name: i.name, qty: i.qty, sku: i.sku ?? null, boxes: i.boxes ?? 1 })),
    timeline: [
      ...steps.filter(([key]) => o[key]).map(([key, text]) => ({ at: o[key], text })),
      ...(o.failedAttempts ?? []).map((f) => ({ at: f.at, text: `❌ Topshirilmadi: ${FAIL_REASONS[f.reason] ?? f.reason} · ${f.by}` })),
    ].sort((a, b) => a.at - b.at),
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
// The buyer picks the window alone: reminded after 3 h and 24 h; after 72 h the team only gets a note.
const SLOT_REMINDERS_MS = [3 * 60 * 60 * 1000, 24 * 60 * 60 * 1000];
const SLOT_ESCALATE_MS = 72 * 60 * 60 * 1000;
const MONTHS = ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr"];
const WEEKDAYS = ["yakshanba", "dushanba", "seshanba", "chorshanba", "payshanba", "juma", "shanba"];
const WEEKDAYS_SHORT = ["Ya", "Du", "Se", "Ch", "Pa", "Ju", "Sh"];
const SUNDAY = 0;

const tashkentDay = (ms) => new Date(ms + TZ_OFFSET_MS).toISOString().slice(0, 10);

// Everything ships from stock, so an order is packed within PREP_WORKING_DAYS. The receipt names
// that day and the earliest delivery day, so the buyer knows what to expect before being asked.
const PREP_WORKING_DAYS = 1;

function workingDayAfter(day, n) {
  let date = new Date(`${day}T00:00:00Z`);
  for (let left = n; left > 0; ) {
    date = new Date(date.getTime() + 864e5);
    if (date.getUTCDay() !== SUNDAY) left--;
  }
  return date;
}

const dayLabel = (date) => `${date.getUTCDate()}-${MONTHS[date.getUTCMonth()]}, ${WEEKDAYS[date.getUTCDay()]}`;

function readinessText(order) {
  const ready = workingDayAfter(tashkentDay(Date.now()), PREP_WORKING_DAYS);
  if (order.orderType === "pickup") {
    return `📦 Mebelingiz <b>${dayLabel(ready)}</b> kuni tayyor bo'ladi, shu kundan do'kondan olib ketishingiz mumkin.`;
  }
  const firstDelivery = workingDayAfter(ready.toISOString().slice(0, 10), 1);
  return `📦 Mebelingiz <b>${dayLabel(ready)}</b> kuni tayyor bo'ladi.\n🚚 Yetkazish <b>${dayLabel(firstDelivery)}</b> kunidan boshlab: qulay kun va soatni botda o'zingiz tanlaysiz.`;
}
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
    t.update(ref, { deliverySlot: slot.key, deliveryLabel: slot.label, slotChosenAt: Date.now() });
    return { order: o, slot };
  });
}

// Slot buttons edit their own message while the buyer browses (calendar, day, back), so the chat
// keeps one picker; booking closes it.
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
      : `🚚 Buyurtmangiz ${no} yo'lga chiqdi! Qabul qilganingizda pastdagi tugmani bosing.${amountDue(o) ? `\n\n💵 Tayyorlab qo'ying: <b>${formatSum(amountDue(o))}</b> naqd.${cardsEnabled() ? " Karta bilan to'lash ham mumkin: haydovchi bot orqali to'lov havolasini yuboradi." : ""}\nPul to'liq bo'lmasa, mebel topshirilmaydi.` : ""}`,
    delivered: `🎉 Rahmat! Buyurtma ${no} yakunlandi. Express Market'ni tanlaganingiz uchun rahmat.`,
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
  await tg("sendMessage", { chat_id: o.telegramUserId, text, parse_mode: "HTML", reply_markup: buttons }).catch((err) =>
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
    throw new HttpError(409, "Jo'natilgan buyurtmani bekor qilib bo'lmaydi. Qaytarish uchun botdagi \"Muammo bor\" tugmasini bosing.");
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
      text: `↩️ ${ORDER_LABEL(o)} bo'yicha bekor qilish so'rovi qabul qilinmadi: buyurtma omborda tayyorlangan va davom etadi.`,
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
    if (action === "drr") {
      answer = await rateDriver(q, id, Number(slotKey));
      closeButtons = true;
      return;
    }
    if (action === "asr") {
      answer = await masters.rate(q);
      closeButtons = true;
      return;
    }
    if (action === "cmp") {
      const [, act, cid, arg] = String(q.data).split(":");
      const r = await handleComplaintCallback(q, act, cid || "-", arg);
      answer = r.answer;
      closeButtons = Boolean(r.close);
      return;
    }
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
      if (o.handedById) {
        await tg("sendMessage", {
          chat_id: q.from.id,
          text: "🚚 Haydovchining xizmatini baholang:",
          reply_markup: { inline_keyboard: [[1, 2, 3, 4, 5].map((n) => ({ text: `${n} ⭐`, callback_data: `drr:${id}:${n}` }))] },
        }).catch(() => {});
      }
    } else if (action === "prob") {
      await setStage(id, ["shipped"], "problem");
      answer = "Muammoni tasvirlab bering";
      closeButtons = true;
      await startComplaint(id, o);
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
      // A pickup paid in cash is paid at the counter: that cash now waits for the desk.
      if (o.orderType === "pickup" && amountDue(o) > 0) {
        await ordersCol.doc(id).update({ cashPending: true, cashCollected: amountDue(o), cashBy: actor });
      }
      return res.json(fulfillmentView(id, o));
    }
    const r = await pickBox(id, req.body || {}, actor);
    return res.json({ ...fulfillmentView(id, r.order), scanned: { item: r.item, box: r.box } });
  }
  return null;
}

// ---------- logistics: vehicles, drivers and routes ----------
// A route ("reys") is one driver in one vehicle taking a day's delivery orders out of the warehouse.
// Stops follow the windows buyers chose (morning first), nearest-next inside each window. Drivers
// work from the mini app: start the route (orders go "shipped"), then mark each hand-over.

const ROUTE_MAX_STOPS = 40;
const ROUTE_ORDER = { started: 0, planned: 1, done: 2 };
const todayKey = () => new Date(Date.now() + TZ_OFFSET_MS).toISOString().slice(0, 10);
const slotDate = (o) => String(o.deliverySlot || "").slice(0, 10);
const slotHour = (o) => Number(String(o.deliverySlot || "").split("_")[1]) || 99;

function cleanVehicle(input) {
  const name = String(input.name || "").trim().slice(0, 60);
  if (!name) throw new HttpError(400, "Mashina nomini kiriting");
  const limit = (v, max, label) => {
    if (v === "" || v === null || v === undefined) return null;
    const n = Math.round(Number(v));
    if (!(n > 0 && n <= max)) throw new HttpError(400, `${label} noto'g'ri`);
    return n;
  };
  return {
    name,
    plate: String(input.plate || "").trim().toUpperCase().slice(0, 20),
    capacityKg: limit(input.capacityKg, 50000, "Yuk ko'tarish (kg)"),
    capacityBoxes: limit(input.capacityBoxes, 2000, "Quti sig'imi"),
    active: input.active !== false,
    updatedAt: Date.now(),
  };
}

// Load of one order: boxes always known; weight only when every module has one (older orders
// fall back to the product's current weight).
function loadOf(o, weightById) {
  const lines = pickLines(o);
  const weights = lines.map((l) => l.weight ?? weightById.get(l.id) ?? null);
  const weight = weights.every(Boolean) ? Math.round(lines.reduce((n, l, i) => n + l.qty * weights[i], 0) * 10) / 10 : null;
  return { boxes: boxesNeeded(o), weight };
}

function orderStops(start, orders) {
  const out = [];
  let here = start;
  for (const hour of [...new Set(orders.map(slotHour))].sort((a, b) => a - b)) {
    const left = orders.filter((o) => slotHour(o) === hour);
    while (left.length) {
      let best = 0;
      left.forEach((o, i) => {
        const cur = left[best];
        if (o.location && (!cur.location || (here && distanceKm(here, o.location) < distanceKm(here, cur.location)))) best = i;
      });
      const [next] = left.splice(best, 1);
      out.push(next);
      if (next.location) here = next.location;
    }
  }
  return out;
}

function routeKm(start, stops) {
  let here = start;
  let km = 0;
  for (const o of stops) {
    if (here && o.location) km += distanceKm(here, o.location);
    if (o.location) here = o.location;
  }
  return Math.round(km * 10) / 10;
}

function stopView(id, o, weightById) {
  return {
    id,
    number: o.number ?? null,
    name: o.name,
    phone: o.phone,
    address: o.address,
    comment: o.comment,
    location: o.location ?? null,
    stage: o.stage,
    status: o.status,
    deliverySlot: o.deliverySlot ?? null,
    deliveryLabel: o.deliveryLabel ?? null,
    payment: o.payment,
    toCollect: amountDue(o),
    dueRequest: o.dueRequest ?? null,
    failedAttempts: o.failedAttempts?.length ?? 0,
    lastFail: o.failedAttempts?.at(-1) ?? null,
    canCard: cardsEnabled(),
    floor: o.delivery?.floor ?? null,
    lift: o.delivery?.lift ?? null,
    lines: o.items.map((i) => `${i.name} × ${i.qty}`),
    routeId: o.routeId ?? null,
    handedAt: o.handedAt ?? null,
    ...loadOf(o, weightById),
  };
}

const productWeights = async () => new Map((await productsCol.get()).docs.map((d) => [d.id, d.data().weight ?? null]));

async function requireDriver(req) {
  const auth = await authenticate(req);
  if (auth.role !== "driver") throw new HttpError(403, "Bu bo'lim faqat haydovchilar uchun");
  return auth;
}

async function driverRoutes(user) {
  const today = todayKey();
  const snap = await routesCol.where("driverId", "==", String(user.id)).get();
  const routes = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((r) => r.date >= today || r.status === "started")
    // Work first: a route on the road, then planned ones by day; finished ones sink to the bottom.
    .sort((a, b) => ROUTE_ORDER[a.status] - ROUTE_ORDER[b.status] || a.date.localeCompare(b.date))
    .slice(0, 10);
  const ids = routes.flatMap((r) => r.orderIds);
  const snaps = ids.length ? await db.getAll(...ids.map((id) => ordersCol.doc(id))) : [];
  const byId = new Map(snaps.filter((x) => x.exists).map((x) => [x.id, x.data()]));
  const weights = await productWeights();
  return routes.map((r) => ({
    ...r,
    dateLabel: dayLabel(new Date(`${r.date}T00:00:00Z`)),
    stops: r.orderIds.filter((id) => byId.has(id)).map((id) => stopView(id, byId.get(id), weights)),
  }));
}

async function startRoute(id, user) {
  const route = (await routesCol.doc(id).get()).data();
  if (!route || route.driverId !== String(user.id)) throw new HttpError(404, "Reys topilmadi");
  if (route.status !== "planned") return;
  const orders = (await db.getAll(...route.orderIds.map((oid) => ordersCol.doc(oid)))).map((x) => ({ id: x.id, ...x.data() }));
  const waiting = orders.filter((o) => o.stage !== "ready" && o.stage !== "shipped" && o.status !== "cancelled");
  if (waiting.length) throw new HttpError(409, `Omborda hali tayyor emas: ${waiting.map(ORDER_LABEL).join(", ")}. Omborchiga ayting`);
  for (const o of orders.filter((x) => x.stage === "ready")) await setStage(o.id, ["ready"], "shipped", { shippedBy: `🚚 ${staffName(user)}` });
  await routesCol.doc(id).update({ status: "started", startedAt: Date.now() });
  await advanceRoute(id);
}

// What the buyer pays at the door: a cash order's total plus any repeat-trip fees.
const amountDue = (o) => (o.payment === "cash" ? o.total : 0) + (o.retryFees ?? 0);
const FAIL_REASONS = {
  absent: "Mijoz uyda yo'q",
  no_answer: "Telefonni ko'tarmadi",
  no_address: "Manzil topilmadi",
  refused: "Mijoz qabul qilmadi",
  no_money: "To'lov yetmadi",
};

async function driverStop(orderId, user) {
  const ref = ordersCol.doc(orderId);
  const o = (await ref.get()).data();
  const route = o?.routeId ? (await routesCol.doc(o.routeId).get()).data() : null;
  if (!o || !route || route.driverId !== String(user.id)) throw new HttpError(404, "Buyurtma sizning reysingizda emas");
  if (o.stage !== "shipped") throw new HttpError(409, o.stage === "delivered" ? "Mijoz allaqachon qabul qilgan" : "Avval reysni boshlang");
  return { ref, o };
}

const buyerButtons = (id) => ({
  inline_keyboard: [[{ text: "✅ Qabul qildim", callback_data: `acc:${id}` }], [{ text: "⚠️ Muammo bor", callback_data: `prob:${id}` }]],
});

// No debt: the furniture leaves the van only when cash plus any card top-up covers what is due.
async function handOver(orderId, user, body) {
  const { ref, o } = await driverStop(orderId, user);
  if (o.handedAt) return;
  const due = amountDue(o);
  const card = o.dueRequest?.status === "paid" ? o.dueRequest.amount : 0;
  const cash = due - card > 0 ? Math.round(Number(body.cash)) : 0;
  if (!(cash >= 0)) throw new HttpError(400, "Olingan naqd summani kiriting");
  if (cash + card < due) {
    throw new HttpError(409, `To'liq emas: yana ${formatSum(due - cash - card)} kerak. «Qolganini karta bilan» yoki «Topshirib bo'lmadi» ni tanlang`);
  }
  // The driver's earning is fixed at hand-over so later rate changes do not rewrite past months.
  const rates = await deliverySettings();
  const driverPay = Math.round(((o.delivery?.total ?? 0) + (o.retryFees ?? 0)) * (1 - rates.commission / 100));
  await ref.update({ handedAt: Date.now(), handedBy: staffName(user), handedById: String(user.id), cashCollected: cash, cashPending: cash > 0, driverPay });
  if (o.telegramUserId) {
    await tg("sendMessage", {
      chat_id: o.telegramUserId,
      text: `🤝 Haydovchi buyurtmangiz ${ORDER_LABEL(o)} ni topshirdi. Hammasi joyidami?`,
      reply_markup: buyerButtons(orderId),
    }).catch((err) => logger.warn("handover notice failed", err));
  }
  await advanceRoute(o.routeId);
}

// The buyer could not take the order: it goes back to the warehouse and off the route. The buyer
// picks a new window (paying the repeat-trip fee) until the attempts run out; then an admin decides.
async function failStop(orderId, user, body) {
  const reason = FAIL_REASONS[body.reason] ? body.reason : null;
  if (!reason) throw new HttpError(400, "Sababni tanlang");
  const { ref, o } = await driverStop(orderId, user);
  if (o.handedAt) throw new HttpError(409, "Bu buyurtma topshirilgan");
  const settings = await deliverySettings();
  const attempts = [...(o.failedAttempts ?? []), { at: Date.now(), reason, by: staffName(user), routeId: o.routeId }];
  const hold = reason === "refused" || attempts.length >= settings.maxAttempts;
  const fee = hold ? 0 : settings.retryFee;
  await ref.update({
    stage: "ready",
    stageAt: Date.now(),
    routeId: null,
    deliverySlot: null,
    deliveryLabel: null,
    dueRequest: null,
    // The slot reminders count from the return to the warehouse, not from the first readiness.
    readyAt: Date.now(),
    slotReminders: 0,
    slotEscalatedAt: null,
    failedAttempts: attempts,
    retryFees: (o.retryFees ?? 0) + fee,
    deliveryHold: hold,
  });
  const no = ORDER_LABEL(o);
  const why = FAIL_REASONS[reason].toLowerCase();
  if (o.telegramUserId) {
    const text = hold
      ? `😔 Buyurtmangiz ${no} ni topshira olmadik (${why}). Mebel omborimizda xavfsiz saqlanmoqda, keyingi qadam bo'yicha siz bilan bog'lanamiz.`
      : `🚚 Bugun buyurtmangiz ${no} ni topshira olmadik (${why}). Mebel omborimizda.\nQayta yetkazish uchun qulay vaqtni tanlang${fee ? ` (qayta yetkazish: ${formatSum(fee)})` : ""}:`;
    await tg("sendMessage", { chat_id: o.telegramUserId, text, reply_markup: hold ? undefined : await slotKeyboard(orderId) }).catch((err) =>
      logger.warn("failed delivery notice failed", err),
    );
  }
  if (hold) {
    await tg("sendMessage", {
      chat_id: ordersChat(),
      text: `⚠️ ${no} ${attempts.length}-marta topshirilmadi: ${FAIL_REASONS[reason]}. Mebel omborga qaytdi. Mijoz bilan gaplashing: qayta yuborish yoki bekor qilish (panel → buyurtma).`,
    }).catch((err) => logger.warn("hold notice failed", err));
  }
  await advanceRoute(o.routeId);
}

// Card top-up at the door: the bot sends the buyer an invoice for what the cash did not cover.
async function requestCardDue(orderId, user, body) {
  if (!cardsEnabled()) throw new HttpError(400, "Karta to'lovi hali ulanmagan");
  const { ref, o } = await driverStop(orderId, user);
  if (o.handedAt) throw new HttpError(409, "Bu buyurtma topshirilgan");
  const cash = Math.max(0, Math.round(Number(body.cash)) || 0);
  const rest = amountDue(o) - cash;
  if (rest <= 0) throw new HttpError(400, "Naqd yetarli: «Topshirdim» ni bosing");
  if (!o.telegramUserId) throw new HttpError(400, "Mijoz Telegram'da emas: karta havolasini yuborib bo'lmaydi");
  const link = await tg("createInvoiceLink", {
    title: `Express Market ${ORDER_LABEL(o)}`,
    description: `Yetkazishda to'lov: ${formatSum(rest)}`,
    payload: `due:${orderId}`,
    provider_token: providerToken(),
    currency: "UZS",
    prices: [{ label: "Qolgan summa", amount: rest * UZS_MINOR }],
  }).catch((err) => {
    logger.error("due invoice failed", err);
    throw new HttpError(502, "To'lov havolasini yaratib bo'lmadi. Naqd oling yoki «Topshirib bo'lmadi» ni tanlang");
  });
  await ref.update({ dueRequest: { amount: rest, cash, status: "awaiting", at: Date.now() } });
  await tg("sendMessage", {
    chat_id: o.telegramUserId,
    text: `💳 Buyurtma ${ORDER_LABEL(o)}: qolgan ${formatSum(rest)} ni karta bilan to'lang. To'lov o'tishi bilan haydovchi mebelni topshiradi.`,
    reply_markup: { inline_keyboard: [[{ text: `💳 ${formatSum(rest)} to'lash`, url: link }]] },
  });
}

async function handleDuePreCheckout(query) {
  const id = String(query.invoice_payload).slice(4);
  const o = (await ordersCol.doc(id).get()).data();
  const ok =
    o?.dueRequest?.status === "awaiting" &&
    o.telegramUserId === query.from.id &&
    query.currency === "UZS" &&
    query.total_amount === o.dueRequest.amount * UZS_MINOR;
  await tg("answerPreCheckoutQuery", {
    pre_checkout_query_id: query.id,
    ok,
    ...(ok ? {} : { error_message: "Bu to'lov havolasi eskirgan. Haydovchidan yangisini so'rang." }),
  });
}

async function handleDuePaid(pay) {
  const id = String(pay.invoice_payload).slice(4);
  const ref = ordersCol.doc(id);
  const o = (await ref.get()).data();
  if (!o?.dueRequest || o.dueRequest.status === "paid") return;
  await ref.update({
    dueRequest: {
      ...o.dueRequest,
      status: "paid",
      paidAt: Date.now(),
      telegramChargeId: pay.telegram_payment_charge_id,
      providerChargeId: pay.provider_payment_charge_id,
    },
  });
  const route = o.routeId ? (await routesCol.doc(o.routeId).get()).data() : null;
  if (!route) return;
  await notifyDriver(route.driverId, `✅ ${ORDER_LABEL(o)}: ${formatSum(o.dueRequest.amount)} karta bilan to'landi. «✅ Topshirdim» ni bosing.`);
}

// After every stop: warn the next buyer the driver is coming, or close the route with a cash report.
async function advanceRoute(routeId) {
  const routeRef = routesCol.doc(routeId);
  const route = (await routeRef.get()).data();
  if (!route || route.status !== "started") return;
  const snaps = await db.getAll(...route.orderIds.map((id) => ordersCol.doc(id)));
  const stops = snaps.filter((x) => x.exists).map((x) => ({ id: x.id, ...x.data() }));
  const open = stops.filter((x) => x.routeId === routeId && x.status !== "cancelled" && !x.handedAt && x.stage === "shipped");
  const next = open[0];
  if (next && !next.comingNoticeAt && next.telegramUserId) {
    await ordersCol.doc(next.id).update({ comingNoticeAt: Date.now() });
    await tg("sendMessage", {
      chat_id: next.telegramUserId,
      text: `🚚 Haydovchi ${ORDER_LABEL(next)} buyurtmangiz bilan sizga kelyapti, siz navbatdagi manzilsiz. Iltimos, uyda bo'ling: u kelishdan oldin qo'ng'iroq qiladi.${amountDue(next) ? `\n💵 To'lov: ${formatSum(amountDue(next))}.` : ""}`,
    }).catch((err) => logger.warn("coming notice failed", err));
  }
  if (open.length) return;
  await routeRef.update({ status: "done", finishedAt: Date.now() });
  const handed = stops.filter((x) => x.handedAt && x.routeId === routeId);
  const failed = stops.filter((x) => x.failedAttempts?.some((a) => a.routeId === routeId));
  const expected = handed.reduce((n, x) => n + amountDue(x) - (x.dueRequest?.status === "paid" ? x.dueRequest.amount : 0), 0);
  const cash = handed.reduce((n, x) => n + (x.cashCollected ?? 0), 0);
  const failedText = failed.map((x) => `${ORDER_LABEL(x)} (${FAIL_REASONS[x.failedAttempts.at(-1).reason].toLowerCase()})`).join(", ");
  const lines = [
    `✅ Reys tugadi: ${route.driverName}, ${route.vehicleName}.`,
    `Topshirildi: ${handed.length} ta${failed.length ? ` · topshirilmadi: ${failedText}` : ""}.`,
    cash || expected
      ? `💵 Haydovchidagi naqd: ${formatSum(cash)} — kassaga topshirish kerak.${cash !== expected ? ` Kutilgan: ${formatSum(expected)}, farq ${formatSum(cash - expected)}.` : ""}`
      : "",
  ];
  await tg("sendMessage", { chat_id: ordersChat(), text: lines.filter(Boolean).join("\n") }).catch((err) => logger.warn("route done notice failed", err));
}

// ---------- driver bot: registration, HR approval and route work in chat ----------
// A second bot only for drivers. Applicants register in chat (phone, car, photos); HR approves them
// in the panel, choosing staff ("shtatda") or contract work and whether the driver may take cash.
// Approved drivers start routes and close stops with chat buttons. Telegram user ids are the same
// in both bots, so an approved driver is the same `staff` document the mini app already knows.

// HR checks the person and the vehicle: documents, the driver standing by the car, and all four
// sides of the car with the plate readable front and back.
const REG_PHOTOS = {
  passport: "Pasport",
  license: "Haydovchilik guvohnomasi (prava)",
  techpass: "Mashina texpasporti",
  withCar: "Mashina oldida o'zingiz",
  carFront: "Mashina oldidan (raqam ko'rinsin)",
  carBack: "Mashina orqasidan (raqam ko'rinsin)",
  carLeft: "Mashina chap yonidan",
  carRight: "Mashina o'ng yonidan",
};
const REG_STEPS = ["phone", "name", "car", "plate", "capacity", ...Object.keys(REG_PHOTOS), "confirm"];
const REG_PROMPTS = {
  name: "Ism va familiyangizni yozing (pasportdagidek):",
  car: "Mashinangiz rusumi (masalan: Isuzu NPR, Labo, Damas):",
  plate: "Mashinaning davlat raqami (masalan: 01 A 123 BC):",
  capacity: "Yuk ko'tarishi, kg (taxminan, masalan: 1500):",
  passport: "🛂 Pasportingizning rasmli sahifasini yuboring (1/8):",
  license: "🪪 Haydovchilik guvohnomasi (prava) rasmini yuboring (2/8):",
  techpass: "📄 Mashina texpasporti rasmini yuboring (3/8):",
  withCar: "🤳 Mashinangiz oldida turib tushgan rasmingizni yuboring: yuzingiz va mashina aniq ko'rinsin (4/8):",
  carFront: "🚚 Mashinani OLDIDAN rasmga oling, davlat raqami aniq o'qilsin (5/8):",
  carBack: "🚚 Mashinani ORQASIDAN rasmga oling, davlat raqami aniq o'qilsin (6/8):",
  carLeft: "🚚 Mashinani CHAP yonidan rasmga oling (7/8):",
  carRight: "🚚 Mashinani O'NG yonidan rasmga oling (8/8):",
};
const DRIVER_MENU = { keyboard: [[{ text: "📋 Reyslarim" }, { text: "📸 Reklama hisoboti" }]], resize_keyboard: true };

// The buyer rates the driver who handed the order over; the average lives on the driver's staff doc.
async function rateDriver(q, orderId, n) {
  const rating = Math.min(5, Math.max(1, Math.round(n) || 0));
  return db.runTransaction(async (t) => {
    const ref = ordersCol.doc(orderId);
    const o = (await t.get(ref)).data();
    if (!o || o.telegramUserId !== q.from.id || !o.handedById || o.driverRating) return "Baho allaqachon qo'yilgan";
    const dRef = staffCol.doc(o.handedById);
    const d = (await t.get(dRef)).data() ?? {};
    const sum = (d.ratingSum ?? 0) + rating;
    const count = (d.ratingCount ?? 0) + 1;
    t.update(ref, { driverRating: rating });
    if (d.role === "driver") t.update(dRef, { ratingSum: sum, ratingCount: count, rating: Math.round((sum / count) * 10) / 10 });
    return "Rahmat!";
  });
}
const EMPLOYMENT = { staff: "Shtatda", contract: "Alohida (yollanma)" };

const driverWebhookSecret = () => createHmac("sha256", DRIVER_BOT_TOKEN.value()).update("driver-webhook").digest("hex");
const dtg = (method, body) => callTelegram(DRIVER_BOT_TOKEN.value(), method, body);

// Drivers added by invite link before the driver bot existed may never have started it.
async function notifyDriver(driverId, text, extra = {}) {
  try {
    await dtg("sendMessage", { chat_id: driverId, text, ...extra });
  } catch {
    await tg("sendMessage", { chat_id: driverId, text }).catch((err) => logger.warn("driver notice failed", err));
  }
}


function regSummary(a) {
  return [
    "Arizangizni tekshiring:",
    `👤 ${a.name}`,
    `📱 ${a.phone}`,
    `🚚 ${a.car} · ${a.plate} · ${a.capacityKg} kg`,
    `📷 ${Object.keys(REG_PHOTOS).length} ta rasm: pasport, prava, texpasport, mashina oldida o'zingiz va mashinaning 4 tomoni`,
  ].join("\n");
}

async function regPrompt(chatId, step, a) {
  if (step === "phone") {
    return dtg("sendMessage", {
      chat_id: chatId,
      text: "Assalomu alaykum! Express Market'ga haydovchi bo'lib ishlash uchun ro'yxatdan o'ting.\n\nAvval telefon raqamingizni ulashing 👇",
      reply_markup: { keyboard: [[{ text: "📱 Raqamni ulashish", request_contact: true }]], resize_keyboard: true, one_time_keyboard: true },
    });
  }
  if (step === "confirm") {
    return dtg("sendMessage", {
      chat_id: chatId,
      text: regSummary(a),
      reply_markup: { inline_keyboard: [[{ text: "✅ Yuborish", callback_data: "reg:send" }, { text: "🔄 Qaytadan", callback_data: "reg:redo" }]] },
    });
  }
  return dtg("sendMessage", { chat_id: chatId, text: REG_PROMPTS[step], reply_markup: { remove_keyboard: true } });
}

// One step of the registration form; returns the field update or an error to show.
function regAnswer(step, msg) {
  const text = String(msg.text || "").trim();
  if (step === "phone") {
    if (!msg.contact || msg.contact.user_id !== msg.from.id) return { error: "Pastdagi «📱 Raqamni ulashish» tugmasini bosing." };
    return { phone: `+${String(msg.contact.phone_number).replace(/\D/g, "")}` };
  }
  if (step === "name") return text.length >= 3 && text.length <= 80 ? { name: text } : { error: "Ism va familiyani to'liq yozing." };
  if (step === "car") return text.length >= 2 && text.length <= 60 ? { car: text } : { error: "Mashina rusumini yozing." };
  if (step === "plate") return text.length >= 4 && text.length <= 20 ? { plate: text.toUpperCase() } : { error: "Davlat raqamini yozing." };
  if (step === "capacity") {
    const kg = Math.round(Number(text.replace(/\D/g, "")));
    return kg >= 100 && kg <= 50000 ? { capacityKg: kg } : { error: "Faqat raqam yozing, masalan 1500." };
  }
  const photo = msg.photo?.at(-1)?.file_id ?? (msg.document?.mime_type?.startsWith("image/") ? msg.document.file_id : null);
  return photo ? { [`${step}FileId`]: photo } : { error: `${REG_PHOTOS[step]} rasmini yuboring.` };
}

async function handleRegistration(msg) {
  const ref = applicationsCol.doc(String(msg.from.id));
  const snap = await ref.get();
  const a = snap.data();
  // Only non-drivers get here, so an "approved" application belongs to a driver HR later removed:
  // they register again like a rejected applicant.
  const restart = msg.text === "/start" && (!a || a.status !== "pending");
  if (!a || restart) {
    await ref.set({ telegramId: msg.from.id, username: msg.from.username || "", step: "phone", status: "draft", createdAt: Date.now() });
    return regPrompt(msg.chat.id, "phone");
  }
  if (a.status === "pending") return dtg("sendMessage", { chat_id: msg.chat.id, text: "⏳ Arizangiz HR bo'limida ko'rib chiqilmoqda. Javob shu yerga keladi." });
  if (a.status !== "draft") return dtg("sendMessage", { chat_id: msg.chat.id, text: "Qayta ro'yxatdan o'tish uchun /start bosing." });
  if (a.step === "confirm") return regPrompt(msg.chat.id, "confirm", a);
  const answer = regAnswer(a.step, msg);
  if (answer.error) return dtg("sendMessage", { chat_id: msg.chat.id, text: answer.error });
  const step = REG_STEPS[REG_STEPS.indexOf(a.step) + 1];
  await ref.update({ ...answer, step });
  return regPrompt(msg.chat.id, step, { ...a, ...answer });
}

async function submitApplication(from) {
  const ref = applicationsCol.doc(String(from.id));
  const a = (await ref.get()).data();
  if (!a || a.step !== "confirm" || a.status !== "draft") return "Ariza topilmadi, /start bosing";
  // Photos move to Storage so HR sees them in the panel without the bot token.
  const photos = {};
  for (const kind of Object.keys(REG_PHOTOS)) photos[kind] = await saveBotPhoto(DRIVER_BOT_TOKEN.value(), a[`${kind}FileId`], `drivers/${from.id}/${kind}-${randomUUID()}`);
  await ref.update({ status: "pending", submittedAt: Date.now(), photos });
  for (const admin of idList(ADMIN_IDS.value())) {
    await tg("sendMessage", {
      chat_id: admin,
      text: `🆕 Haydovchi arizasi: ${a.name}, ${a.phone}, ${a.car} ${a.plate}.\nPanel → Xodimlar (HR) → Haydovchi arizalari.`,
    }).catch((err) => logger.warn("application notice failed", err));
  }
  await dtg("sendMessage", { chat_id: from.id, text: "✅ Arizangiz yuborildi. HR bo'limi tekshirib, shu yerga javob beradi." });
  return "Yuborildi";
}

// ---------- driver work in chat ----------

const routeMapUrl = (stops) => {
  const pts = stops.filter((s) => s.location).map((s) => `${s.location.lat},${s.location.lon}`);
  return pts.length ? `https://www.google.com/maps/dir/${pts.join("/")}` : null;
};
const openStops = (r) => r.stops.filter((s) => s.stage === "shipped" && !s.handedAt && s.routeId === r.id);
const stillDue = (s) => Math.max(0, s.toCollect - (s.dueRequest?.status === "paid" ? s.dueRequest.amount : 0));

function stopText(s, i) {
  const floor = s.floor ? ` · ${s.floor}-qavat${s.lift ? ", lift bor" : s.floor > 2 ? ", liftsiz" : ""}` : "";
  return [
    `${i + 1}. #${s.number} · ${s.name} · ${String(s.deliveryLabel || "").split(", ").at(-1)}`,
    `📞 ${s.phone}`,
    `🏠 ${s.address || "manzil yozilmagan"}${floor}`,
    s.comment ? `💬 ${s.comment}` : "",
    `📦 ${s.lines.join(", ")} · ${s.boxes} quti`,
    stillDue(s) ? `💵 Olinadi: ${formatSum(stillDue(s))}` : "💳 To'langan",
  ]
    .filter(Boolean)
    .join("\n");
}

function stopButtons(s) {
  const rows = [[{ text: "✅ Topshirdim", callback_data: `ds:h:${s.id}` }, { text: "❌ Topshirib bo'lmadi", callback_data: `ds:f:${s.id}` }]];
  if (s.location) rows.push([{ text: "📍 Xaritada", url: `https://maps.google.com/?q=${s.location.lat},${s.location.lon}` }]);
  return { inline_keyboard: rows };
}

async function sendRoutes(chatId, user) {
  const routes = (await driverRoutes(user)).filter((r) => r.status !== "done");
  if (!routes.length) return dtg("sendMessage", { chat_id: chatId, text: "Hozircha sizga reys biriktirilmagan. Reys tuzilganda shu yerga xabar keladi.", reply_markup: DRIVER_MENU });
  for (const r of routes) {
    const cash = r.stops.reduce((n, s) => n + stillDue(s), 0);
    const rows = r.status === "planned" ? [[{ text: "▶️ Reysni boshlash", callback_data: `dr:start:${r.id}` }]] : [[{ text: "📍 Navbatdagi manzil", callback_data: `dr:next:${r.id}` }]];
    const map = routeMapUrl(r.status === "planned" ? r.stops : openStops(r));
    if (map) rows.push([{ text: "🗺 Butun marshrut", url: map }]);
    await dtg("sendMessage", {
      chat_id: chatId,
      text: `🚚 ${r.dateLabel} · ${ROUTE_STATUS_TEXT[r.status]}\n${r.vehicleName} · ${r.stops.length} ta manzil${r.km ? ` · ~${r.km} km` : ""}${cash ? `\n💵 Jami naqd: ${formatSum(cash)}` : ""}\n\n${r.stops.map((s, i) => `${i + 1}. #${s.number} ${s.name} — ${String(s.address || "").slice(0, 40)}`).join("\n")}`,
      reply_markup: { inline_keyboard: rows },
    });
  }
}
const ROUTE_STATUS_TEXT = { planned: "Rejada", started: "Yo'lda", done: "Tugadi" };

// Shows the next open stop of the route, or the end-of-route note with the cash to hand in.
async function sendNextStop(chatId, user, routeId) {
  const route = (await driverRoutes(user)).find((r) => r.id === routeId);
  if (!route) return dtg("sendMessage", { chat_id: chatId, text: "Reys topilmadi." });
  const open = openStops(route);
  if (open.length) return dtg("sendMessage", { chat_id: chatId, text: stopText(open[0], route.stops.indexOf(open[0])), reply_markup: stopButtons(open[0]) });
  const cash = route.stops.filter((s) => s.handedAt && s.routeId === route.id).length;
  const done = (await routesCol.doc(routeId).get()).data();
  const snaps = await db.getAll(...done.orderIds.map((id) => ordersCol.doc(id)));
  const collected = snaps.reduce((n, x) => n + (x.data()?.routeId === routeId ? (x.data().cashCollected ?? 0) : 0), 0);
  return dtg("sendMessage", {
    chat_id: chatId,
    text: `🏁 Reys tugadi: ${cash} ta topshirildi.${collected ? `\n💵 Sizda naqd: ${formatSum(collected)} — kassaga topshiring.` : ""}`,
    reply_markup: DRIVER_MENU,
  });
}

async function driverFromUpdate(from) {
  const staff = (await staffCol.doc(String(from.id)).get()).data();
  return staff?.role === "driver" ? staff : null;
}

async function handleDriverText(msg, staff) {
  const user = msg.from;
  if (msg.photo && (await hr.adPhoto(msg, staff, dtg))) return;
  if (msg.text === "📸 Reklama hisoboti") return hr.adStart(msg.chat.id, user.id, dtg);
  const awaiting = staff.awaitingCash;
  if (awaiting && /^[\d\s']+$/.test(String(msg.text || "").trim())) {
    const cash = Number(String(msg.text).replace(/\D/g, ""));
    await staffCol.doc(String(user.id)).update({ awaitingCash: null });
    return closeStop(msg.chat.id, user, awaiting, () => handOver(awaiting, user, { cash }), cash);
  }
  if (msg.text === "/start") {
    const trust = staff.employment === "staff" ? "shtatda" : staff.employment === "contract" ? "alohida (yollanma)" : "ish turi HR tomonidan belgilanmagan";
    await dtg("sendMessage", {
      chat_id: msg.chat.id,
      text: `👋 Salom, ${staff.name}! Siz Express Market haydovchisisiz (${trust}).\n${staff.cashAllowed ? "💵 Sizga naqd to'lovli buyurtmalar ham biriktiriladi." : "💳 Sizga oldindan to'langan buyurtmalar biriktiriladi."}\nReyslaringiz pastdagi «📋 Reyslarim» tugmasida.`,
      reply_markup: DRIVER_MENU,
    });
  }
  return sendRoutes(msg.chat.id, user);
}

// Runs one stop action and answers in chat; a short-cash refusal offers the card top-up instead.
async function closeStop(chatId, user, orderId, action, cash) {
  const routeId = (await ordersCol.doc(orderId).get()).data()?.routeId;
  try {
    await action();
  } catch (err) {
    const short = err instanceof HttpError && err.status === 409 && cash !== undefined;
    const rows = short
      ? [[...(cardsEnabled() ? [{ text: "💳 Qolganini karta bilan", callback_data: `ds:c:${orderId}:${cash}` }] : []), { text: "❌ Topshirib bo'lmadi", callback_data: `ds:f:${orderId}` }]]
      : [];
    return dtg("sendMessage", { chat_id: chatId, text: `⚠️ ${err.message}`, ...(rows.length ? { reply_markup: { inline_keyboard: rows } } : {}) });
  }
  if (routeId) await sendNextStop(chatId, user, routeId);
}

async function handleDriverCallback(q) {
  const user = q.from;
  const chatId = q.message?.chat.id ?? user.id;
  const answer = (text = "") => dtg("answerCallbackQuery", { callback_query_id: q.id, text }).catch(() => {});
  if (q.data === "reg:send") return answer(await submitApplication(user));
  if (q.data === "reg:redo") {
    await applicationsCol.doc(String(user.id)).update({ step: "phone", status: "draft" });
    await answer();
    return regPrompt(chatId, "phone");
  }
  const staff = await driverFromUpdate(user);
  if (!staff) return answer("Avval ro'yxatdan o'ting: /start");
  const [kind, act, id, extra] = String(q.data).split(":");
  await answer();
  try {
    if (kind === "dr" && act === "start") {
      await startRoute(id, user);
      return sendNextStop(chatId, user, id);
    }
    if (kind === "dr" && act === "next") return sendNextStop(chatId, user, id);
    if (kind === "dr" && act === "list") return sendRoutes(chatId, user);
  } catch (err) {
    return dtg("sendMessage", { chat_id: chatId, text: `⚠️ ${err.message}` });
  }
  if (kind !== "ds") return;
  const o = (await ordersCol.doc(id).get()).data();
  if (act === "h") {
    const due = o ? amountDue(o) - (o.dueRequest?.status === "paid" ? o.dueRequest.amount : 0) : 0;
    if (due > 0) {
      await staffCol.doc(String(user.id)).update({ awaitingCash: id });
      return dtg("sendMessage", { chat_id: chatId, text: `💵 #${o.number}: qancha naqd oldingiz? Faqat raqam yozing.\nKerak: ${formatSum(due)}` });
    }
    return closeStop(chatId, user, id, () => handOver(id, user, {}));
  }
  if (act === "f") {
    return dtg("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: q.message.message_id,
      reply_markup: { inline_keyboard: Object.entries(FAIL_REASONS).map(([k, label]) => [{ text: label, callback_data: `ds:r:${id}:${k}` }]) },
    }).catch(() => dtg("sendMessage", { chat_id: chatId, text: "Sababni tanlang:", reply_markup: { inline_keyboard: Object.entries(FAIL_REASONS).map(([k, label]) => [{ text: label, callback_data: `ds:r:${id}:${k}` }]) } }));
  }
  if (act === "r") return closeStop(chatId, user, id, () => failStop(id, user, { reason: extra }));
  if (act === "c") {
    try {
      await requestCardDue(id, user, { cash: Number(extra) });
      await staffCol.doc(String(user.id)).update({ awaitingCash: null });
      return dtg("sendMessage", { chat_id: chatId, text: "💳 Mijozga to'lov havolasi yuborildi. To'lov o'tganda xabar keladi, keyin «✅ Topshirdim» ni bosing va olgan naqdingizni yozing." });
    } catch (err) {
      return dtg("sendMessage", { chat_id: chatId, text: `⚠️ ${err.message}` });
    }
  }
}

async function handleDriverBot(req, res) {
  const header = req.get("x-telegram-bot-api-secret-token") || "";
  if (!sameSecret(header, driverWebhookSecret())) throw new HttpError(403, "Forbidden");
  // Replies are best-effort: an error must not make Telegram resend the update forever.
  try {
    if (req.body?.callback_query) await handleDriverCallback(req.body.callback_query);
    const msg = req.body?.message;
    if (msg && msg.chat.type === "private") {
      const staff = await driverFromUpdate(msg.from);
      if (staff) await handleDriverText(msg, staff);
      else await handleRegistration(msg);
    }
  } catch (err) {
    logger.error("driver bot update failed", err);
  }
  return res.json({ ok: true });
}

async function setupDriverBot() {
  try {
    const bot = await dtg("getMe", {});
    await dtg("setWebhook", { url: `${WEBAPP_URL}/api/driverbot`, secret_token: driverWebhookSecret(), allowed_updates: ["message", "callback_query"] });
    await dtg("setMyCommands", { commands: [{ command: "start", description: "Boshlash / ro'yxatdan o'tish" }, { command: "reys", description: "Reyslarim" }] });
    return `@${bot.username}`;
  } catch (err) {
    return `ulanmadi: ${err.message}`;
  }
}

// ---------- HR: applications and driver trust ----------

function cleanTrust(input) {
  const employment = input.employment === "staff" ? "staff" : "contract";
  // Cash is only for staff drivers HR vouches for; contract drivers carry prepaid orders only.
  return { employment, cashAllowed: employment === "staff" && input.cashAllowed === true };
}

async function handleHr(req, res, path, method) {
  if (path === "/api/driver-applications" && method === "GET") {
    await requireRole(req, "admin");
    const snap = await applicationsCol.where("status", "==", "pending").get();
    return res.json(snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.submittedAt - b.submittedAt));
  }
  const appMatch = path.match(/^\/api\/driver-applications\/(\d{1,20})\/(approve|reject)$/);
  if (appMatch && method === "POST") {
    const { user } = await requireRole(req, "admin");
    const [, id, action] = appMatch;
    const ref = applicationsCol.doc(id);
    const a = (await ref.get()).data();
    if (a?.status !== "pending") throw new HttpError(409, "Ariza allaqachon ko'rib chiqilgan");
    if (action === "reject") {
      const reason = String(req.body?.reason || "").trim().slice(0, 200);
      if (!reason) throw new HttpError(400, "Rad etish sababini yozing");
      await ref.update({ status: "rejected", reviewedAt: Date.now(), reviewedBy: staffName(user), rejectReason: reason });
      await dtg("sendMessage", { chat_id: id, text: `❌ Arizangiz rad etildi: ${reason}\nQayta topshirish uchun /start bosing.` }).catch(() => {});
      return res.json({ ok: true });
    }
    const trust = cleanTrust(req.body || {});
    const vehicleRef = vehiclesCol.doc();
    await db.runTransaction(async (t) => {
      t.set(vehicleRef, { name: a.car, plate: a.plate, capacityKg: a.capacityKg, capacityBoxes: null, active: true, driverId: id, createdAt: Date.now(), updatedAt: Date.now() });
      t.set(staffCol.doc(id), {
        role: "driver",
        name: a.name,
        username: a.username,
        phone: a.phone,
        photos: a.photos,
        vehicleId: vehicleRef.id,
        ...trust,
        addedAt: Date.now(),
        approvedBy: staffName(user),
      });
      t.update(ref, { status: "approved", reviewedAt: Date.now(), reviewedBy: staffName(user), ...trust });
    });
    await dtg("sendMessage", {
      chat_id: id,
      text: `🎉 Tabriklaymiz, ${a.name}! Siz Express Market haydovchisi sifatida qabul qilindingiz (${EMPLOYMENT[trust.employment].toLowerCase()}).\n${trust.cashAllowed ? "💵 Sizga naqd to'lovli buyurtmalar ham biriktiriladi." : "💳 Sizga oldindan to'langan buyurtmalar biriktiriladi."}\n\nReys tuzilganda shu yerga xabar keladi. «📋 Reyslarim» tugmasi doim pastda.`,
      reply_markup: DRIVER_MENU,
    }).catch((err) => logger.warn("approve notice failed", err));
    return res.json({ ok: true });
  }
  const trustMatch = path.match(/^\/api\/staff\/(\d{1,20})\/trust$/);
  if (trustMatch && method === "PUT") {
    await requireRole(req, "admin");
    const ref = staffCol.doc(trustMatch[1]);
    const staff = (await ref.get()).data();
    if (staff?.role !== "driver") throw new HttpError(404, "Haydovchi topilmadi");
    const trust = cleanTrust(req.body || {});
    await ref.update(trust);
    return res.json({ ...staff, ...trust });
  }
  return null;
}

// ---------- complaints ("shikoyatlar") ----------
// The buyer reports a problem from the shipped notice or from "Mening buyurtmalarim"; the bot collects
// the kind, a short text and photos, then the complaint lands in the panel as a task with a deadline.
// An admin takes it, writes to the buyer through the bot, picks a resolution and the buyer rates it.

const COMPLAINT_SLA_MS = 24 * 60 * 60 * 1000;
const COMPLAINT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const COMPLAINT_MAX_PHOTOS = 5;
const COMPLAINT_TYPES = {
  broken: "Singan / shikastlangan",
  missing: "Qism yetishmaydi",
  wrong: "Boshqa mahsulot keldi",
  assembly: "Yig'ishda muammo",
  quality: "Sifat / nuqson",
  other: "Boshqa",
};
// Kinds a photo proves; for assembly questions or "other" a text is enough.
const PHOTO_REQUIRED = new Set(["broken", "missing", "wrong", "quality"]);
const RESOLUTIONS = {
  part: "Yetishmagan / singan qism yuboriladi",
  replace: "Mahsulot almashtiriladi",
  master: "Usta yuboriladi",
  refund_partial: "Pulning bir qismi qaytariladi",
  refund_full: "Pul to'liq qaytariladi",
  advice: "Maslahat berildi, muammo hal bo'ldi",
  reject: "Shikoyat asossiz deb topildi",
};
const complaintNo = (c) => `S-${c.number}`;

async function saveBotPhoto(token, fileId, path) {
  const file = await callTelegram(token, "getFile", { file_id: fileId });
  const res = await fetch(`https://api.telegram.org/file/bot${token.trim()}/${file.file_path}`);
  if (!res.ok) throw new Error(`photo download ${res.status}`);
  return saveBuffer(Buffer.from(await res.arrayBuffer()), `${path}.jpg`, "image/jpeg");
}

const typeKeyboard = (cid) => ({
  inline_keyboard: Object.entries(COMPLAINT_TYPES).map(([k, label]) => [{ text: label, callback_data: `cmp:t:${cid}:${k}` }]),
});

// Opens (or reuses) a complaint draft for an order and asks the buyer what happened.
async function startComplaint(orderId, o) {
  if (!o.telegramUserId) throw new HttpError(400, "Mijoz Telegram'da emas");
  const open = await complaintsCol.where("orderId", "==", orderId).get();
  const active = open.docs.find((d) => !["resolved", "closed"].includes(d.data().status));
  if (active?.data().status === "open" || active?.data().status === "in_progress") {
    throw new HttpError(409, `Bu buyurtma bo'yicha shikoyatingiz (${complaintNo(active.data())}) ko'rib chiqilmoqda`);
  }
  const ref = active?.ref ?? complaintsCol.doc();
  if (!active) {
    await ref.set({
      orderId,
      orderNumber: o.number ?? null,
      buyerId: o.telegramUserId,
      name: o.name,
      phone: o.phone,
      status: "collecting",
      step: "type",
      photos: [],
      photoIds: [],
      history: [],
      createdAt: Date.now(),
    });
  }
  await tg("sendMessage", { chat_id: o.telegramUserId, text: `⚠️ Buyurtma ${ORDER_LABEL(o)}: nima muammo bo'ldi?`, reply_markup: typeKeyboard(ref.id) });
}

// Buyer messages while a draft is open: the description text, then photos.
async function collectComplaint(msg) {
  const snap = await complaintsCol.where("buyerId", "==", msg.from.id).where("status", "==", "collecting").get();
  const doc = snap.docs.sort((a, b) => b.data().createdAt - a.data().createdAt)[0];
  if (!doc) return false;
  const c = doc.data();
  const chat = msg.chat.id;
  if (c.step === "type") {
    await tg("sendMessage", { chat_id: chat, text: "Avval muammo turini tanlang:", reply_markup: typeKeyboard(doc.id) });
    return true;
  }
  if (c.step === "text") {
    const text = String(msg.text || msg.caption || "").trim();
    if (text.length < 3) {
      await tg("sendMessage", { chat_id: chat, text: "Muammoni bir-ikki gap bilan yozing:" });
      return true;
    }
    await doc.ref.update({ text: text.slice(0, 1000), step: "photos" });
    await tg("sendMessage", {
      chat_id: chat,
      text: `📷 Endi rasm yuboring (1–${COMPLAINT_MAX_PHOTOS} ta): muammo aniq ko'rinsin. Tugatgach «✅ Yuborish» ni bosing.`,
      reply_markup: { inline_keyboard: [[{ text: "✅ Yuborish", callback_data: `cmp:s:${doc.id}` }]] },
    });
    return true;
  }
  const photo = msg.photo?.at(-1)?.file_id ?? (msg.document?.mime_type?.startsWith("image/") ? msg.document.file_id : null);
  if (!photo) {
    await tg("sendMessage", { chat_id: chat, text: "Rasm yuboring yoki «✅ Yuborish» ni bosing.", reply_markup: { inline_keyboard: [[{ text: "✅ Yuborish", callback_data: `cmp:s:${doc.id}` }]] } });
    return true;
  }
  if (c.photoIds.length >= COMPLAINT_MAX_PHOTOS) {
    await tg("sendMessage", { chat_id: chat, text: `Ko'pi bilan ${COMPLAINT_MAX_PHOTOS} ta rasm. «✅ Yuborish» ni bosing.`, reply_markup: { inline_keyboard: [[{ text: "✅ Yuborish", callback_data: `cmp:s:${doc.id}` }]] } });
    return true;
  }
  await doc.ref.update({ photoIds: [...c.photoIds, photo] });
  await tg("sendMessage", {
    chat_id: chat,
    text: `✔️ ${c.photoIds.length + 1}-rasm qabul qilindi. Yana yuboring yoki «✅ Yuborish» ni bosing.`,
    reply_markup: { inline_keyboard: [[{ text: "✅ Yuborish", callback_data: `cmp:s:${doc.id}` }]] },
  });
  return true;
}

async function submitComplaint(ref, c, chat) {
  if (PHOTO_REQUIRED.has(c.type) && !c.photoIds.length) return "Kamida bitta rasm yuboring";
  const photos = [];
  for (const [i, id] of c.photoIds.entries()) photos.push(await saveBotPhoto(BOT_TOKEN.value(), id, `complaints/${ref.id}/${i}-${randomUUID()}`));
  const number = await db.runTransaction(async (t) => {
    const n = ((await t.get(countersRef)).data()?.complaint ?? 0) + 1;
    t.set(countersRef, { complaint: n }, { merge: true });
    t.update(ref, { status: "open", number: n, photos, submittedAt: Date.now(), dueAt: Date.now() + COMPLAINT_SLA_MS });
    return n;
  });
  const order = (await ordersCol.doc(c.orderId).get()).data();
  const lines = order ? order.items.map((i) => `${i.name} × ${i.qty}`).join(", ") : "";
  await tg("sendMessage", {
    chat_id: ordersChat(),
    text: `🛠 Yangi shikoyat S-${number}: ${ORDER_LABEL(order ?? {})} ${c.name}, ${c.phone}\n${COMPLAINT_TYPES[c.type]}: ${c.text}\n${lines}\n${photos.length} ta rasm. Panel → Shikoyatlar (javob muddati 24 soat).`,
  }).catch((err) => logger.warn("complaint notice failed", err));
  await tg("sendMessage", { chat_id: chat, text: `✅ Shikoyatingiz qabul qilindi (S-${number}). 24 soat ichida javob beramiz, natijasi shu botga keladi.` });
  return "Yuborildi";
}

async function handleComplaintCallback(q, act, cid, arg) {
  const ref = complaintsCol.doc(cid);
  const c = (await ref.get()).data();
  if (!c || c.buyerId !== q.from.id) return { answer: "Shikoyat topilmadi", close: true };
  const chat = q.message?.chat.id ?? q.from.id;
  if (act === "t" && c.status === "collecting" && COMPLAINT_TYPES[arg]) {
    await ref.update({ type: arg, step: "text" });
    await tg("sendMessage", { chat_id: chat, text: `${COMPLAINT_TYPES[arg]}. Muammoni qisqacha yozing:` });
    return { answer: "", close: true };
  }
  if (act === "s" && c.status === "collecting") {
    if (c.step !== "photos") return { answer: "Avval muammoni yozing" };
    const answer = await submitComplaint(ref, c, chat);
    return { answer, close: answer === "Yuborildi" };
  }
  if (act === "r" && c.status === "resolved" && !c.rating) {
    const rating = Math.min(5, Math.max(1, Number(arg) || 0));
    await ref.update({ rating, ratedAt: Date.now(), status: "closed" });
    await tg("sendMessage", { chat_id: chat, text: rating >= 4 ? "Rahmat! Bahoingiz biz uchun muhim. 🙏" : "Rahmat. Kamchiliklarni tuzatamiz, bahoingiz rahbariyatga yetkazildi." });
    if (rating <= 2) {
      await tg("sendMessage", { chat_id: ordersChat(), text: `⭐ ${rating}/5: ${complaintNo(c)} (${c.name}) yechimidan norozi. Panel → Shikoyatlar.` }).catch(() => {});
    }
    return { answer: "Rahmat!", close: true };
  }
  return { answer: "Bu tugma endi faol emas", close: true };
}

function complaintView(id, c) {
  return {
    id,
    number: c.number ?? null,
    orderId: c.orderId,
    orderNumber: c.orderNumber,
    name: c.name,
    phone: c.phone,
    type: c.type ?? null,
    text: c.text ?? "",
    photos: c.photos ?? [],
    status: c.status,
    submittedAt: c.submittedAt ?? c.createdAt,
    dueAt: c.dueAt ?? null,
    assignee: c.assignee ?? null,
    resolution: c.resolution ?? null,
    rating: c.rating ?? null,
    history: c.history ?? [],
  };
}

async function handleComplaints(req, res, path, method) {
  const start = path.match(/^\/api\/orders\/([\w-]{1,64})\/complaint$/);
  if (start && method === "POST") {
    const { user } = await authenticate(req);
    const o = (await ordersCol.doc(start[1]).get()).data();
    if (!user || !o || o.telegramUserId !== user.id) throw new HttpError(404, "Buyurtma topilmadi");
    const closedAt = o.deliveredAt ?? o.stageAt ?? o.createdAt;
    const allowed = o.stage === "shipped" || o.stage === "problem" || (o.stage === "delivered" && Date.now() - closedAt < COMPLAINT_WINDOW_MS);
    if (!allowed) throw new HttpError(409, "Bu buyurtma bo'yicha shikoyat qilib bo'lmaydi");
    await startComplaint(start[1], o);
    return res.json({ ok: true });
  }
  if (path === "/api/complaints" && method === "GET") {
    await requireRole(req, "admin");
    const snap = await complaintsCol.where("status", "in", ["open", "in_progress", "resolved", "closed"]).get();
    return res.json(snap.docs.map((d) => complaintView(d.id, d.data())).sort((a, b) => b.submittedAt - a.submittedAt));
  }
  const m = path.match(/^\/api\/complaints\/([\w-]{1,64})\/(take|message|resolve)$/);
  if (!m || method !== "POST") return null;
  const { user } = await requireRole(req, "admin");
  const [, id, action] = m;
  const ref = complaintsCol.doc(id);
  const c = (await ref.get()).data();
  if (!c || c.status === "collecting") throw new HttpError(404, "Shikoyat topilmadi");
  const by = staffName(user);
  const log = (text) => [...(c.history ?? []), { at: Date.now(), by, text }];
  if (action === "take") {
    if (c.status !== "open") throw new HttpError(409, "Shikoyat allaqachon ishda");
    await ref.update({ status: "in_progress", assignee: by, takenAt: Date.now(), history: log("Ishga olindi") });
    await tg("sendMessage", { chat_id: c.buyerId, text: `🛠 Shikoyatingiz ${complaintNo(c)} ishga olindi. Mas'ul: ${by}.` }).catch(() => {});
  }
  if (action === "message") {
    const text = String(req.body?.text || "").trim().slice(0, 1000);
    if (!text) throw new HttpError(400, "Xabar matnini yozing");
    await tg("sendMessage", { chat_id: c.buyerId, text: `💬 Shikoyat ${complaintNo(c)} bo'yicha:\n${text}` });
    await ref.update({ history: log(`Mijozga: ${text}`) });
  }
  if (action === "resolve") {
    if (!["open", "in_progress"].includes(c.status)) throw new HttpError(409, "Shikoyat yopilgan");
    const kind = RESOLUTIONS[req.body?.kind] ? req.body.kind : null;
    if (!kind) throw new HttpError(400, "Yechimni tanlang");
    const note = String(req.body?.note || "").trim().slice(0, 500);
    const order = (await ordersCol.doc(c.orderId).get()).data();
    const refundCap = order?.paidAmount ?? order?.total ?? 0;
    const amount = kind === "refund_full" ? refundCap : kind === "refund_partial" ? Math.round(Number(req.body?.amount)) : 0;
    if (kind === "refund_partial" && !(amount > 0 && amount < refundCap)) throw new HttpError(400, `Qaytariladigan summani kiriting (0 dan ${formatSum(refundCap)} gacha)`);
    const resolution = { kind, note, amount, at: Date.now(), by };
    await ref.update({ status: "resolved", resolution, history: log(`Yechim: ${RESOLUTIONS[kind]}${amount ? ` · ${formatSum(amount)}` : ""}${note ? ` · ${note}` : ""}`) });
    // Refunds join the accounting queue the cancellations already use; the problem stage closes.
    const update = {
      ...(amount ? { refund: { status: "pending", amount, reason: `Shikoyat ${complaintNo(c)}` } } : {}),
      ...(order?.stage === "problem" ? { stage: "delivered", stageAt: Date.now(), deliveredAt: Date.now() } : {}),
    };
    if (Object.keys(update).length) await ordersCol.doc(c.orderId).update(update);
    await tg("sendMessage", {
      chat_id: c.buyerId,
      text: `✅ Shikoyat ${complaintNo(c)} bo'yicha qaror: ${RESOLUTIONS[kind]}${amount ? ` (${formatSum(amount)})` : ""}.${note ? `\n${note}` : ""}\n\nXizmatimizni baholang:`,
      reply_markup: { inline_keyboard: [[1, 2, 3, 4, 5].map((n) => ({ text: `${n} ⭐`, callback_data: `cmp:r:${id}:${n}` }))] },
    }).catch((err) => logger.warn("resolution notice failed", err));
  }
  return res.json(complaintView(id, (await ref.get()).data()));
}

// ---------- cash desk ("kassa") ----------
// Cash taken by drivers (at hand-over) and by the shop (pickup orders) waits as `cashPending` on the
// order until a cashier accepts it into the desk. Every movement of the desk is an immutable
// `cashbook` entry; meta/cash keeps the running balance in the same transaction. Mistakes are fixed
// with a counter-entry, never by editing history.

const CASH_IN = { driver: "Haydovchidan", store: "Do'kon savdosi", other_in: "Boshqa kirim" };
const CASH_OUT = {
  purchase: "Zakup / tovar",
  salary: "Maosh",
  rent: "Ijara",
  fuel: "Yoqilg'i / transport",
  utility: "Kommunal / aloqa",
  tax: "Soliq",
  marketing: "Reklama",
  bank: "Bankka topshirildi",
  refund: "Mijozga qaytarildi",
  other: "Boshqa chiqim",
};
// Bank deposits move money, refunds reduce revenue and stock purchases reach profit through the
// product cost when the goods sell: none of them is an operating expense.
const NOT_EXPENSE = new Set(["bank", "refund", "purchase"]);

// Writes one ledger line and moves the balance; `t` already read the cash doc (`balance`).
function bookCash(t, balance, entry) {
  const amount = Math.round(entry.amount);
  const next = balance + (entry.type === "in" ? amount : -amount);
  if (next < 0) throw new HttpError(409, `Kassada yetarli pul yo'q: qoldiq ${formatSum(balance)}`);
  const ref = cashbookCol.doc();
  t.set(ref, { ...entry, amount, balanceAfter: next, at: entry.at ?? Date.now() });
  t.set(cashRef, { balance: next, updatedAt: Date.now() }, { merge: true });
  return { id: ref.id, next };
}

// Who holds a pending order's cash: the driver of its route, or the shop for pickups.
const cashHolder = (o, routes) => (o.orderType === "pickup" ? "store" : (o.handedById ?? routes.get(o.routeId)?.driverId ?? "unknown"));

async function pendingCash() {
  const snap = await ordersCol.where("cashPending", "==", true).get();
  const orders = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const routeIds = [...new Set(orders.map((o) => o.routeId).filter(Boolean))];
  const routeSnaps = routeIds.length ? await db.getAll(...routeIds.map((id) => routesCol.doc(id))) : [];
  const routes = new Map(routeSnaps.filter((x) => x.exists).map((x) => [x.id, x.data()]));
  const groups = new Map();
  for (const o of orders) {
    const key = cashHolder(o, routes);
    const g = groups.get(key) ?? { holder: key, name: key === "store" ? "Do'kon / ombor" : (routes.get(o.routeId)?.driverName ?? o.handedBy ?? "—"), total: 0, orders: [] };
    g.total += o.cashCollected;
    g.orders.push({ id: o.id, number: o.number ?? null, name: o.name, amount: o.cashCollected, at: o.handedAt ?? o.shippedAt ?? o.createdAt, by: o.handedBy ?? o.cashBy ?? "" });
    groups.set(key, g);
  }
  return { groups: [...groups.values()].sort((a, b) => b.total - a.total), routes };
}

async function handleCash(req, res, path, method) {
  if (path === "/api/cash" && method === "GET") {
    await requireRole(req, "admin");
    const from = Number(req.query.from) || Date.now() - 30 * 24 * 60 * 60 * 1000;
    const [{ groups }, cash, entries] = await Promise.all([
      pendingCash(),
      cashRef.get(),
      cashbookCol.where("at", ">=", from).orderBy("at", "desc").limit(2000).get(),
    ]);
    return res.json({
      balance: cash.data()?.balance ?? 0,
      pending: groups,
      entries: entries.docs.map((d) => ({ id: d.id, ...d.data() })),
      categories: { in: CASH_IN, out: CASH_OUT, notExpense: [...NOT_EXPENSE] },
    });
  }
  if (path === "/api/cash/settle" && method === "POST") {
    const { user } = await requireRole(req, "admin");
    const body = req.body || {};
    const ids = [...new Set((Array.isArray(body.orderIds) ? body.orderIds : []).map(String))].filter((id) => /^[\w-]{1,64}$/.test(id));
    if (!ids.length) throw new HttpError(400, "Buyurtmalarni tanlang");
    const received = Math.round(Number(body.received));
    if (!(received >= 0)) throw new HttpError(400, "Qabul qilingan summani kiriting");
    const note = String(body.note || "").trim().slice(0, 300);
    const { routes } = await pendingCash();
    const result = await db.runTransaction(async (t) => {
      const [cash, ...snaps] = await t.getAll(cashRef, ...ids.map((id) => ordersCol.doc(id)));
      const orders = snaps.map((x) => ({ id: x.id, ...x.data() }));
      if (orders.some((o) => !o.cashPending)) throw new HttpError(409, "Ba'zi buyurtmalar puli allaqachon qabul qilingan, sahifani yangilang");
      const holders = new Set(orders.map((o) => cashHolder(o, routes)));
      if (holders.size !== 1) throw new HttpError(400, "Bir martada bitta odamning pulini qabul qiling");
      const holder = [...holders][0];
      const expected = orders.reduce((n, o) => n + o.cashCollected, 0);
      if (received !== expected && !note) throw new HttpError(400, `Summa farq qiladi (kutilgan ${formatSum(expected)}): izohga sababini yozing`);
      const name = holder === "store" ? "Do'kon / ombor" : (routes.get(orders[0].routeId)?.driverName ?? orders[0].handedBy ?? "—");
      const entry = bookCash(t, cash.data()?.balance ?? 0, {
        type: "in",
        category: holder === "store" ? "store" : "driver",
        holder,
        holderName: name,
        amount: received,
        expected,
        diff: received - expected,
        orderIds: ids,
        note,
        by: staffName(user),
      });
      for (const o of orders) t.update(ordersCol.doc(o.id), { cashPending: false, cashSettledAt: Date.now(), cashSettlementId: entry.id });
      return { holder, expected, count: orders.length, entry };
    });
    if (result.holder !== "store" && result.holder !== "unknown") {
      const diff = received - result.expected;
      await notifyDriver(
        result.holder,
        `✅ Kassaga ${formatSum(received)} qabul qilindi (${result.count} ta buyurtma).${diff ? `\n${diff < 0 ? "⚠️ Kamomad" : "Ortiqcha"}: ${formatSum(Math.abs(diff))}.` : ""}`,
      );
    }
    return res.json({ ok: true, balance: result.entry.next });
  }
  if (path === "/api/cash/entries" && method === "POST") {
    const { user } = await requireRole(req, "admin");
    const body = req.body || {};
    const type = body.type === "in" ? "in" : "out";
    const cats = type === "in" ? { other_in: CASH_IN.other_in } : CASH_OUT;
    const category = cats[body.category] ? body.category : null;
    if (!category || category === "refund") throw new HttpError(400, "Kategoriyani tanlang");
    const amount = Math.round(Number(body.amount));
    if (!(amount > 0 && amount <= 10_000_000_000)) throw new HttpError(400, "Summani kiriting");
    const note = String(body.note || "").trim().slice(0, 300);
    if (!note) throw new HttpError(400, "Izoh yozing: nima uchun");
    const next = await db.runTransaction(async (t) => {
      const cash = await t.get(cashRef);
      return bookCash(t, cash.data()?.balance ?? 0, { type, category, amount, note, by: staffName(user) }).next;
    });
    return res.json({ ok: true, balance: next });
  }
  return null;
}

// ---------- purchasing ("zakup"): suppliers, purchase orders, receiving ----------
// The panel suggests what to reorder from sales speed and each product's minimum; a purchase order
// goes draft → sent → partial/received. Receiving books stock in (journal note "Zakup PO-n") and
// takes the line price as the product's new cost. Payments come from the cash desk or the bank and
// leave a supplier debt until paid in full. Buying stock is not an expense: its cost reaches the
// profit report through the product cost when the goods sell.

const poNo = (p) => `PO-${p.number}`;

function cleanSupplier(input) {
  const name = String(input.name || "").trim().slice(0, 80);
  if (!name) throw new HttpError(400, "Ta'minotchi nomini kiriting");
  const lead = Math.round(Number(input.leadDays ?? 7));
  if (!(lead >= 1 && lead <= 180)) throw new HttpError(400, "Yetkazish muddati (kun) noto'g'ri");
  return {
    name,
    phone: String(input.phone || "").trim().slice(0, 40),
    contact: String(input.contact || "").trim().slice(0, 80),
    note: String(input.note || "").trim().slice(0, 300),
    leadDays: lead,
    active: input.active !== false,
    updatedAt: Date.now(),
  };
}

const poTotal = (lines) => lines.reduce((n, l) => n + l.qty * l.cost, 0);
const poPaid = (p) => (p.payments ?? []).reduce((n, x) => n + x.amount, 0);
const poView = (id, p) => ({ id, ...p, total: poTotal(p.lines), paid: poPaid(p), debt: Math.max(0, poTotal(p.lines) - poPaid(p)) });

async function handlePurchases(req, res, path, method) {
  if (path === "/api/suppliers" && method === "GET") {
    await requireRole(req, "admin");
    const snap = await suppliersCol.get();
    return res.json(snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.name.localeCompare(b.name)));
  }
  if (path === "/api/suppliers" && method === "POST") {
    await requireRole(req, "admin");
    const ref = suppliersCol.doc();
    const data = { ...cleanSupplier(req.body || {}), createdAt: Date.now() };
    await ref.set(data);
    return res.status(201).json({ id: ref.id, ...data });
  }
  const sup = path.match(/^\/api\/suppliers\/([\w-]{1,64})$/);
  if (sup && method === "PUT") {
    await requireRole(req, "admin");
    const data = cleanSupplier(req.body || {});
    await suppliersCol.doc(sup[1]).update(data);
    return res.json({ id: sup[1], ...data });
  }

  if (path === "/api/purchases" && method === "GET") {
    await requireRole(req, "admin");
    const snap = await purchasesCol.orderBy("createdAt", "desc").limit(300).get();
    return res.json(snap.docs.map((d) => poView(d.id, d.data())));
  }
  if (path === "/api/purchases" && method === "POST") {
    const { user } = await requireRole(req, "admin");
    const body = req.body || {};
    const supplier = (await suppliersCol.doc(String(body.supplierId || "-")).get()).data();
    if (!supplier) throw new HttpError(400, "Ta'minotchini tanlang");
    const raw = (Array.isArray(body.lines) ? body.lines : []).filter((l) => Math.round(Number(l.qty)) > 0);
    if (!raw.length) throw new HttpError(400, "Kamida bitta mahsulot va sonini kiriting");
    if (raw.length > 200) throw new HttpError(400, "Bitta buyurtmada 200 xildan ko'p bo'lmasin");
    const snaps = await db.getAll(...raw.map((l) => productsCol.doc(String(l.productId || "-"))));
    const lines = raw.map((l, i) => {
      const p = snaps[i].data();
      if (!p || p.kind === "kit") throw new HttpError(400, "Komplekt emas, modul yoki mahsulot tanlang");
      const qty = Math.round(Number(l.qty));
      const cost = Math.round(Number(l.cost ?? p.cost ?? 0));
      if (!(qty > 0 && qty <= 100000) || !(cost >= 0)) throw new HttpError(400, `«${p.name}»: soni yoki narxi noto'g'ri`);
      return { productId: snaps[i].id, name: p.name, sku: p.sku ?? null, qty, cost, received: 0 };
    });
    const ref = purchasesCol.doc();
    const data = await db.runTransaction(async (t) => {
      const n = ((await t.get(countersRef)).data()?.purchase ?? 0) + 1;
      const po = {
        number: n,
        supplierId: String(body.supplierId),
        supplierName: supplier.name,
        lines,
        status: "draft",
        note: String(body.note || "").trim().slice(0, 300),
        expectedAt: Date.now() + supplier.leadDays * 24 * 60 * 60 * 1000,
        payments: [],
        createdAt: Date.now(),
        createdBy: staffName(user),
      };
      t.set(countersRef, { purchase: n }, { merge: true });
      t.set(ref, po);
      return po;
    });
    return res.status(201).json(poView(ref.id, data));
  }
  const m = path.match(/^\/api\/purchases\/([\w-]{1,64})\/(send|receive|pay|cancel)$/);
  if (!m || method !== "POST") return null;
  const { user } = await requireRole(req, "admin");
  const [, id, action] = m;
  const ref = purchasesCol.doc(id);
  const by = staffName(user);
  const body = req.body || {};
  const po = await db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    const p = snap.data();
    if (!p) throw new HttpError(404, "Zakup buyurtmasi topilmadi");
    if (action === "send") {
      if (p.status !== "draft") throw new HttpError(409, "Buyurtma allaqachon yuborilgan");
      const sup = (await t.get(suppliersCol.doc(p.supplierId))).data();
      const next = { status: "sent", sentAt: Date.now(), sentBy: by, expectedAt: Date.now() + (sup?.leadDays ?? 7) * 24 * 60 * 60 * 1000 };
      t.update(ref, next);
      return { ...p, ...next };
    }
    if (action === "cancel") {
      if (!["draft", "sent"].includes(p.status) || p.lines.some((l) => l.received > 0)) throw new HttpError(409, "Qabul qilingan buyurtmani bekor qilib bo'lmaydi");
      t.update(ref, { status: "cancelled", cancelledAt: Date.now(), cancelledBy: by });
      return { ...p, status: "cancelled" };
    }
    if (action === "pay") {
      const amount = Math.round(Number(body.amount));
      const debt = poTotal(p.lines) - poPaid(p);
      if (!(amount > 0 && amount <= debt)) throw new HttpError(400, `To'lov summasi 0 dan ${formatSum(debt)} gacha bo'lsin`);
      const from = body.from === "cash" ? "cash" : "bank";
      const cash = from === "cash" ? await t.get(cashRef) : null;
      const payment = { amount, from, at: Date.now(), by, note: String(body.note || "").trim().slice(0, 200) };
      if (cash) bookCash(t, cash.data()?.balance ?? 0, { type: "out", category: "purchase", amount, note: `${poNo(p)} · ${p.supplierName}`, purchaseId: id, by });
      const payments = [...(p.payments ?? []), payment];
      t.update(ref, { payments });
      return { ...p, payments };
    }
    // receive: quantities per product, never more than ordered and still open
    if (!["sent", "partial"].includes(p.status)) throw new HttpError(409, "Avval buyurtmani yuboring (holati: yuborilgan bo'lishi kerak)");
    const want = new Map((Array.isArray(body.lines) ? body.lines : []).map((l) => [String(l.productId), Math.round(Number(l.qty))]));
    const take = p.lines.filter((l) => want.get(l.productId) > 0);
    if (!take.length) throw new HttpError(400, "Qabul qilingan sonni kiriting");
    for (const l of take) {
      if (want.get(l.productId) > l.qty - l.received) throw new HttpError(400, `«${l.name}»: buyurtmada qolgani ${l.qty - l.received} ta`);
    }
    const prodSnaps = await t.getAll(...take.map((l) => productsCol.doc(l.productId)));
    take.forEach((l, i) => {
      const product = prodSnaps[i].data();
      if (!product) throw new HttpError(404, `«${l.name}» mahsuloti o'chirilgan`);
      const qty = want.get(l.productId);
      // The latest purchase price becomes the cost the profit report uses.
      if (l.cost > 0) t.update(prodSnaps[i].ref, { cost: l.cost });
      moveStock(t, prodSnaps[i].ref, product, "in", qty, `Zakup ${poNo(p)} · ${p.supplierName}`, by);
    });
    const lines = p.lines.map((l) => ({ ...l, received: l.received + (want.get(l.productId) > 0 ? want.get(l.productId) : 0) }));
    const done = lines.every((l) => l.received >= l.qty);
    const next = { lines, status: done ? "received" : "partial", ...(done ? { receivedAt: Date.now() } : {}), lastReceivedAt: Date.now(), lastReceivedBy: by };
    t.update(ref, next);
    return { ...p, ...next };
  });
  return res.json(poView(id, po));
}

async function handleLogistics(req, res, path, method) {
  if (path === "/api/vehicles" && method === "GET") {
    await requireRole(req, "admin");
    const snap = await vehiclesCol.get();
    return res.json(snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.name.localeCompare(b.name)));
  }
  if (path === "/api/vehicles" && method === "POST") {
    await requireRole(req, "admin");
    const ref = vehiclesCol.doc();
    const data = { ...cleanVehicle(req.body || {}), createdAt: Date.now() };
    await ref.set(data);
    return res.status(201).json({ id: ref.id, ...data });
  }
  const vehicleMatch = path.match(/^\/api\/vehicles\/([\w-]{1,64})$/);
  if (vehicleMatch && (method === "PUT" || method === "DELETE")) {
    await requireRole(req, "admin");
    const ref = vehiclesCol.doc(vehicleMatch[1]);
    if (method === "DELETE") {
      await ref.delete();
      return res.json({ ok: true });
    }
    const data = cleanVehicle(req.body || {});
    await ref.update(data);
    return res.json({ id: ref.id, ...data });
  }

  if (path === "/api/logistics" && method === "GET") {
    await requireRole(req, "admin");
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date)) ? String(req.query.date) : todayKey();
    const [orderSnap, routeSnap, vehicleSnap, driverSnap, weights, settings] = await Promise.all([
      ordersCol.where("deliverySlot", ">=", `${date}_`).where("deliverySlot", "<", `${date}_~`).get(),
      routesCol.where("date", "==", date).get(),
      vehiclesCol.get(),
      staffCol.where("role", "==", "driver").get(),
      productWeights(),
      deliverySettings(),
    ]);
    const orders = orderSnap.docs
      .map((d) => stopView(d.id, d.data(), weights))
      .filter((o) => o.status !== "cancelled" && o.stage !== null)
      .sort((a, b) => a.deliverySlot.localeCompare(b.deliverySlot));
    // Stops sent back to the warehouse lost their slot, so the day query misses them; the route
    // cards still list them, marked as not delivered.
    const known = new Set(orders.map((o) => o.id));
    const missing = routeSnap.docs.flatMap((d) => d.data().orderIds).filter((id) => !known.has(id));
    const back = missing.length ? await db.getAll(...missing.map((id) => ordersCol.doc(id))) : [];
    const returned = back.filter((x) => x.exists).map((x) => stopView(x.id, x.data(), weights));
    return res.json({
      date,
      dateLabel: dayLabel(new Date(`${date}T00:00:00Z`)),
      warehouse: settings.warehouse,
      orders,
      returned,
      routes: routeSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.createdAt - b.createdAt),
      vehicles: vehicleSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
      drivers: driverSnap.docs.map((d) => ({ id: d.id, name: d.data().name, username: d.data().username, employment: d.data().employment ?? null, cashAllowed: d.data().cashAllowed === true, vehicleId: d.data().vehicleId ?? null })),
    });
  }

  if (path === "/api/routes" && method === "POST") {
    const { user } = await requireRole(req, "admin");
    const body = req.body || {};
    const ids = [...new Set((Array.isArray(body.orderIds) ? body.orderIds : []).map(String))].filter((id) => /^[\w-]{1,64}$/.test(id));
    if (!ids.length) throw new HttpError(400, "Reysga kamida bitta buyurtma tanlang");
    if (ids.length > ROUTE_MAX_STOPS) throw new HttpError(400, `Bitta reysda ${ROUTE_MAX_STOPS} tadan ko'p manzil bo'lmasin`);
    const settings = await deliverySettings();
    const ref = routesCol.doc();
    const route = await db.runTransaction(async (t) => {
      const [vehicle, driver, ...snaps] = await t.getAll(
        vehiclesCol.doc(String(body.vehicleId || "-")),
        staffCol.doc(String(body.driverId || "-")),
        ...ids.map((id) => ordersCol.doc(id)),
      );
      if (!vehicle.exists || vehicle.data().active === false) throw new HttpError(400, "Mashinani tanlang");
      if (!driver.exists || driver.data().role !== "driver") throw new HttpError(400, "Haydovchini tanlang");
      const orders = snaps.map((x) => {
        if (!x.exists) throw new HttpError(404, "Buyurtma topilmadi");
        return { id: x.id, ...x.data() };
      });
      const date = slotDate(orders[0]);
      for (const o of orders) {
        if (o.orderType !== "delivery" || o.status === "cancelled" || !["new", "picking", "ready"].includes(o.stage)) {
          throw new HttpError(409, `${ORDER_LABEL(o)} ni reysga qo'shib bo'lmaydi: u yo'lda yoki yopilgan`);
        }
        if (!date || slotDate(o) !== date) throw new HttpError(400, "Reysdagi hamma buyurtma bitta kunga tegishli bo'lsin");
        if (o.routeId) throw new HttpError(409, `${ORDER_LABEL(o)} boshqa reysda bor`);
      }
      const cashOrders = orders.filter((o) => amountDue(o) > 0);
      if (cashOrders.length && driver.data().cashAllowed !== true) {
        throw new HttpError(409, `${driver.data().name} naqd pul ololmaydi (HR ruxsati yo'q): ${cashOrders.map(ORDER_LABEL).join(", ")} naqd to'lovli. Ularni naqd ruxsati bor haydovchiga biriktiring`);
      }
      const stops = orderStops(settings.warehouse, orders);
      const v = vehicle.data();
      const data = {
        date,
        driverId: driver.id,
        driverName: driver.data().name,
        vehicleId: vehicle.id,
        vehicleName: [v.name, v.plate].filter(Boolean).join(" · "),
        orderIds: stops.map((o) => o.id),
        km: routeKm(settings.warehouse, stops),
        status: "planned",
        createdAt: Date.now(),
        createdBy: staffName(user),
      };
      t.set(ref, data);
      for (const o of orders) t.update(ordersCol.doc(o.id), { routeId: ref.id });
      return data;
    });
    await notifyDriver(route.driverId, `🚚 Sizga yangi reys: ${dayLabel(new Date(`${route.date}T00:00:00Z`))}, ${route.orderIds.length} ta manzil, ${route.vehicleName}.`, {
      reply_markup: { inline_keyboard: [[{ text: "📋 Reysni ko'rish", callback_data: "dr:list" }]] },
    });
    return res.status(201).json({ id: ref.id, ...route });
  }
  const routeMatch = path.match(/^\/api\/routes\/([\w-]{1,64})$/);
  if (routeMatch && method === "DELETE") {
    await requireRole(req, "admin");
    const ref = routesCol.doc(routeMatch[1]);
    await db.runTransaction(async (t) => {
      const snap = await t.get(ref);
      if (!snap.exists) throw new HttpError(404, "Reys topilmadi");
      if (snap.data().status !== "planned") throw new HttpError(409, "Boshlangan reysni bekor qilib bo'lmaydi");
      const orders = await t.getAll(...snap.data().orderIds.map((id) => ordersCol.doc(id)));
      for (const o of orders) if (o.exists && o.data().routeId === ref.id) t.update(o.ref, { routeId: null });
      t.delete(ref);
    });
    return res.json({ ok: true });
  }

  if (path === "/api/driver/routes" && method === "GET") {
    const { user } = await requireDriver(req);
    return res.json(await driverRoutes(user));
  }
  const startMatch = path.match(/^\/api\/driver\/routes\/([\w-]{1,64})\/start$/);
  if (startMatch && method === "POST") {
    const { user } = await requireDriver(req);
    await startRoute(startMatch[1], user);
    return res.json(await driverRoutes(user));
  }
  const stopMatch = path.match(/^\/api\/driver\/stops\/([\w-]{1,64})\/(handed|failed|card)$/);
  if (stopMatch && method === "POST") {
    const { user } = await requireDriver(req);
    const [, id, action] = stopMatch;
    const act = { handed: handOver, failed: failStop, card: requestCardDue }[action];
    await act(id, user, req.body || {});
    return res.json(await driverRoutes(user));
  }
  return null;
}

// Built once all helpers exist; the module only reaches the rest of the backend through this object.
const masters = createMasters({
  db,
  HttpError,
  tg,
  callTelegram,
  logger,
  MASTER_BOT_TOKEN,
  WEBAPP_URL,
  UZS_MINOR,
  ordersCol,
  countersRef,
  hmac: (key, text) => createHmac("sha256", key).update(text).digest("hex"),
  sameSecret,
  saveBotPhoto,
  uuid: randomUUID,
  increment: (n) => FieldValue.increment(n),
  adminIds: () => idList(ADMIN_IDS.value()),
  formatSum,
  providerToken,
  ordersChat,
  requireRole,
  authenticate,
  staffName,
});

const hr = createHr({
  db,
  HttpError,
  tg,
  logger,
  parseLocation,
  warehouse: async () => (await deliverySettings()).warehouse,
  // Straight-line metres for the check-in fence (distanceKm adds the road factor for pricing).
  distanceM: (a, b) => (distanceKm(a, b) / ROAD_FACTOR) * 1000,
  saveBotPhoto,
  driverToken: () => DRIVER_BOT_TOKEN.value(),
  uuid: randomUUID,
  adminIds: () => idList(ADMIN_IDS.value()),
  staffCol,
  ordersCol,
  requireRole,
  staffName,
  botUsername: getBotUsername,
  cashRef,
  bookCash,
  formatSum,
  notifyDriver,
});

async function route(req, res) {
  const path = req.path;
  const method = req.method;

  if (path === "/api/telegram" && method === "POST") return handleTelegramUpdate(req, res);
  if (path === "/api/driverbot" && method === "POST") return handleDriverBot(req, res);
  if (path === "/api/masterbot" && method === "POST") return masters.handleMasterBot(req, res);
  if (path.startsWith("/api/hr/")) {
    const handled = await hr.handleApi(req, res, path, method);
    if (handled !== null) return handled;
  }
  if (path.startsWith("/api/assembly") || path.startsWith("/api/masters") || path.startsWith("/api/master-applications")) {
    const handled = await masters.handleApi(req, res, path, method);
    if (handled !== null) return handled;
  }
  if (path.startsWith("/api/suppliers") || path.startsWith("/api/purchases")) {
    const handled = await handlePurchases(req, res, path, method);
    if (handled !== null) return handled;
  }
  if (path.startsWith("/api/cash")) {
    const handled = await handleCash(req, res, path, method);
    if (handled !== null) return handled;
  }
  if (path.startsWith("/api/complaints") || /^\/api\/orders\/[\w-]+\/complaint$/.test(path)) {
    const handled = await handleComplaints(req, res, path, method);
    if (handled !== null) return handled;
  }
  if (path.startsWith("/api/driver-applications") || /^\/api\/staff\/\d+\/trust$/.test(path)) {
    const handled = await handleHr(req, res, path, method);
    if (handled !== null) return handled;
  }
  if (path === "/api/setup" && method === "GET") return handleSetup(res);

  if (path === "/api/config" && method === "GET") {
    const { user, role } = await authenticate(req);
    return res.json({ categories: CATEGORIES, role, user, cardPayments: cardsEnabled() });
  }

  if (path === "/api/products" && method === "GET") {
    const staff = req.query.all === "1" && (await isStaffRequest(req));
    const admin = staff && (await authenticate(req)).role === "admin";
    return res.json((await listProducts({ staff })).map((p) => (admin ? p : withoutCost(p))));
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

  if (path === "/api/products/import" && method === "POST") {
    const { user } = await requireRole(req, "admin");
    const body = req.body || {};
    return res.json(await importProducts(body.rows, { apply: body.apply === true, actor: staffName(user) }));
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
      const product = { id: snap.id, ...snap.data() };
      return res.json((await authenticate(req)).role === "admin" ? product : withoutCost(product));
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
    const role = req.body?.role === "driver" ? "driver" : "warehouse";
    await invitesCol.doc(code).set({ role, createdBy: user.id, createdAt: Date.now(), expiresAt });
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

  if (path === "/api/delivery/quote" && method === "POST") {
    const body = req.body || {};
    // The unloading part depends on the cart: weigh it from the catalog, not from the client.
    const items = (Array.isArray(body.items) ? body.items : []).slice(0, 100);
    return res.json(quoteDelivery(await deliverySettings(), body, await cartWeight(items)));
  }

  if (path === "/api/crm/segments") {
    await requireRole(req, "admin");
    if (method === "GET") return res.json(await segmentSettings());
    if (method === "PUT") {
      const next = cleanSegmentSettings(req.body || {});
      await segmentsRef.set(next);
      return res.json(next);
    }
  }

  if (path === "/api/delivery/settings") {
    await requireRole(req, "admin");
    if (method === "GET") return res.json(await deliverySettings());
    if (method === "PUT") {
      // Merge over the stored rates: the mini app sheet edits only some of them.
      const next = cleanDeliverySettings({ ...(await deliverySettings()), ...(req.body || {}) });
      await deliveryRef.set(next);
      return res.json(next);
    }
  }

  if (path === "/api/orders" && method === "GET") {
    await requireRole(req, "admin");
    // `from` (ms) asks for a period, as reports do; without it the latest orders come back.
    const from = Number(req.query.from);
    const query = Number.isFinite(from) && from > 0
      ? ordersCol.where("createdAt", ">=", from).orderBy("createdAt", "desc").limit(ORDER_REPORT_LIMIT)
      : ordersCol.orderBy("createdAt", "desc").limit(ORDER_LIST_LIMIT);
    const snap = await query.get();
    return res.json(snap.docs.map((d) => orderSummary(d.id, d.data())));
  }

  if (path === "/api/admin/login-code" && method === "POST") {
    const { user } = await requireRole(req, "admin");
    return res.status(201).json(await createAdminLogin(user));
  }
  if (path === "/api/admin/session" && method === "POST") {
    return res.status(201).json(await redeemAdminLogin(String(req.body?.code || "").replace(/[^a-f0-9]/g, "")));
  }
  if (path === "/api/admin/logout" && method === "POST") {
    const token = req.get("x-admin-token");
    if (token && token.length >= 32) await adminSessionsCol.doc(tokenId(token)).delete();
    return res.json({ ok: true });
  }
  if (path === "/api/admin/info" && method === "GET") {
    await requireRole(req, "admin");
    return res.json({
      project: PROJECT_ID,
      webapp: WEBAPP_URL,
      bot: await getBotUsername().catch(() => null),
      admins: idList(ADMIN_IDS.value()).length,
      ordersChat: idList(ORDERS_CHAT_ID.value()).length > 0,
      cardPayments: cardsEnabled(),
      slots: { capacity: SLOT_CAPACITY, windows: DELIVERY_WINDOWS, daysAhead: SLOT_DAYS_AHEAD },
      prepDays: PREP_WORKING_DAYS,
      categories: CATEGORIES,
    });
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

  const orderMatch = path.match(/^\/api\/orders\/([\w-]{1,64})(?:\/(buyer-cancel|admin-cancel|reject-cancel|refunded|retry-delivery))?$/);
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
    // After the attempts ran out and the buyer was reached: offer the calendar once more.
    if (action === "retry-delivery" && method === "POST") {
      const ref = ordersCol.doc(id);
      const o = (await ref.get()).data();
      if (!o?.deliveryHold || o.stage !== "ready") throw new HttpError(409, "Bu buyurtma qayta yetkazishni kutmayapti");
      await ref.update({ deliveryHold: false, readyAt: Date.now(), slotReminders: 0, slotEscalatedAt: null });
      if (o.telegramUserId) {
        await tg("sendMessage", {
          chat_id: o.telegramUserId,
          text: `🚚 Buyurtmangiz ${ORDER_LABEL(o)} ni qayta yetkazamiz. Qulay vaqtni tanlang:`,
          reply_markup: await slotKeyboard(id),
        }).catch((err) => logger.warn("retry notice failed", err));
      }
      return res.json(orderDetail(id, { ...o, deliveryHold: false }));
    }
    if (action === "refunded" && method === "POST") {
      const ref = ordersCol.doc(id);
      const o = await db.runTransaction(async (t) => {
        const [snap, cash] = await t.getAll(ref, cashRef);
        const order = snap.data();
        if (order?.refund?.status !== "pending") throw new HttpError(409, "Qaytariladigan to'lov yo'q");
        const refund = { ...order.refund, status: "done", doneAt: Date.now(), doneBy: by };
        // Card refunds go back through the bank; cash ones are paid out of the desk.
        if (order.payment === "cash") {
          bookCash(t, cash.data()?.balance ?? 0, { type: "out", category: "refund", amount: refund.amount, orderIds: [id], note: `${ORDER_LABEL(order)} ${refund.reason ?? ""}`.trim(), by });
        }
        t.update(ref, { refund });
        return { ...order, refund };
      });
      if (o.telegramUserId) {
        const how = o.payment === "cash" ? "naqd qaytarildi" : "kartangizga qaytarildi";
        await tg("sendMessage", { chat_id: o.telegramUserId, text: `💳 ${ORDER_LABEL(o)}: ${formatSum(o.refund.amount)} ${how}.` }).catch(() => {});
      }
      return res.json(orderDetail(id, o));
    }
  }

  if (path.startsWith("/api/fulfillment") || path.startsWith("/api/screens")) {
    const handled = await handleFulfillment(req, res, path, method);
    if (handled !== null) return handled;
  }
  if (path.startsWith("/api/vehicles") || path.startsWith("/api/routes") || path.startsWith("/api/driver/") || path === "/api/logistics") {
    const handled = await handleLogistics(req, res, path, method);
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
    secrets: [BOT_TOKEN, PAYMENT_PROVIDER_TOKEN, DRIVER_BOT_TOKEN, MASTER_BOT_TOKEN],
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

// Ready delivery orders without a chosen window: remind the buyer, then note it for the team.
export const remindSlots = onSchedule(
  { schedule: "every 60 minutes", region: REGION, secrets: [BOT_TOKEN] },
  async () => {
    const now = Date.now();
    const snap = await ordersCol.where("stage", "==", "ready").get();
    for (const doc of snap.docs) {
      const o = doc.data();
      if (o.orderType !== "delivery" || o.deliverySlot || !o.telegramUserId || o.deliveryHold) continue;
      const sent = o.slotReminders ?? 0;
      try {
        if (!o.slotEscalatedAt && o.readyAt < now - SLOT_ESCALATE_MS) {
          await tg("sendMessage", { chat_id: ordersChat(), text: `⏳ ${ORDER_LABEL(o)}: mijoz 3 kundan beri yetkazish vaqtini tanlamadi (2 marta eslatildi). Mebel omborda turibdi.` });
          await doc.ref.update({ slotEscalatedAt: now });
        } else if (sent < SLOT_REMINDERS_MS.length && o.readyAt < now - SLOT_REMINDERS_MS.at(sent)) {
          await tg("sendMessage", {
            chat_id: o.telegramUserId,
            text: `🔔 Mebelingiz ${ORDER_LABEL(o)} omborda tayyor turibdi. Yetkazish vaqtini tanlang:`,
            reply_markup: await slotKeyboard(doc.id),
          });
          await doc.ref.update({ slotReminders: sent + 1 });
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
    const handedCutoff = Date.now() - HANDED_CLOSE_MS;
    const snap = await ordersCol.where("stage", "==", "shipped").get();
    for (const doc of snap.docs) {
      const { stageAt, handedAt, routeId } = doc.data();
      // On a route only the driver's hand-over counts: an open stop waits for the driver, not the clock.
      if (routeId && !handedAt) continue;
      if (stageAt >= cutoff && !(handedAt && handedAt < handedCutoff)) continue;
      await setStage(doc.id, ["shipped"], "delivered", { autoClosed: true }).catch((err) => logger.warn("auto close failed", err));
    }
  },
);
