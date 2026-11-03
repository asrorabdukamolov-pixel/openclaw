// Express Market masters ("ustalar"): an assembly marketplace on its own Telegram bot.
// Masters register in the master bot (contact, districts, experience, photos, payout card); HR
// approves them in the panel. A buyer picks a master for a delivered order in the mini app and asks
// for a day; the master accepts in the bot, presses "Boshladim" and "Tugatdim" with a photo, and the
// buyer gets the fee invoice in the main bot. After the card payment the buyer rates the master and
// the master's share (fee minus the platform commission) waits in the panel until it is paid out
// to the master's card. Fee and commission rules live in meta/assembly (panel → Sozlamalar).

export const ASSEMBLY_DEFAULTS = { percent: 10, minFee: 100000, commission: 10 };
export const DISTRICTS = [
  "Bektemir",
  "Chilonzor",
  "Mirobod",
  "Mirzo Ulug'bek",
  "Olmazor",
  "Sergeli",
  "Shayxontohur",
  "Uchtepa",
  "Yakkasaroy",
  "Yangihayot",
  "Yashnobod",
  "Yunusobod",
  "Toshkent viloyati",
];
const WINDOWS = { "09": "09:00–12:00", "12": "12:00–15:00", "15": "15:00–18:00", "18": "18:00–21:00" };
const REG_STEPS = ["phone", "name", "districts", "experience", "about", "face", "passport", "samples", "card", "holder", "confirm"];
const REG_PROMPTS = {
  name: "Ism va familiyangizni yozing (pasportdagidek):",
  experience: "Necha yildan beri mebel yig'asiz? Faqat raqam yozing:",
  about: "O'zingiz haqingizda qisqacha: qanday mebellarni yig'asiz, asboblaringiz bormi:",
  face: "🤳 O'zingizning rasmingizni yuboring (yuzingiz aniq ko'rinsin) — mijozlar shu rasmni ko'radi:",
  passport: "🛂 Pasportingizning rasmli sahifasini yuboring (faqat HR ko'radi):",
  samples: "🛠 Yig'gan mebellaringizdan 1–5 ta rasm yuboring. Tugatgach «✅ Tayyor» ni bosing.",
  card: "💳 Ish haqi o'tkaziladigan karta raqami (16 xonali, Uzcard / Humo / Visa):",
  holder: "Karta egasining ismi (kartada yozilganidek):",
};
const MENU = { keyboard: [[{ text: "📋 Ishlarim" }]], resize_keyboard: true };
const JOB_STATE = { requested: "Taklif", accepted: "Qabul qilindi", started: "Ishlamoqda", done: "To'lov kutilmoqda", paid: "To'landi", declined: "Rad etildi", cancelled: "Bekor" };
const DAY_MS = 24 * 60 * 60 * 1000;

const maskCard = (n) => (n ? `${n.slice(0, 4)} **** **** ${n.slice(-4)}` : "");
const roundFee = (n) => Math.round(n / 1000) * 1000;

export function assemblyFee(goodsTotal, s) {
  return Math.max(s.minFee, roundFee((goodsTotal * s.percent) / 100));
}

export function createMasters(ctx) {
  const { db, HttpError, tg, logger } = ctx;
  const mastersCol = db.collection("masters");
  const appsCol = db.collection("masterApplications");
  const jobsCol = db.collection("assemblyJobs");
  const payoutsCol = db.collection("masterPayouts");
  const settingsRef = db.collection("meta").doc("assembly");
  const mtg = (method, body) => ctx.callTelegram(ctx.MASTER_BOT_TOKEN.value(), method, body);
  const secret = () => ctx.hmac(ctx.MASTER_BOT_TOKEN.value(), "master-webhook");

  async function settings() {
    return { ...ASSEMBLY_DEFAULTS, ...(await settingsRef.get()).data() };
  }

  function cleanSettings(input) {
    const pct = (v, name) => {
      const n = Number(v);
      if (!(n >= 0 && n <= 100)) throw new HttpError(400, `${name}: 0–100 %`);
      return Math.round(n * 10) / 10;
    };
    const minFee = Math.round(Number(input.minFee));
    if (!(minFee >= 0 && minFee <= 100_000_000)) throw new HttpError(400, "Eng kam yig'ish narxi noto'g'ri");
    return { percent: pct(input.percent, "Yig'ish foizi"), minFee, commission: pct(input.commission, "Komissiya"), updatedAt: Date.now() };
  }

  // ---------- registration in the master bot ----------

  const districtKeyboard = (picked) => ({
    inline_keyboard: [
      ...DISTRICTS.map((d, i) => [{ text: `${picked.includes(d) ? "✅ " : ""}${d}`, callback_data: `mr:d:${i}` }]),
      [{ text: "➡️ Davom etish", callback_data: "mr:dn" }],
    ],
  });

  async function prompt(chatId, step, a = {}) {
    if (step === "phone") {
      return mtg("sendMessage", {
        chat_id: chatId,
        text: "Assalomu alaykum! Express Market'da mebel yig'uvchi usta bo'lib ishlash uchun ro'yxatdan o'ting.\n\nAvval telefon raqamingizni ulashing 👇",
        reply_markup: { keyboard: [[{ text: "📱 Raqamni ulashish", request_contact: true }]], resize_keyboard: true, one_time_keyboard: true },
      });
    }
    if (step === "districts") {
      return mtg("sendMessage", { chat_id: chatId, text: "Qaysi tumanlarda ishlaysiz? Bir nechtasini tanlang:", reply_markup: districtKeyboard(a.districts ?? []) });
    }
    if (step === "samples") {
      return mtg("sendMessage", { chat_id: chatId, text: REG_PROMPTS.samples, reply_markup: { inline_keyboard: [[{ text: "✅ Tayyor", callback_data: "mr:sd" }]] } });
    }
    if (step === "confirm") {
      return mtg("sendMessage", {
        chat_id: chatId,
        text: [
          "Arizangizni tekshiring:",
          `👤 ${a.name} · ${a.phone}`,
          `📍 ${a.districts.join(", ")}`,
          `🛠 Tajriba: ${a.experience} yil`,
          `💬 ${a.about}`,
          `💳 ${maskCard(a.card)} · ${a.holder}`,
          `📷 Rasm, pasport va ${a.sampleIds.length} ta ish namunasi`,
        ].join("\n"),
        reply_markup: { inline_keyboard: [[{ text: "✅ Yuborish", callback_data: "mr:send" }, { text: "🔄 Qaytadan", callback_data: "mr:redo" }]] },
      });
    }
    return mtg("sendMessage", { chat_id: chatId, text: REG_PROMPTS[step], reply_markup: { remove_keyboard: true } });
  }

  const photoOf = (msg) => msg.photo?.at(-1)?.file_id ?? (msg.document?.mime_type?.startsWith("image/") ? msg.document.file_id : null);

  function answer(step, msg) {
    const text = String(msg.text || "").trim();
    if (step === "phone") {
      if (!msg.contact || msg.contact.user_id !== msg.from.id) return { error: "Pastdagi «📱 Raqamni ulashish» tugmasini bosing." };
      return { phone: `+${String(msg.contact.phone_number).replace(/\D/g, "")}` };
    }
    if (step === "name") return text.length >= 3 && text.length <= 80 ? { name: text } : { error: "Ism va familiyani to'liq yozing." };
    if (step === "experience") return /^\d{1,2}$/.test(text) ? { experience: Number(text) } : { error: "Faqat raqam yozing, masalan 5." };
    if (step === "about") return text.length >= 5 ? { about: text.slice(0, 500) } : { error: "Bir-ikki gap yozing." };
    if (step === "card") {
      const n = text.replace(/\D/g, "");
      return /^(8600|9860|4\d{3}|5\d{3}|6262)\d{12}$/.test(n) ? { card: n } : { error: "Karta raqami 16 xonali bo'lsin (8600…, 9860…, 4…, 5…)." };
    }
    if (step === "holder") return text.length >= 3 ? { holder: text.toUpperCase().slice(0, 60) } : { error: "Karta egasining ismini yozing." };
    const photo = photoOf(msg);
    return photo ? { [`${step}FileId`]: photo } : { error: "Rasm yuboring." };
  }

  async function register(msg) {
    const ref = appsCol.doc(String(msg.from.id));
    const a = (await ref.get()).data();
    if (!a || (msg.text === "/start" && a.status !== "pending")) {
      await ref.set({ telegramId: msg.from.id, username: msg.from.username || "", step: "phone", status: "draft", districts: [], sampleIds: [], createdAt: Date.now() });
      return prompt(msg.chat.id, "phone");
    }
    if (a.status === "pending") return mtg("sendMessage", { chat_id: msg.chat.id, text: "⏳ Arizangiz HR bo'limida ko'rib chiqilmoqda. Javob shu yerga keladi." });
    if (a.status !== "draft") return mtg("sendMessage", { chat_id: msg.chat.id, text: "Qayta ro'yxatdan o'tish uchun /start bosing." });
    if (["districts", "confirm"].includes(a.step)) return prompt(msg.chat.id, a.step, a);
    if (a.step === "samples") {
      const photo = photoOf(msg);
      if (!photo) return prompt(msg.chat.id, "samples");
      if (a.sampleIds.length >= 5) return mtg("sendMessage", { chat_id: msg.chat.id, text: "5 ta yetarli. «✅ Tayyor» ni bosing." });
      await ref.update({ sampleIds: [...a.sampleIds, photo] });
      return mtg("sendMessage", { chat_id: msg.chat.id, text: `✔️ ${a.sampleIds.length + 1}-namuna qabul qilindi.`, reply_markup: { inline_keyboard: [[{ text: "✅ Tayyor", callback_data: "mr:sd" }]] } });
    }
    const got = answer(a.step, msg);
    if (got.error) return mtg("sendMessage", { chat_id: msg.chat.id, text: got.error });
    const step = REG_STEPS[REG_STEPS.indexOf(a.step) + 1];
    await ref.update({ ...got, step });
    return prompt(msg.chat.id, step, { ...a, ...got });
  }

  async function regCallback(q, data) {
    const ref = appsCol.doc(String(q.from.id));
    const a = (await ref.get()).data();
    const chat = q.message?.chat.id ?? q.from.id;
    if (!a || a.status !== "draft") return "Ariza topilmadi, /start bosing";
    if (data === "mr:redo") {
      await ref.set({ telegramId: q.from.id, username: q.from.username || "", step: "phone", status: "draft", districts: [], sampleIds: [], createdAt: Date.now() });
      await prompt(chat, "phone");
      return "";
    }
    if (data.startsWith("mr:d:") && a.step === "districts") {
      const d = DISTRICTS[Number(data.slice(5))];
      const districts = a.districts.includes(d) ? a.districts.filter((x) => x !== d) : [...a.districts, d];
      await ref.update({ districts });
      await mtg("editMessageReplyMarkup", { chat_id: chat, message_id: q.message.message_id, reply_markup: districtKeyboard(districts) }).catch(() => {});
      return "";
    }
    if (data === "mr:dn" && a.step === "districts") {
      if (!a.districts.length) return "Kamida bitta tumanni tanlang";
      await ref.update({ step: "experience" });
      await prompt(chat, "experience");
      return "";
    }
    if (data === "mr:sd" && a.step === "samples") {
      if (!a.sampleIds.length) return "Kamida bitta rasm yuboring";
      await ref.update({ step: "card" });
      await prompt(chat, "card");
      return "";
    }
    if (data === "mr:send" && a.step === "confirm") {
      const save = (fileId, name) => ctx.saveBotPhoto(ctx.MASTER_BOT_TOKEN.value(), fileId, `masters/${q.from.id}/${name}-${ctx.uuid()}`);
      const photos = { face: await save(a.faceFileId, "face"), passport: await save(a.passportFileId, "passport"), samples: [] };
      for (const [i, id] of a.sampleIds.entries()) photos.samples.push(await save(id, `sample${i}`));
      await ref.update({ status: "pending", submittedAt: Date.now(), photos });
      for (const admin of ctx.adminIds()) {
        await tg("sendMessage", { chat_id: admin, text: `🆕 Usta arizasi: ${a.name}, ${a.phone}, ${a.districts.join(", ")}.\nPanel → Xodimlar (HR) → Usta arizalari.` }).catch(() => {});
      }
      await mtg("sendMessage", { chat_id: chat, text: "✅ Arizangiz yuborildi. HR bo'limi tekshirib, shu yerga javob beradi." });
      return "Yuborildi";
    }
    return "";
  }

  // ---------- jobs ----------

  const jobText = (j) =>
    [
      `🔧 Yig'ish ishi #${j.number}: ${JOB_STATE[j.status]}`,
      `📅 ${j.date} · ${WINDOWS[j.window] ?? j.window}`,
      `🛋 ${j.lines.join(", ")}`,
      `💰 Yig'ish narxi: ${ctx.formatSum(j.fee)} · sizga: ${ctx.formatSum(j.masterAmount)}`,
      ["accepted", "started", "done"].includes(j.status) ? `👤 ${j.customerName} · 📞 ${j.customerPhone}\n🏠 ${j.address || "manzil yozilmagan"}` : `📍 ${j.areaHint}`,
      j.note ? `💬 ${j.note}` : "",
    ]
      .filter(Boolean)
      .join("\n");

  function jobButtons(j) {
    const rows = {
      requested: [[{ text: "✅ Qabul qilaman", callback_data: `mj:a:${j.id}` }, { text: "❌ Rad etaman", callback_data: `mj:d:${j.id}` }]],
      accepted: [[{ text: "▶️ Boshladim", callback_data: `mj:s:${j.id}` }]],
      started: [[{ text: "✅ Tugatdim", callback_data: `mj:f:${j.id}` }]],
    }[j.status];
    if (rows && j.location && j.status !== "requested") rows.push([{ text: "📍 Xaritada", url: `https://maps.google.com/?q=${j.location.lat},${j.location.lon}` }]);
    return rows ? { inline_keyboard: rows } : undefined;
  }

  const sendJob = (chatId, j) => mtg("sendMessage", { chat_id: chatId, text: jobText(j), reply_markup: jobButtons(j) });

  async function myJobs(chatId, masterId) {
    const snap = await jobsCol.where("masterId", "==", String(masterId)).get();
    const jobs = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((j) => ["requested", "accepted", "started", "done"].includes(j.status));
    if (!jobs.length) return mtg("sendMessage", { chat_id: chatId, text: "Hozircha faol ish yo'q. Mijoz sizni tanlaganda shu yerga xabar keladi.", reply_markup: MENU });
    for (const j of jobs.sort((a, b) => a.date.localeCompare(b.date))) await sendJob(chatId, j);
  }

  // Moves a job from one state to the next for its own master; returns the updated job.
  async function step(jobId, masterId, from, patch) {
    const ref = jobsCol.doc(jobId);
    return db.runTransaction(async (t) => {
      const j = (await t.get(ref)).data();
      if (!j || j.masterId !== String(masterId)) throw new HttpError(404, "Ish topilmadi");
      if (j.status !== from) throw new HttpError(409, `Bu ish hozir «${JOB_STATE[j.status]}» holatida`);
      t.update(ref, patch);
      return { id: jobId, ...j, ...patch };
    });
  }

  // The finished job turns into the buyer's invoice in the main bot.
  async function invoiceBuyer(j) {
    const link = await tg("createInvoiceLink", {
      title: `Mebel yig'ish #${j.number}`,
      description: `${j.masterName}: ${j.lines.join(", ")}`.slice(0, 255),
      payload: `asm:${j.id}`,
      provider_token: ctx.providerToken(),
      currency: "UZS",
      prices: [{ label: "Mebel yig'ish xizmati", amount: j.fee * ctx.UZS_MINOR }],
    });
    await tg("sendMessage", {
      chat_id: j.customerId,
      text: `✅ Usta ${j.masterName} mebelingizni yig'ib bo'ldi (ish #${j.number}).\n💳 Yig'ish xizmati: ${ctx.formatSum(j.fee)}. Iltimos, to'lang:`,
      reply_markup: { inline_keyboard: [[{ text: `💳 ${ctx.formatSum(j.fee)} to'lash`, url: link }]] },
    });
  }

  async function masterCallback(q, data) {
    const master = (await mastersCol.doc(String(q.from.id)).get()).data();
    if (!master || master.status !== "active") return "Siz faol usta emassiz";
    const [, act, id] = data.split(":");
    const chat = q.message?.chat.id ?? q.from.id;
    try {
      if (act === "a") {
        const j = await step(id, q.from.id, "requested", { status: "accepted", acceptedAt: Date.now() });
        await sendJob(chat, j);
        await tg("sendMessage", {
          chat_id: j.customerId,
          text: `👍 Usta ${j.masterName} so'rovingizni qabul qildi: ${j.date}, ${WINDOWS[j.window] ?? j.window}.\n📞 Usta telefoni: ${master.phone}. U siz bilan bog'lanib, aniq vaqtni kelishadi.`,
        }).catch(() => {});
        return "Qabul qilindi";
      }
      if (act === "d") {
        const j = await step(id, q.from.id, "requested", { status: "declined", declinedAt: Date.now() });
        await tg("sendMessage", { chat_id: j.customerId, text: `Usta ${j.masterName} bu vaqtda band. Ilovada boshqa ustani tanlang: 🧾 Mening buyurtmalarim → 🔧 Usta topish.` }).catch(() => {});
        return "Rad etildi";
      }
      if (act === "s") {
        const j = await step(id, q.from.id, "accepted", { status: "started", startedAt: Date.now() });
        await sendJob(chat, j);
        await tg("sendMessage", { chat_id: j.customerId, text: `🔧 Usta ${j.masterName} yig'ishni boshladi.` }).catch(() => {});
        return "Omad!";
      }
      if (act === "f") {
        const j = (await jobsCol.doc(id).get()).data();
        if (!j || j.masterId !== String(q.from.id) || j.status !== "started") return "Bu ish boshlanmagan";
        await mastersCol.doc(String(q.from.id)).update({ awaitingPhoto: id });
        await mtg("sendMessage", { chat_id: chat, text: "📷 Yig'ilgan mebelning rasmini yuboring — shundan keyin mijozga to'lov cheki boradi." });
        return "";
      }
    } catch (err) {
      return err instanceof HttpError ? err.message.slice(0, 190) : "Xatolik";
    }
    return "";
  }

  async function finishWithPhoto(msg, master) {
    const photo = photoOf(msg);
    if (!photo) return mtg("sendMessage", { chat_id: msg.chat.id, text: "📷 Yig'ilgan mebelning rasmini yuboring." });
    const id = master.awaitingPhoto;
    const url = await ctx.saveBotPhoto(ctx.MASTER_BOT_TOKEN.value(), photo, `jobs/${id}/done-${ctx.uuid()}`);
    const j = await step(id, msg.from.id, "started", { status: "done", doneAt: Date.now(), donePhoto: url });
    await mastersCol.doc(String(msg.from.id)).update({ awaitingPhoto: null });
    try {
      await invoiceBuyer(j);
      await mtg("sendMessage", { chat_id: msg.chat.id, text: `👏 Rahmat! Mijozga ${ctx.formatSum(j.fee)} lik to'lov cheki yuborildi. To'lagach, ${ctx.formatSum(j.masterAmount)} kartangizga o'tkaziladi.`, reply_markup: MENU });
    } catch (err) {
      logger.error("assembly invoice failed", err);
      await mtg("sendMessage", { chat_id: msg.chat.id, text: "Ish yakunlandi. Mijozga to'lov cheki tez orada yuboriladi.", reply_markup: MENU });
    }
  }

  async function handleMasterBot(req, res) {
    if (!ctx.sameSecret(req.get("x-telegram-bot-api-secret-token") || "", secret())) throw new HttpError(403, "Forbidden");
    try {
      const q = req.body?.callback_query;
      if (q) {
        const data = String(q.data || "");
        const text = data.startsWith("mr:") ? await regCallback(q, data) : data.startsWith("mj:") ? await masterCallback(q, data) : "";
        await mtg("answerCallbackQuery", { callback_query_id: q.id, text }).catch(() => {});
      }
      const msg = req.body?.message;
      if (msg && msg.chat.type === "private") {
        const master = (await mastersCol.doc(String(msg.from.id)).get()).data();
        if (master?.status === "blocked") await mtg("sendMessage", { chat_id: msg.chat.id, text: "Hisobingiz vaqtincha bloklangan. HR bo'limiga murojaat qiling." });
        else if (master && master.awaitingPhoto && !msg.text) await finishWithPhoto(msg, master);
        else if (master) {
          if (msg.text === "/start") await mtg("sendMessage", { chat_id: msg.chat.id, text: `👋 Salom, ${master.name}! ⭐ ${master.rating ?? "—"} · ${master.jobsDone ?? 0} ta ish.`, reply_markup: MENU });
          await myJobs(msg.chat.id, msg.from.id);
        } else await register(msg);
      }
    } catch (err) {
      logger.error("master bot update failed", err);
    }
    return res.json({ ok: true });
  }

  async function setupMasterBot() {
    try {
      const bot = await mtg("getMe", {});
      await mtg("setWebhook", { url: `${ctx.WEBAPP_URL}/api/masterbot`, secret_token: secret(), allowed_updates: ["message", "callback_query"] });
      await mtg("setMyCommands", { commands: [{ command: "start", description: "Boshlash / ro'yxatdan o'tish" }] });
      return `@${bot.username}`;
    } catch (err) {
      return `ulanmadi: ${err.message}`;
    }
  }

  // ---------- buyer: payment and rating in the main bot ----------

  async function preCheckout(query) {
    const j = (await jobsCol.doc(String(query.invoice_payload).slice(4)).get()).data();
    const ok = j?.status === "done" && j.customerId === query.from.id && query.currency === "UZS" && query.total_amount === j.fee * ctx.UZS_MINOR;
    await tg("answerPreCheckoutQuery", { pre_checkout_query_id: query.id, ok, ...(ok ? {} : { error_message: "Bu to'lov allaqachon qilingan yoki eskirgan." }) });
  }

  async function paid(pay) {
    const id = String(pay.invoice_payload).slice(4);
    const ref = jobsCol.doc(id);
    const j = await db.runTransaction(async (t) => {
      const job = (await t.get(ref)).data();
      if (!job || job.status !== "done") return null;
      const patch = { status: "paid", paidAt: Date.now(), telegramChargeId: pay.telegram_payment_charge_id, providerChargeId: pay.provider_payment_charge_id };
      t.update(ref, patch);
      t.update(mastersCol.doc(job.masterId), { jobsDone: ctx.increment(1), earned: ctx.increment(job.masterAmount), unpaid: ctx.increment(job.masterAmount) });
      return { id, ...job, ...patch };
    });
    if (!j) return;
    await mtg("sendMessage", { chat_id: j.masterId, text: `💰 Mijoz ish #${j.number} uchun to'ladi. ${ctx.formatSum(j.masterAmount)} kartangizga o'tkaziladi.` }).catch(() => {});
    await tg("sendMessage", {
      chat_id: j.customerId,
      text: `Rahmat! To'lov qabul qilindi. Usta ${j.masterName} ishini baholang:`,
      reply_markup: { inline_keyboard: [[1, 2, 3, 4, 5].map((n) => ({ text: `${n} ⭐`, callback_data: `asr:${j.id}:${n}` }))] },
    });
  }

  // Rating buttons; a short written review may follow as the buyer's next message.
  async function rate(q) {
    const [, id, n] = String(q.data).split(":");
    const ref = jobsCol.doc(id);
    const rating = Math.min(5, Math.max(1, Number(n) || 0));
    const j = await db.runTransaction(async (t) => {
      const job = (await t.get(ref)).data();
      if (!job || job.customerId !== q.from.id || job.status !== "paid" || job.rating) return null;
      const mRef = mastersCol.doc(job.masterId);
      const m = (await t.get(mRef)).data() ?? {};
      const count = (m.ratingCount ?? 0) + 1;
      t.update(mRef, { ratingSum: (m.ratingSum ?? 0) + rating, ratingCount: count, rating: Math.round((((m.ratingSum ?? 0) + rating) / count) * 10) / 10 });
      t.update(ref, { rating, ratedAt: Date.now(), awaitingReview: true });
      return job;
    });
    if (!j) return "Baho allaqachon qo'yilgan";
    await tg("sendMessage", { chat_id: q.from.id, text: "Rahmat! Xohlasangiz, usta haqida bir-ikki gap yozing (boshqa mijozlar ko'radi). Yoki /skip." });
    if (rating <= 2) await tg("sendMessage", { chat_id: ctx.ordersChat(), text: `⭐ ${rating}/5: usta ${j.masterName}, ish #${j.number}. Panel → Ustalar.` }).catch(() => {});
    return "Rahmat!";
  }

  async function collectReview(msg) {
    const snap = await jobsCol.where("customerId", "==", msg.from.id).where("awaitingReview", "==", true).get();
    const doc = snap.docs[0];
    if (!doc) return false;
    const text = String(msg.text || "").trim();
    await doc.ref.update({ awaitingReview: false, ...(text && text !== "/skip" ? { review: text.slice(0, 500) } : {}) });
    await tg("sendMessage", { chat_id: msg.chat.id, text: "🙏 Rahmat, fikringiz saqlandi." });
    return true;
  }

  // ---------- HTTP: buyer and panel ----------

  const publicMaster = (id, m, reviews = []) => ({
    id,
    name: m.name,
    photo: m.photos?.face ?? null,
    samples: m.photos?.samples ?? [],
    districts: m.districts,
    experience: m.experience,
    about: m.about,
    rating: m.rating ?? null,
    ratingCount: m.ratingCount ?? 0,
    jobsDone: m.jobsDone ?? 0,
    reviews,
  });

  const jobView = (id, j) => ({ id, ...j });

  async function handleApi(req, res, path, method) {
    if (path === "/api/assembly/settings") {
      if (method === "GET") return res.json(await settings());
      await ctx.requireRole(req, "admin");
      const next = cleanSettings({ ...(await settings()), ...(req.body || {}) });
      await settingsRef.set(next);
      return res.json(next);
    }
    if (path === "/api/masters" && method === "GET") {
      const { user, role } = await ctx.authenticate(req);
      if (!user) throw new HttpError(401, "Ilovani Telegram'da oching");
      const [snap, jobs] = await Promise.all([mastersCol.where("status", "==", "active").get(), jobsCol.where("status", "==", "paid").get()]);
      const reviews = new Map();
      for (const d of jobs.docs.map((x) => x.data()).filter((j) => j.review).sort((a, b) => b.ratedAt - a.ratedAt)) {
        reviews.set(d.masterId, [...(reviews.get(d.masterId) ?? []), { rating: d.rating, text: d.review, at: d.ratedAt }].slice(0, 5));
      }
      const district = String(req.query.district || "");
      const list = snap.docs
        .map((d) => (role === "admin" ? { ...publicMaster(d.id, d.data(), reviews.get(d.id)), admin: masterAdmin(d.id, d.data()) } : publicMaster(d.id, d.data(), reviews.get(d.id))))
        .filter((m) => !district || m.districts.includes(district))
        .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || b.jobsDone - a.jobsDone);
      return res.json({ masters: list, districts: DISTRICTS, windows: WINDOWS, settings: await settings() });
    }
    if (path === "/api/assembly" && method === "POST") {
      const { user } = await ctx.authenticate(req);
      if (!user) throw new HttpError(401, "Ilovani Telegram'da oching");
      const body = req.body || {};
      const orderRef = ctx.ordersCol.doc(String(body.orderId || "-"));
      const o = (await orderRef.get()).data();
      if (!o || o.telegramUserId !== user.id) throw new HttpError(404, "Buyurtma topilmadi");
      const received = o.stage === "delivered" || o.handedAt || (o.orderType === "pickup" && o.stage === "shipped");
      if (!received || o.status === "cancelled") throw new HttpError(409, "Usta mebel qo'lingizga tekkandan keyin chaqiriladi");
      const date = String(body.date || "");
      const today = new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < today || date > new Date(Date.now() + 5 * 3600e3 + 30 * DAY_MS).toISOString().slice(0, 10)) {
        throw new HttpError(400, "Sanani bugundan 30 kungacha tanlang");
      }
      if (!WINDOWS[body.window]) throw new HttpError(400, "Vaqt oralig'ini tanlang");
      const mSnap = await mastersCol.doc(String(body.masterId || "-")).get();
      if (!mSnap.exists || mSnap.data().status !== "active") throw new HttpError(400, "Ustani tanlang");
      const open = await jobsCol.where("orderId", "==", orderRef.id).get();
      if (open.docs.some((d) => ["requested", "accepted", "started", "done"].includes(d.data().status))) throw new HttpError(409, "Bu buyurtmaga usta allaqachon chaqirilgan");
      const s = await settings();
      const fee = assemblyFee(o.goodsTotal ?? o.total, s);
      const m = mSnap.data();
      const ref = jobsCol.doc();
      const job = await db.runTransaction(async (t) => {
        const number = ((await t.get(ctx.countersRef)).data()?.assembly ?? 0) + 1;
        const data = {
          number,
          orderId: orderRef.id,
          orderNumber: o.number ?? null,
          customerId: user.id,
          customerName: o.name,
          customerPhone: o.phone,
          address: o.address ?? "",
          location: o.location ?? null,
          areaHint: o.address ? o.address.split(",")[0].slice(0, 40) : "manzil mijoz bilan kelishiladi",
          lines: o.items.map((i) => `${i.name} × ${i.qty}`),
          masterId: mSnap.id,
          masterName: m.name,
          date,
          window: body.window,
          note: String(body.note || "").trim().slice(0, 300),
          fee,
          commissionPct: s.commission,
          masterAmount: fee - Math.round((fee * s.commission) / 100),
          status: "requested",
          createdAt: Date.now(),
        };
        t.set(ctx.countersRef, { assembly: number }, { merge: true });
        t.set(ref, data);
        return { id: ref.id, ...data };
      });
      await sendJob(job.masterId, job).catch((err) => logger.warn("master offer failed", err));
      return res.status(201).json(jobView(job.id, job));
    }
    if (path === "/api/assembly/mine" && method === "GET") {
      const { user } = await ctx.authenticate(req);
      if (!user) throw new HttpError(401, "Ilovani Telegram'da oching");
      const snap = await jobsCol.where("customerId", "==", user.id).get();
      return res.json(snap.docs.map((d) => jobView(d.id, d.data())));
    }

    // ---- panel ----
    if (path === "/api/assembly/jobs" && method === "GET") {
      await ctx.requireRole(req, "admin");
      const snap = await jobsCol.orderBy("createdAt", "desc").limit(500).get();
      return res.json(snap.docs.map((d) => jobView(d.id, d.data())));
    }
    if (path === "/api/masters/all" && method === "GET") {
      await ctx.requireRole(req, "admin");
      const snap = await mastersCol.get();
      return res.json(snap.docs.map((d) => ({ ...publicMaster(d.id, d.data()), admin: masterAdmin(d.id, d.data()) })));
    }
    if (path === "/api/master-applications" && method === "GET") {
      await ctx.requireRole(req, "admin");
      const snap = await appsCol.where("status", "==", "pending").get();
      return res.json(snap.docs.map((d) => ({ id: d.id, ...d.data(), cardMasked: maskCard(d.data().card) })).sort((a, b) => a.submittedAt - b.submittedAt));
    }
    const appMatch = path.match(/^\/api\/master-applications\/(\d{1,20})\/(approve|reject)$/);
    if (appMatch && method === "POST") {
      const { user } = await ctx.requireRole(req, "admin");
      const [, id, action] = appMatch;
      const ref = appsCol.doc(id);
      const a = (await ref.get()).data();
      if (a?.status !== "pending") throw new HttpError(409, "Ariza allaqachon ko'rib chiqilgan");
      const by = ctx.staffName(user);
      if (action === "reject") {
        const reason = String(req.body?.reason || "").trim().slice(0, 200);
        if (!reason) throw new HttpError(400, "Rad etish sababini yozing");
        await ref.update({ status: "rejected", reviewedAt: Date.now(), reviewedBy: by, rejectReason: reason });
        await mtg("sendMessage", { chat_id: id, text: `❌ Arizangiz rad etildi: ${reason}\nQayta topshirish uchun /start bosing.` }).catch(() => {});
        return res.json({ ok: true });
      }
      await db.runTransaction(async (t) => {
        t.set(mastersCol.doc(id), {
          name: a.name,
          username: a.username,
          phone: a.phone,
          districts: a.districts,
          experience: a.experience,
          about: a.about,
          photos: a.photos,
          card: a.card,
          holder: a.holder,
          status: "active",
          rating: null,
          ratingSum: 0,
          ratingCount: 0,
          jobsDone: 0,
          earned: 0,
          unpaid: 0,
          approvedAt: Date.now(),
          approvedBy: by,
        });
        t.update(ref, { status: "approved", reviewedAt: Date.now(), reviewedBy: by });
      });
      await mtg("sendMessage", {
        chat_id: id,
        text: `🎉 Tabriklaymiz, ${a.name}! Siz Express Market ustasi sifatida qabul qilindingiz. Mijozlar ilovada sizni tanlaganda shu yerga ish taklifi keladi.`,
        reply_markup: MENU,
      }).catch(() => {});
      return res.json({ ok: true });
    }
    const mMatch = path.match(/^\/api\/masters\/(\d{1,20})\/(block|unblock|payout)$/);
    if (mMatch && method === "POST") {
      const { user } = await ctx.requireRole(req, "admin");
      const [, id, action] = mMatch;
      const ref = mastersCol.doc(id);
      const by = ctx.staffName(user);
      if (action !== "payout") {
        const status = action === "block" ? "blocked" : "active";
        await ref.update({ status, statusChangedAt: Date.now(), statusChangedBy: by });
        await mtg("sendMessage", { chat_id: id, text: status === "blocked" ? "⛔ Hisobingiz bloklandi. Savollar bo'lsa, HR bo'limiga murojaat qiling." : "✅ Hisobingiz qayta faollashtirildi.", reply_markup: MENU }).catch(() => {});
        return res.json({ ok: true });
      }
      // Payout: the admin transferred the master's unpaid share to their card; record and zero it.
      const amount = await db.runTransaction(async (t) => {
        const m = (await t.get(ref)).data();
        if (!m || !(m.unpaid > 0)) throw new HttpError(409, "To'lanadigan summa yo'q");
        t.set(payoutsCol.doc(), { masterId: id, masterName: m.name, amount: m.unpaid, card: maskCard(m.card), at: Date.now(), by, note: String(req.body?.note || "").slice(0, 200) });
        t.update(ref, { unpaid: 0, lastPayoutAt: Date.now() });
        return m.unpaid;
      });
      await mtg("sendMessage", { chat_id: id, text: `💳 Kartangizga ${ctx.formatSum(amount)} o'tkazildi. Rahmat!` }).catch(() => {});
      return res.json({ ok: true, amount });
    }
    return null;
  }

  // Card number and passport are for the panel only, never for buyers.
  function masterAdmin(id, m) {
    return { phone: m.phone, username: m.username, card: m.card, cardMasked: maskCard(m.card), holder: m.holder, passport: m.photos?.passport ?? null, status: m.status, earned: m.earned ?? 0, unpaid: m.unpaid ?? 0, approvedAt: m.approvedAt };
  }

  return {
    handleMasterBot,
    setupMasterBot,
    handleApi,
    preCheckout,
    paid,
    rate,
    collectReview,
  };
}
