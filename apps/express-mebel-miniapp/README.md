# Express Market — Telegram Mini App (Firebase)

Mebel do'koni uchun Telegram mini ilova: katalog, savat, buyurtma, ombor va mahsulotlarni boshqarish.
Firebase'da ishlaydi: **Hosting** (sahifalar), **Cloud Functions** (API + bot), **Firestore** (mahsulotlar, ombor, buyurtmalar), **Storage** (rasmlar).

Ranglar va shriftlar Express Mebel brendbukidan (Express Market logosi shu shriftdan yig'ilgan):

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
firebase target:apply hosting app <ID> --project <ID>   # bir marta: ilova qaysi saytda turadi
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

## Yetkazish narxi

Sozlamalar → Yetkazish narxlari: **1 km narxi**, **uy ichigacha tushirish** = yuk og'irligi × 1 kg narxi (hozir 500 so'm; sotuvdagi har bir mahsulotda og'irlik majburiy),
**liftsiz har qavat** (1–2-qavat bepul) va **kompaniya komissiyasi** (yetkazish pulidan, hozir 20%). Haydovchi har topshirilgan
manzil uchun yetkazish pulining komissiyadan qolgan qismini oladi (topshirish paytida buyurtmaga yoziladi).



Rasmiylashtirishda mijoz joylashuv, qavat va "Lift bor" ni kiritadi; narx serverda hisoblanib, to'lashdan oldin ko'rinadi
va jami summaga (karta to'lovida alohida "Yetkazib berish" qatori bo'lib) qo'shiladi:

`masofa (km) × 1 km narxi + tushirib berish + (liftsiz bo'lsa) (qavat − bepul qavatlar) × qavat narxi`

- Boshlang'ich qiymatlar: 1 km = 1 500, tushirib berish = 100 000, liftsiz har qavat = 20 000, bepul qavatlar = 2.
- Admin: ☰ → **🚚 Yetkazish narxlari** — narxlar va **ombor lokatsiyasi** ("📍 Hozir ombordaman" yoki koordinata / xarita havolasi).
  Ombor lokatsiyasi kiritilmaguncha masofa narxi 0 hisoblanadi va guruhdagi xabarda ogohlantirish chiqadi.
- Masofa: to'g'ri chiziq × 1,3 (yo'l egriligi uchun taxmin). Olib ketishda yetkazish puli yo'q.

## Yetkazish vaqtini tanlash

Yetkaziladigan buyurtma ombordan **Tayyor** bo'lganda mijozga bot xabar yuboradi: "Qachon yetkazib beraylik?" va
eng yaqin bo'sh 4 ta vaqt (ertadan boshlab, yakshanbasiz; 10:00–13:00 va 14:00–18:00) + **🗓 Boshqa kunni tanlash**.
"Boshqa kun" botning o'zida kalendar ochadi: 30 kun ichidagi bo'sh kunlar → soat → band. Operator ishtirok etmaydi.

- Bir vaqtga ko'pi bilan 4 ta buyurtma (`SLOT_CAPACITY`, `functions/index.js`); to'lgan vaqt taklif qilinmaydi,
  eski tugma bosilsa yangi bo'sh vaqtlar yuboriladi.
- Tanlangan vaqt buyurtmalar guruhiga yoziladi va ombor ekranidagi kartada 🗓 bilan ko'rinadi.
- Tanlanmasa mijozga 3 va 24 soatda eslatma; 72 soatda guruhga faqat ma'lumot uchun xabar (`remindSlots`, har soatda).
- Savdo jarayonida operator mijoz bilan bog'lanmaydi: hammasi bot orqali. Operator faqat shikoyatlarda, zarur bo'lsa.

## Boshqaruv paneli (kompyuter)

`https://<ID>.web.app/admin.html` — kompyuter brauzeri uchun to'liq panel: Dashboard, Savdo va buyurtmalar, CRM (mijozlar),
Logistika, Mahsulotlar (SKU, komplektlar), Ombor, Moliya, Buxgalteriya (1C uchun CSV), Marketing (bannerlar va tahlil),
Xodimlar, Sozlamalar (yetkazish narxlari, ombor lokatsiyasi).

**Kirish**: Telegram'da botga **/panel** yozing (faqat adminlar) yoki mini ilovada ☰ → **💻 Kompyuterda ochish**. Havola
10 daqiqa va bir marta ishlaydi; brauzer 30 kun eslab qoladi. Admin `ADMIN_IDS` dan olib tashlansa, sessiyasi ham yopiladi.
"Chiqish" tugmasi sessiyani o'chiradi.

## Logistika: mashinalar, haydovchilar, reyslar

Panel → **Logistika**:

1. **🚐 Mashinalar** → **＋ Mashina**: nomi, davlat raqami, yuk ko'tarish (kg) va sig'imi (quti).
2. **Haydovchi qo'shish**: Xodimlar (HR) → **＋ Haydovchini taklif qilish** → havolani haydovchiga yuboring, u botda **Start** ni bosadi.
3. Yuqoridan **kunni** tanlang (Bugun, Ertaga, …). O'sha kunga yetkazish vaqtini tanlagan buyurtmalar chiqadi.
4. **Reys tuzish**: buyurtmalarni belgilang, haydovchi va mashinani tanlang → **Reys yaratish**.
   Tizim manzillarni tartiblaydi: avval 10:00–13:00 oynasi, keyin 14:00–18:00; har oyna ichida ombordan eng yaqinidan.
   Og'irlik yoki qutilar mashinaga sig'masa, ogohlantiradi. Haydovchiga bot xabar yuboradi.

### Haydovchi boti (ro'yxatdan o'tish va ish)

Haydovchilar uchun alohida bot (BotFather'da ochiladi, tokeni `DRIVER_BOT_TOKEN` secret):
`firebase functions:secrets:set DRIVER_BOT_TOKEN --project <ID>` → `firebase deploy` → `/api/setup` ni oching (javobda `driverBot`).

- **Ro'yxatdan o'tish** botning o'zida: telefon (📱 tugma), ism, mashina rusumi, davlat raqami, yuk ko'tarishi va 8 ta rasm —
  pasport, prava, texpasport, mashina oldida o'zi, mashina oldidan va orqasidan (raqam ko'rinsin), chap va o'ng yonidan.
- **HR tasdiqlaydi:** panel → Xodimlar (HR) → **Haydovchi arizalari** → rasmlar va ma'lumotlar → ish turi
  (**Shtatda** yoki **Alohida/yollanma**) va **💵 Naqd pul olishga ruxsat** (faqat shtatdagiga) → Tasdiqlash yoki sabab bilan Rad etish.
  Tasdiqlansa, haydovchi va mashinasi tizimga qo'shiladi. Keyin HR xodimni bosib, ish turi va naqd ruxsatini o'zgartira oladi.
- **Naqd ruxsati yo'q** haydovchiga tizim naqd to'lovli buyurtmani reysga biriktirmaydi: faqat oldindan to'langanlar.
- **Ish chatda:** reys xabari keladi → «▶️ Reysni boshlash» → manzillar birma-bir (📞, 📍, ✅ Topshirdim, ❌ Topshirib bo'lmadi);
  naqdda bot "qancha oldingiz?" deb so'raydi; oxirida "sizda naqd: … — kassaga topshiring".

Haydovchi Telegram ilovada **☰ → 🚚 Reyslarim**:
- manzillar tartib bilan: mijoz, telefon (bosib qo'ng'iroq), manzil, qavat/lift, qutilar, olinadigan naqd pul;
- **📍 Xarita** va **🗺 Butun marshrut** — Google Maps'da yo'l;
- **▶️ Reysni boshlash** — mebel mashinaga yuklangach; hamma buyurtma omborda "Tayyor" bo'lishi kerak. Mijozlarga "yo'lga chiqdi" xabari boradi;
- har manzilda **🤝 Topshirdim** — mijozga "Qabul qildim / Muammo bor" tugmalari qayta boradi. Mijoz 24 soat ichida javob bermasa, buyurtma avtomatik yopiladi.
- Haydovchi oldingi manzilni yopishi bilan bot navbatdagi mijozga "haydovchi kelyapti, uyda bo'ling" deb yozadi.
- **Naqd:** "Topshirdim" da haydovchi olingan summani kiritadi. Qarzga berilmaydi: summa to'liq bo'lmasa, tizim topshirishga ruxsat bermaydi.
  Kam bo'lsa — **💳 Qolganini karta bilan** (bot mijozga qolgan summaga to'lov havolasi yuboradi, to'lov o'tgach topshiriladi) yoki **❌ Topshirib bo'lmadi**.
- **❌ Topshirib bo'lmadi** (uyda yo'q, telefonni ko'tarmadi, manzil topilmadi, pul yetmadi, qabul qilmadi): mebel omborga qaytadi, reysdan chiqadi,
  mijozga yangi vaqt tanlash uchun kalendar boradi. Qayta yetkazish narxi va urinishlar soni: Sozlamalar → Yetkazish narxlari.
  Urinishlar tugasa yoki mijoz qabul qilmasa — buyurtma "Topshirilmadi: qaror kerak" bo'ladi; admin buyurtmada **🚚 Qayta yetkazish** yoki **❌ Bekor qilish** ni tanlaydi.
- Reysdagi buyurtma haydovchi topshirmaguncha o'zicha "yetkazildi" bo'lib yopilmaydi.
- Oxirgi manzildan keyin reys "Tugadi" bo'ladi va buyurtmalar guruhiga hisobot boradi: topshirilganlar, topshirilmaganlar, haydovchidagi naqd va kutilgan summadan farq.

Mahsulot og'irligi (kg) mahsulot formasida yoki Excel'dagi "Og'irligi, kg" ustunida kiritiladi; komplekt og'irligi modullardan hisoblanadi.

## HR: oylik, keldi-ketdi, to'lovlar

Panel → **Xodimlar (HR)** (yuqorida oy tanlanadi; hisob har oyning 1-sanasidan, bugungi holat real vaqtda):
- **Jadval:** har bir xodim, haydovchi va usta — ishlagani, hisoblangan, bonus, berilgan va **berilishi kerak**.
- **Oylikli xodim:** «＋ Xodim (oylikli)» (lavozim, qat'iy oylik) → xodim kartasida **Telegram'ni ulash havolasi** → xodim bosib ulanadi.
  Keyin mijozlar botidagi **📍 Keldim / Ketdim** tugmasi bilan belgilaydi: joylashuvi ombor (yoki ofis) dan radius ichida bo'lishi shart.
  Oylik **ishlagan soat** bo'yicha: oylik ÷ oy normasi × ishlagan soat. Kechikishlar ko'rinadi (jarima yo'q). Unutilgan kunni HR izoh bilan tuzatadi.
- **Haydovchi:** topshirgan manzillari bo'yicha daromad + **reklama bonusi**: haydovchi botida «📸 Reklama hisoboti» → mashinaning 4 tomoni →
  HR tasdiqlasa, bonus (hozir 700 000) shu oyga qo'shiladi. Mijoz «Qabul qildim» dan keyin haydovchini 1–5 ⭐ baholaydi.
- **Usta:** to'langan ishlardagi ulushi (to'lov «Ustalar» bo'limida).
- **To'lov berish:** avans / oylik / bonus, kartaga yoki kassadan (kassada «Maosh» chiqimi). Tarix xodim kartasida.
- Sozlamalar → **HR:** ish kunlari, ish vaqti, radius, ofis lokatsiyasi, reklama bonusi.
- **Xodim kartasi:** rasm (jadvalda ham ko'rinadi), hujjatlar (rasm yoki PDF: pasport, shartnoma…), shaxsiy ish jadvali
  (kunlar, soatlar — oylik normasi va kechikish shundan) va oylik.
- **Haydovchi va mashina bog'langan:** botdan ro'yxatdan o'tganda mashina rasmlari va texpasporti mashinaga, pasport, prava va
  "mashina oldida" rasmi haydovchiga tushadi. Mashinani boshqa haydovchiga o'tkazish yoki haydovchiga boshqa mashina berish —
  Logistika → "Haydovchilar va mashinalar" yoki haydovchi kartasida; rasmlar va hujjatlar mashinada qoladi.

## Ustalar (mebel yig'ish)

Ustalar uchun alohida bot (BotFather'da ochiladi, tokeni `MASTER_BOT_TOKEN` secret):
`firebase functions:secrets:set MASTER_BOT_TOKEN --project <ID>` → `firebase deploy` → `/api/setup` (javobda `masterBot`).

- **Usta ro'yxatdan o'tadi (usta botida):** telefon, ism, ishlaydigan tumanlar, tajriba, o'zi haqida, rasmi, pasport,
  1–5 ta ish namunasi, **ish haqi kartasi** (16 xonali) va karta egasi. HR: panel → Xodimlar (HR) → **Usta arizalari** → Tasdiqlash / Rad etish.
- **Narx (Sozlamalar → Yig'ish xizmati):** yig'ish = mebel narxining **10%**, eng kami **100 000 so'm**; kompaniya komissiyasi
  yig'ish narxining **10%**. Yangi qoidalar yangi ishlarga qo'llanadi.
- **Mijoz:** 🧾 Mening buyurtmalarim → buyurtma (qo'lga tekkan) → **🔧 Usta topish** → tuman, reyting, ishlar soni, namunalar va izohlar
  bo'yicha ustani tanlaydi → kun va vaqt oralig'i → so'rov ustaga boradi.
- **Usta (botda):** Qabul qilaman / Rad etaman → qabul qilsa mijozga usta telefoni boradi → **▶️ Boshladim** → **✅ Tugatdim** + yig'ilgan mebel rasmi.
- Shu zahoti mijozga asosiy botda **to'lov cheki** (karta) boradi; to'lagach usta va mijozga xabar, mijoz 1–5 baho va izoh qoldiradi.
- **Panel → 🔧 Ustalar:** reyting, ishlar, ishlagan va **to'lanadigan** summa; ustani ochib karta raqamini nusxalaysiz,
  pulni kartaga o'tkazgach **O'tkazildi** → ustaga botda xabar. Bloklash / faollashtirish. Yig'ish ishlari ro'yxati va komissiya daromadi.

## Zakup (ta'minotchilar va kirim)

Panel → **🏭 Zakup**:
- **Ta'minotchilar:** nomi, telefon, mas'ul, **yetkazish muddati (kun)**. Mahsulotga ta'minotchi va **Minimal qoldiq** mahsulot formasida yoki Excel'da biriktiriladi.
- **Buyurtma berish kerak:** tizim o'zi hisoblaydi — oxirgi 30 kun sotuvi, yetkazish muddati va minimal qoldiq bo'yicha.
  Tavsiya = muddat + 30 kunlik sotuv (kamida minimal qoldiqning 2 baravari) − qoldiq − yo'ldagi zakup. Ta'minotchi bo'yicha guruhlanadi;
  soni va narxini o'zgartirib **Zakup buyurtmasi yaratish**.
- **Zakup buyurtmasi (PO):** Qoralama → **Yuborildi** (matnni nusxalab fabrikaga yuborasiz) → **Qabul qilish** (qisman ham bo'ladi):
  qoldiqqa kirim bo'ladi (jurnalda "Zakup PO-n"), tannarx oxirgi kirim narxiga yangilanadi, yorliqlarni shu yerdan chop etasiz.
- **To'lov:** bank yoki kassadan naqd (kassada chiqim bo'ladi); ta'minotchiga qarz ko'rinadi. Zakup to'lovi xarajat emas —
  foydaga mahsulot sotilganda tannarx orqali tushadi.

## Kassa va moliya

Panel → **💵 Kassa**:
- **Haydovchi va do'kondagi naqd:** haydovchi «Topshirdim» da olgan naqd va do'kondan olib ketilgan naqd buyurtmalar shu yerda turadi.
  Pulni sanab **Qabul qilish** → summa kassaga kirim bo'ladi, haydovchiga botda tasdiq boradi. Summa farq qilsa, izoh majburiy va farq (kamomad) daftarda qoladi.
- **Kirim / Chiqim:** ijara, maosh, zakup, yoqilg'i, soliq, reklama, bankka topshirish va boshqalar; izoh majburiy.
  Kassadagidan ko'p chiqim qilib bo'lmaydi. Yozuvlar o'chirilmaydi — xato teskari yozuv bilan tuzatiladi.
- Naqd buyurtma bo'yicha **Pul qaytarildi** bosilsa, summa kassadan chiqim bo'ladi (karta qaytarishlari bank orqali).
- **Kassa daftari** CSV'ga yuklanadi.

Panel → **💰 Moliya**: tushum, **tannarx**, yalpi foyda va marja, kassadan xarajatlar kategoriya bo'yicha va **sof foyda**.
Tannarx mahsulot formasida yoki Excel'dagi «Tannarx» ustunida kiritiladi; uni faqat adminlar ko'radi (mijoz, omborchi va ekranga yuborilmaydi).
Komplekt tannarxi modullaridan hisoblanadi.

## Shikoyatlar

- Mijoz "⚠️ Muammo bor" ni bosadi (yetkazilganda) yoki mini ilovada buyurtmani ochib **⚠️ Muammo bildirish** (yetkazilgandan keyin 30 kun ichida).
- Bot so'raydi: muammo turi (singan, qism yetishmaydi, boshqa mahsulot, yig'ish, sifat, boshqa) → qisqa tavsif → 1–5 ta rasm
  (singan, yetishmagan, boshqa mahsulot va sifat uchun rasm majburiy) → **✅ Yuborish**. Buyurtmalar guruhiga "🛠 Yangi shikoyat S-…" boradi.
- Panel → **🛠 Shikoyatlar**: ro'yxat, javob muddati (24 soat, o'tsa qizil), mas'ul, holat; turlar va ko'p shikoyat olgan mahsulotlar hisoboti.
- Shikoyatni ochib: **🙋 Ishga olish** → **mijozga xabar** (bot orqali) → **yechim**: qism yuborish, almashtirish, usta,
  qisman / to'liq pul qaytarish (Buxgalteriyadagi "Pul qaytarish kutilmoqda"ga tushadi), maslahat yoki asossiz.
- Yechimdan keyin mijoz 1–5 baho beradi; 1–2 baho guruhga ogohlantirish bo'lib boradi.

## Buyurtmalar arxivi va bekor qilish

- **Mijoz**: ☰ → **🧾 Mening buyurtmalarim** — holati, tarixi, "Qayta buyurtma berish".
- **Admin**: ☰ → **📋 Buyurtmalar** — Faol / Yakunlangan / Bekor / Hammasi, raqam, ism yoki telefon bo'yicha qidiruv,
  har buyurtmaning bosqichlar tarixi (kim, qachon). Buyurtmalar Firestore `orders` da o'chmasdan saqlanadi.

Bekor qilish (hamma buyurtma ombordan yuboriladi, qoida bir xil):

| Bosqich | Kim | Nima bo'ladi |
| --- | --- | --- |
| Qabul qilindi | Mijoz o'zi: ☰ → 🧾 Mening buyurtmalarim | Darhol bekor, tovar qoldiqqa qaytadi |
| Tayyorlanmoqda / Tayyor | Mijoz so'raydi, admin guruhda yoki ilovada tasdiqlaydi | "Qutilarni polkaga qaytaring", qoldiq qaytadi |
| Yo'lda va keyin | Bekor qilinmaydi | "Muammo bor" / qaytarish operator orqali |

Har bekor qilishda sabab yoziladi. To'langan karta buyurtmasida "💳 Pul qaytarish kerak" vazifasi chiqadi: pul
Click/Payme kabinetida qaytariladi, so'ng admin **"Pul qaytarildi"** ni bosadi va mijozga xabar boradi.

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

## Mahsulotlarni Excel orqali kiritish

Panel → **Mahsulotlar (SKU)**:

1. **⬇️ Excel** — joriy katalogni `.xlsx` qilib yuklab beradi. Bu fayl shablon ham: "Yo'riqnoma" varag'ida har bir ustun tushuntirilgan.
2. Excel'da tahrirlang: narx, qoldiq, tavsifni o'zgartiring, pastga yangi qatorlar qo'shing (ID va SKU bo'sh qoladi).
3. **⬆️ Exceldan yuklash** — tizim avval tekshiradi va hisobot ko'rsatadi: nechta yangi, nechtasi yangilanadi, qaysi qatorda xato bor.
   Xato bor paytda hech narsa saqlanmaydi. Hammasi to'g'ri bo'lsa, **Tasdiqlash** bosiladi.

Qoidalar:
- Qator mahsulotni **ID**, **SKU** yoki aynan **nomi** bo'yicha topadi va yangilaydi, topilmasa yangisini qo'shadi. Shuning uchun bir faylni qayta yuklash dubl yaratmaydi.
- Faylda yo'q mahsulotlar o'chirilmaydi. Rasmlar Excel'dan emas, panelda mahsulotning o'zidan yuklanadi.
- **Qoldiq** o'zgarsa, ombor jurnaliga "Excel import" kirim/chiqim bo'lib yoziladi.
- Komplekt tarkibi: `100003×2; 100004×1`. SKU o'rniga modul nomi ham bo'ladi, shu faylda yangi qo'shilgan modul ham.

## Omborchini qo'shish

1. Admin: ☰ → **👥 Xodimlar** → **＋ Omborchini taklif qilish** → **📤 Yuborish** (yoki nusxalab, omborchiga jo'nating).
2. Omborchi havolani bosadi → bot ochiladi → **Start**. Bot "✅ … omborchi sifatida qo'shildingiz" deb javob beradi, adminga ham xabar keladi.
3. Omborchi ilovani ochadi → ☰ → **📦 Ombor**.

Havola 24 soat va bir marta ishlaydi. Xodimni o'chirish: o'sha bo'limda **O'chirish**. Xodimlar Firestore `staff` kolleksiyasida saqlanadi.

## Keyin o'zgartirish

- **Admin ID'lari, buyurtma chati**: Cloud Shell'da `functions/.env.<ID>` faylini tahrirlang (`nano functions/.env.<ID>`) → `firebase deploy --only functions --project <ID>`.
- **Bot tokeni**: `firebase functions:secrets:set BOT_TOKEN --project <ID>` → `firebase deploy --only functions --project <ID>` → `/api/setup` ni qayta oching.
- **Kod yangilansa**: `git pull` → `firebase deploy --project <ID>`.
- **Brend nomli sayt manzili** (masalan `expressmarket.web.app`): `firebase hosting:sites:create expressmarket --project <ID>` →
  `firebase target:clear hosting app --project <ID>` → `firebase target:apply hosting app expressmarket --project <ID>` (deploy endi shu saytga boradi) →
  `functions/.env.<ID>` ga `WEBAPP_URL=https://expressmarket.web.app` qatorini qo'shing → `firebase deploy --project <ID>` →
  `https://expressmarket.web.app/api/setup` ni oching (bot tugmasi va webhook yangi manzilga o'tadi).
- Ma'lumotlarni Firebase konsolida ko'rish: **Firestore** → `products`, `stockMovements`, `orders`, `banners`.

## Boshqa Firebase loyihaga ko'chirish

`scripts/migrate-project.mjs` Firestore ma'lumotlari (mahsulotlar, qoldiq tarixi, buyurtmalar, bannerlar, xodimlar,
ekranlar, sozlamalar) va Storage'dagi rasmlarni boshqa loyihaga ko'chiradi, rasm havolalarini yangi bucket'ga moslaydi.
Cloud Shell'da (`functions/` da `npm install` qilingan bo'lsin):

```bash
node scripts/migrate-project.mjs --from <eski ID> --to <yangi ID> --from-bucket <eski bucket> --to-bucket <yangi bucket>          # sanab ko'rsatadi
node scripts/migrate-project.mjs --from <eski ID> --to <yangi ID> --from-bucket <eski bucket> --to-bucket <yangi bucket> --apply  # ko'chiradi
```

Yangi loyihada mahsulot yoki buyurtma bo'lsa, skript hech narsani yozmasdan to'xtaydi. Kirish havolalari, panel sessiyalari,
ekran ulash kodlari va taklif havolalari ko'chirilmaydi: ular qayta olinadi. Bucket nomlari:
`gcloud storage buckets list --project <ID> --format="value(name)"`.

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
