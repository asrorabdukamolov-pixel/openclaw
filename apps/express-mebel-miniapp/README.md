# Express Mebel — Telegram Mini App

Mebel do'koni uchun Telegram mini ilova: katalog, savat, buyurtma va mahsulotlarni boshqarish (admin panel).
Ranglar va shriftlar Express Mebel brendbukidan olingan:

| Token | Rang | Brendbuk |
| --- | --- | --- |
| Aksent (dengiz to'lqini) | `#008E9B` | PANTONE 2230 CP |
| Asosiy to'q kulrang | `#2B2A29` | PANTONE P 179-16 C |
| Bazaviy to'q kulrang | `#303030` | PANTONE 426 |
| Oq | `#FFFFFF` | — |

Shriftlar: **Prompt Italic** (sarlavhalar, lotin) va **Montserrat** (asosiy matn). Bannerlarda brend-motiv — uchta qiya chiziq.

Bo'limlar: **Oshxona, Shkaf, Tumba, Parta, Pufik, Krovat**.

## Imkoniyatlar

- FeedUp uslubidagi bosh sahifa: profil rasmi, "Buyurtma turi", menyu, bannerlar, qidiruv, yopishqoq bo'lim tablari, 2 ustunli mahsulot kartalari ("Yangi" belgisi, chegirma %, eski narx, `+` tugmasi).
- Mahsulot sahifasi (bir nechta rasm, o'lcham, material, tavsif), savat, buyurtma (yetkazib berish / olib ketish).
- Buyurtma admin chatiga Telegram bot orqali yuboriladi, mijozga tasdiq xabari boradi.
- **Admin panel**: mahsulot qo'shish / tahrirlash / o'chirish, telefondan rasm yuklash (avtomatik siqiladi), narx, eski narx, "Yangi" belgisi.
- **Ombor (tayyor mahsulot ombori)**: har bir mahsulotning qoldig'i, kirim / chiqim, harakatlar tarixi (kim, qachon, nechta, izoh).
  Buyurtma tushganda qoldiq avtomatik kamayadi; qoldiq 0 bo'lsa mahsulot saytda "Sotuvda yo'q" bo'ladi va uni sotib olib bo'lmaydi.
  Mijoz ombordagidan ko'p miqdorni savatga qo'sha olmaydi.

## Ishga tushirish

Hech qanday paket o'rnatish shart emas (Node.js 20+).

```bash
cd apps/express-mebel-miniapp
BOT_TOKEN=123456:ABC... \
WEBAPP_URL=https://sizning-domen.uz \
ADMIN_IDS=111111111,222222222 \
node server.mjs
```

| O'zgaruvchi | Vazifasi |
| --- | --- |
| `BOT_TOKEN` | @BotFather bergan token. Bot `/start` ga katalog tugmasi bilan javob beradi va menyu tugmasini o'rnatadi. |
| `WEBAPP_URL` | Serverning ochiq **HTTPS** manzili (Telegram faqat HTTPS qabul qiladi). |
| `ADMIN_IDS` | Mahsulotlarni va omborni boshqara oladigan Telegram user id lar (vergul bilan). Id ni @userinfobot dan bilish mumkin. |
| `WAREHOUSE_IDS` | Ombor xodimlari: faqat kirim / chiqim kiritadi, mahsulot va narxni o'zgartira olmaydi. |
| `ORDERS_CHAT_ID` | Buyurtmalar keladigan chat (ixtiyoriy, standart — birinchi admin). |
| `ADMIN_TOKEN` | Ixtiyoriy parol: oddiy brauzerda `https://domen/?admin=PAROL` ochib admin panelga kirish. |
| `PORT` | Port (standart `3000`). |
| `DATA_DIR` | Mahsulotlar va rasmlar saqlanadigan papka (standart `./data`). |

### Bot sozlash

1. @BotFather → `/newbot` → token oling.
2. Serverni HTTPS domen ortida ishga tushiring (masalan Nginx + Let's Encrypt, Railway, Render, VPS).
3. @BotFather → `/mybots` → bot → *Bot Settings* → *Configure Mini App* → `WEBAPP_URL` ni kiriting (ixtiyoriy, server menyu tugmasini o'zi ham o'rnatadi).
4. Botga `/start` yozing → "Katalogni ochish".

### Ombor

Menyuda **📦 Ombor** (admin va ombor xodimlariga ko'rinadi):

1. Ro'yxatda mahsulotlar qoldiq bo'yicha tartiblangan: tugaganlar (qizil) va kam qolganlar (≤ 3, sariq) tepada.
2. Mahsulotni bosing → **＋ Kirim** yoki **− Chiqim** → miqdor va izoh → saqlang.
3. Har bir harakat jurnalga yoziladi: Kirim, Chiqim, Sotuv (buyurtmadan avtomatik).

Yangi mahsulot qo'shishda "Boshlang'ich qoldiq" kiritiladi; keyin qoldiq faqat ombor orqali o'zgaradi.
Buyurtmadan keyin mahsulot tugasa yoki 3 tadan kam qolsa, admin chatiga kelgan buyurtma xabarida ogohlantirish bo'ladi.

Jurnal `data/stock-movements.json` faylida saqlanadi.

### Mahsulot qo'shish

Admin (`ADMIN_IDS` dagi foydalanuvchi) mini ilovani ochganda menyuda **⚙️ Mahsulotlarni boshqarish** paydo bo'ladi
(profil rasmini bosish ham admin panelni ochadi). U yerda **＋ Yangi mahsulot qo'shish** → rasmlar, nom, bo'lim, narx → **Saqlash**.

Ma'lumotlar `data/products.json` da, rasmlar `data/uploads/` da saqlanadi — server qayta ishga tushganda ham yo'qolmaydi.
Birinchi ishga tushishda namunaviy mahsulotlar `seed-products.json` dan olinadi; ularni admin paneldan o'chirib yuborish mumkin.

## API

| Metod | Yo'l | Ruxsat |
| --- | --- | --- |
| GET | `/api/config` | hamma |
| GET | `/api/products` | hamma |
| POST | `/api/products` | admin |
| PUT / DELETE | `/api/products/:id` | admin |
| POST | `/api/upload` | admin (`{ dataUrl }`) |
| GET | `/api/stock?productId=` | admin, ombor |
| POST | `/api/stock` | admin, ombor (`{ productId, type: "in" \| "out", qty, note }`) |
| POST | `/api/orders` | hamma (qoldiqdan ko'p bo'lsa 409) |

Admin tekshiruvi Telegram `initData` imzosi (bot token bilan HMAC) yoki `x-admin-token` sarlavhasi orqali.
