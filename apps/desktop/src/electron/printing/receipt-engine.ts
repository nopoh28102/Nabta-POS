import type { ReceiptPrintRequest } from "@nabta/contracts";

export function escapeReceiptHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function formatReceiptMoney(minor: number): string {
  return `${minor < 0 ? "−" : ""}${new Intl.NumberFormat("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(minor) / 100)} ج.م`;
}

export function formatQtyForReceipt(qtyMilli: number, unitKind: "PIECE" | "WEIGHT"): string {
  return unitKind === "WEIGHT" ? `${(qtyMilli / 1000).toFixed(3)} كجم` : String(qtyMilli / 1000);
}

export interface ReceiptDimensions {
  paperWidth: "58" | "80";
  printableWidthMm: number;
  sidePaddingMm: number;
}

/**
 * Resolves the physical printable geometry of thermal receipt rolls.
 *
 * NOTE: Thermal receipt printers (Xprinter XP-80, XP-Q808K, POS-80, Epson TM-T20):
 * - 80 mm paper rolls have a physical 72 mm thermal head (576 dots at 203 DPI).
 *   Windows thermal drivers declare PageMediaSize as 72 mm (72,000 microns / 283.25 hundredths of an inch).
 * - 58 mm paper rolls have a physical 48 mm thermal head (384 dots at 203 DPI).
 *   Windows thermal drivers declare PageMediaSize as 48 mm (48,000 microns).
 *
 * If @page or body are declared with the paper roll width (80 mm), Chromium treats the page box as 80 mm wide.
 * When printed onto a 72 mm thermal driver page with RTL direction, Chromium aligns the right edge,
 * displacing the entire canvas 8 mm to the left. This causes the left side of the receipt
 * (prices, currency, dates, box borders) to be clipped off by the physical paper edge,
 * while leaving a 10 mm blank void on the right.
 *
 * Aligning @page and body to the exact printable head width (72 mm / 48 mm) with symmetric side padding
 * guarantees that the receipt is perfectly centered on the paper roll with zero clipping.
 */
export function resolveReceiptDimensions(paperWidth: "58" | "80"): ReceiptDimensions {
  if (paperWidth === "58") {
    return {
      paperWidth: "58",
      printableWidthMm: 48,
      sidePaddingMm: 2.5,
    };
  }
  return {
    paperWidth: "80",
    printableWidthMm: 72,
    sidePaddingMm: 3.5,
  };
}

export function receiptHtml(request: ReceiptPrintRequest, paperWidth: "58" | "80"): string {
  const { sale, storeName } = request;
  const dims = resolveReceiptDimensions(paperWidth);
  const branding = request.branding ?? { logoDataUrl: "", receiptPhone: "", whatsappPhone: "", socialHandle: "", receiptFooter: "شكراً لزيارتكم" };
  const rows = sale.lines.map((line) => `<article class="item"><div class="item-top"><b>${escapeReceiptHtml(line.nameAr)}</b><strong dir="ltr">${escapeReceiptHtml(formatReceiptMoney(line.netMinor))}</strong></div><div class="item-meta"><span dir="ltr">${escapeReceiptHtml(formatQtyForReceipt(line.qtyMilli, line.unitKind))} × ${escapeReceiptHtml(formatReceiptMoney(line.unitPriceMinor))}</span><span>${line.unitKind === "WEIGHT" ? "موزون" : "قطعة"}</span></div></article>`).join("");
  const contacts = [
    branding.receiptPhone ? `<span dir="ltr">☎ ${escapeReceiptHtml(branding.receiptPhone)}</span>` : "",
    branding.whatsappPhone ? `<span dir="ltr">واتساب ${escapeReceiptHtml(branding.whatsappPhone)}</span>` : "",
    branding.socialHandle ? `<span>${escapeReceiptHtml(branding.socialHandle)}</span>` : "",
  ].filter(Boolean).join("<span class=\"contact-separator\">•</span>");
  const mark = branding.logoDataUrl
    ? `<img class="brand-logo" src="${escapeReceiptHtml(branding.logoDataUrl)}" alt="شعار المتجر" />`
    : `<span class="brand-mark" aria-hidden="true">✦</span>`;
  const printedAt = new Intl.DateTimeFormat("ar-EG", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Cairo" }).format(new Date(sale.postedAt));
  const itemCount = new Intl.NumberFormat("ar-EG").format(sale.lines.length);

  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${escapeReceiptHtml(sale.invoiceNo)}</title><style>
    @page { size: ${dims.printableWidthMm}mm auto; margin: 0; }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      width: ${dims.printableWidthMm}mm;
      max-width: ${dims.printableWidthMm}mm;
      color: #111;
      background: #fff;
      font-family: Tahoma, Arial, "Segoe UI", sans-serif;
      font-size: ${paperWidth === "58" ? "8.5" : "9.5"}pt;
      line-height: 1.42;
      -webkit-font-smoothing: none;
    }
    .receipt {
      width: 100%;
      max-width: ${dims.printableWidthMm}mm;
      margin: 0 auto;
      padding: 2.5mm ${dims.sidePaddingMm}mm 3.5mm;
    }
    .rule { height: .7mm; background: #111; margin: 0 0 2mm; }
    header { text-align: center; padding: .3mm 0 2.2mm; }
    .brand-row { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: .6mm; }
    .brand-logo { width: 15mm; height: 15mm; object-fit: contain; border-radius: 2mm; }
    .brand-mark { display: inline-grid; place-items: center; width: 13mm; height: 13mm; border: 1.35px solid #111; border-radius: 50%; color: #111; font-size: 18pt; }
    h1 { font-size: ${paperWidth === "58" ? "16" : "19"}pt; margin: 0; font-weight: 900; letter-spacing: -.35px; }
    .store-subtitle { margin: .2mm 0 1mm; color: #222; font-size: ${paperWidth === "58" ? "8.5" : "9.5"}pt; font-weight: 600; }
    .receipt-kind { display: inline-block; margin-top: 1mm; padding: .7mm 5mm; border: 1.35px solid #111; border-radius: 3mm; font-size: ${paperWidth === "58" ? "10" : "12"}pt; font-weight: 900; }
    .contacts { margin-top: 1.2mm; display: flex; justify-content: center; flex-wrap: wrap; gap: 1mm; color: #333; font-size: 7.8pt; }
    .contact-separator { color: #777; }
    .invoice-box {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 1mm;
      margin-top: 2mm;
      padding: 1.6mm 0;
      border-top: 1px dashed #555;
      border-bottom: 1px dashed #555;
      font-size: 7.8pt;
      text-align: right;
    }
    .invoice-box span { min-width: 0; overflow-wrap: anywhere; }
    .invoice-box span:last-child { text-align: left; padding-left: 0.5mm; }
    .invoice-box b { display: block; margin-top: .2mm; color: #111; font-family: Consolas, monospace; font-size: 8.3pt; }
    .items-title {
      margin: 2.3mm 0 0;
      padding: 1.1mm;
      border-top: 1px solid #111;
      border-bottom: 1px solid #111;
      background: #efefef;
      text-align: center;
      font-size: ${paperWidth === "58" ? "9" : "10.5"}pt;
      color: #111;
      font-weight: 900;
    }
    .items { border-bottom: 1.2px solid #111; }
    .item { padding: 1.9mm 0 1.7mm; border-bottom: 1px dashed #888; }
    .item:last-child { border-bottom: 0; }
    .item-top { display: flex; justify-content: space-between; gap: 2mm; align-items: flex-start; }
    .item-top b { min-width: 0; max-width: 70%; overflow-wrap: anywhere; font-size: ${paperWidth === "58" ? "8.7" : "9.7"}pt; line-height: 1.35; }
    .item-top strong { flex: 0 0 auto; white-space: nowrap; font-size: ${paperWidth === "58" ? "11" : "13"}pt; }
    .item-meta { display: flex; justify-content: space-between; gap: 2mm; margin-top: .5mm; color: #444; font-size: 7.7pt; direction: rtl; }
    .summary { margin-top: 2.5mm; padding-top: 1.8mm; border-top: 1.4px solid #111; display: grid; gap: 1.2mm; }
    .summary p { margin: 0; display: flex; justify-content: space-between; gap: 2mm; }
    .summary p span { min-width: 0; }
    .summary .total {
      margin-top: .8mm;
      padding: 2mm 2.2mm;
      border: 1.5px solid #111;
      border-radius: 2.2mm;
      font-size: ${paperWidth === "58" ? "12" : "14"}pt;
      font-weight: 900;
    }
    .paid-change { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 1.5mm; margin-top: 1.4mm; }
    .paid-change p {
      min-height: 12mm;
      padding: 1.3mm;
      border: 1.2px solid #111;
      border-radius: 2mm;
      background: #fff;
      text-align: center;
      flex-direction: column;
      justify-content: center;
      font-size: 8pt;
    }
    .paid-change b { display: block; margin-top: .5mm; font-size: ${paperWidth === "58" ? "10" : "11"}pt; }
    footer { margin-top: 3mm; padding: 2.2mm 0 1mm; border-top: 1px dashed #555; text-align: center; color: #222; font-size: ${paperWidth === "58" ? "9" : "10.5"}pt; font-weight: 800; }
    footer small { display: block; margin-top: 1mm; color: #555; font-size: 7pt; font-weight: 500; }
    @media print { .receipt { break-inside: avoid; } }
  </style></head><body><article class="receipt"><div class="rule"></div><header><div class="brand-row">${mark}<h1>${escapeReceiptHtml(storeName)}</h1><p class="store-subtitle">مواد غذائية ومنتجات منزلية</p></div><span class="receipt-kind">فاتورة بيع</span>${contacts ? `<div class="contacts">${contacts}</div>` : ""}<div class="invoice-box"><span>رقم الفاتورة<b dir="ltr">${escapeReceiptHtml(sale.invoiceNo)}</b></span><span>تاريخ العملية<b>${escapeReceiptHtml(printedAt)}</b></span></div></header><div class="items-title">تفاصيل المشتريات — ${itemCount} أصناف</div><section class="items">${rows}</section><section class="summary"><p><span>إجمالي الأصناف</span><span dir="ltr">${escapeReceiptHtml(formatReceiptMoney(sale.subtotalMinor))}</span></p>${sale.discountMinor ? `<p><span>الخصم</span><span dir="ltr">− ${escapeReceiptHtml(formatReceiptMoney(sale.discountMinor))}</span></p>` : ""}<p class="total"><span>إجمالي المطلوب</span><span dir="ltr">${escapeReceiptHtml(formatReceiptMoney(sale.totalMinor))}</span></p><div class="paid-change"><p><span>المدفوع</span><b dir="ltr">${escapeReceiptHtml(formatReceiptMoney(sale.paidMinor))}</b></p><p><span>الباقي</span><b dir="ltr">${escapeReceiptHtml(formatReceiptMoney(sale.changeMinor))}</b></p></div></section><footer>✦ ${escapeReceiptHtml(branding.receiptFooter || "شكراً لزيارتكم")} ✦<small>نتمنى لكم دائماً مستلزمات أفضل</small></footer></article></body></html>`;
}
