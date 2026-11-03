// Express Market HR: employees, attendance and pay for the month (1st to 1st, Tashkent time).
// Salaried employees check in and out in the main bot by sharing their location near the warehouse
// (or office); pay accrues by hours worked: monthly salary / scheduled hours of the month × hours.
// Drivers earn their share of each delivery they handed over (frozen on the order as `driverPay`)
// plus the monthly car-ad bonus once HR approves the photo report sent in the driver bot. Masters
// earn their share of paid assembly jobs (masters.js). Advances and salaries paid are recorded per
// month; cash ones leave the cash desk as "Maosh".

export const HR_DEFAULTS = { workDays: [1, 2, 3, 4, 5, 6], start: "09:00", end: "18:00", radius: 200, office: null, adBonus: 700000 };
const TZ = 5 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const AD_SIDES = { front: "Oldidan", back: "Orqasidan", left: "Chap yonidan", right: "O'ng yonidan" };
const PAY_TYPES = { advance: "Avans", salary: "Oylik", bonus: "Bonus" };
export const CHECK_KEYBOARD = { keyboard: [[{ text: "📍 Keldim / Ketdim", request_location: true }]], resize_keyboard: true };

const dayKey = (ts) => new Date(ts + TZ).toISOString().slice(0, 10);
const monthKey = (ts) => new Date(ts + TZ).toISOString().slice(0, 7);
const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
// UTC timestamp of a Tashkent wall-clock time on a given day.
const at = (date, hhmm) => Date.parse(`${date}T${hhmm}:00Z`) - TZ;

function monthRange(month) {
  const [y, m] = month.split("-").map(Number);
  const from = Date.UTC(y, m - 1, 1) - TZ;
  const to = Date.UTC(y, m, 1) - TZ;
  return { from, to };
}

function monthDays(month) {
  const [y, m] = month.split("-").map(Number);
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
}

// Scheduled hours in the month: working weekdays × the daily span.
function normHours(month, s) {
  const span = (minutes(s.end) - minutes(s.start)) / 60;
  return monthDays(month).filter((d) => s.workDays.includes(new Date(`${d}T00:00:00Z`).getUTCDay())).length * span;
}

// Hours of one attendance day; an open day counts to now (today) or to the scheduled end (past).
function dayHours(a, s, now) {
  if (!a.inAt) return 0;
  const end = a.outAt ?? (a.date === dayKey(now) ? now : Math.max(a.inAt, at(a.date, s.end)));
  return Math.max(0, (end - a.inAt) / HOUR);
}

export function createHr(ctx) {
  const { db, HttpError, tg, logger } = ctx;
  const employeesCol = db.collection("employees");
  const attendanceCol = db.collection("attendance");
  const paymentsCol = db.collection("payPayments");
  const adCol = db.collection("adReports");
  const settingsRef = db.collection("meta").doc("hr");

  async function settings() {
    return { ...HR_DEFAULTS, ...(await settingsRef.get()).data() };
  }

  function cleanSettings(input) {
    const time = (v, name) => {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v))) throw new HttpError(400, `${name}: SS:DD ko'rinishida`);
      return String(v);
    };
    const days = [...new Set((Array.isArray(input.workDays) ? input.workDays : []).map(Number))].filter((d) => d >= 0 && d <= 6).sort();
    if (!days.length) throw new HttpError(400, "Kamida bitta ish kunini tanlang");
    const start = time(input.start, "Ish boshlanishi");
    const end = time(input.end, "Ish tugashi");
    if (minutes(end) <= minutes(start)) throw new HttpError(400, "Ish tugashi boshlanishidan keyin bo'lsin");
    const radius = Math.round(Number(input.radius));
    if (!(radius >= 30 && radius <= 5000)) throw new HttpError(400, "Radius 30–5000 m bo'lsin");
    const adBonus = Math.round(Number(input.adBonus));
    if (!(adBonus >= 0 && adBonus <= 100_000_000)) throw new HttpError(400, "Reklama bonusi noto'g'ri");
    return { workDays: days, start, end, radius, adBonus, office: input.office ? ctx.parseLocation(input.office) : null, updatedAt: Date.now() };
  }

  // A personal schedule overrides the company one for norm hours and lateness (part-time, shifts).
  function cleanSchedule(input) {
    if (!input) return null;
    const days = [...new Set((Array.isArray(input.workDays) ? input.workDays : []).map(Number))].filter((d) => d >= 0 && d <= 6).sort();
    const ok = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v));
    if (!days.length || !ok(input.start) || !ok(input.end) || minutes(input.end) <= minutes(input.start)) throw new HttpError(400, "Shaxsiy ish jadvali noto'g'ri: kunlar va vaqtni tekshiring");
    return { workDays: days, start: input.start, end: input.end };
  }

  const scheduleOf = (e, s) => ({ ...s, ...(e.schedule ?? {}) });

  function cleanEmployee(input) {
    const name = String(input.name || "").trim().slice(0, 80);
    if (!name) throw new HttpError(400, "Ismni kiriting");
    const salary = Math.round(Number(input.salary));
    if (!(salary >= 0 && salary <= 1_000_000_000)) throw new HttpError(400, "Oylik noto'g'ri");
    return {
      name,
      position: String(input.position || "").trim().slice(0, 60),
      phone: String(input.phone || "").trim().slice(0, 30),
      salary,
      schedule: cleanSchedule(input.schedule),
      active: input.active !== false,
      updatedAt: Date.now(),
    };
  }

  // ---------- main bot: linking and check-in / check-out ----------

  async function linkEmployee(msg, code) {
    const snap = await employeesCol.where("inviteCode", "==", code).limit(1).get();
    const doc = snap.docs[0];
    if (!doc || doc.data().inviteExpiresAt < Date.now()) {
      return tg("sendMessage", { chat_id: msg.chat.id, text: "⚠️ Havola eskirgan. HR bo'limidan yangisini so'rang." });
    }
    await doc.ref.update({ telegramId: msg.from.id, username: msg.from.username || "", inviteCode: null, linkedAt: Date.now() });
    const s = await settings();
    return tg("sendMessage", {
      chat_id: msg.chat.id,
      text: `✅ ${doc.data().name}, siz Express Market xodimi sifatida ulandingiz.\n\nIshga kelganda va ketayotganda pastdagi «📍 Keldim / Ketdim» tugmasini bosing — joylashuvingiz ish joyidan ${s.radius} m ichida bo'lishi kerak.\nIsh vaqti: ${s.start}–${s.end}.`,
      reply_markup: CHECK_KEYBOARD,
    });
  }

  // A shared location from a linked employee: first one of the day checks in, the next checks out.
  async function handleLocation(msg) {
    const snap = await employeesCol.where("telegramId", "==", msg.from.id).limit(1).get();
    const emp = snap.docs[0];
    if (!emp || emp.data().active === false) return false;
    const reply = (text) => tg("sendMessage", { chat_id: msg.chat.id, text, reply_markup: CHECK_KEYBOARD });
    if (msg.forward_origin || msg.forward_date) return reply("Joylashuvni tugma orqali yuboring, uzatilgan xabar qabul qilinmaydi."), true;
    const s = await settings();
    const places = [ctx.warehouse && (await ctx.warehouse()), s.office].filter(Boolean);
    if (!places.length) return reply("Ish joyi lokatsiyasi hali kiritilmagan. HR bilan bog'laning."), true;
    const here = { lat: msg.location.latitude, lon: msg.location.longitude };
    const dist = Math.round(Math.min(...places.map((p) => ctx.distanceM(p, here))));
    if (dist > s.radius) return reply(`❌ Siz ish joyidan ${dist} m uzoqdasiz (ruxsat: ${s.radius} m). Ish joyiga kelib qayta bosing.`), true;
    const now = Date.now();
    const date = dayKey(now);
    const ref = attendanceCol.doc(`${emp.id}_${date}`);
    const own = scheduleOf(emp.data(), s);
    const a = (await ref.get()).data();
    const hhmm = new Date(now + TZ).toISOString().slice(11, 16);
    if (!a) {
      const late = Math.max(0, Math.round((now - at(date, own.start)) / 60000));
      await ref.set({ employeeId: emp.id, date, inAt: now, inDist: dist, lateMin: late, outAt: null });
      return reply(`🟢 Keldingiz: ${hhmm}.${late > 0 ? ` ⏰ ${late} daqiqa kechikish.` : " Vaqtida 👍"}`), true;
    }
    if (a.outAt) return reply(`Bugun allaqachon ketgansiz (${new Date(a.outAt + TZ).toISOString().slice(11, 16)}). Ertaga ko'rishguncha!`), true;
    await ref.update({ outAt: now, outDist: dist });
    const h = (now - a.inAt) / HOUR;
    return reply(`🔴 Ketdingiz: ${hhmm}. Bugun ${Math.floor(h)} soat ${Math.round((h % 1) * 60)} daqiqa ishladingiz.`), true;
  }

  // ---------- driver bot: monthly car-ad photo report ----------

  async function adStart(chatId, driverId, dtg) {
    const month = monthKey(Date.now());
    const ref = adCol.doc(`${driverId}_${month}`);
    const r = (await ref.get()).data();
    if (r && r.status !== "rejected" && r.status !== "draft") {
      return dtg("sendMessage", { chat_id: chatId, text: r.status === "approved" ? "✅ Bu oy reklama hisobotingiz tasdiqlangan." : "⏳ Bu oy hisobotingiz HR'da ko'rib chiqilmoqda." });
    }
    await ref.set({ driverId: String(driverId), month, status: "draft", photos: {}, createdAt: Date.now() });
    return dtg("sendMessage", { chat_id: chatId, text: `📸 Reklama hisoboti (${month}). Mashinangizni 4 tomondan rasmga oling, reklama aniq ko'rinsin.\n\n1/4: ${AD_SIDES.front}:` });
  }

  // Returns true when the photo belonged to an open ad report.
  async function adPhoto(msg, driver, dtg) {
    const ref = adCol.doc(`${msg.from.id}_${monthKey(Date.now())}`);
    const r = (await ref.get()).data();
    if (!r || r.status !== "draft") return false;
    const photo = msg.photo?.at(-1)?.file_id;
    if (!photo) return false;
    const sides = Object.keys(AD_SIDES);
    const side = sides.find((k) => !r.photos[k]);
    const url = await ctx.saveBotPhoto(ctx.driverToken(), photo, `ads/${msg.from.id}/${r.month}-${side}-${ctx.uuid()}`);
    const photos = { ...r.photos, [side]: url };
    const next = sides.find((k) => !photos[k]);
    if (next) {
      await ref.update({ photos });
      await dtg("sendMessage", { chat_id: msg.chat.id, text: `✔️ Qabul qilindi. ${sides.indexOf(next) + 1}/4: ${AD_SIDES[next]}:` });
      return true;
    }
    await ref.update({ photos, status: "pending", submittedAt: Date.now(), driverName: driver.name });
    await dtg("sendMessage", { chat_id: msg.chat.id, text: "✅ Hisobot yuborildi. HR tasdiqlagach, bonus shu oy hisobingizga qo'shiladi." });
    for (const admin of ctx.adminIds()) {
      await tg("sendMessage", { chat_id: admin, text: `📸 Reklama hisoboti: ${driver.name} (${r.month}). Panel → Xodimlar (HR).` }).catch(() => {});
    }
    return true;
  }

  // ---------- pay summary ----------

  async function summary(month) {
    const s = await settings();
    const now = Date.now();
    const { from, to } = monthRange(month);
    const [emps, att, drivers, delivered, ads, masters, jobs, payouts, pays] = await Promise.all([
      employeesCol.get(),
      attendanceCol.where("date", ">=", `${month}-01`).where("date", "<=", `${month}-31`).get(),
      ctx.staffCol.where("role", "==", "driver").get(),
      ctx.ordersCol.where("handedAt", ">=", from).where("handedAt", "<", to).get(),
      adCol.where("month", "==", month).get(),
      db.collection("masters").get(),
      db.collection("assemblyJobs").where("paidAt", ">=", from).where("paidAt", "<", to).get(),
      db.collection("masterPayouts").where("at", ">=", from).where("at", "<", to).get(),
      paymentsCol.where("month", "==", month).get(),
    ]);
    const paid = new Map();
    for (const p of pays.docs.map((d) => d.data())) paid.set(p.personKey, (paid.get(p.personKey) || 0) + p.amount);
    const companyNorm = normHours(month, s);
    const vehicles = new Map((await db.collection("vehicles").get()).docs.map((v) => [v.id, v.data()]));
    const rows = [];
    for (const e of emps.docs) {
      const d = e.data();
      const own = scheduleOf(d, s);
      const norm = normHours(month, own);
      const days = att.docs.map((x) => x.data()).filter((a) => a.employeeId === e.id);
      const hours = days.reduce((n, a) => n + dayHours(a, own, now), 0);
      const accrued = norm ? Math.round((hours * d.salary) / norm) : 0;
      const key = `emp:${e.id}`;
      rows.push({
        key,
        kind: "employee",
        name: d.name,
        photo: d.photo ?? null,
        position: d.position || "Xodim",
        active: d.active !== false,
        linked: Boolean(d.telegramId),
        work: `${days.length} kun · ${Math.round(hours * 10) / 10} soat${days.some((a) => a.lateMin > 0) ? ` · ${days.filter((a) => a.lateMin > 0).length} kechikish` : ""}`,
        accrued,
        bonus: 0,
        paid: paid.get(key) || 0,
        detail: { salary: d.salary, normHours: norm, hours, rate: norm ? Math.round(d.salary / norm) : 0, schedule: d.schedule ? `${own.start}–${own.end}` : null },
      });
    }
    const handed = delivered.docs.map((x) => ({ id: x.id, ...x.data() }));
    for (const dr of drivers.docs) {
      const mine = handed.filter((o) => o.handedById === dr.id);
      const earned = mine.reduce((n, o) => n + (o.driverPay ?? 0), 0);
      const km = mine.reduce((n, o) => n + (o.delivery?.km ?? 0), 0);
      const ad = ads.docs.map((x) => x.data()).find((r) => r.driverId === dr.id && r.status === "approved");
      const key = `drv:${dr.id}`;
      const car = vehicles.get(dr.data().vehicleId);
      rows.push({
        key,
        kind: "driver",
        name: dr.data().name,
        photo: dr.data().photo ?? dr.data().photos?.withCar ?? null,
        vehicle: car ? [car.name, car.plate].filter(Boolean).join(" · ") : null,
        position: dr.data().employment === "staff" ? "Haydovchi (shtatda)" : "Haydovchi (yollanma)",
        active: true,
        work: `${mine.length} ta manzil · ${Math.round(km)} km${dr.data().rating ? ` · ⭐ ${dr.data().rating}` : ""}`,
        accrued: earned,
        bonus: ad ? ad.amount : 0,
        paid: paid.get(key) || 0,
        detail: { deliveries: mine.length, km },
      });
    }
    const jobList = jobs.docs.map((x) => x.data());
    const payoutList = payouts.docs.map((x) => x.data());
    for (const m of masters.docs) {
      const mine = jobList.filter((j) => j.masterId === m.id);
      rows.push({
        key: `mst:${m.id}`,
        kind: "master",
        name: m.data().name,
        photo: m.data().photos?.face ?? null,
        position: "Usta (ishbay)",
        active: m.data().status === "active",
        work: `${mine.length} ta ish${m.data().rating ? ` · ⭐ ${m.data().rating}` : ""}`,
        accrued: mine.reduce((n, j) => n + j.masterAmount, 0),
        bonus: 0,
        paid: payoutList.filter((p) => p.masterId === m.id).reduce((n, p) => n + p.amount, 0),
        detail: { unpaidAll: m.data().unpaid ?? 0 },
      });
    }
    for (const r of rows) r.balance = r.accrued + r.bonus - r.paid;
    return { month, settings: s, normHours: companyNorm, rows };
  }

  async function person(key, month) {
    const s = await settings();
    const now = Date.now();
    const { from, to } = monthRange(month);
    const [kind, id] = key.split(":");
    const pays = (await paymentsCol.where("personKey", "==", key).get()).docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => b.at - a.at);
    if (kind === "emp") {
      const e = (await employeesCol.doc(id).get()).data();
      if (!e) throw new HttpError(404, "Xodim topilmadi");
      const att = (await attendanceCol.where("employeeId", "==", id).get()).docs.map((d) => d.data()).filter((a) => a.date.startsWith(month)).sort((a, b) => a.date.localeCompare(b.date));
      const own = scheduleOf(e, s);
      return { kind, employee: { id, ...e, inviteCode: undefined }, attendance: att.map((a) => ({ ...a, hours: Math.round(dayHours(a, own, now) * 100) / 100, open: !a.outAt })), payments: pays, settings: own, company: s };
    }
    if (kind === "drv") {
      const orders = (await ctx.ordersCol.where("handedById", "==", id).get()).docs
        .map((d) => d.data())
        .filter((o) => o.handedAt >= from && o.handedAt < to)
        .sort((a, b) => b.handedAt - a.handedAt)
        .map((o) => ({ number: o.number, name: o.name, at: o.handedAt, km: o.delivery?.km ?? null, fee: (o.delivery?.total ?? 0) + (o.retryFees ?? 0), pay: o.driverPay ?? 0, cash: o.cashCollected ?? 0, rating: o.driverRating ?? null }));
      const ads = (await adCol.where("driverId", "==", id).get()).docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => b.month.localeCompare(a.month));
      const staff = (await ctx.staffCol.doc(id).get()).data() ?? {};
      const vehicles = (await db.collection("vehicles").get()).docs.map((v) => ({ id: v.id, ...v.data() }));
      const { awaitingCash, ...profile } = staff;
      return { kind, profile: { id, ...profile }, vehicle: vehicles.find((v) => v.id === staff.vehicleId) ?? null, vehicles, deliveries: orders, ads, payments: pays };
    }
    throw new HttpError(400, "Ustalar tarixi «Ustalar» bo'limida");
  }

  async function handleApi(req, res, path, method) {
    if (!path.startsWith("/api/hr/")) return null;
    const { user } = await ctx.requireRole(req, "admin");
    const by = ctx.staffName(user);
    const body = req.body || {};
    if (path === "/api/hr/settings") {
      if (method === "GET") return res.json(await settings());
      const next = cleanSettings({ ...(await settings()), ...body });
      await settingsRef.set(next);
      return res.json(next);
    }
    if (path === "/api/hr/summary" && method === "GET") {
      const month = /^\d{4}-\d{2}$/.test(String(req.query.month)) ? String(req.query.month) : monthKey(Date.now());
      return res.json(await summary(month));
    }
    if (path === "/api/hr/person" && method === "GET") {
      const month = /^\d{4}-\d{2}$/.test(String(req.query.month)) ? String(req.query.month) : monthKey(Date.now());
      return res.json(await person(String(req.query.key || ""), month));
    }
    if (path === "/api/hr/employees" && method === "POST") {
      const ref = employeesCol.doc();
      const data = { ...cleanEmployee(body), telegramId: null, createdAt: Date.now(), createdBy: by };
      await ref.set(data);
      return res.status(201).json({ id: ref.id, ...data });
    }
    const emp = path.match(/^\/api\/hr\/employees\/([\w-]{1,64})(?:\/(invite))?$/);
    if (emp && method === "PUT" && !emp[2]) {
      const data = cleanEmployee(body);
      await employeesCol.doc(emp[1]).update(data);
      return res.json({ id: emp[1], ...data });
    }
    if (emp && emp[2] === "invite" && method === "POST") {
      const code = ctx.uuid().replace(/-/g, "").slice(0, 20);
      await employeesCol.doc(emp[1]).update({ inviteCode: code, inviteExpiresAt: Date.now() + 24 * HOUR });
      return res.json({ link: `https://t.me/${await ctx.botUsername()}?start=emp_${code}` });
    }
    if (path === "/api/hr/attendance" && method === "POST") {
      // HR correction of a day (forgotten check-out, a day off the system); kept with who and why.
      const id = String(body.employeeId || "");
      const date = String(body.date || "");
      const empDoc = (await employeesCol.doc(id).get()).data();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !empDoc) throw new HttpError(400, "Xodim va sanani tanlang");
      const time = (v) => (/^\d{2}:\d{2}$/.test(String(v)) ? at(date, String(v)) : null);
      const inAt = time(body.in);
      const outAt = time(body.out);
      if (!inAt || (outAt && outAt <= inAt)) throw new HttpError(400, "Kelish va ketish vaqtini to'g'ri kiriting");
      const note = String(body.note || "").trim().slice(0, 200);
      if (!note) throw new HttpError(400, "Tuzatish sababini yozing");
      const own = scheduleOf(empDoc, await settings());
      await attendanceCol.doc(`${id}_${date}`).set({ employeeId: id, date, inAt, outAt, lateMin: Math.max(0, Math.round((inAt - at(date, own.start)) / 60000)), corrected: { by, at: Date.now(), note } });
      return res.json({ ok: true });
    }
    if (path === "/api/hr/pay" && method === "POST") {
      const key = String(body.key || "");
      if (!/^(emp|drv):[\w-]{1,64}$/.test(key)) throw new HttpError(400, "Xodimni tanlang (ustalarga to'lov «Ustalar» bo'limida)");
      const type = PAY_TYPES[body.type] ? body.type : null;
      if (!type) throw new HttpError(400, "To'lov turini tanlang");
      const amount = Math.round(Number(body.amount));
      if (!(amount > 0 && amount <= 1_000_000_000)) throw new HttpError(400, "Summani kiriting");
      const month = /^\d{4}-\d{2}$/.test(String(body.month)) ? String(body.month) : monthKey(Date.now());
      const from = body.from === "cash" ? "cash" : "card";
      const name = String(body.name || "").slice(0, 80);
      await db.runTransaction(async (t) => {
        if (from === "cash") {
          const cash = await t.get(ctx.cashRef);
          ctx.bookCash(t, cash.data()?.balance ?? 0, { type: "out", category: "salary", amount, note: `${PAY_TYPES[type]}: ${name} (${month})`, by });
        }
        t.set(paymentsCol.doc(), { personKey: key, name, month, type, amount, from, note: String(body.note || "").slice(0, 200), at: Date.now(), by });
      });
      return res.json({ ok: true });
    }
    // Photos and documents kept on a person or a car: an employee, a driver or a vehicle.
    if ((path === "/api/hr/files" || path === "/api/hr/files/remove") && method === "POST") {
      const m = /^(emp|drv|veh):([\w-]{1,64})$/.exec(String(body.target || ""));
      if (!m) throw new HttpError(400, "Kimga yoki qaysi mashinaga yuklanayotgani noma'lum");
      const ref = { emp: employeesCol, drv: ctx.staffCol, veh: db.collection("vehicles") }[m[1]].doc(m[2]);
      const doc = (await ref.get()).data();
      if (!doc) throw new HttpError(404, "Topilmadi");
      if (path.endsWith("/remove")) {
        await ref.update({ docs: (doc.docs ?? []).filter((d) => d.url !== body.url) });
        return res.json({ ok: true });
      }
      const f = /^data:(image\/(?:jpeg|png|webp)|application\/pdf);base64,(.+)$/.exec(String(body.dataUrl || ""));
      if (!f) throw new HttpError(400, "Faqat rasm (JPG, PNG, WEBP) yoki PDF");
      const buffer = Buffer.from(f[2], "base64");
      if (buffer.length > 6 * 1024 * 1024) throw new HttpError(400, "Fayl 6 MB dan katta bo'lmasin");
      const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" }[f[1]];
      const url = await ctx.saveBuffer(buffer, `hr/${m[1]}-${m[2]}/${ctx.uuid()}.${ext}`, f[1]);
      if (body.role === "photo") await ref.update({ photo: url });
      else {
        const name = String(body.name || "Hujjat").trim().slice(0, 80);
        await ref.update({ docs: [...(doc.docs ?? []), { name, url, type: f[1], at: Date.now(), by }] });
      }
      return res.json({ ok: true, url });
    }
    if (path === "/api/hr/ad-reports" && method === "GET") {
      const snap = await adCol.where("status", "==", "pending").get();
      return res.json(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    }
    const ad = path.match(/^\/api\/hr\/ad-reports\/([\w-]{1,80})\/(approve|reject)$/);
    if (ad && method === "POST") {
      const ref = adCol.doc(ad[1]);
      const r = (await ref.get()).data();
      if (r?.status !== "pending") throw new HttpError(409, "Hisobot ko'rib chiqilgan");
      const s = await settings();
      const ok = ad[2] === "approve";
      const reason = String(body.reason || "").trim().slice(0, 200);
      if (!ok && !reason) throw new HttpError(400, "Rad etish sababini yozing");
      await ref.update({ status: ok ? "approved" : "rejected", amount: ok ? s.adBonus : 0, reviewedAt: Date.now(), reviewedBy: by, rejectReason: reason || null });
      await ctx.notifyDriver(r.driverId, ok ? `✅ Reklama hisobotingiz tasdiqlandi: ${ctx.formatSum(s.adBonus)} bonus ${r.month} oyiga qo'shildi.` : `❌ Reklama hisoboti rad etildi: ${reason}. Rasmlarni qayta yuboring: «📸 Reklama hisoboti».`);
      return res.json({ ok: true });
    }
    return null;
  }

  return { handleApi, linkEmployee, handleLocation, adStart, adPhoto, settings };
}
