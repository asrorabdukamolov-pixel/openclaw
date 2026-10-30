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
- **Komplektlar**: bir nechta moduldan yig'ilgan mahsulot (masalan, oshxona); mavjud soni modullar qoldig'idan hisoblanadi.
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
| `PAYMENT_PROVIDER_TOKEN` | BotFather'dan to'lov provayderi tokeni yoki `-` (karta to'lovi o'chiq) |

API'larni yoqish haqida so'rasa — **Yes**. Birinchi deploy xato bilan tugasa (ruxsatlar hali tarqalmagan bo'ladi), 2–3 daqiqadan keyin `firebase deploy --project <ID>` ni qayta ishga tushiring.

### 4. Botni ulash

Brauzerda oching: `https://<ID>.web.app/api/setup`

`{"ok":true,"bot":"@...","seeded":true}` chiqsa — tayyor: bot webhook'i va **Katalog** menyu tugmasi o'rnatildi, katalog namunaviy mahsulotlar bilan to'ldirildi.
Botga `/start` yozing → **🛋 Katalogni ochish**.

## Karta orqali to'lov

To'lov Telegram Payments orqali: to'lov oynasi Telegram ichida ochiladi, karta ma'lumotlari bizning serverga kelmaydi.

1. To'lov provayderi bilan merchant shartnoma tuzing (O'zbekistonda odatda Click yoki Payme; yuridik shaxs yoki YaTT kerak).
2. **@BotFather** → `/mybots` → botingiz → **Payments** → provayderni tanlang va ulang. BotFather **provider token** beradi
   (avval `TEST` tokeni bilan sinab ko'rish mumkin).
3. Cloud Shell:
   ```bash
   firebase functions:secrets:set PAYMENT_PROVIDER_TOKEN --project <ID>   # tokenni qo'ying
   firebase deploy --only functions --project <ID>
   ```
4. `https://<ID>.web.app/api/setup` ni qayta oching (bot to'lov tasdiqlash so'rovlarini qabul qiladigan bo'ladi).

Token o'rniga `-` saqlansa, karta to'lovi o'chiq turadi, faqat "Qabul qilganda" qoladi.

Qanday ishlaydi:
- Mijoz **💳 Karta orqali** ni tanlaydi → mahsulot bron qilinadi → Telegram to'lov oynasi ochiladi.
- To'lov o'tsa: buyurtma `paid`, guruhga "💳 TO'LANGAN" xabari, mijozga chek.
- Oyna yopilsa yoki to'lov o'tmasa: bron darhol qaytadi (ombor tarixida "Bron qaytdi").
- 30 daqiqada to'lanmagan bronlarni `releaseUnpaid` funksiyasi har 10 daqiqada qaytaradi.
- Telegram to'lovdan oldin summa, valyuta (UZS) va buyurtma holatini tekshiradi; muddati o'tgan buyurtmaga to'lov qabul qilinmaydi.

## Ombor ekrani va shtrix-kod

Ombordagi kompyuter, sensorli monitor yoki planshetda brauzerda ochiladi: `https://<ID>.web.app/ombor.html`.

1. **Ulash:** Telegram ilovada admin: ☰ → **🖥 Ombor ekrani** → nom → **Kod olish** (10 daqiqa, bir martalik).
   Ekranda kodni kiriting. Ekran shu brauzerda eslab qoladi; uzish: o'sha bo'limda **Uzish**.
2. **Etiketka:** ekranda **🏷 Etiketkalar** → mahsulot → nechta dona → **Chop etish**. Har bir dona va har bir quti
   uchun alohida etiketka (58 × 40 mm, CODE128): `EM<SKU>-<quti raqami>`, masalan `EM100013-2`.
   Mahsulotning qutilar soni admin panelda **"Qutilar soni"** maydonida.
3. **Buyurtma bosqichlari** (har birida mijozga bot xabari):

| Bosqich | Kim o'tkazadi | Mijozga |
| --- | --- | --- |
| 🆕 Yangi | naqd buyurtma darhol, karta — to'langach ekranga tushadi | "Buyurtmangiz #N qabul qilindi" |
| 📦 Yig'ilmoqda | ekranda **Yig'ishni boshlash** | "omborda yig'ilmoqda" |
| ✅ Tayyor | barcha qutilar skanerlanganda o'zi | "yig'ildi, jo'natishga tayyor" |
| 🚚 Yo'lda | ekranda **Yo'lga chiqarish** | "yo'lga chiqdi" + **✅ Qabul qildim** / **⚠️ Muammo bor** |
| 🏁 Yakunlandi | mijoz **Qabul qildim** bosadi yoki 5 kundan keyin o'zi (`closeShipped`) | "Rahmat!" |
| ⚠️ Muammo | mijoz **Muammo bor** bosadi | adminga xabar, operator bog'lanadi |

Skaner (USB/Bluetooth) klaviatura kabi ishlaydi: kod + Enter. Noto'g'ri mahsulot, ortiqcha yoki takroriy quti
qizil signal bilan rad etiladi. Shtrix-kod o'qilmasa, qutini ekranda bosib belgilash mumkin.
Ekran har 5 soniyada yangilanadi, yangi buyurtma kelganda ovozli signal beradi (**🔈 Ovozni yoqish** bir marta bosiladi).
Admin va omborchilar ham shu amallarni Telegram orqali bajarishi mumkin (API bir xil).

4. **Skaner bilan kirim / chiqim:** ekranda **📥 Kirim / Chiqim** → rejim → qutilarni ketma-ket skanerlang → **Saqlash**.
   Bir necha qutili mahsulot faqat **barcha qutilari** skanerlanganda 1 dona hisoblanadi; chala to'plam ogohlantiriladi
   va hisobga kirmaydi. Chiqim uchun sabab majburiy, qoldiqdan ko'p chiqim rad etiladi. Qoldiq Telegram ilovada darhol yangilanadi.
5. **Yangi mahsulot (ombor):** o'sha bo'limda **＋ Yangi mahsulot** → nom, bo'lim, qutilar soni → SKU beriladi →
   **🏷 Etiketka chop etish** → skanerlab kirim. Mahsulot **qoralama**: mijozlarga ko'rinmaydi va sotilmaydi.
   Adminga bot xabari keladi; admin narx va rasmni kiritib, **Saytda ko'rsatish** ni belgilaydi.

Bu versiyani yuklagandan keyin `/api/setup` ni **qayta oching**: mavjud mahsulotlarga SKU beriladi va bot
"Qabul qildim" tugmalarini qabul qiladigan bo'ladi.

## Yetkazish vaqtini tanlash

Yetkaziladigan buyurtma ombordan **Tayyor** bo'lganda mijozga bot xabar yuboradi: "Qachon yetkazib beraylik?" va
eng yaqin bo'sh 4 ta vaqt (ertadan boshlab, yakshanbasiz; 10:00–13:00 va 14:00–18:00) + **📞 Boshqa kun kerak**.

- Bir vaqtga ko'pi bilan 4 ta buyurtma (`SLOT_CAPACITY`, `functions/index.js`); to'lgan vaqt taklif qilinmaydi,
  eski tugma bosilsa yangi bo'sh vaqtlar yuboriladi.
- Tanlangan vaqt buyurtmalar guruhiga yoziladi va ombor ekranidagi kartada 🗓 bilan ko'rinadi.
- 3 soatda tanlanmasa mijozga eslatma, 24 soatda tanlanmasa guruhga "qo'ng'iroq qiling" (`remindSlots`, har soatda).
- "Boshqa kun" bosilsa, guruhga mijozning ismi va telefoni bilan xabar boradi.

## Komplektlar (oshxona va boshqa yig'ma mahsulotlar)

Mahsulot uch darajada: **quti** (shtrix-kod `EM<SKU>-<quti>`) → **modul / mahsulot** (SKU, qoldiq shu yerda) → **komplekt**
(katalogda sotiladi, o'z qoldig'i va shtrix-kodi yo'q).

1. Avval modullarni qo'shing: ☰ → ⚙️ → **＋ Mahsulot / modul**. Faqat komplekt ichida sotiladigan modulda
   **"Katalogda alohida sotiladi"** belgisini olib tashlang: u katalogda chiqmaydi, lekin omborda, etiketkada va skanerda bor.
2. ☰ → ⚙️ → **＋ Komplekt**: nom, narx, rasm, so'ng modullarni tanlab sonini yozing (masalan, pastki shkaf 60 × 2).
3. **Modul yetishmasa**: "Buyurtma asosida" (katalogda "~N kunda" deb turadi, savatga qo'shilmaydi) yoki "Katalogdan yashirish".

- Komplekt mavjud soni = eng kam yetadigan modul: `qoldiq ÷ komplektdagi soni`, eng kichigi.
- Buyurtmada har bir modul band qilinadi; ombor ekranida karta komplekt nomini, terish oynasi esa barcha modul va qutilarni ko'rsatadi.
- Komplektga qo'lda kirim/chiqim qilinmaydi (modullarni kirim qiling); komplektda turgan modulni o'chirib bo'lmaydi.

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
printf 'BOT_TOKEN=123:abc\nPAYMENT_PROVIDER_TOKEN=-\n' > functions/.secret.local
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
| POST | `/api/products` | admin (komplekt: `{ kind: "kit", components: [{ id, qty }], whenShort: "preorder" \| "hide", leadDays }`) |
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
| POST | `/api/screens/pair-code` | admin (`{ name }` → 8 belgili kod) |
| POST | `/api/screens/pair` | hamma (`{ code }` → ekran tokeni) |
| GET / DELETE | `/api/screens`, `/api/screens/:id` | admin |
| GET | `/api/products?all=1` | ekran tokeni, admin, omborchi (qoralamalar va alohida sotilmaydigan modullar bilan; `listed` = katalogda) |
| POST | `/api/products/draft` | ekran tokeni, admin, omborchi (`{ name, category, boxes, size, material }`) |
| POST | `/api/stock/scan` | ekran tokeni, admin, omborchi (`{ type: "in" \| "out", note, scans: { "EM100013-1": 2, … } }`) |
| GET | `/api/fulfillment` | ekran tokeni, admin, omborchi |
| POST | `/api/fulfillment/:id/start` · `/pick` · `/ship` | ekran tokeni, admin, omborchi (`pick`: `{ code }` yoki `{ item, box }`) |
| GET | `/api/geocode?lat=&lon=` | hamma |
| POST | `/api/orders/:id/cancel` | buyurtma egasi (to'lanmagan bronni qaytarish) |
| POST | `/api/orders` | hamma (qoldiqdan ko'p bo'lsa 409); `payment: "card"` → `invoiceLink` |

Rol Telegram `initData` imzosi (bot token bilan HMAC) orqali aniqlanadi. Firestore va Storage qoidalari to'g'ridan-to'g'ri kirishni yopadi — hamma narsa funksiya orqali.
