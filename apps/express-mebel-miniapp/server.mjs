// Express Mebel — Telegram Mini App server.
// Zero dependencies: Node 20+ (http, fs, crypto, global fetch).
//
// Env:
//   PORT          HTTP port (default 3000)
//   BOT_TOKEN     Telegram bot token from @BotFather (enables bot + initData auth)
//   WEBAPP_URL    Public HTTPS URL of this server (shown as Web App button)
//   ADMIN_IDS     Comma-separated Telegram user ids allowed to manage products and stock
//   WAREHOUSE_IDS Comma-separated Telegram user ids of warehouse staff (stock in/out only)
//   ADMIN_TOKEN   Optional password for managing products from a normal browser
//   ORDERS_CHAT_ID Chat id that receives new orders (default: first ADMIN_IDS entry)

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
const DATA_DIR = process.env.DATA_DIR || join(ROOT, "data");
const UPLOAD_DIR = join(DATA_DIR, "uploads");
const DB_FILE = join(DATA_DIR, "products.json");
const STOCK_FILE = join(DATA_DIR, "stock-movements.json");
const SEED_FILE = join(ROOT, "seed-products.json");

const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const WEBAPP_URL = process.env.WEBAPP_URL || "";
const idList = (value) =>
  (value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const ADMIN_IDS = idList(process.env.ADMIN_IDS);
const WAREHOUSE_IDS = idList(process.env.WAREHOUSE_IDS);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const ORDERS_CHAT_ID = process.env.ORDERS_CHAT_ID || ADMIN_IDS[0] || "";

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

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

// ---------- storage ----------

mkdirSync(UPLOAD_DIR, { recursive: true });
if (!existsSync(DB_FILE)) {
  writeFileSync(DB_FILE, existsSync(SEED_FILE) ? readFileSync(SEED_FILE) : "[]");
}
if (!existsSync(STOCK_FILE)) writeFileSync(STOCK_FILE, "[]");
let products = JSON.parse(readFileSync(DB_FILE, "utf8"));
let movements = JSON.parse(readFileSync(STOCK_FILE, "utf8"));
let saving = Promise.resolve();

// Writes are queued so products and the stock journal land on disk in mutation order.
function persist() {
  const productsSnapshot = JSON.stringify(products, null, 2);
  const movementsSnapshot = JSON.stringify(movements, null, 2);
  saving = saving.then(() =>
    Promise.all([writeFile(DB_FILE, productsSnapshot), writeFile(STOCK_FILE, movementsSnapshot)]),
  );
  return saving;
}

// Stock types: "in" (kirim), "out" (chiqim), "sale" (buyurtma). Callers validate before calling;
// the check and the decrement run synchronously so two orders cannot oversell the last unit.
function moveStock(product, type, qty, note, by) {
  product.stock += type === "in" ? qty : -qty;
  product.updatedAt = Date.now();
  const movement = {
    id: randomUUID(),
    productId: product.id,
    productName: product.name,
    type,
    qty,
    balance: product.stock,
    note: String(note || "").slice(0, 200),
    by: by || "—",
    at: Date.now(),
  };
  movements.push(movement);
  return movement;
}

const staffName = (user) =>
  user ? [user.first_name, user.last_name].filter(Boolean).join(" ") || String(user.id) : "Admin";

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
    ? (input.images ?? existing.images).map(String).filter((s) => s.startsWith("/")).slice(0, 8)
    : [];
  return {
    id: existing.id || randomUUID(),
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

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- Telegram auth ----------

// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
function verifyInitData(initData) {
  if (!BOT_TOKEN || !initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const expected = createHmac("sha256", secret).update(dataCheckString).digest("hex");
  if (expected.length !== hash.length) return null;
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(hash))) return null;
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
  const user = verifyInitData(req.headers["x-telegram-init-data"]);
  const token = req.headers["x-admin-token"];
  const isAdmin =
    (user && ADMIN_IDS.includes(String(user.id))) ||
    Boolean(ADMIN_TOKEN && typeof token === "string" && sameSecret(token, ADMIN_TOKEN));
  const role = isAdmin ? "admin" : user && WAREHOUSE_IDS.includes(String(user.id)) ? "warehouse" : null;
  return { user, role };
}

function requireRole(req, ...roles) {
  const auth = authenticate(req);
  if (!roles.includes(auth.role)) throw new HttpError(403, "Ruxsat yo'q");
  return auth;
}

// ---------- Telegram Bot API ----------

async function tg(method, body) {
  if (!BOT_TOKEN) return null;
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${method}: ${json.description}`);
  return json.result;
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const formatSum = (n) => `${Math.round(n).toLocaleString("ru-RU").replace(/,/g, " ")} so'm`;

async function botLoop() {
  if (!BOT_TOKEN) return;
  if (WEBAPP_URL) {
    await tg("setChatMenuButton", {
      menu_button: { type: "web_app", text: "Katalog", web_app: { url: WEBAPP_URL } },
    }).catch((err) => console.error("[bot] menu button:", err.message));
  }
  let offset = 0;
  for (;;) {
    try {
      const updates = await tg("getUpdates", { offset, timeout: 50, allowed_updates: ["message"] });
      for (const u of updates) {
        offset = u.update_id + 1;
        const msg = u.message;
        if (!msg?.text?.startsWith("/start")) continue;
        await tg("sendMessage", {
          chat_id: msg.chat.id,
          parse_mode: "HTML",
          text:
            "Assalomu alaykum! 👋\n\n<b>Express Mebel</b> — sifatli mebel tez yetkazib beriladi.\n" +
            "Katalogni ochish uchun quyidagi tugmani bosing.",
          reply_markup: WEBAPP_URL
            ? { inline_keyboard: [[{ text: "🛋 Katalogni ochish", web_app: { url: WEBAPP_URL } }]] }
            : undefined,
        });
      }
    } catch (err) {
      console.error("[bot]", err.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

// ---------- reverse geocoding ----------

// OpenStreetMap Nominatim usage policy: identify the app and stay at <= 1 request/second.
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

function parseLocation(value) {
  if (!value) return null;
  const lat = Number(value.lat);
  const lon = Number(value.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw new HttpError(400, "Joylashuv noto'g'ri");
  }
  return { lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6 };
}

// ---------- HTTP ----------

async function readBody(req, limit = 12 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "Fayl juda katta");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, "JSON noto'g'ri");
  }
}

function send(res, status, data) {
  res.writeHead(status, { "content-type": MIME[".json"], "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}

async function serveFile(res, baseDir, relPath, cache) {
  const filePath = normalize(join(baseDir, relPath));
  if (!filePath.startsWith(baseDir + sep)) throw new HttpError(404, "Topilmadi");
  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      "content-type": MIME[extname(filePath).toLowerCase()] || "application/octet-stream",
      "cache-control": cache,
    });
    res.end(body);
  } catch {
    throw new HttpError(404, "Topilmadi");
  }
}

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  if (pathname === "/api/config" && method === "GET") {
    const { user, role } = authenticate(req);
    return send(res, 200, { categories: CATEGORIES, role, user });
  }

  if (pathname === "/api/products" && method === "GET") {
    const sorted = [...products].sort((a, b) => b.createdAt - a.createdAt);
    return send(res, 200, sorted);
  }

  if (pathname === "/api/products" && method === "POST") {
    const { user } = requireRole(req, "admin");
    const body = await readBody(req);
    const product = cleanProduct(body);
    products.push(product);
    const initial = Math.floor(Number(body.stock));
    if (initial > 0) moveStock(product, "in", Math.min(initial, 100000), "Boshlang'ich qoldiq", staffName(user));
    await persist();
    return send(res, 201, product);
  }

  const match = pathname.match(/^\/api\/products\/([\w-]+)$/);
  if (match) {
    const index = products.findIndex((p) => p.id === match[1]);
    if (index === -1) throw new HttpError(404, "Mahsulot topilmadi");
    if (method === "GET") return send(res, 200, products[index]);
    requireRole(req, "admin");
    if (method === "PUT") {
      products[index] = cleanProduct(await readBody(req), products[index]);
      await persist();
      return send(res, 200, products[index]);
    }
    if (method === "DELETE") {
      products.splice(index, 1);
      await persist();
      return send(res, 200, { ok: true });
    }
  }

  if (pathname === "/api/upload" && method === "POST") {
    requireRole(req, "admin");
    const { dataUrl } = await readBody(req);
    const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(String(dataUrl || ""));
    if (!m) throw new HttpError(400, "Faqat JPG, PNG yoki WEBP rasm");
    const ext = m[1] === "jpeg" ? "jpg" : m[1];
    const name = `${randomUUID()}.${ext}`;
    await writeFile(join(UPLOAD_DIR, name), Buffer.from(m[2], "base64"));
    return send(res, 201, { url: `/uploads/${name}` });
  }

  if (pathname === "/api/geocode" && method === "GET") {
    const loc = parseLocation({ lat: url.searchParams.get("lat"), lon: url.searchParams.get("lon") });
    if (!loc) throw new HttpError(400, "Joylashuv yo'q");
    try {
      return send(res, 200, { address: await reverseGeocode(loc.lat, loc.lon) });
    } catch (err) {
      console.error("[geocode]", err.message);
      throw new HttpError(502, "Manzilni aniqlab bo'lmadi, qo'lda yozing");
    }
  }

  if (pathname === "/api/stock" && method === "GET") {
    requireRole(req, "admin", "warehouse");
    const productId = url.searchParams.get("productId");
    const list = productId ? movements.filter((m) => m.productId === productId) : movements;
    return send(res, 200, list.slice(-100).reverse());
  }

  if (pathname === "/api/stock" && method === "POST") {
    const { user } = requireRole(req, "admin", "warehouse");
    const body = await readBody(req);
    const product = products.find((p) => p.id === body.productId);
    if (!product) throw new HttpError(404, "Mahsulot topilmadi");
    if (body.type !== "in" && body.type !== "out") throw new HttpError(400, "Amal turi noto'g'ri");
    const qty = Number(body.qty);
    if (!Number.isInteger(qty) || qty <= 0 || qty > 100000) throw new HttpError(400, "Miqdor noto'g'ri");
    if (body.type === "out" && qty > product.stock) {
      throw new HttpError(400, `Omborda faqat ${product.stock} ta bor`);
    }
    const movement = moveStock(product, body.type, qty, body.note, staffName(user));
    await persist();
    return send(res, 201, { product, movement });
  }

  if (pathname === "/api/orders" && method === "POST") {
    const { user } = authenticate(req);
    const body = await readBody(req);
    const items = (Array.isArray(body.items) ? body.items : [])
      .map((it) => ({ product: products.find((p) => p.id === it.id), qty: Math.max(1, Math.min(99, Number(it.qty) | 0)) }))
      .filter((it) => it.product);
    if (!items.length) throw new HttpError(400, "Savat bo'sh");
    const phone = String(body.phone || "").trim();
    const location = body.orderType === "pickup" ? null : parseLocation(body.location);
    if (!/^\+?[\d\s()-]{7,20}$/.test(phone)) throw new HttpError(400, "Telefon raqam noto'g'ri");
    const short = items.find((it) => it.qty > it.product.stock);
    if (short) {
      throw new HttpError(
        409,
        short.product.stock
          ? `«${short.product.name}» omborda faqat ${short.product.stock} ta qoldi`
          : `«${short.product.name}» tugadi`,
      );
    }
    const buyer = user ? staffName(user) : String(body.name || "Mijoz").slice(0, 60);
    for (const it of items) moveStock(it.product, "sale", it.qty, "Buyurtma", buyer);
    await persist();
    const total = items.reduce((sum, it) => sum + it.product.price * it.qty, 0);
    const lines = items.map(
      (it) => `• ${escapeHtml(it.product.name)} × ${it.qty} = ${formatSum(it.product.price * it.qty)}`,
    );
    const who = user
      ? `${escapeHtml([user.first_name, user.last_name].filter(Boolean).join(" "))}${user.username ? ` (@${escapeHtml(user.username)})` : ""}`
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
        .filter((it) => it.product.stock <= 3)
        .map((it) =>
          it.product.stock
            ? `⚠️ «${escapeHtml(it.product.name)}» omborda ${it.product.stock} ta qoldi`
            : `⛔️ «${escapeHtml(it.product.name)}» tugadi — saytda sotuvdan chiqdi`,
        ),
    ]
      .filter((l) => l !== "")
      .join("\n");
    if (ORDERS_CHAT_ID) {
      const sent = await tg("sendMessage", { chat_id: ORDERS_CHAT_ID, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } });
      // A native location pin lets the courier open navigation straight from the chat.
      if (location) {
        await tg("sendLocation", {
          chat_id: ORDERS_CHAT_ID,
          latitude: location.lat,
          longitude: location.lon,
          reply_parameters: { message_id: sent.message_id },
        });
      }
    }
    else console.log("[order]\n" + text.replace(/<[^>]+>/g, ""));
    if (user) {
      await tg("sendMessage", {
        chat_id: user.id,
        parse_mode: "HTML",
        text: `✅ Buyurtmangiz qabul qilindi!\n\n${lines.join("\n")}\n\n<b>Jami:</b> ${formatSum(total)}\n\nTez orada operatorimiz siz bilan bog'lanadi.`,
      }).catch(() => {});
    }
    return send(res, 201, { ok: true, total });
  }

  throw new HttpError(404, "Topilmadi");
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    if (url.pathname.startsWith("/uploads/")) {
      return await serveFile(res, UPLOAD_DIR, url.pathname.slice("/uploads/".length), "public, max-age=31536000, immutable");
    }
    const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    return await serveFile(res, PUBLIC_DIR, rel, "no-cache");
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) send(res, status, { error: err.message || "Xatolik" });
  }
});

server.listen(PORT, () => {
  console.log(`Express Mebel mini app: http://localhost:${PORT}`);
  if (!BOT_TOKEN) console.log("BOT_TOKEN not set: bot and Telegram admin auth are disabled.");
  botLoop();
});
