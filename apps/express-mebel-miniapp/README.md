# Express Mebel — Telegram Mini App (Firebase)

Mebel do'koni uchun Telegram mini ilova: katalog, savat, buyurtma, ombor va mahsulotlarni boshqarish.
Firebase'da ishlaydi: **Hosting** (sahifalar), **Cloud Functions** (API + bot), **Firestore** (mahsulotlar, ombor, buyurtmalar), **Storage** (rasmlar).

Ranglar va shriftlar Express Mebel brendbukidan:

| Token | Rang | Brendbuk |
| --- | --- | --- |
| Aksent (dengiz to'lqini) | `#008E9B` | PANTONE 2230 CP |
| Asosiy to'q kulrang | `#2B2A29` | PANTONE P 179-16 C |
| Bazaviy to'q kulrang | `#303030` | PANTONE 426 |
| Oq | `#FFFFFF` | — |

Shriftlar: **Prompt Italic** (sarlavhalar) va **Montserrat** (matn). Bo'limlar: **Oshxona, Shkaf, Tumba, Parta, Pufik, Krovat**.

## Imkoniyatlar

- Katalog: bannerlar, qidiruv, bo'lim tablari, "Yangi" belgisi, chegirma %, eski narx.
- Mahsulot sahifasi, savat, buyurtma (yetkazib berish / olib ketish).
- Telefon raqam Telegram'dan bir bosishda (`requestContact`), manzil lokatsiyadan avtomatik (`LocationManager` + OpenStreetMap).
- Buyurtma admin chatiga xarita havolalari va lokatsiya pini bilan keladi, mijozga tasdiq xabari boradi. Buyurtmalar Firestore `orders` kolleksiyasida ham saqlanadi.
- **Ombor**: qoldiq, kirim / chiqim, harakatlar tarixi. Buyurtmada qoldiq tranzaksiyada kamayadi; 0 bo'lsa mahsulot sotuvdan chiqadi.
- **Admin panel**: mahsulot qo'shish / tahrirlash / o'chirish, telefondan rasm yuklash.
- **Bannerlar va aksiyalar** (☰ → 🖼): bosh sahifadagi aylanuvchi bannerlar. Ko'rinish: *Rasm* (butun banner — rasm, 2:1, masalan 1200×600),
  *Qora* yoki *Moviy* (brend rangidagi matnli karta + yon rasm). Bosilganda bo'lim yoki mahsulotni ochadi.
  Tartib raqami, "Saytda ko'rsatish" belgisi (yashirilgan banner o'chmaydi, keyin qayta yoqiladi).

| Rol | Kim | Nima qila oladi |
| --- | --- | --- |
| Admin | `ADMIN_IDS` | hamma narsa |
| Ombor xodimi | admin taklif qilgan (☰ → 👥 Xodimlar) | faqat kirim / chiqim |
| Mijoz | boshqalar | katalog va buyurtma |

## Firebase'ga ulash (bir marta)

Kompyuter shart emas — hammasi brauzerda (telefonda ham bo'ladi, lekin kompyuterda qulayroq).

### 1. Telegram

1. **@BotFather** → botingiz → **API Token** (eski token oshkor bo'lgan bo'lsa: `/revoke` → yangisi).
2. **@userinfobot** → o'z **ID** raqamingiz (admin uchun). Ombor xodimlari ham shu yo'l bilan ID'sini bilib beradi.

### 2. Firebase loyiha

1. https://console.firebase.google.com → **Create a project** → nomi, masalan `express-mebel` → Google Analytics shart emas.
   Loyiha **ID** sini eslab qoling (masalan `express-mebel-1a2b3`) — sayt manzili `https://<ID>.web.app` bo'ladi.
2. Chapda pastda **Upgrade** → **Blaze** tarifi → karta ulang (Visa/Mastercard). Bepul limit kichik do'kon uchun yetadi.
   Xavotir bo'lmasligi uchun **Budget alert** qo'ying (masalan $5).
3. **Build → Firestore Database → Create database** → joylashuv **eur3 (Europe)** → *Start in production mode*.
4. **Build → Storage → Get started** → o'sha joylashuv → *production mode*.

### 3. Yuklash (Google Cloud Shell)

https://shell.cloud.google.com ni o'sha Google akkaunt bilan oching va buyruqlarni ketma-ket kiriting:

```bash
git clone --depth 1 --filter=blob:none --sparse -b claude/manga-mini-telegram-app-65fu6q \
  https://github.com/asrorabdukamolov-pixel/openclaw.git express-mebel
cd express-mebel && git sparse-checkout set apps/express-mebel-miniapp
cd apps/express-mebel-miniapp

command -v firebase || npm install -g firebase-tools   # Cloud Shell'da odatda bor
firebase login --no-localhost        # havolani oching, ruxsat bering, kodni qaytarib qo'ying
(cd functions && npm install)
firebase deploy --project <ID>       # <ID> o'rniga loyiha ID si
```

`firebase deploy` birinchi marta so'raydi:

| Savol | Javob |
| --- | --- |
| `BOT_TOKEN` | bot tokeni (ekranda ko'rinmaydi, bu normal) |
| `ADMIN_IDS` | sizning ID'ingiz; bir nechta bo'lsa `111,222` |
| `ORDERS_CHAT_ID` | buyurtmalar guruhi ID'si yoki `-` (birinchi adminga keladi) |

API'larni yoqish haqida so'rasa — **Yes**. Birinchi deploy xato bilan tugasa (ruxsatlar hali tarqalmagan bo'ladi), 2–3 daqiqadan keyin `firebase deploy --project <ID>` ni qayta ishga tushiring.

### 4. Botni ulash

Brauzerda oching: `https://<ID>.web.app/api/setup`

`{"ok":true,"bot":"@...","seeded":true}` chiqsa — tayyor: bot webhook'i va **Katalog** menyu tugmasi o'rnatildi, katalog namunaviy mahsulotlar bilan to'ldirildi.
Botga `/start` yozing → **🛋 Katalogni ochish**.

## Omborchini qo'shish

1. Admin: ☰ → **👥 Xodimlar** → **＋ Omborchini taklif qilish** → **📤 Yuborish** (yoki nusxalab, omborchiga jo'nating).
2. Omborchi havolani bosadi → bot ochiladi → **Start**. Bot "✅ … omborchi sifatida qo'shildingiz" deb javob beradi, adminga ham xabar keladi.
3. Omborchi ilovani ochadi → ☰ → **📦 Ombor**.

Havola 24 soat va bir marta ishlaydi. Xodimni o'chirish: o'sha bo'limda **O'chirish**. Xodimlar Firestore `staff` kolleksiyasida saqlanadi.

## Keyin o'zgartirish

- **Admin ID'lari, buyurtma chati**: Cloud Shell'da `functions/.env.<ID>` faylini tahrirlang (`nano functions/.env.<ID>`) → `firebase deploy --only functions --project <ID>`.
- **Bot tokeni**: `firebase functions:secrets:set BOT_TOKEN --project <ID>` → `firebase deploy --only functions --project <ID>` → `/api/setup` ni qayta oching.
- **Kod yangilansa**: `git pull` → `firebase deploy --project <ID>`.
- Ma'lumotlarni Firebase konsolida ko'rish: **Firestore** → `products`, `stockMovements`, `orders`, `banners`.

## Mahalliy sinov (dasturchilar uchun)

```bash
cd functions && npm install && cd ..
printf 'ADMIN_IDS=42\nORDERS_CHAT_ID=-\n' > functions/.env.local
printf 'BOT_TOKEN=123:abc\n' > functions/.secret.local
firebase emulators:start --project demo-express
# http://127.0.0.1:5000  →  /api/setup katalogni to'ldiradi (Telegram qismi soxta token bilan xato beradi)
```

## API

Hammasi `https://<ID>.web.app/api/...` ostida (Hosting → `api` funksiyasi, `europe-west1`).

| Metod | Yo'l | Ruxsat |
| --- | --- | --- |
| GET | `/api/setup` | hamma (webhook, menyu tugmasi, bo'sh katalog va bannerlarni to'ldirish) |
| POST | `/api/telegram` | faqat Telegram (`X-Telegram-Bot-Api-Secret-Token`) |
| GET | `/api/config` | hamma |
| GET | `/api/products`, `/api/products/:id` | hamma |
| POST | `/api/products` | admin |
| PUT / DELETE | `/api/products/:id` | admin |
| POST | `/api/upload` | admin (`{ dataUrl }` → Storage `images/`) |
| GET | `/api/banners` | hamma (faol bannerlar); `?all=1` — admin uchun yashirinlari bilan |
| POST | `/api/banners` | admin |
| PUT / DELETE | `/api/banners/:id` | admin |
| GET | `/api/stock?productId=` | admin, ombor |
| POST | `/api/stock` | admin, ombor (`{ productId, type: "in" \| "out", qty, note }`) |
| GET | `/api/staff` | admin |
| POST | `/api/staff/invites` | admin (24 soatlik bir martalik havola) |
| DELETE | `/api/staff/:telegramId` | admin |
| GET | `/api/geocode?lat=&lon=` | hamma |
| POST | `/api/orders` | hamma (qoldiqdan ko'p bo'lsa 409) |

Rol Telegram `initData` imzosi (bot token bilan HMAC) orqali aniqlanadi. Firestore va Storage qoidalari to'g'ridan-to'g'ri kirishni yopadi — hamma narsa funksiya orqali.
