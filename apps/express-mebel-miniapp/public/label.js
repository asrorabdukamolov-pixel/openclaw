// Barcode labels: `count` units × the product's boxes, each box coded EM<sku>-<box> (CODE128),
// the same code the warehouse screen accepts when picking.
const params = new URLSearchParams(location.search);
const count = Math.max(1, Math.min(200, Number(params.get("count")) || 1));
const info = document.querySelector("#info");

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
        <div class="name">${esc(p.name)}</div>
        <div class="box">Quti ${box}/${boxes}</div>
        <svg></svg>`;
      sheet.append(label);
      JsBarcode(label.querySelector("svg"), code, { format: "CODE128", height: 40, fontSize: 14, margin: 0, displayValue: true });
    }
  }
  info.textContent = `${p.name}: ${count} dona × ${boxes} quti = ${count * boxes} ta etiketka`;
} catch (err) {
  info.textContent = err.message;
}
