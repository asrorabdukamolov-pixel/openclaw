// Barcode labels: `count` units × the product's boxes, each box coded EM<sku>-<box> (CODE128),
// the same code the warehouse screen accepts when picking.
const params = new URLSearchParams(location.search);
const count = Math.max(1, Math.min(200, Number(params.get("count")) || 1));
const info = document.querySelector("#info");

// Roll sizes in mm; "s" fits board edges from 18 mm. The choice is remembered per screen.
const SIZES = { l: [58, 40], m: [58, 30], s: [40, 15] };
const sizeSelect = document.querySelector("#size");
const pageStyle = document.createElement("style");
document.head.append(pageStyle);
const applySize = (key) => {
  const [w, h] = SIZES[key];
  document.body.className = `size-${key}`;
  document.body.style.setProperty("--w", `${w}mm`);
  document.body.style.setProperty("--h", `${h}mm`);
  pageStyle.textContent = `@page { size: ${w}mm ${h}mm; margin: 0; }`;
};
const savedSize = (() => {
  try {
    return localStorage.getItem("em_label_size");
  } catch {
    return null;
  }
})();
sizeSelect.value = SIZES[params.get("size")] ? params.get("size") : SIZES[savedSize] ? savedSize : "l";
applySize(sizeSelect.value);
sizeSelect.onchange = () => {
  applySize(sizeSelect.value);
  try {
    localStorage.setItem("em_label_size", sizeSelect.value);
  } catch {}
};

const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

try {
  // Drafts are visible to paired screens only, so the screen's token goes along.
  const token = (() => {
    try {
      return localStorage.getItem("em_screen_token") || "";
    } catch {
      return "";
    }
  })();
  const res = await fetch(`/api/products/${encodeURIComponent(params.get("id") || "")}`, { headers: { "x-screen-token": token } });
  const p = await res.json();
  if (!res.ok) throw new Error(p.error || "Mahsulot topilmadi");
  if (!p.sku) throw new Error("Mahsulotda SKU yo'q: /api/setup ni bir marta oching");
  const boxes = p.boxes ?? 1;
  const sheet = document.querySelector("#sheet");
  for (let unit = 1; unit <= count; unit++) {
    for (let box = 1; box <= boxes; box++) {
      const code = `EM${p.sku}-${box}`;
      const label = document.createElement("div");
      label.className = "label";
      label.innerHTML = `
        <div class="top"><span>EXPRESS MEBEL</span><span>SKU ${p.sku}</span></div>
        <div class="name"><span>${esc(p.name)}</span><span class="small-box">${box}/${boxes}</span></div>
        <div class="box">Quti ${box}/${boxes}</div>
        <svg preserveAspectRatio="none"></svg>
        <div class="code">${code}</div>`;
      sheet.append(label);
      JsBarcode(label.querySelector("svg"), code, { format: "CODE128", height: 40, margin: 0, displayValue: false });
    }
  }
  info.textContent = `${p.name}: ${count} dona × ${boxes} quti = ${count * boxes} ta etiketka`;
} catch (err) {
  info.textContent = err.message;
}
