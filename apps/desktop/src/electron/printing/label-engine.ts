import bwipjs from "bwip-js";

export type LabelBarcodeKind = "EAN13" | "EAN8" | "CODE128";

export interface LabelPrinterProfile {
  model: "XP-233B";
  dpi: 203;
  widthMm: number;
  heightMm: number;
  gapMm: number;
  speedMmPerSecond: number;
  density: number;
  direction: 0 | 1;
  offsetXmm: number;
  offsetYmm: number;
  mediaType: "GAP";
  renderMode: "RASTER" | "NATIVE_TSPL";
  calibrationConfirmed: boolean;
}

export interface LabelPrintContent {
  storeName: string;
  name: string;
  barcode: string;
  priceMinor: number;
  copies: number;
}

export interface LabelLayout {
  widthDots: number;
  heightDots: number;
  bytesPerRow: number;
  safeMarginDots: number;
  isCompact: boolean;
  text: { x: number; y: number; width: number; height: number; nameWidth: number; priceWidth: number };
  barcode: { x: number; y: number; width: number; height: number; quietZoneDots: number; narrowBarDots: number };
}

export const DEFAULT_XP233B_PROFILE: LabelPrinterProfile = {
  model: "XP-233B",
  dpi: 203,
  // 50 x 20 mm is the estimated physical label size on the cashier XP-233B.
  // 2 mm is the standard physical gap between labels.
  widthMm: 50,
  heightMm: 20,
  gapMm: 2,
  speedMmPerSecond: 50.8,
  density: 8,
  direction: 1,
  offsetXmm: 0,
  offsetYmm: 0,
  mediaType: "GAP",
  renderMode: "RASTER",
  calibrationConfirmed: false,
};

export function mmToDots(mm: number, dpi = 203): number {
  if (!Number.isFinite(mm) || mm <= 0 || !Number.isFinite(dpi) || dpi <= 0) {
    throw new Error("Invalid physical label dimension");
  }
  return Math.round((mm * dpi) / 25.4);
}

export function dotsToMm(dots: number, dpi = 203): number {
  return (dots * 25.4) / dpi;
}

/**
 * Standard TSPL BITMAP protocol polarity:
 * 0: White dot (thermal head off, paper color remains white).
 * 1: Black dot (thermal head on, heats paper to print black).
 *
 * NOTE: Chromium monochrome rasterizer sets black ink pixels as 1 and white
 * background as 0. Therefore, the raw ink bitmap already matches the TSPL wire
 * format. Inverting bits (^ 0xff) causes the entire sticker background to turn
 * solid black and texts to turn white.
 */
export function encodeXp233bTsplBitmap(inkBitmap: Buffer, invert = false): Buffer {
  if (!invert) {
    return Buffer.from(inkBitmap);
  }
  const encoded = Buffer.allocUnsafe(inkBitmap.length);
  for (let index = 0; index < inkBitmap.length; index += 1) {
    encoded[index] = inkBitmap[index]! ^ 0xff;
  }
  return encoded;
}

function isWithin(value: number, minimum: number, maximum: number): boolean {
  return Number.isFinite(value) && value >= minimum && value <= maximum;
}

export function validateLabelPrinterProfile(profile: LabelPrinterProfile): void {
  if (profile.model !== "XP-233B" || profile.dpi !== 203) {
    throw new Error("Unsupported label printer profile");
  }
  // XP-233B accepts 20–60 mm media, but its usable thermal print width is 56 mm.
  if (!isWithin(profile.widthMm, 20, 56)) {
    throw new Error("Label width must stay within the XP-233B printable width (20–56 mm)");
  }
  if (!isWithin(profile.heightMm, 10, 150)) {
    throw new Error("Label height must be between 10 and 150 mm");
  }
  if (!isWithin(profile.gapMm, 0.5, 10)) {
    throw new Error("Label gap must be between 0.5 and 10 mm");
  }
  if (!isWithin(profile.speedMmPerSecond, 25.4, 127)) {
    throw new Error("Label speed must be between 25.4 and 127 mm/s");
  }
  if (!Number.isInteger(profile.density) || profile.density < 0 || profile.density > 15) {
    throw new Error("Label density must be an integer from 0 to 15");
  }
  if (profile.direction !== 0 && profile.direction !== 1) {
    throw new Error("Label direction must be 0 (normal) or 1 (reversed 180°)");
  }
  if (!isWithin(profile.offsetXmm, -10, 10) || !isWithin(profile.offsetYmm, -10, 10)) {
    throw new Error("Label offsets must be between -10 and 10 mm");
  }
  if (profile.mediaType !== "GAP") {
    throw new Error("Only gap media is supported by this profile");
  }
  if (profile.renderMode !== "RASTER" && profile.renderMode !== "NATIVE_TSPL") {
    throw new Error("Render mode must be RASTER or NATIVE_TSPL");
  }
}

export function ean13CheckDigit(value: string): number {
  let sum = 0;
  for (let index = 0; index < 12; index += 1) {
    sum += Number(value[index]) * (index % 2 === 0 ? 1 : 3);
  }
  return (10 - (sum % 10)) % 10;
}

export function isValidEan13(value: string): boolean {
  if (!/^\d{13}$/u.test(value)) return false;
  return ean13CheckDigit(value) === Number(value[12]);
}

export function ean8CheckDigit(value: string): number {
  let sum = 0;
  for (let index = 0; index < 7; index += 1) {
    sum += Number(value[index]) * (index % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

export function isValidEan8(value: string): boolean {
  if (!/^\d{8}$/u.test(value)) return false;
  return ean8CheckDigit(value) === Number(value[7]);
}

/**
 * Resolves the appropriate barcode symbology for the given code.
 *
 * NOTE: If a 13-digit code has a leading zero (UPC-A format), or has an invalid
 * EAN-13 check digit, we encode it as Code 128 rather than standard EAN13.
 * This guarantees thermal printer firmware (like XP-233B TSPL) never strips
 * the leading zero or alters the printed digits.
 */
export function resolveLabelBarcodeKind(value: string): LabelBarcodeKind {
  if (value.startsWith("0") && /^\d+$/u.test(value)) {
    return "CODE128";
  }
  if (isValidEan13(value)) {
    return "EAN13";
  }
  if (isValidEan8(value)) {
    return "EAN8";
  }
  if (/^[\x20-\x7e]{1,48}$/u.test(value)) {
    return "CODE128";
  }
  throw new Error("Barcode contains characters unsupported by standard retail symbologies (Code 128 / EAN)");
}

export function createLabelLayout(profile: LabelPrinterProfile, barcode: string): LabelLayout {
  validateLabelPrinterProfile(profile);
  const widthDots = mmToDots(profile.widthMm, profile.dpi);
  const heightDots = mmToDots(profile.heightMm, profile.dpi);
  const isCompact = heightDots <= 180; // Labels <= 22 mm height (like 50x20)

  // Safe physical margins from label edges to account for label roll wandering
  const safeMarginDots = Math.max(mmToDots(1.2, profile.dpi), 10);
  const printableWidth = widthDots - safeMarginDots * 2;
  const printableHeight = heightDots - safeMarginDots * 2;

  const barcodeKind = resolveLabelBarcodeKind(barcode);
  const quietZoneDots = Math.max(mmToDots(2.0, profile.dpi), 16);
  const narrowBarDots = 2; // 2 dots = 0.25 mm at 203 DPI, optimal for retail CCD & laser scanners

  // Estimated total module width of the barcode
  const isAllDigits = /^\d+$/u.test(barcode);
  const estimatedModules = barcodeKind === "EAN13"
    ? 95
    : barcodeKind === "EAN8"
      ? 67
      : isAllDigits
        ? Math.ceil(barcode.length / 2) * 11 + 35
        : (barcode.length + 3) * 11;
  const barsWidth = estimatedModules * narrowBarDots;
  const barcodeWidth = barsWidth + quietZoneDots * 2;
  if (barcodeWidth > printableWidth) {
    // If Code 128 is wide, verify if 1-dot narrow bar fits safely
    const fallbackNarrowBar = 1;
    const fallbackWidth = estimatedModules * fallbackNarrowBar + quietZoneDots * 2;
    if (fallbackWidth > printableWidth) {
      throw new Error("Barcode is too wide for the calibrated label while preserving quiet zones");
    }
  }

  // Calculate vertical proportions
  let textHeight: number;
  let barcodeHeight: number;

  if (isCompact) {
    // Compact layout (e.g. 50x20 mm):
    // Top area for Product Name & Price: ~42-46 dots
    // Barcode area: ~60-68 dots
    // Barcode digits: ~16 dots
    textHeight = Math.min(Math.floor(printableHeight * 0.35), 48);
    barcodeHeight = Math.max(mmToDots(6.0, profile.dpi), Math.min(mmToDots(9.0, profile.dpi), printableHeight - textHeight - 24));
  } else {
    // Standard / Large layout (e.g. 50x30 mm, 58x40 mm):
    textHeight = Math.floor(printableHeight * 0.42);
    barcodeHeight = Math.max(mmToDots(8.0, profile.dpi), Math.min(mmToDots(14.0, profile.dpi), printableHeight - textHeight - 26));
  }

  if (textHeight < 20 || barcodeHeight < 36) {
    throw new Error("Label height is too small to render legible Arabic text and a scannable barcode");
  }

  const nameWidth = Math.floor(printableWidth * 0.64);
  const priceWidth = printableWidth - nameWidth - 8;
  const barcodeY = safeMarginDots + textHeight + 4;

  return {
    widthDots,
    heightDots,
    bytesPerRow: Math.ceil(widthDots / 8),
    safeMarginDots,
    isCompact,
    text: {
      x: safeMarginDots,
      y: safeMarginDots,
      width: printableWidth,
      height: textHeight,
      nameWidth,
      priceWidth,
    },
    barcode: {
      x: Math.max(safeMarginDots, Math.round((widthDots - barsWidth) / 2)),
      y: barcodeY,
      width: Math.min(barsWidth, printableWidth),
      height: barcodeHeight,
      quietZoneDots,
      narrowBarDots,
    },
  };
}

function tsplNumber(value: number): string {
  return Number(value.toFixed(3)).toString();
}

function tsplBarcodeType(kind: LabelBarcodeKind): string {
  return kind === "CODE128" ? "128" : kind;
}

export function createLabelSvgBarcode(kind: LabelBarcodeKind, barcode: string, heightMm: number): string {
  const bcid = kind === "EAN13" ? "ean13" : kind === "EAN8" ? "ean8" : "code128";
  try {
    const svg = bwipjs.toSVG({
      bcid,
      text: barcode,
      includetext: false,
      height: heightMm,
      scaleX: 2,
      scaleY: 2,
      paddingwidth: 0,
      paddingheight: 0,
      backgroundcolor: "FFFFFF",
      barcolor: "000000",
    });
    return svg.replace("<svg ", '<svg preserveAspectRatio="none" ');
  } catch (error) {
    throw new Error(`Failed to render barcode SVG: ${error instanceof Error ? error.message : "unknown"}`);
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

/**
 * Generates the unified HTML used to rasterize the sticker at 203 DPI.
 * When `includeBarcode` is true (Test B / Default), the barcode is rendered as
 * vector SVG within the same DOM, ensuring 100% deterministic alignment,
 * zero layering conflict, and identical appearance on screen preview and physical paper.
 *
 * When `includeBarcode` is false (Test A), only the text/price header is rendered,
 * leaving the lower half of the sticker empty for native TSPL BARCODE execution.
 */
export function createLabelRasterHtml(profile: LabelPrinterProfile, content: LabelPrintContent, includeBarcode = true): string {
  const layout = createLabelLayout(profile, content.barcode);
  const price = `${(content.priceMinor / 100).toFixed(2)} ج.م`;
  const kind = resolveLabelBarcodeKind(content.barcode);

  const barcodeSvg = includeBarcode
    ? createLabelSvgBarcode(kind, content.barcode, dotsToMm(layout.barcode.height, profile.dpi))
    : "";

  const nameFont = layout.isCompact
    ? Math.max(11, Math.min(15, Math.floor(layout.text.height * 0.44)))
    : Math.max(13, Math.min(18, Math.floor(layout.text.height * 0.38)));

  const priceFont = layout.isCompact
    ? Math.max(13, Math.min(17, Math.floor(layout.text.height * 0.48)))
    : Math.max(15, Math.min(22, Math.floor(layout.text.height * 0.45)));

  const codeFont = Math.max(10, Math.min(14, Math.floor(layout.heightDots * 0.08)));

  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      width: ${layout.widthDots}px;
      height: ${layout.heightDots}px;
      overflow: hidden;
      background: #ffffff;
      color: #000000;
      font-family: Tahoma, "Segoe UI", Arial, sans-serif;
      -webkit-font-smoothing: none;
    }
    .label-container {
      position: relative;
      width: ${layout.widthDots}px;
      height: ${layout.heightDots}px;
      overflow: hidden;
      background: #ffffff;
    }
    .header-row {
      position: absolute;
      left: ${layout.text.x}px;
      top: ${layout.text.y}px;
      width: ${layout.text.width}px;
      height: ${layout.text.height}px;
      display: flex;
      flex-direction: row-reverse;
      justify-content: space-between;
      align-items: center;
      overflow: hidden;
    }
    .name {
      width: ${layout.text.nameWidth}px;
      max-height: ${layout.text.height}px;
      font-size: ${nameFont}px;
      font-weight: 800;
      line-height: 1.12;
      text-align: right;
      direction: rtl;
      overflow: hidden;
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
    }
    .price-tag {
      width: ${layout.text.priceWidth}px;
      text-align: left;
      direction: rtl;
      font-size: ${priceFont}px;
      font-weight: 900;
      line-height: 1.05;
      white-space: nowrap;
      overflow: hidden;
    }
    .barcode-box {
      position: absolute;
      left: ${layout.barcode.x}px;
      top: ${layout.barcode.y}px;
      width: ${layout.barcode.width}px;
      height: ${layout.barcode.height}px;
      display: flex;
      justify-content: center;
      align-items: center;
      overflow: hidden;
      background: #ffffff;
    }
    .barcode-box svg {
      display: block;
      width: 100%;
      height: 100%;
    }
    .digits {
      position: absolute;
      left: ${layout.safeMarginDots}px;
      top: ${layout.barcode.y + layout.barcode.height + 2}px;
      width: ${layout.widthDots - layout.safeMarginDots * 2}px;
      height: ${codeFont + 4}px;
      font-family: Consolas, "Courier New", monospace;
      font-size: ${codeFont}px;
      font-weight: 700;
      letter-spacing: 0.5px;
      text-align: center;
      direction: ltr;
      white-space: nowrap;
      overflow: hidden;
    }
  </style></head><body>
    <div class="label-container">
      <div class="header-row">
        <div class="name">${escapeHtml(content.name)}</div>
        <div class="price-tag">${escapeHtml(price)}</div>
      </div>
      ${includeBarcode ? `<div class="barcode-box">${barcodeSvg}</div><div class="digits">${escapeHtml(content.barcode)}</div>` : ""}
    </div>
  </body></html>`;
}

/** Backward-compatible alias for text-only rasterization */
export function createLabelTextRasterHtml(profile: LabelPrinterProfile, content: LabelPrintContent): string {
  return createLabelRasterHtml(profile, content, false);
}

/**
 * Builds Test B (Rasterized Barcode):
 * The entire label (Arabic text, price, barcode bars, and digits) is encoded as
 * ONE unified 1-bit monochrome bitmap and sent to the printer via BITMAP 0,0.
 *
 * Guarantees:
 * 1. Background is 100% white.
 * 2. Text, price, and barcode bars are 100% black.
 * 3. Barcode lines cannot be masked or submerged.
 * 4. Text and price cannot be clipped or misaligned.
 * 5. Exactly 1 PRINT command with correct copy count.
 * 6. Stopping exactly at the gap without extra blank feeds.
 */
export function createTsplRasterJob(profile: LabelPrinterProfile, content: LabelPrintContent, labelRaster: Buffer): Buffer {
  validateLabelPrinterProfile(profile);
  if (!Number.isInteger(content.copies) || content.copies < 1 || content.copies > 100) {
    throw new Error("Label copy count must be from 1 to 100");
  }
  if (!content.name.trim() || !Number.isInteger(content.priceMinor) || content.priceMinor <= 0) {
    throw new Error("Label content is incomplete");
  }

  const layout = createLabelLayout(profile, content.barcode);
  const expectedRasterBytes = layout.bytesPerRow * layout.heightDots;
  if (labelRaster.length !== expectedRasterBytes) {
    throw new Error(`Label raster dimensions do not match the profile (expected ${expectedRasterBytes} bytes, got ${labelRaster.length})`);
  }

  const speedIps = profile.speedMmPerSecond / 25.4;
  const commands = [
    `SIZE ${tsplNumber(profile.widthMm)} mm,${tsplNumber(profile.heightMm)} mm`,
    `GAP ${tsplNumber(profile.gapMm)} mm,0 mm`,
    `DIRECTION ${profile.direction},0`,
    "REFERENCE 0,0",
    `SPEED ${tsplNumber(speedIps)}`,
    `DENSITY ${profile.density}`,
    "CLS",
    `BITMAP 0,0,${layout.bytesPerRow},${layout.heightDots},0,`,
  ];

  return Buffer.concat([
    Buffer.from(`${commands.join("\r\n")}`, "ascii"),
    labelRaster,
    Buffer.from(`\r\nPRINT ${content.copies},1\r\n`, "ascii"),
  ]);
}

/**
 * Builds Test A (Native TSPL Barcode):
 * Barcode is drawn by the printer firmware using the native TSPL `BARCODE` command.
 * If `headerRaster` is provided, it only covers the top text area, leaving the
 * lower barcode area clean and empty on the printer's frame buffer.
 */
export function createTsplNativeBarcodeJob(profile: LabelPrinterProfile, content: LabelPrintContent, headerRaster?: Buffer): Buffer {
  validateLabelPrinterProfile(profile);
  if (!Number.isInteger(content.copies) || content.copies < 1 || content.copies > 100) {
    throw new Error("Label copy count must be from 1 to 100");
  }
  if (!content.name.trim() || !Number.isInteger(content.priceMinor) || content.priceMinor <= 0) {
    throw new Error("Label content is incomplete");
  }

  const layout = createLabelLayout(profile, content.barcode);
  const kind = resolveLabelBarcodeKind(content.barcode);

  const offsetX = Math.round((profile.offsetXmm * profile.dpi) / 25.4);
  const offsetY = Math.round((profile.offsetYmm * profile.dpi) / 25.4);
  const barcodeX = layout.barcode.x + offsetX;
  const barcodeY = layout.barcode.y + offsetY;

  if (
    barcodeX < layout.safeMarginDots ||
    barcodeY < layout.safeMarginDots ||
    barcodeX + layout.barcode.width > layout.widthDots - layout.safeMarginDots ||
    barcodeY + layout.barcode.height > layout.heightDots - layout.safeMarginDots
  ) {
    throw new Error("Offset would place the barcode outside the safe printable area");
  }

  const speedIps = profile.speedMmPerSecond / 25.4;
  const commands = [
    `SIZE ${tsplNumber(profile.widthMm)} mm,${tsplNumber(profile.heightMm)} mm`,
    `GAP ${tsplNumber(profile.gapMm)} mm,0 mm`,
    `DIRECTION ${profile.direction},0`,
    "REFERENCE 0,0",
    `SPEED ${tsplNumber(speedIps)}`,
    `DENSITY ${profile.density}`,
    "CLS",
  ];

  const barcodeCommand = `BARCODE ${barcodeX},${barcodeY},"${tsplBarcodeType(kind)}",${layout.barcode.height},1,0,${layout.barcode.narrowBarDots},${layout.barcode.narrowBarDots},"${content.barcode}"`;

  if (headerRaster) {
    const expectedHeaderBytes = layout.bytesPerRow * layout.text.height;
    if (headerRaster.length !== expectedHeaderBytes) {
      throw new Error(`Header raster dimensions mismatch (expected ${expectedHeaderBytes} bytes, got ${headerRaster.length})`);
    }
    commands.push(`BITMAP 0,0,${layout.bytesPerRow},${layout.text.height},0,`);
    return Buffer.concat([
      Buffer.from(`${commands.join("\r\n")}`, "ascii"),
      headerRaster,
      Buffer.from(`\r\n${barcodeCommand}\r\nPRINT ${content.copies},1\r\n`, "ascii"),
    ]);
  }

  return Buffer.from(`${commands.join("\r\n")}\r\n${barcodeCommand}\r\nPRINT ${content.copies},1\r\n`, "ascii");
}

/**
 * Backward-compatible entry point for TSPL job creation.
 * Uses `renderMode` from the profile (defaults to RASTER).
 */
export function createTsplLabelJob(profile: LabelPrinterProfile, content: LabelPrintContent, raster: Buffer): Buffer {
  if (profile.renderMode === "NATIVE_TSPL") {
    return createTsplNativeBarcodeJob(profile, content, raster);
  }
  return createTsplRasterJob(profile, content, raster);
}

export function createTsplGapCalibrationJob(profile: LabelPrinterProfile): Buffer {
  validateLabelPrinterProfile(profile);
  return Buffer.from(
    `SIZE ${tsplNumber(profile.widthMm)} mm,${tsplNumber(profile.heightMm)} mm\r\nGAP ${tsplNumber(profile.gapMm)} mm,0 mm\r\nGAPDETECT\r\n`,
    "ascii",
  );
}

/**
 * Converts a 1-bit monochrome TSPL bitmap into a standard Windows BMP image Buffer.
 * Useful for automated visual tests, pixel assertions, and artifact generation.
 */
export function monochromeBitmapToBmp(bitmap: Buffer, width: number, height: number): Buffer {
  const bytesPerRow = Math.ceil(width / 8);
  const bmpRowBytes = Math.ceil(bytesPerRow / 4) * 4; // DWORD aligned
  const imageSize = bmpRowBytes * height;
  const fileSize = 14 + 40 + 8 + imageSize;
  const buf = Buffer.alloc(fileSize);

  // BITMAPFILEHEADER (14 bytes)
  buf.write("BM", 0);
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(62, 10); // Offset to pixel data

  // BITMAPINFOHEADER (40 bytes)
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(-height, 22); // Top-down
  buf.writeUInt16LE(1, 26); // Planes
  buf.writeUInt16LE(1, 28); // Bit count (1-bit)
  buf.writeUInt32LE(0, 30); // Compression (BI_RGB)
  buf.writeUInt32LE(imageSize, 34);
  buf.writeUInt32LE(8000, 38); // ~203 DPI (dots per meter)
  buf.writeUInt32LE(8000, 42);
  buf.writeUInt32LE(2, 46); // Color table entries
  buf.writeUInt32LE(2, 50);

  // Color table:
  // Color 0 = White (RGB 255, 255, 255)
  buf[54] = 255;
  buf[55] = 255;
  buf[56] = 255;
  buf[57] = 0;
  // Color 1 = Black (RGB 0, 0, 0)
  buf[58] = 0;
  buf[59] = 0;
  buf[60] = 0;
  buf[61] = 0;

  // Copy rows with DWORD padding
  for (let y = 0; y < height; y += 1) {
    const srcOffset = y * bytesPerRow;
    const destOffset = 62 + y * bmpRowBytes;
    bitmap.copy(buf, destOffset, srcOffset, srcOffset + bytesPerRow);
  }

  return buf;
}

export interface BitmapInspectionResult {
  totalPixels: number;
  whitePixels: number;
  blackPixels: number;
  blackPercentage: number;
  isBackgroundWhite: boolean;
  quietZonesWhite: boolean;
  hasBarcodeTransitions: boolean;
}

/**
 * Deep pixel inspection tool that analyzes the actual 1-bit bitmap to verify
 * regression fixes (no black background, visible barcode transitions, white quiet zones).
 */
export function inspectMonochromeBitmap(bitmap: Buffer, width: number, height: number): BitmapInspectionResult {
  const bytesPerRow = Math.ceil(width / 8);
  let whitePixels = 0;
  let blackPixels = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const byte = bitmap[y * bytesPerRow + Math.floor(x / 8)]!;
      const bit = (byte & (0x80 >> (x % 8))) !== 0 ? 1 : 0;
      if (bit === 1) {
        blackPixels += 1;
      } else {
        whitePixels += 1;
      }
    }
  }

  const totalPixels = width * height;
  const blackPercentage = (blackPixels / totalPixels) * 100;

  // In a valid white sticker with text and barcode:
  // Black ink coverage is typically between 3% and 25%.
  // If the background was inverted, black coverage would be > 75%!
  const isBackgroundWhite = blackPercentage < 40 && whitePixels > blackPixels;

  // Inspect quiet zones in the middle row (where the barcode lives)
  const middleY = Math.floor(height * 0.65);
  let leftQuietZoneBlack = 0;
  let rightQuietZoneBlack = 0;
  for (let x = 0; x < 16; x += 1) {
    const leftByte = bitmap[middleY * bytesPerRow + Math.floor(x / 8)]!;
    if ((leftByte & (0x80 >> (x % 8))) !== 0) leftQuietZoneBlack += 1;

    const rightX = width - 1 - x;
    const rightByte = bitmap[middleY * bytesPerRow + Math.floor(rightX / 8)]!;
    if ((rightByte & (0x80 >> (rightX % 8))) !== 0) rightQuietZoneBlack += 1;
  }
  const quietZonesWhite = leftQuietZoneBlack === 0 && rightQuietZoneBlack === 0;

  // Check for alternating black and white transitions across the middle scanline
  let transitions = 0;
  let lastBit: number | null = null;
  for (let x = 16; x < width - 16; x += 1) {
    const byte = bitmap[middleY * bytesPerRow + Math.floor(x / 8)]!;
    const bit = (byte & (0x80 >> (x % 8))) !== 0 ? 1 : 0;
    if (lastBit !== null && bit !== lastBit) {
      transitions += 1;
    }
    lastBit = bit;
  }
  const hasBarcodeTransitions = transitions >= 10;

  return {
    totalPixels,
    whitePixels,
    blackPixels,
    blackPercentage,
    isBackgroundWhite,
    quietZonesWhite,
    hasBarcodeTransitions,
  };
}
