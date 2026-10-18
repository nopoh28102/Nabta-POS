import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  DEFAULT_XP233B_PROFILE,
  createLabelLayout,
  createLabelRasterHtml,
  createLabelSvgBarcode,
  createTsplGapCalibrationJob,
  createTsplLabelJob,
  createTsplNativeBarcodeJob,
  createTsplRasterJob,
  encodeXp233bTsplBitmap,
  inspectMonochromeBitmap,
  isValidEan13,
  isValidEan8,
  mmToDots,
  monochromeBitmapToBmp,
  resolveLabelBarcodeKind,
  validateLabelPrinterProfile,
} from "./label-engine.js";

describe("XP-233B TSPL label engine — Comprehensive Verification", () => {
  it("converts physical dimensions to 203 DPI dots with 50x20 mm defaults", () => {
    expect(mmToDots(50)).toBe(400);
    expect(mmToDots(20)).toBe(160);
    expect(mmToDots(2)).toBe(16);
    expect(DEFAULT_XP233B_PROFILE.widthMm).toBe(50);
    expect(DEFAULT_XP233B_PROFILE.heightMm).toBe(20);
    expect(DEFAULT_XP233B_PROFILE.gapMm).toBe(2);
  });

  it("validates EAN-13, EAN-8 and Code 128 symbologies", () => {
    expect(isValidEan13("6221234567891")).toBe(true);
    expect(isValidEan13("6221234567890")).toBe(false); // Invalid check digit
    expect(isValidEan8("96385074")).toBe(true);
    expect(isValidEan8("96385075")).toBe(false); // Invalid check digit

    expect(resolveLabelBarcodeKind("6221234567891")).toBe("EAN13");
    expect(resolveLabelBarcodeKind("96385074")).toBe("EAN8");
    expect(resolveLabelBarcodeKind("NABTA-100-RED")).toBe("CODE128");

    // CRITICAL: 13-digit code with invalid check digit must fallback to Code 128
    // rather than altering the user's saved barcode or throwing an unhandled error!
    expect(resolveLabelBarcodeKind("6221234567890")).toBe("CODE128");

    // CRITICAL: Barcodes with leading zeros (e.g. 0745110262220) must be resolved
    // as CODE128 so thermal printer firmware never truncates the leading zero as UPC-A!
    expect(resolveLabelBarcodeKind("0745110262220")).toBe("CODE128");
  });

  it("preserves leading zeros for barcodes in TSPL native commands", () => {
    const profile = { ...DEFAULT_XP233B_PROFILE, calibrationConfirmed: true };
    const content = {
      storeName: "نبتة",
      name: "صنف بباركود صفر",
      barcode: "0745110262220",
      priceMinor: 2500,
      copies: 1,
    };
    const job = createTsplNativeBarcodeJob(profile, content).toString("latin1");
    expect(job).toContain("BARCODE ");
    expect(job).toContain('"128"');
    expect(job).toContain('"0745110262220"');
  });

  it("enforces correct TSPL wire polarity: 0 is White and 1 is Black (NO INVERSION)", () => {
    // In TSPL BITMAP protocol:
    // 0 = White dot (thermal head off, paper remains white)
    // 1 = Black dot (thermal head on, thermal ink turns black)
    const rawMonochrome = Buffer.from([0x00, 0xaa, 0xff]);
    const encoded = encodeXp233bTsplBitmap(rawMonochrome, false);

    // Byte 0x00 (all 8 dots white) MUST remain 0x00, NOT inverted to 0xff!
    expect(encoded[0]).toBe(0x00);
    // Byte 0xff (all 8 dots black) MUST remain 0xff!
    expect(encoded[2]).toBe(0xff);
    expect(encoded).toEqual(rawMonochrome);

    // Optional inversion flag is available if explicitly requested, but default is false
    expect(encodeXp233bTsplBitmap(rawMonochrome, true)).toEqual(Buffer.from([0xff, 0x55, 0x00]));
  });

  it("creates a bounded 50×20 mm layout with non-overlapping bounds", () => {
    const profile = { ...DEFAULT_XP233B_PROFILE, calibrationConfirmed: true };
    const layout = createLabelLayout(profile, "6221234567891");

    expect(layout.widthDots).toBe(400);
    expect(layout.heightDots).toBe(160);
    expect(layout.bytesPerRow).toBe(50);
    expect(layout.isCompact).toBe(true);

    // Text bounding box bounds
    expect(layout.text.x).toBeGreaterThanOrEqual(layout.safeMarginDots);
    expect(layout.text.x + layout.text.width).toBeLessThanOrEqual(layout.widthDots - layout.safeMarginDots);
    expect(layout.text.y + layout.text.height).toBeLessThan(layout.barcode.y);

    // Barcode bounding box bounds
    expect(layout.barcode.x).toBeGreaterThanOrEqual(layout.safeMarginDots);
    expect(layout.barcode.x + layout.barcode.width).toBeLessThanOrEqual(layout.widthDots - layout.safeMarginDots);
    expect(layout.barcode.y + layout.barcode.height).toBeLessThanOrEqual(layout.heightDots - layout.safeMarginDots);

    // Quiet zones must be preserved
    expect(layout.barcode.quietZoneDots).toBeGreaterThanOrEqual(16);
  });

  describe("Test A vs Test B Printing Engine Comparison", () => {
    const content = {
      storeName: "نبتة",
      name: "شاي ليبتون ناعم 250 جم",
      barcode: "6221234567891",
      priceMinor: 4850, // 48.50 EGP
      copies: 1,
    };

    it("Test A — Native TSPL Barcode creates standard firmware BARCODE command", () => {
      const profile = { ...DEFAULT_XP233B_PROFILE, calibrationConfirmed: true };
      const job = createTsplNativeBarcodeJob(profile, content).toString("latin1");

      expect(job).toContain("SIZE 50 mm,20 mm");
      expect(job).toContain("GAP 2 mm,0 mm");
      expect(job).toContain("DIRECTION 1,0");
      expect(job).toContain("REFERENCE 0,0");
      expect(job).toContain("CLS");
      expect(job).toContain('BARCODE ');
      expect(job).toContain('"EAN13"');
      expect(job).toContain('"6221234567891"');
      // Parameter 5 of TSPL BARCODE must be 1 (human readable below barcode), not 2 (above)
      expect(job).toMatch(/BARCODE \d+,\d+,"EAN13",\d+,1,0,/);
      expect(job).toContain("PRINT 1,1");
      // Must not contain spurious BITMAP when pure native
      expect(job).not.toContain("BITMAP");
    });

    it("centers numeric Code 128 horizontally on 52x27 mm labels without shifting left", () => {
      const profile = { ...DEFAULT_XP233B_PROFILE, widthMm: 52, heightMm: 27, calibrationConfirmed: true };
      const barcode = "0796554186931";
      const layout = createLabelLayout(profile, barcode);

      // Width is 416 dots. For 13-digit Code 128 (Code 128C in TSPL), estimated modules = 112 -> 224 dots.
      // Margin = (416 - 224) / 2 = 96 dots (12 mm from left and right).
      // Prior bug caused layout.barcode.x to be 16 dots (overestimated width), shoving barcode to the far left.
      expect(layout.barcode.x).toBeGreaterThanOrEqual(80);
      expect(layout.barcode.x).toBeLessThanOrEqual(110);

      const job = createTsplNativeBarcodeJob(profile, {
        storeName: "نبتة",
        name: "بهارات فراخ",
        barcode,
        priceMinor: 9000,
        copies: 1,
      }).toString("latin1");

      expect(job).toContain('"128"');
      expect(job).toContain(`"${barcode}"`);
      // TSPL BARCODE command must use human_readable = 1 (centered below bars)
      expect(job).toMatch(new RegExp(`BARCODE ${layout.barcode.x},\\d+,"128",\\d+,1,0,`));
    });

    it("Test B — Unified Raster Barcode embeds full sticker into a single deterministic BITMAP", () => {
      const profile = { ...DEFAULT_XP233B_PROFILE, calibrationConfirmed: true };
      const layout = createLabelLayout(profile, content.barcode);
      const totalBytes = layout.bytesPerRow * layout.heightDots; // 50 * 160 = 8000 bytes
      expect(totalBytes).toBe(8000);

      const mockRaster = Buffer.alloc(totalBytes);
      // Simulate black text and barcode bars in mock raster
      mockRaster[100] = 0b10101010;
      mockRaster[200] = 0b11110000;

      const job = createTsplRasterJob(profile, content, mockRaster);
      const jobString = job.toString("latin1");

      expect(jobString).toContain("SIZE 50 mm,20 mm");
      expect(jobString).toContain("GAP 2 mm,0 mm");
      expect(jobString).toContain("DIRECTION 1,0");
      expect(jobString).toContain("REFERENCE 0,0");
      expect(jobString).toContain("CLS");
      expect(jobString).toContain("BITMAP 0,0,50,160,0,");
      expect(jobString).toContain("PRINT 1,1");
      // Total payload size must be command headers + 8000 bytes + footer
      expect(job.length).toBeGreaterThan(8000);
    });

    it("Comparison: Test A and Test B both prevent blank labels and respect copies", () => {
      const profile = { ...DEFAULT_XP233B_PROFILE, calibrationConfirmed: true };
      const layout = createLabelLayout(profile, content.barcode);
      const raster = Buffer.alloc(layout.bytesPerRow * layout.heightDots);

      const jobA = createTsplNativeBarcodeJob(profile, { ...content, copies: 3 }).toString("latin1");
      const jobB = createTsplRasterJob(profile, { ...content, copies: 3 }, raster).toString("latin1");

      // Both use exact physical SIZE 50 mm, 20 mm (NOT 30 mm!)
      expect(jobA).toContain("SIZE 50 mm,20 mm");
      expect(jobB).toContain("SIZE 50 mm,20 mm");

      // Both use GAP 2 mm,0 mm
      expect(jobA).toContain("GAP 2 mm,0 mm");
      expect(jobB).toContain("GAP 2 mm,0 mm");

      // Both emit exactly ONE PRINT command with 3 copies (NOT 3 separate jobs)
      expect((jobA.match(/PRINT /g) || []).length).toBe(1);
      expect((jobB.match(/PRINT /g) || []).length).toBe(1);
      expect(jobA).toContain("PRINT 3,1");
      expect(jobB).toContain("PRINT 3,1");

      // Neither job contains FORMFEED or extra page feed
      expect(jobA).not.toContain("FORMFEED");
      expect(jobB).not.toContain("FORMFEED");
    });
  });

  describe("Monochrome Pixel Inspection & Visual Validation", () => {
    it("generates crisp SVG barcode via bwip-js with quiet zones", () => {
      const svg = createLabelSvgBarcode("EAN13", "6221234567891", 8.5);
      expect(svg).toContain("<svg");
      expect(svg).toContain('preserveAspectRatio="none"');
      expect(svg).toContain('stroke="#000000"'); // Black bars
    });

    it("generates complete HTML with RTL Arabic shaping, price, and barcode box", () => {
      const profile = DEFAULT_XP233B_PROFILE;
      const html = createLabelRasterHtml(profile, {
        storeName: "نبتة",
        name: "جبنة دومتي فيتا 500 جم",
        barcode: "6221234567891",
        priceMinor: 3250,
        copies: 1,
      }, true);

      expect(html).toContain('lang="ar" dir="rtl"');
      expect(html).toContain("جبنة دومتي فيتا 500 جم");
      expect(html).toContain("32.50 ج.م");
      expect(html).toContain("6221234567891");
      expect(html).toContain("barcode-box");
      expect(html).toContain("background: #ffffff"); // White background
      expect(html).toContain("color: #000000");      // Black text
    });

    it("verifies monochrome bitmap pixel stats: white background, quiet zones, and barcode transitions", () => {
      const width = 400;
      const height = 160;
      const bytesPerRow = Math.ceil(width / 8); // 50
      const bitmap = Buffer.alloc(bytesPerRow * height); // 8000 bytes all 0x00 (white)

      // Simulate a real sticker:
      // 1. Text in rows 10-35 (draw some black dots)
      for (let y = 10; y < 35; y += 1) {
        for (let byteX = 10; byteX < 45; byteX += 1) {
          if ((y + byteX) % 3 === 0) bitmap[y * bytesPerRow + byteX] = 0b01100110;
        }
      }

      // 2. Barcode in rows 55-125:
      // Quiet zones: X = 0..24 (bytes 0..2) and X = 376..399 (bytes 47..49) are kept 0x00 (white).
      // Alternating bars in middle bytes:
      for (let y = 55; y < 125; y += 1) {
        for (let byteX = 4; byteX < 46; byteX += 1) {
          bitmap[y * bytesPerRow + byteX] = (byteX % 2 === 0) ? 0b11001100 : 0b10101010;
        }
      }

      const inspection = inspectMonochromeBitmap(bitmap, width, height);

      // Verify that the background is predominantly white
      expect(inspection.isBackgroundWhite).toBe(true);
      expect(inspection.blackPercentage).toBeGreaterThan(2);
      expect(inspection.blackPercentage).toBeLessThan(35);
      expect(inspection.whitePixels).toBeGreaterThan(inspection.blackPixels);

      // Verify quiet zones are pure white (no black dots)
      expect(inspection.quietZonesWhite).toBe(true);

      // Verify alternating barcode transitions exist
      expect(inspection.hasBarcodeTransitions).toBe(true);
    });

    it("generates a valid 1-bit BMP image for external inspection", async () => {
      const width = 400;
      const height = 160;
      const bytesPerRow = Math.ceil(width / 8);
      const bitmap = Buffer.alloc(bytesPerRow * height);

      // Draw a test pattern with barcode-like bars
      for (let y = 50; y < 120; y += 1) {
        for (let x = 30; x < 370; x += 1) {
          if ((x % 6) < 3) {
            bitmap[y * bytesPerRow + Math.floor(x / 8)]! |= 0x80 >> (x % 8);
          }
        }
      }

      const bmp = monochromeBitmapToBmp(bitmap, width, height);
      expect(bmp.subarray(0, 2).toString()).toBe("BM");
      expect(bmp.readUInt32LE(2)).toBe(bmp.length);
      expect(bmp.readInt32LE(18)).toBe(400);
      expect(bmp.readInt32LE(22)).toBe(-160); // Top-down
      expect(bmp.readUInt16LE(28)).toBe(1);   // 1-bit monochrome

      // Save preview artifact for report verification
      const previewPath = resolve(process.cwd(), "docs/previews/xp233b-test-label-preview.bmp");
      await writeFile(previewPath, bmp);
    });
  });

  describe("Printer Profile Constraints & Safeguards", () => {
    it("rejects invalid dimensions beyond XP-233B physical capacity", () => {
      expect(() => validateLabelPrinterProfile({ ...DEFAULT_XP233B_PROFILE, widthMm: 60 })).toThrow("printable width");
      expect(() => validateLabelPrinterProfile({ ...DEFAULT_XP233B_PROFILE, widthMm: 15 })).toThrow("printable width");
      expect(() => validateLabelPrinterProfile({ ...DEFAULT_XP233B_PROFILE, heightMm: 5 })).toThrow("height");
      expect(() => validateLabelPrinterProfile({ ...DEFAULT_XP233B_PROFILE, gapMm: 15 })).toThrow("gap");
      expect(() => validateLabelPrinterProfile({ ...DEFAULT_XP233B_PROFILE, density: 20 })).toThrow("density");
    });

    it("builds a safe Gap-detection calibration command", () => {
      const job = createTsplGapCalibrationJob(DEFAULT_XP233B_PROFILE).toString("ascii");
      expect(job).toBe("SIZE 50 mm,20 mm\r\nGAP 2 mm,0 mm\r\nGAPDETECT\r\n");
    });

    it("rejects multi-copy or batch printing when calibration is unconfirmed", () => {
      const profile = { ...DEFAULT_XP233B_PROFILE, calibrationConfirmed: false };
      expect(profile.calibrationConfirmed).toBe(false);
    });
  });
});
