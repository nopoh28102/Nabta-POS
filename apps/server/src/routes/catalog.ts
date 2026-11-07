import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { archiveProductRequestSchema, attachNumericBarcodeRequestSchema, createProductRequestSchema, productCsvImportRequestSchema, productExportRequestSchema, quoteRequestSchema, updateProductPriceRequestSchema, updateProductRequestSchema } from "@nabta/contracts";
import { allocateInvoiceDiscount, calculateInventoryIssueValue, calculateLineMinor, extractTokenVariants, normalizeArabicSearch, scoreArabicFuzzyMatch, toSafeNumber } from "@nabta/domain";
import type { Database } from "../db.js";
import { transaction } from "../db.js";
import { ApiError } from "../errors.js";
import { requireAuth, requirePermission } from "../auth.js";
import { audit } from "../audit.js";
import { canonicalJson, sha256 } from "../security.js";
import { findProductReference } from "../product-reference.js";

interface CatalogRow {
  id: string;
  name_ar: string;
  description: string;
  category: string;
  unit_kind: "PIECE" | "WEIGHT";
  weight_unit: "KILOGRAM" | "GRAM" | "LITER" | "MILLILITER";
  price_minor: number;
  carton_price_minor: number | null;
  carton_contents_unit: "PIECE" | "BAG" | null;
  retail_package_size: number | null;
  retail_package_price_minor: number | null;
  retail_package_unit: "PIECE" | "BAG" | null;
  retail_package_label: "PACKAGE" | "STACK" | "PACKET" | null;
  wholesale_price_minor: number;
  purchase_pack_size: number;
  reorder_level_milli: number;
  stock_version: number;
  qty_milli: number;
  warehouse_id: string;
  barcodes: string[];
  barcode_mappings: Array<{ barcode: string; saleUnit: "UNIT" | "PACKAGE" | "CARTON" }>;
  image_barcode: string | null;
  cursor_rank: number;
}

interface CatalogCursor {
  rank: number;
  nameAr: string;
  id: string;
}

interface FuzzyCatalogCandidate {
  id: string;
  name_ar: string;
  search_name: string;
  description: string;
  category: string;
  sku: string;
}

function decodeCatalogCursor(value: unknown): CatalogCursor | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<CatalogCursor>;
    if (typeof parsed.rank !== "number" || parsed.rank < 0 || parsed.rank > 5 || typeof parsed.nameAr !== "string" || !parsed.nameAr || typeof parsed.id !== "string" || !/^[0-9a-f-]{36}$/i.test(parsed.id)) {
      throw new Error("invalid catalog cursor");
    }
    return { rank: parsed.rank, nameAr: parsed.nameAr, id: parsed.id };
  } catch {
    throw new ApiError(422, "INVALID_CATALOG_CURSOR", "مؤشر الكتالوج غير صالح");
  }
}

function encodeCatalogCursor(row: Pick<CatalogRow, "cursor_rank" | "name_ar" | "id">): string {
  return Buffer.from(JSON.stringify({ rank: row.cursor_rank, nameAr: row.name_ar, id: row.id })).toString("base64url");
}

interface QuoteProductRow extends CatalogRow {
  warehouse_id: string;
}

interface PricedQuoteLine {
  lineId: string;
  unitPriceMinor: bigint;
  qtyMilli: bigint;
  grossMinor: bigint;
  saleUnit: "UNIT" | "PACKAGE" | "CARTON";
  row?: QuoteProductRow | undefined;
  packageSize?: number | undefined;
  weightedLabelBarcode?: string | undefined;
  manualItem?: boolean | undefined;
  manualNameAr?: string | undefined;
}

interface ProductReferenceCatalogRow {
  barcode: string;
  name_ar: string;
  category: string;
  subcategory: string;
  brand: string;
  manufacturer: string;
  size: string;
  flavor: string;
  description: string;
  image_source_url: string;
  image_asset_path: string | null;
}

interface ImportRow {
  nameAr: string;
  category: string;
  unitKind: "PIECE" | "WEIGHT";
  priceMinor: number;
  barcode: string;
  reorderLevelMilli: number;
  openingQtyMilli: number;
  openingUnitCostMinor: number;
  wholesalePriceMinor: number;
  availableQtyMilli?: number;
  weightUnit: "KILOGRAM" | "GRAM" | "LITER" | "MILLILITER";
  advancedWorkbook?: boolean;
  description?: string;
  purchasePackSize?: number;
  cartonPriceMinor?: number;
  cartonContentsUnit?: "PIECE" | "BAG";
  retailPackage?: { unitsPerPackage: number; packagePriceMinor: number; contentsUnit: "PIECE" | "BAG"; label: "PACKAGE" | "STACK" | "PACKET" };
  barcodeMappings?: Array<{ barcode: string; saleUnit: "UNIT" | "PACKAGE" | "CARTON" }>;
  exportedAt?: string;
  expectedStockVersion?: number;
}

function parseCsv(csv: string): { rows: ImportRow[]; errors: string[] } {
  const records: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index]!;
    if (char === '"') {
      if (quoted && csv[index + 1] === '"') { cell += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) { row.push(cell); cell = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && csv[index + 1] === "\n") index += 1;
      row.push(cell); cell = "";
      if (row.some((value) => value.trim() !== "")) records.push(row);
      row = [];
    } else cell += char;
  }
  if (quoted) return { rows: [], errors: ["الملف يحتوي على علامة اقتباس غير مغلقة"] };
  if (cell || row.length) { row.push(cell); if (row.some((value) => value.trim() !== "")) records.push(row); }
  const expected = ["nameAr", "category", "unitKind", "priceMinor", "barcode", "reorderLevelMilli", "openingQtyMilli", "openingUnitCostMinor"];
  const internalExpected = [...expected, "wholesalePriceMinor"];
  const workbookExpected = [...internalExpected, "availableQtyMilli", "weightUnit"];
  const advancedWorkbookExpected = [...workbookExpected, "description", "purchasePackSize", "cartonPriceMinor", "cartonContentsUnit", "retailPackageSize", "retailPackagePriceMinor", "retailPackageContentsUnit", "retailPackageLabel", "packageBarcode", "cartonBarcode", "exportedAt", "expectedStockVersion"];
  const header = records.shift()?.map((value) => value.replace(/^\uFEFF/, "").trim());
  const hasWholesale = header?.join(",") === internalExpected.join(",");
  const isWorkbook = header?.join(",") === workbookExpected.join(",");
  const isAdvancedWorkbook = header?.join(",") === advancedWorkbookExpected.join(",");
  if (!header || (!isAdvancedWorkbook && !isWorkbook && !hasWholesale && header.join(",") !== expected.join(","))) return { rows: [], errors: ["رؤوس الأعمدة يجب أن تكون: " + expected.join(",") + " أو " + internalExpected.join(",") + " أو قالب Excel الصادر من نبتة"] };
  const errors: string[] = [];
  const rows: ImportRow[] = [];
  records.forEach((values, index) => {
    const line = index + 2;
    if (values.length !== (isAdvancedWorkbook ? advancedWorkbookExpected.length : isWorkbook ? workbookExpected.length : hasWholesale ? internalExpected.length : expected.length)) { errors.push("السطر " + line + ": عدد الأعمدة غير صحيح"); return; }
    const [nameAr, category, unitKind, priceMinor, barcode, reorderLevelMilli, openingQtyMilli, openingUnitCostMinor, wholesalePriceMinor, availableQtyMilli, weightUnit, description = "", purchasePackSize = "", cartonPriceMinor = "", cartonContentsUnit = "", retailPackageSize = "", retailPackagePriceMinor = "", retailPackageContentsUnit = "", retailPackageLabel = "", packageBarcode = "", cartonBarcode = "", exportedAt = "", expectedStockVersion = ""] = values.map((value) => value.trim());
    try {
      const retailPackage = isAdvancedWorkbook && retailPackageSize
        ? { unitsPerPackage: Number(retailPackageSize), packagePriceMinor: Number(retailPackagePriceMinor), contentsUnit: retailPackageContentsUnit, label: retailPackageLabel || "PACKAGE" }
        : undefined;
      const barcodeMappings = isAdvancedWorkbook
        ? [
          { barcode, saleUnit: "UNIT" as const },
          ...(packageBarcode ? [{ barcode: packageBarcode, saleUnit: "PACKAGE" as const }] : []),
          ...(cartonBarcode ? [{ barcode: cartonBarcode, saleUnit: "CARTON" as const }] : []),
        ]
        : undefined;
      const parsed = createProductRequestSchema.parse({
        nameAr, category, unitKind, ...(isWorkbook || isAdvancedWorkbook ? { weightUnit } : {}), priceMinor: Number(priceMinor), barcodes: [barcode],
        reorderLevelMilli: Number(reorderLevelMilli), openingQtyMilli: Number(openingQtyMilli), openingUnitCostMinor: Number(openingUnitCostMinor), wholesalePriceMinor: (hasWholesale || isWorkbook || isAdvancedWorkbook) ? Number(wholesalePriceMinor) : Number(openingUnitCostMinor),
        ...(isAdvancedWorkbook ? { purchasePackSize: Number(purchasePackSize), ...(cartonPriceMinor ? { cartonPriceMinor: Number(cartonPriceMinor), cartonContentsUnit } : {}), ...(retailPackage ? { retailPackage } : {}), barcodeMappings } : {}),
      });
      const available = (isWorkbook || isAdvancedWorkbook) ? Number(availableQtyMilli) : undefined;
      if (available !== undefined && (!Number.isSafeInteger(available) || available < 0)) throw new Error("العدد المتاح غير صحيح");
      const importedStockVersion = expectedStockVersion ? Number(expectedStockVersion) : undefined;
      if (importedStockVersion !== undefined && (!Number.isInteger(importedStockVersion) || importedStockVersion < 0)) throw new Error("رقم مراجعة الرصيد غير صحيح");
      if (exportedAt && Number.isNaN(Date.parse(exportedAt))) throw new Error("تاريخ تصدير القالب غير صحيح");
      rows.push({ nameAr: parsed.nameAr, category: parsed.category, unitKind: parsed.unitKind, priceMinor: parsed.priceMinor, barcode: parsed.barcodes[0]!, reorderLevelMilli: parsed.reorderLevelMilli, openingQtyMilli: parsed.openingQtyMilli, openingUnitCostMinor: parsed.openingUnitCostMinor, wholesalePriceMinor: parsed.wholesalePriceMinor ?? parsed.openingUnitCostMinor, ...(available === undefined ? {} : { availableQtyMilli: available }), weightUnit: parsed.weightUnit, ...(isAdvancedWorkbook ? { advancedWorkbook: true, description, purchasePackSize: parsed.purchasePackSize, ...(parsed.cartonPriceMinor && parsed.cartonContentsUnit ? { cartonPriceMinor: parsed.cartonPriceMinor, cartonContentsUnit: parsed.cartonContentsUnit } : {}), ...(parsed.retailPackage ? { retailPackage: { ...parsed.retailPackage, label: parsed.retailPackage.label ?? "PACKAGE" } } : {}), ...(parsed.barcodeMappings ? { barcodeMappings: parsed.barcodeMappings } : {}), ...(exportedAt ? { exportedAt } : {}), ...(importedStockVersion !== undefined ? { expectedStockVersion: importedStockVersion } : {}) } : {}) });
    } catch (error) { errors.push("السطر " + line + ": " + (error instanceof Error ? error.message : "بيانات غير صحيحة")); }
  });
  const seen = new Set<string>();
  for (const item of rows) for (const mapping of item.barcodeMappings ?? [{ barcode: item.barcode, saleUnit: "UNIT" as const }]) {
    if (seen.has(mapping.barcode)) errors.push("الباركود مكرر داخل الملف: " + mapping.barcode); else seen.add(mapping.barcode);
  }
  return { rows, errors };
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

async function findFuzzyCatalogProductIds(
  db: Database,
  input: { query: string; category: string; unitKind: "PIECE" | "WEIGHT" | "" },
): Promise<string[]> {
  const normalized = normalizeArabicSearch(input.query);
  if (normalized.length < 3 || /^[0-9]+$/.test(normalized)) return [];

  const candidates = await db.query<FuzzyCatalogCandidate>(`
    SELECT p.id, p.name_ar, p.search_name, COALESCE(p.description, '') AS description,
           p.category, COALESCE(p.sku, '') AS sku
    FROM products p
    WHERE p.active
      AND ($1 = '' OR p.category = $1)
      AND ($2 = '' OR p.unit_kind::text = $2)
  `, [input.category, input.unitKind]);

  return candidates.rows
    .map((candidate) => ({
      id: candidate.id,
      name: candidate.name_ar,
      score: scoreArabicFuzzyMatch(
        [candidate.search_name, candidate.name_ar, candidate.description, candidate.category, candidate.sku].join(" "),
        normalized,
      ),
    }))
    .filter((candidate) => candidate.score >= 0.7)
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name, "ar-EG"))
    .slice(0, 24)
    .map((candidate) => candidate.id);
}

export function registerCatalogRoutes(app: FastifyInstance, db: Database): void {
  app.post("/v1/product-barcodes/generate", async (request) => {
    requirePermission(request, "PRODUCT_WRITE");
    for (let attempt = 0; attempt < 8; attempt += 1) {
      // EAN-13: a numerical, check-digit protected internal label that common
      // retail scanners can read without needing Code-128/Code-39 settings.
      const randomDigits = randomUUID()
        .replaceAll("-", "")
        .split("")
        .map((character) => (parseInt(character, 16) % 10).toString())
        .join("")
        .slice(0, 9);
      const base = `209${randomDigits}`;
      const sum = [...base].reduce(
        (total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3),
        0,
      );
      const barcode = base + ((10 - (sum % 10)) % 10).toString();
      const existing = await db.query<{ barcode: string }>("SELECT barcode FROM product_barcodes WHERE barcode = $1", [barcode]);
      if (!existing.rows[0]) return { barcode, symbology: "EAN13", scope: "INTERNAL" as const };
    }
    throw new ApiError(503, "BARCODE_GENERATION_RETRY", "تعذر توليد باركود فريد؛ أعد المحاولة");
  });

  app.post("/v1/products/:productId/barcodes", async (request, reply) => {
    const auth = requirePermission(request, "PRODUCT_WRITE");
    const body = attachNumericBarcodeRequestSchema.parse({
      productId: String((request.params as { productId?: string }).productId ?? ""),
      ...(request.body as object),
    });
    return transaction(db, async (client) => {
      const product = await client.query<{ id: string; name_ar: string }>(
        "SELECT id, name_ar FROM products WHERE id = $1 AND active FOR UPDATE",
        [body.productId],
      );
      if (!product.rows[0]) throw new ApiError(404, "PRODUCT_NOT_FOUND", "الصنف غير موجود أو غير نشط");
      try {
        await client.query(
          "INSERT INTO product_barcodes(product_id, barcode) VALUES ($1, $2)",
          [body.productId, body.barcode],
        );
      } catch (cause) {
        const error = cause as { code?: string };
        if (error.code === "23505")
          throw new ApiError(409, "BARCODE_EXISTS", "الباركود الرقمي مستخدم لصنف آخر");
        throw cause;
      }
      await audit(client, auth, "PRODUCT_NUMERIC_BARCODE_ATTACHED", "product", body.productId, {
        nameAr: product.rows[0].name_ar,
        barcode: body.barcode,
      });
      return reply.status(201).send({ productId: body.productId, barcode: body.barcode });
    });
  });

  app.get("/v1/product-references/:barcode", async (request, reply) => {
    requirePermission(request, "PRODUCT_WRITE");
    const barcode = String((request.params as { barcode?: string }).barcode ?? "").trim();
    if (!barcode || barcode.length > 80) throw new ApiError(400, "BARCODE_INVALID", "الباركود غير صالح");
    const catalog = await db.query<ProductReferenceCatalogRow>(`
      SELECT barcode, name_ar, category, subcategory, brand, manufacturer, size, flavor,
             description, image_source_url, image_asset_path
      FROM product_reference_catalog
      WHERE barcode = $1
    `, [barcode]);
    const catalogItem = catalog.rows[0];
    if (catalogItem) {
      return {
        barcode: catalogItem.barcode,
        nameAr: catalogItem.name_ar,
        category: catalogItem.category,
        subcategory: catalogItem.subcategory,
        size: catalogItem.size,
        manufacturer: catalogItem.manufacturer || catalogItem.brand,
        description: catalogItem.description,
        imageUrl: catalogItem.image_asset_path ? `nabta-media://product/${encodeURIComponent(catalogItem.barcode)}` : catalogItem.image_source_url,
        notes: [catalogItem.brand, catalogItem.flavor].filter(Boolean).join(" • "),
      };
    }
    const reference = findProductReference(barcode);
    if (!reference) return reply.code(404).send({ code: "REFERENCE_NOT_FOUND", message: "لا توجد بيانات مرجعية لهذا الباركود" });
    return reference;
  });

  app.get("/v1/media/catalog-images", async () => {
    const result = await db.query<{ barcode: string; image_source_url: string }>(`
      SELECT barcode, image_source_url
      FROM product_reference_catalog
      WHERE image_source_url <> ''
    `);
    return result.rows.map((r) => ({ barcode: r.barcode, url: r.image_source_url }));
  });

  app.get("/v1/products/export", async (request, reply) => {
    const auth = requirePermission(request, "EXPORT");
    const query = productExportRequestSchema.parse(request.query);
    if (query.mode === "INTERNAL" && !auth.permissions.has("VIEW_COST")) {
      throw new ApiError(403, "FORBIDDEN", "ليس لديك صلاحية تصدير سعر الجملة الداخلي");
    }
    const normalized = normalizeArabicSearch(query.query ?? "");
    const result = await db.query<CatalogRow>(`
      SELECT p.id, p.name_ar, p.category, p.unit_kind, p.weight_unit, p.price_minor, p.wholesale_price_minor, p.reorder_level_milli, p.version,
             sb.qty_milli, sb.warehouse_id,
             COALESCE(array_agg(pb.barcode ORDER BY pb.barcode) FILTER (WHERE pb.barcode IS NOT NULL), '{}') AS barcodes
      FROM terminals t JOIN products p ON p.active
      LEFT JOIN stock_balances sb ON sb.product_id = p.id AND sb.warehouse_id = t.warehouse_id
      LEFT JOIN product_barcodes pb ON pb.product_id = p.id
      WHERE t.id = $1
        AND ($2 = '' OR pb.barcode = $2 OR p.search_name LIKE '%' || $3 || '%' OR lower(p.sku) LIKE '%' || lower($2) || '%')
        AND (cardinality($4::uuid[]) = 0 OR p.id = ANY($4::uuid[]))
        AND (NOT $5::boolean OR COALESCE(sb.qty_milli, 0) > 0)
      GROUP BY p.id, sb.qty_milli, sb.warehouse_id ORDER BY p.name_ar
    `, [auth.terminalId, query.query ?? "", normalized, query.productIds ?? [], query.availableOnly]);
    const lines = [query.mode === "INTERNAL"
      ? "nameAr,category,unitKind,priceMinor,barcode,reorderLevelMilli,openingQtyMilli,openingUnitCostMinor,wholesalePriceMinor"
      : "nameAr,category,unitKind,priceMinor,barcode,reorderLevelMilli,openingQtyMilli,openingUnitCostMinor"];
    for (const row of result.rows) for (const barcode of row.barcodes) {
      const base = [row.name_ar, row.category, row.unit_kind, row.price_minor, barcode, row.reorder_level_milli, 0, 0];
      if (query.mode === "INTERNAL") base.push(row.wholesale_price_minor);
      lines.push(base.map(csvCell).join(","));
    }
    return reply.type("text/csv; charset=utf-8").send("\uFEFF" + lines.join("\r\n") + "\r\n");
  });

  app.get("/v1/products/export-data", async (request) => {
    const auth = requirePermission(request, "EXPORT");
    const query = productExportRequestSchema.parse(request.query);
    if (query.mode === "INTERNAL" && !auth.permissions.has("VIEW_COST")) {
      throw new ApiError(403, "FORBIDDEN", "ليس لديك صلاحية تصدير سعر الجملة الداخلي");
    }
    const normalized = normalizeArabicSearch(query.query ?? "");
    const [store, products] = await Promise.all([
      db.query<{ store_name: string }>("SELECT store_name FROM system_state WHERE singleton"),
      db.query<CatalogRow>(`
        SELECT p.id, p.name_ar, p.description, p.category, p.unit_kind, p.weight_unit, p.price_minor, p.carton_price_minor, p.carton_contents_unit, p.retail_package_size, p.retail_package_price_minor, p.retail_package_unit, p.retail_package_label, p.wholesale_price_minor, p.purchase_pack_size, p.reorder_level_milli, p.version,
               COALESCE(sb.qty_milli, 0) AS qty_milli, COALESCE(sb.version, 0) AS stock_version, sb.warehouse_id,
               COALESCE(array_agg(pb.barcode ORDER BY pb.barcode) FILTER (WHERE pb.barcode IS NOT NULL), '{}') AS barcodes,
               COALESCE(jsonb_agg(jsonb_build_object('barcode', pb.barcode, 'saleUnit', pb.sale_unit) ORDER BY pb.barcode) FILTER (WHERE pb.barcode IS NOT NULL), '[]'::jsonb) AS barcode_mappings
        FROM terminals t
        JOIN products p ON p.active
        LEFT JOIN stock_balances sb ON sb.product_id = p.id AND sb.warehouse_id = t.warehouse_id
        LEFT JOIN product_barcodes pb ON pb.product_id = p.id
        WHERE t.id = $1
          AND ($2 = '' OR pb.barcode = $2 OR p.search_name LIKE '%' || $3 || '%' OR lower(p.sku) LIKE '%' || lower($2) || '%')
          AND (cardinality($4::uuid[]) = 0 OR p.id = ANY($4::uuid[]))
          AND (NOT $5::boolean OR COALESCE(sb.qty_milli, 0) > 0)
       GROUP BY p.id, sb.qty_milli, sb.warehouse_id, sb.version
        ORDER BY p.name_ar
      `, [auth.terminalId, query.query ?? "", normalized, query.productIds ?? [], query.availableOnly]),
    ]);
    return {
      storeName: store.rows[0]?.store_name ?? "نبتة",
      generatedAt: new Date().toISOString(),
      mode: query.mode,
      items: products.rows.map((product) => ({
        nameAr: product.name_ar,
        category: product.category,
        barcode: product.barcode_mappings.find((mapping) => mapping.saleUnit === "UNIT")?.barcode ?? product.barcodes[0] ?? null,
        description: product.description,
        unitKind: product.unit_kind,
        weightUnit: product.weight_unit,
        availableQtyMilli: product.qty_milli,
        stockVersion: product.stock_version,
        reorderLevelMilli: product.reorder_level_milli,
        priceMinor: product.price_minor,
        purchasePackSize: product.purchase_pack_size,
        ...(product.carton_price_minor ? { cartonPriceMinor: product.carton_price_minor } : {}),
        ...(product.carton_contents_unit ? { cartonContentsUnit: product.carton_contents_unit } : {}),
        ...(product.retail_package_size && product.retail_package_price_minor && product.retail_package_unit ? { retailPackage: { unitsPerPackage: product.retail_package_size, packagePriceMinor: product.retail_package_price_minor, contentsUnit: product.retail_package_unit, ...(product.retail_package_label !== "PACKAGE" && product.retail_package_label ? { label: product.retail_package_label } : {}) } } : {}),
        barcodeMappings: product.barcode_mappings,
        ...(query.mode === "INTERNAL" ? { wholesalePriceMinor: product.wholesale_price_minor } : {}),
      })),
    };
  });

  app.get("/v1/inventory/export", async (request) => {
    const auth = requirePermission(request, "EXPORT");
    const [store, inventory] = await Promise.all([
      db.query<{ store_name: string }>("SELECT store_name FROM system_state WHERE singleton"),
      db.query<{
        name_ar: string;
        category: string;
        unit_kind: "PIECE" | "WEIGHT";
        price_minor: number;
        carton_price_minor: number | null;
        carton_contents_unit: "PIECE" | "BAG" | null;
        qty_milli: number;
        created_at: string;
        barcodes: string[];
      }>(`
        SELECT p.name_ar, p.category, p.unit_kind, p.price_minor, sb.qty_milli, p.created_at,
               COALESCE(array_agg(pb.barcode ORDER BY pb.barcode) FILTER (WHERE pb.barcode IS NOT NULL), '{}') AS barcodes
        FROM terminals t
        JOIN stock_balances sb ON sb.warehouse_id = t.warehouse_id AND sb.qty_milli > 0
        JOIN products p ON p.id = sb.product_id AND p.active
        LEFT JOIN product_barcodes pb ON pb.product_id = p.id
        WHERE t.id = $1
        GROUP BY p.id, sb.qty_milli
        ORDER BY p.name_ar
      `, [auth.terminalId]),
    ]);
    return {
      storeName: store.rows[0]?.store_name ?? "نبتة",
      generatedAt: new Date().toISOString(),
      items: inventory.rows.map((item) => ({
        nameAr: item.name_ar,
        category: item.category,
        barcode: item.barcodes[0] ?? null,
        unitKind: item.unit_kind,
        availableQtyMilli: item.qty_milli,
        priceMinor: item.price_minor,
        createdAt: item.created_at,
      })),
    };
  });

  app.post("/v1/products/import", async (request, reply) => {
    const auth = requirePermission(request, "PRODUCT_WRITE");
    const body = productCsvImportRequestSchema.parse(request.body);
    const parsed = parseCsv(body.csv);
    if (body.preview) return { preview: true, rowCount: parsed.rows.length, errors: parsed.errors };
    if (parsed.errors.length) throw new ApiError(422, "CSV_INVALID", "يوجد خطأ في ملف الأصناف؛ استخدم المعاينة أولاً", { errors: parsed.errors });
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !/^[0-9a-f-]{36}$/i.test(key)) throw new ApiError(400, "IDEMPOTENCY_REQUIRED", "مفتاح العملية مطلوب للاستيراد");
    const payloadHash = sha256(canonicalJson(body));
    const result = await transaction(db, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [auth.userId + ":" + key]);
      const prior = await client.query<{ payload_hash: string; status: string; response_body: unknown }>("SELECT payload_hash, status, response_body FROM idempotency_requests WHERE user_id = $1 AND key = $2 FOR UPDATE", [auth.userId, key]);
      if (prior.rows[0]) {
        if (prior.rows[0].payload_hash !== payloadHash) throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "مفتاح العملية مستخدم ببيانات مختلفة");
        if (prior.rows[0].status === "COMPLETED") return prior.rows[0].response_body;
      } else await client.query("INSERT INTO idempotency_requests(user_id, key, payload_hash) VALUES ($1, $2, $3)", [auth.userId, key, payloadHash]);
      const terminal = await client.query<{ warehouse_id: string }>("SELECT warehouse_id FROM terminals WHERE id = $1 AND active", [auth.terminalId]);
      if (!terminal.rows[0]) throw new ApiError(409, "TERMINAL_INVALID", "نقطة البيع غير صالحة");
      const barcodes = parsed.rows.flatMap((item) => (item.barcodeMappings ?? [{ barcode: item.barcode, saleUnit: "UNIT" as const }]).map((mapping) => mapping.barcode));
      const existing = await client.query<{ barcode: string; id: string; active: boolean; unit_kind: "PIECE" | "WEIGHT"; weight_unit: "KILOGRAM" | "GRAM" | "LITER" | "MILLILITER" }>(`
        SELECT pb.barcode, p.id, p.active, p.unit_kind, p.weight_unit
        FROM product_barcodes pb JOIN products p ON p.id = pb.product_id
        WHERE pb.barcode = ANY($1::text[])
        FOR UPDATE OF p
      `, [barcodes]);
      const existingByBarcode = new Map(existing.rows.map((item) => [item.barcode, item]));
      let createdCount = 0;
      let updatedCount = 0;
      for (const item of parsed.rows) {
        if (item.unitKind === "PIECE" && (item.openingQtyMilli % 1000 !== 0 || item.reorderLevelMilli % 1000 !== 0)) throw new ApiError(422, "PIECE_FRACTION", "أحد أصناف القطعة يحتوي كمية كسرية");
        const current = existingByBarcode.get(item.barcode);
        if (current) {
          if (!current.active) throw new ApiError(409, "BARCODE_ARCHIVED", "الباركود مسجل لصنف مؤرشف؛ استعده من الإدارة أو استخدم باركوداً جديداً", { barcode: item.barcode });
          if (current.unit_kind !== item.unitKind) throw new ApiError(422, "UNIT_KIND_IMMUTABLE", "لا يمكن تغيير طريقة بيع صنف قائم من ملف الاستيراد؛ أنشئ صنفاً جديداً عند اختلاف الوحدة", { barcode: item.barcode });
          if (current.unit_kind === "WEIGHT" && current.weight_unit !== item.weightUnit) throw new ApiError(422, "WEIGHT_UNIT_IMMUTABLE", "لا يمكن تغيير كيلو/جرام/لتر/ملليلتر لصنف قائم من ملف الاستيراد؛ أنشئ صنفاً جديداً عند اختلاف الوحدة", { barcode: item.barcode });
          if (item.availableQtyMilli !== undefined && item.unitKind === "PIECE" && item.availableQtyMilli % 1000 !== 0) throw new ApiError(422, "PIECE_FRACTION", "العدد المتاح لصنف القطعة يجب أن يكون عدداً صحيحاً");
          if (item.advancedWorkbook) {
            const secondaryMappings = (item.barcodeMappings ?? []).filter((mapping) => mapping.saleUnit !== "UNIT");
            for (const mapping of secondaryMappings) {
              const owner = existingByBarcode.get(mapping.barcode);
              if (owner && owner.id !== current.id) throw new ApiError(409, "BARCODE_EXISTS", "باركود العبوة أو الكرتونة مسجل لصنف آخر؛ ضم الأصناف المتكررة من بطاقة الصنف أولاً", { barcode: mapping.barcode });
            }
            await client.query("DELETE FROM product_barcodes WHERE product_id = $1 AND sale_unit IN ('PACKAGE', 'CARTON')", [current.id]);
            for (const mapping of secondaryMappings) {
              const conversionQtyMilli = mapping.saleUnit === "PACKAGE" ? item.retailPackage!.unitsPerPackage * 1000 : item.purchasePackSize! * 1000;
              await client.query("INSERT INTO product_barcodes(product_id, barcode, conversion_qty_milli, sale_unit) VALUES ($1, $2, $3, $4)", [current.id, mapping.barcode, conversionQtyMilli, mapping.saleUnit]);
            }
          }
          const balance = await client.query<{ qty_milli: number; inventory_value_minor: number; version: number }>(
            "SELECT qty_milli, inventory_value_minor, version FROM stock_balances WHERE warehouse_id = $1 AND product_id = $2 FOR UPDATE",
            [terminal.rows[0].warehouse_id, current.id],
          );
          const currentBalance = balance.rows[0];
          if (!currentBalance) throw new ApiError(404, "STOCK_BALANCE_MISSING", "رصيد الصنف غير موجود");
          const actualQtyMilli = item.availableQtyMilli ?? currentBalance.qty_milli;
          if (item.advancedWorkbook && item.expectedStockVersion !== undefined && actualQtyMilli !== currentBalance.qty_milli && currentBalance.version !== item.expectedStockVersion) {
            throw new ApiError(409, "WORKBOOK_STOCK_STALE", "رصيد هذا الصنف تغير داخل البرنامج بعد تصدير ملف Excel؛ صدّر قالباً جديداً ثم أعد كتابة الكمية المطلوبة", { barcode: item.barcode, exportedAt: item.exportedAt, expectedStockVersion: item.expectedStockVersion, currentStockVersion: currentBalance.version });
          }
          const delta = actualQtyMilli - currentBalance.qty_milli;
          let inventoryValueMinor = currentBalance.inventory_value_minor;
          if (delta !== 0) {
            const valueDelta = delta > 0
              ? toSafeNumber(calculateLineMinor(BigInt(item.wholesalePriceMinor), BigInt(delta)), "workbookStockGain")
              : -toSafeNumber(calculateInventoryIssueValue(BigInt(currentBalance.inventory_value_minor), BigInt(currentBalance.qty_milli), BigInt(-delta)), "workbookStockIssue");
            inventoryValueMinor += valueDelta;
            if (inventoryValueMinor < 0) throw new Error("negative inventory value invariant failed");
            const count = await client.query<{ id: string }>(`
              INSERT INTO stock_counts(warehouse_id, product_id, expected_qty_milli, actual_qty_milli, expected_version, value_delta_minor, reason, user_id, approved_by)
              VALUES ($1, $2, $3, $4, $5, $6, 'تعديل الكمية من ملف Excel للأصناف', $7, $7) RETURNING id
            `, [terminal.rows[0].warehouse_id, current.id, currentBalance.qty_milli, actualQtyMilli, currentBalance.version, valueDelta, auth.userId]);
            await client.query("UPDATE stock_balances SET qty_milli = $3, inventory_value_minor = $4, version = version + 1, updated_at = now() WHERE warehouse_id = $1 AND product_id = $2", [terminal.rows[0].warehouse_id, current.id, actualQtyMilli, inventoryValueMinor]);
            await client.query(`INSERT INTO stock_movements(warehouse_id, product_id, movement_type, qty_delta_milli, value_delta_minor, balance_qty_milli, balance_value_minor, reference_type, reference_id, actor_user_id, reason)
              VALUES ($1, $2, 'COUNT_ADJUSTMENT', $3, $4, $5, $6, 'product_workbook', $7, $8, 'تعديل الكمية من ملف Excel للأصناف')`, [terminal.rows[0].warehouse_id, current.id, delta, valueDelta, actualQtyMilli, inventoryValueMinor, count.rows[0]!.id, auth.userId]);
            if (delta > 0) await client.query("INSERT INTO stock_lots(warehouse_id, product_id, lot_code, qty_milli) VALUES ($1, $2, 'WORKBOOK-ADJUSTMENT', $3)", [terminal.rows[0].warehouse_id, current.id, delta]);
            if (delta < 0) {
              let remaining = -delta;
              const lots = await client.query<{ id: string; qty_milli: number }>("SELECT id, qty_milli FROM stock_lots WHERE warehouse_id = $1 AND product_id = $2 AND qty_milli > 0 ORDER BY (expires_on IS NULL), expires_on, received_at, id FOR UPDATE", [terminal.rows[0].warehouse_id, current.id]);
              for (const lot of lots.rows) {
                const issued = Math.min(remaining, lot.qty_milli);
                if (issued > 0) await client.query("UPDATE stock_lots SET qty_milli = qty_milli - $2 WHERE id = $1", [lot.id, issued]);
                remaining -= issued;
                if (remaining === 0) break;
              }
              if (remaining !== 0) throw new Error("workbook lot allocation invariant failed");
            }
          }
          if (item.advancedWorkbook) {
            await client.query(`
              UPDATE products
              SET name_ar = $2, search_name = $3, category = $4, description = $5, price_minor = $6,
                  carton_price_minor = $7, carton_contents_unit = $8, wholesale_price_minor = $9, purchase_pack_size = $10,
                  retail_package_size = $11, retail_package_price_minor = $12, retail_package_unit = $13, retail_package_label = $14,
                  reorder_level_milli = $15, updated_at = now()
              WHERE id = $1
            `, [current.id, item.nameAr, normalizeArabicSearch(item.nameAr), item.category, item.description ?? "", item.priceMinor, item.cartonPriceMinor ?? null, item.cartonContentsUnit ?? null, item.wholesalePriceMinor, item.purchasePackSize ?? 1, item.retailPackage?.unitsPerPackage ?? null, item.retailPackage?.packagePriceMinor ?? null, item.retailPackage?.contentsUnit ?? null, item.retailPackage?.label ?? "PACKAGE", item.reorderLevelMilli]);
          } else {
            await client.query(`
              UPDATE products
              SET name_ar = $2, search_name = $3, category = $4, price_minor = $5,
                  wholesale_price_minor = $6, reorder_level_milli = $7, updated_at = now()
              WHERE id = $1
            `, [current.id, item.nameAr, normalizeArabicSearch(item.nameAr), item.category, item.priceMinor, item.wholesalePriceMinor, item.reorderLevelMilli]);
          }
          await audit(client, auth, "PRODUCT_IMPORTED_UPDATED", "product", current.id, { barcode: item.barcode, source: "product_import", previousQtyMilli: currentBalance.qty_milli, actualQtyMilli });
          updatedCount += 1;
          continue;
        }
        if (item.advancedWorkbook) {
          for (const mapping of (item.barcodeMappings ?? []).filter((candidate) => candidate.saleUnit !== "UNIT")) {
            if (existingByBarcode.has(mapping.barcode)) throw new ApiError(409, "BARCODE_EXISTS", "باركود العبوة أو الكرتونة مسجل لصنف آخر؛ لا يمكن إنشاء صنف جديد به", { barcode: mapping.barcode });
          }
        }
        const openingValueMinor = item.openingQtyMilli === 0 ? 0 : toSafeNumber(calculateLineMinor(BigInt(item.openingUnitCostMinor), BigInt(item.openingQtyMilli)), "openingValueMinor");
        const product = item.advancedWorkbook
          ? await client.query<{ id: string }>("INSERT INTO products(name_ar, search_name, category, description, unit_kind, weight_unit, price_minor, carton_price_minor, carton_contents_unit, wholesale_price_minor, purchase_pack_size, retail_package_size, retail_package_price_minor, retail_package_unit, retail_package_label, reorder_level_milli) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id", [item.nameAr, normalizeArabicSearch(item.nameAr), item.category, item.description ?? "", item.unitKind, item.weightUnit, item.priceMinor, item.cartonPriceMinor ?? null, item.cartonContentsUnit ?? null, item.wholesalePriceMinor, item.purchasePackSize ?? 1, item.retailPackage?.unitsPerPackage ?? null, item.retailPackage?.packagePriceMinor ?? null, item.retailPackage?.contentsUnit ?? null, item.retailPackage?.label ?? "PACKAGE", item.reorderLevelMilli])
          : await client.query<{ id: string }>("INSERT INTO products(name_ar, search_name, category, unit_kind, weight_unit, price_minor, wholesale_price_minor, reorder_level_milli) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id", [item.nameAr, normalizeArabicSearch(item.nameAr), item.category, item.unitKind, item.weightUnit, item.priceMinor, item.wholesalePriceMinor, item.reorderLevelMilli]);
        const id = product.rows[0]!.id;
        for (const mapping of item.barcodeMappings ?? [{ barcode: item.barcode, saleUnit: "UNIT" as const }]) {
          const conversionQtyMilli = mapping.saleUnit === "PACKAGE" ? item.retailPackage!.unitsPerPackage * 1000 : mapping.saleUnit === "CARTON" ? item.purchasePackSize! * 1000 : 1000;
          await client.query("INSERT INTO product_barcodes(product_id, barcode, conversion_qty_milli, sale_unit) VALUES ($1, $2, $3, $4)", [id, mapping.barcode, conversionQtyMilli, mapping.saleUnit]);
        }
        await client.query("INSERT INTO stock_balances(warehouse_id, product_id, qty_milli, inventory_value_minor, version) VALUES ($1, $2, $3, $4, $5)", [terminal.rows[0].warehouse_id, id, item.openingQtyMilli, openingValueMinor, item.openingQtyMilli > 0 ? 1 : 0]);
        if (item.openingQtyMilli > 0) {
          const lot = await client.query<{ id: string }>("INSERT INTO stock_lots(warehouse_id, product_id, lot_code, qty_milli) VALUES ($1, $2, 'CSV-OPENING', $3) RETURNING id", [terminal.rows[0].warehouse_id, id, item.openingQtyMilli]);
          await client.query("INSERT INTO stock_movements(warehouse_id, product_id, movement_type, qty_delta_milli, value_delta_minor, balance_qty_milli, balance_value_minor, reference_type, reference_id, actor_user_id, reason) VALUES ($1, $2, 'OPENING', $3, $4, $3, $4, 'csv_import', $5, $6, 'استيراد أصناف CSV')", [terminal.rows[0].warehouse_id, id, item.openingQtyMilli, openingValueMinor, lot.rows[0]!.id, auth.userId]);
        }
        await audit(client, auth, "PRODUCT_IMPORTED", "product", id, { barcode: item.barcode });
        createdCount += 1;
      }
      const response = { importedCount: parsed.rows.length, createdCount, updatedCount, errors: [] };
      await client.query("UPDATE idempotency_requests SET status = 'COMPLETED', response_status = 201, response_body = $3::jsonb, completed_at = now() WHERE user_id = $1 AND key = $2", [auth.userId, key, JSON.stringify(response)]);
      return response;
    });
    return reply.status(201).send(result);
  });

  app.get("/v1/catalog", async (request) => {
    const auth = requireAuth(request);
    const query = typeof (request.query as Record<string, unknown>).query === "string" ? String((request.query as Record<string, unknown>).query).trim() : "";
    const category = typeof (request.query as Record<string, unknown>).category === "string" ? String((request.query as Record<string, unknown>).category).trim() : "";
    const unitKindRaw = typeof (request.query as Record<string, unknown>).unitKind === "string" ? String((request.query as Record<string, unknown>).unitKind).trim() : "";
    const unitKind = unitKindRaw === "PIECE" || unitKindRaw === "WEIGHT" ? unitKindRaw : "";
    const limitInput = Number((request.query as Record<string, unknown>).limit ?? 60);
    const limit = Number.isInteger(limitInput) ? Math.min(Math.max(limitInput, 1), 200) : 60;
    const cursor = decodeCatalogCursor((request.query as Record<string, unknown>).cursor);
    const normalized = normalizeArabicSearch(query);
    const tokens = normalized.split(/\s+/).filter(Boolean);

    const params: unknown[] = [auth.terminalId, query, normalized, category];
    // This slot remains stable when the query is rerun with fuzzy candidates.
    // It keeps the fast SQL path free of approximate matching unless needed.
    params.push([] as string[]);
    const fuzzyProductIdsIdx = params.length;
    // The value is restricted to the two literals above, so interpolation keeps
    // the dynamic keyset-query parameter indexes stable on PGlite and Postgres.
    const unitKindCondition = unitKind ? `AND p.unit_kind = '${unitKind}'` : "";
    let tokenConditionsSql = "true";

    if (tokens.length > 0) {
      const tokenClauses: string[] = [];
      for (const token of tokens) {
        const variants = extractTokenVariants(token);
        const variantClauses: string[] = [];
        for (const variant of variants) {
          params.push(`%${variant}%`);
          variantClauses.push(`p.search_name LIKE $${params.length}`);
        }
        tokenClauses.push(`(${variantClauses.join(" OR ")})`);
      }
      tokenConditionsSql = tokenClauses.join(" AND ");
    }

    params.push(`${normalized}%`);
    const normalizedPrefixIdx = params.length;

    params.push(`% ${normalized}%`);
    const wordPrefixIdx = params.length;

    params.push(tokens[0] ? `${tokens[0]}%` : "");
    const firstTokenPrefixIdx = params.length;

    params.push(limit + 1);
    const limitIdx = params.length;

    params.push(cursor?.rank ?? null);
    const cursorRankIdx = params.length;

    params.push(cursor?.nameAr ?? null);
    const cursorNameArIdx = params.length;

    params.push(cursor?.id ?? null);
    const cursorIdIdx = params.length;

    if (cursor?.rank === 5) {
      params[fuzzyProductIdsIdx - 1] = await findFuzzyCatalogProductIds(db, { query, category, unitKind });
    }

    const catalogSql = `
      WITH terminal_context AS (
        SELECT warehouse_id FROM terminals WHERE id = $1
      ),
      matched_products AS (
        SELECT p.id, p.name_ar,
          CASE
            WHEN $2 = '' THEN 1
            WHEN EXISTS (
              SELECT 1 FROM product_barcodes exact_barcode
              WHERE exact_barcode.product_id = p.id
                AND (
                  exact_barcode.barcode = $2
                  OR ($2 <> '' AND exact_barcode.barcode = '0' || $2)
                  OR ($2 LIKE '0%' AND exact_barcode.barcode = substring($2 from 2))
                )
            ) THEN 0
            WHEN $3 <> '' AND p.search_name LIKE $${normalizedPrefixIdx} THEN 1
            WHEN $3 <> '' AND p.search_name LIKE $${wordPrefixIdx} THEN 2
            WHEN $${firstTokenPrefixIdx} <> '' AND p.search_name LIKE $${firstTokenPrefixIdx} THEN 3
            WHEN p.id = ANY($${fuzzyProductIdsIdx}::uuid[]) THEN 5
            ELSE 4
          END AS cursor_rank
        FROM products p
        WHERE p.active
          AND (
            $2 = ''
            OR EXISTS (
              SELECT 1 FROM product_barcodes exact_barcode
              WHERE exact_barcode.product_id = p.id
                AND (
                  exact_barcode.barcode = $2
                  OR ($2 <> '' AND exact_barcode.barcode = '0' || $2)
                  OR ($2 LIKE '0%' AND exact_barcode.barcode = substring($2 from 2))
                )
            )
            OR lower(COALESCE(p.sku, '')) LIKE lower($2) || '%'
            OR lower(COALESCE(p.sku, '')) LIKE 'catalog:' || lower($2) || '%'
            OR ($2 <> '' AND lower(COALESCE(p.sku, '')) LIKE 'catalog:0' || lower($2) || '%')
            OR (${tokenConditionsSql})
            OR p.id = ANY($${fuzzyProductIdsIdx}::uuid[])
          )
          AND ($4 = '' OR p.category = $4)
          ${unitKindCondition}
      ),
      paged_products AS (
        SELECT * FROM matched_products
        WHERE $${cursorRankIdx}::int IS NULL
           OR cursor_rank > $${cursorRankIdx}
           OR (cursor_rank = $${cursorRankIdx} AND (name_ar > $${cursorNameArIdx} OR (name_ar = $${cursorNameArIdx} AND id > $${cursorIdIdx}::uuid)))
        ORDER BY cursor_rank, name_ar, id
        LIMIT $${limitIdx}
      )
      SELECT p.id, p.name_ar, p.description, p.category, p.unit_kind, p.weight_unit, p.price_minor, p.carton_price_minor, p.carton_contents_unit, p.retail_package_size, p.retail_package_price_minor, p.retail_package_unit, p.retail_package_label, p.wholesale_price_minor, p.purchase_pack_size, p.reorder_level_milli,
             COALESCE(sb.qty_milli, 0) AS qty_milli,
             COALESCE(sb.version, 0) AS stock_version,
             sb.warehouse_id, matched.cursor_rank,
             COALESCE(array_agg(pb.barcode ORDER BY pb.barcode) FILTER (WHERE pb.barcode IS NOT NULL), '{}') AS barcodes,
             COALESCE(jsonb_agg(jsonb_build_object('barcode', pb.barcode, 'saleUnit', pb.sale_unit) ORDER BY pb.barcode) FILTER (WHERE pb.barcode IS NOT NULL), '[]'::jsonb) AS barcode_mappings,
             (
               SELECT ref.barcode
               FROM product_barcodes reference_barcode
               JOIN product_reference_catalog ref ON ref.barcode = reference_barcode.barcode
               WHERE reference_barcode.product_id = p.id AND ref.image_asset_path IS NOT NULL
               ORDER BY reference_barcode.created_at, ref.barcode
               LIMIT 1
             ) AS image_barcode
      FROM paged_products matched
      JOIN products p ON p.id = matched.id
      JOIN terminal_context t ON true
      LEFT JOIN stock_balances sb ON sb.product_id = p.id AND sb.warehouse_id = t.warehouse_id
      LEFT JOIN product_barcodes pb ON pb.product_id = p.id
      GROUP BY p.id, sb.qty_milli, sb.warehouse_id, sb.version, matched.cursor_rank, matched.name_ar, matched.id
      ORDER BY matched.cursor_rank, matched.name_ar, matched.id
    `;
    let result = await db.query<CatalogRow>(catalogSql, params);
    if (!cursor && result.rows.length === 0) {
      const fuzzyProductIds = await findFuzzyCatalogProductIds(db, { query, category, unitKind });
      if (fuzzyProductIds.length > 0) {
        params[fuzzyProductIdsIdx - 1] = fuzzyProductIds;
        result = await db.query<CatalogRow>(catalogSql, params);
      }
    }
    const pageRows = result.rows.slice(0, limit);
    const lastRow = pageRows.at(-1);
    return {
      products: pageRows.map((row) => ({
        id: row.id, warehouseId: row.warehouse_id, nameAr: row.name_ar, description: row.description, category: row.category, unitKind: row.unit_kind, weightUnit: row.weight_unit,
        priceMinor: row.price_minor, ...(row.carton_price_minor ? { cartonPriceMinor: row.carton_price_minor } : {}), ...(row.carton_contents_unit ? { cartonContentsUnit: row.carton_contents_unit } : {}), ...(row.retail_package_size && row.retail_package_price_minor && row.retail_package_unit ? { retailPackage: { unitsPerPackage: row.retail_package_size, packagePriceMinor: row.retail_package_price_minor, contentsUnit: row.retail_package_unit, ...(row.retail_package_label !== "PACKAGE" && row.retail_package_label ? { label: row.retail_package_label } : {}) } } : {}), ...(auth.permissions.has("VIEW_COST") ? { wholesalePriceMinor: row.wholesale_price_minor } : {}), purchasePackSize: row.purchase_pack_size, availableQtyMilli: row.qty_milli, reorderLevelMilli: row.reorder_level_milli,
        barcodes: row.barcodes, barcodeMappings: row.barcode_mappings, ...(row.image_barcode ? { imageBarcode: row.image_barcode } : {}), version: row.stock_version,
      })),
      hasMore: result.rows.length > limit,
      ...(result.rows.length > limit && lastRow ? { nextCursor: encodeCatalogCursor(lastRow) } : {}),
    };
  });

  app.put("/v1/products/:productId", async (request) => {
    const auth = requirePermission(request, "PRODUCT_WRITE");
    const body = updateProductRequestSchema.parse({
      productId: String((request.params as { productId?: string }).productId ?? ""),
      ...(request.body as object),
    });
    if (body.wholesalePriceMinor !== undefined && !auth.permissions.has("VIEW_COST")) {
      throw new ApiError(403, "FORBIDDEN", "ليس لديك صلاحية تعديل سعر الجملة الداخلي");
    }
    if (!auth.permissions.has("STOCK_COUNT") || (auth.role !== "OWNER" && auth.role !== "MANAGER")) {
      throw new ApiError(403, "MANAGER_APPROVAL_REQUIRED", "تعديل الكمية المتاحة يحتاج حساب مدير أو مالك");
    }

    return transaction(db, async (client) => {
      const terminal = await client.query<{ warehouse_id: string }>(
        "SELECT warehouse_id FROM terminals WHERE id = $1 AND active",
        [auth.terminalId],
      );
      if (!terminal.rows[0]) throw new ApiError(409, "TERMINAL_INVALID", "نقطة البيع غير صالحة");

      const current = await client.query<{
        id: string;
        name_ar: string;
        category: string;
        description: string;
        price_minor: number;
        carton_price_minor: number | null;
        carton_contents_unit: "PIECE" | "BAG" | null;
        wholesale_price_minor: number;
        purchase_pack_size: number;
        retail_package_size: number | null;
        retail_package_price_minor: number | null;
        retail_package_unit: "PIECE" | "BAG" | null;
        retail_package_label: "PACKAGE" | "STACK" | "PACKET";
        unit_kind: "PIECE" | "WEIGHT";
      }>(
        "SELECT id, name_ar, category, description, price_minor, carton_price_minor, carton_contents_unit, wholesale_price_minor, purchase_pack_size, retail_package_size, retail_package_price_minor, retail_package_unit, retail_package_label, unit_kind FROM products WHERE id = $1 AND active FOR UPDATE",
        [body.productId],
      );
      const product = current.rows[0];
      if (!product) throw new ApiError(404, "PRODUCT_NOT_FOUND", "الصنف غير موجود أو غير نشط");
      if (product.unit_kind === "PIECE" && body.availableQtyMilli % 1000 !== 0) {
        throw new ApiError(422, "PIECE_FRACTION", "صنف القطعة لا يقبل كمية كسرية");
      }

      const balance = await client.query<{
        qty_milli: number;
        inventory_value_minor: number;
        version: number;
      }>(
        "SELECT qty_milli, inventory_value_minor, version FROM stock_balances WHERE warehouse_id = $1 AND product_id = $2 FOR UPDATE",
        [terminal.rows[0].warehouse_id, body.productId],
      );
      const currentBalance = balance.rows[0];
      if (!currentBalance) throw new ApiError(404, "STOCK_BALANCE_MISSING", "رصيد الصنف غير موجود");
      if (currentBalance.version !== body.expectedStockVersion) {
        throw new ApiError(409, "VERSION_CONFLICT", "تغير الرصيد أثناء التعديل؛ أعد فتح الصنف ثم احفظ مرة أخرى");
      }

      const wholesalePriceMinor = body.wholesalePriceMinor ?? product.wholesale_price_minor;
      const retailPackage = body.retailPackage === undefined
        ? (product.retail_package_size && product.retail_package_price_minor && product.retail_package_unit
          ? { unitsPerPackage: product.retail_package_size, packagePriceMinor: product.retail_package_price_minor, contentsUnit: product.retail_package_unit, label: product.retail_package_label }
          : null)
        : body.retailPackage;
      const cartonPriceMinor = body.cartonPriceMinor === undefined ? product.carton_price_minor : body.cartonPriceMinor;
      const cartonContentsUnit = body.cartonContentsUnit === undefined ? product.carton_contents_unit : body.cartonContentsUnit;
      if (retailPackage && product.unit_kind !== "PIECE") {
        throw new ApiError(422, "RETAIL_PACKAGE_REQUIRES_PIECES", "بيع العبوة الكاملة متاح للأصناف التي تُخزن بالقطعة فقط");
      }
      if (cartonPriceMinor && (product.unit_kind !== "PIECE" || body.purchasePackSize < 2 || !cartonContentsUnit)) {
        throw new ApiError(422, "CARTON_CONFIGURATION_INVALID", "بيع الكرتونة يتطلب صنف قطع وسعة كرتونة لا تقل عن قطعتين ومحتوى محدداً");
      }
      const legacySourceProductIds = new Set<string>();
      if (body.barcodeMappings) {
        if (new Set(body.barcodeMappings.map((item) => item.barcode)).size !== body.barcodeMappings.length || new Set(body.barcodeMappings.map((item) => item.saleUnit)).size !== body.barcodeMappings.length) throw new ApiError(422, "BARCODE_MAPPING_DUPLICATE", "كل باركود ووحدة بيع يجب تسجيلهما مرة واحدة فقط");
        if (body.barcodeMappings.some((item) => item.saleUnit === "PACKAGE") && !retailPackage) throw new ApiError(422, "PACKAGE_BARCODE_INVALID", "حدد بيع العبوة قبل تسجيل باركودها");
        if (body.barcodeMappings.some((item) => item.saleUnit === "CARTON") && !cartonPriceMinor) throw new ApiError(422, "CARTON_BARCODE_INVALID", "حدد بيع الكرتونة قبل تسجيل باركودها");
        const secondaryMappings = body.barcodeMappings.filter((item) => item.saleUnit !== "UNIT");
        if (secondaryMappings.length !== body.barcodeMappings.length) throw new ApiError(422, "BARCODE_UNIT_IMMUTABLE", "باركود القطعة الأساسي لا يُعدّل من هذا النموذج");
        // Keep all legacy/individual barcodes. This form manages only the
        // explicitly-labelled package and carton barcodes.
        await client.query("DELETE FROM product_barcodes WHERE product_id = $1 AND sale_unit IN ('PACKAGE', 'CARTON')", [body.productId]);
        for (const mapping of secondaryMappings) {
          const conversionQtyMilli = mapping.saleUnit === "PACKAGE" ? retailPackage!.unitsPerPackage * 1000 : body.purchasePackSize * 1000;
          const owner = await client.query<{ product_id: string; unit_kind: "PIECE" | "WEIGHT" }>(`
            SELECT pb.product_id, p.unit_kind
            FROM product_barcodes pb
            JOIN products p ON p.id = pb.product_id
            WHERE pb.barcode = $1
            FOR UPDATE
          `, [mapping.barcode]);
          const source = owner.rows[0];
          if (source && source.product_id !== body.productId) {
            if (!body.mergeLegacyProducts) throw new ApiError(409, "BARCODE_EXISTS", "الباركود مسجل لصنف قديم؛ فعّل خيار ضم الباركود لنقله مع رصيده بأمان");
            if (source.unit_kind !== product.unit_kind) throw new ApiError(422, "MERGE_UNIT_KIND_MISMATCH", "لا يمكن ضم صنف بالوزن مع صنف بالقطعة أو العكس");
            await client.query(
              "UPDATE product_barcodes SET product_id = $1, conversion_qty_milli = $3, sale_unit = $4 WHERE barcode = $2",
              [body.productId, mapping.barcode, conversionQtyMilli, mapping.saleUnit],
            );
            legacySourceProductIds.add(source.product_id);
            continue;
          }
          const reassigned = await client.query(
            "UPDATE product_barcodes SET conversion_qty_milli = $3, sale_unit = $4 WHERE product_id = $1 AND barcode = $2",
            [body.productId, mapping.barcode, conversionQtyMilli, mapping.saleUnit],
          );
          if (reassigned.rowCount === 0) {
            await client.query("INSERT INTO product_barcodes(product_id, barcode, conversion_qty_milli, sale_unit) VALUES ($1, $2, $3, $4)", [body.productId, mapping.barcode, conversionQtyMilli, mapping.saleUnit]);
          }
        }
      }
      const delta = body.availableQtyMilli - currentBalance.qty_milli;
      let inventoryValueMinor = currentBalance.inventory_value_minor;
      if (delta !== 0) {
        const valueDelta = delta > 0
          ? toSafeNumber(calculateLineMinor(BigInt(wholesalePriceMinor), BigInt(delta)), "catalogEditorValueDelta")
          : -toSafeNumber(calculateInventoryIssueValue(BigInt(currentBalance.inventory_value_minor), BigInt(currentBalance.qty_milli), BigInt(-delta)), "catalogEditorIssueValue");
        inventoryValueMinor += valueDelta;
        if (inventoryValueMinor < 0) throw new Error("negative inventory value invariant failed");
        const count = await client.query<{ id: string }>(`
          INSERT INTO stock_counts(warehouse_id, product_id, expected_qty_milli, actual_qty_milli, expected_version,
            value_delta_minor, reason, user_id, approved_by)
          VALUES ($1, $2, $3, $4, $5, $6, 'تعديل بيانات الصنف من بطاقة الصنف', $7, $7)
          RETURNING id
        `, [terminal.rows[0].warehouse_id, body.productId, currentBalance.qty_milli, body.availableQtyMilli, currentBalance.version, valueDelta, auth.userId]);
        await client.query(
          "UPDATE stock_balances SET qty_milli = $3, inventory_value_minor = $4, version = version + 1, updated_at = now() WHERE warehouse_id = $1 AND product_id = $2",
          [terminal.rows[0].warehouse_id, body.productId, body.availableQtyMilli, inventoryValueMinor],
        );
        await client.query(`
          INSERT INTO stock_movements(warehouse_id, product_id, movement_type, qty_delta_milli,
            value_delta_minor, balance_qty_milli, balance_value_minor, reference_type, reference_id, actor_user_id, reason)
          VALUES ($1, $2, 'COUNT_ADJUSTMENT', $3, $4, $5, $6, 'product_editor', $7, $8, 'تعديل الكمية من بطاقة الصنف')
        `, [terminal.rows[0].warehouse_id, body.productId, delta, valueDelta, body.availableQtyMilli, inventoryValueMinor, count.rows[0]!.id, auth.userId]);
        if (delta > 0) {
          await client.query(
            "INSERT INTO stock_lots(warehouse_id, product_id, lot_code, qty_milli) VALUES ($1, $2, 'EDITOR-ADJUSTMENT', $3)",
            [terminal.rows[0].warehouse_id, body.productId, delta],
          );
        } else {
          let remaining = -delta;
          const lots = await client.query<{ id: string; qty_milli: number }>(
            "SELECT id, qty_milli FROM stock_lots WHERE warehouse_id = $1 AND product_id = $2 AND qty_milli > 0 ORDER BY (expires_on IS NULL), expires_on, received_at, id FOR UPDATE",
            [terminal.rows[0].warehouse_id, body.productId],
          );
          for (const lot of lots.rows) {
            const issued = Math.min(remaining, lot.qty_milli);
            if (issued > 0) await client.query("UPDATE stock_lots SET qty_milli = qty_milli - $2 WHERE id = $1", [lot.id, issued]);
            remaining -= issued;
            if (remaining === 0) break;
          }
          if (remaining !== 0) throw new Error("product editor lot allocation invariant failed");
        }
      }

      let mergedQtyMilli = 0;
      for (const sourceProductId of legacySourceProductIds) {
        const otherWarehouses = await client.query<{ warehouse_id: string }>(
          "SELECT warehouse_id FROM stock_balances WHERE product_id = $1 AND warehouse_id <> $2 AND qty_milli > 0 FOR UPDATE",
          [sourceProductId, terminal.rows[0].warehouse_id],
        );
        if (otherWarehouses.rows.length) throw new ApiError(409, "MERGE_MULTI_WAREHOUSE", "لا يمكن ضم صنف له رصيد في مخزن آخر؛ انقله أو سوِّ رصيده من ذلك المخزن أولاً");
        const sourceBalanceResult = await client.query<{ qty_milli: number; inventory_value_minor: number; version: number }>(
          "SELECT qty_milli, inventory_value_minor, version FROM stock_balances WHERE warehouse_id = $1 AND product_id = $2 FOR UPDATE",
          [terminal.rows[0].warehouse_id, sourceProductId],
        );
        const sourceBalance = sourceBalanceResult.rows[0];
        if (!sourceBalance) throw new ApiError(404, "MERGE_SOURCE_BALANCE_MISSING", "رصيد الصنف القديم غير موجود");
        if (sourceBalance.qty_milli > 0) {
          const lots = await client.query<{ id: string; qty_milli: number; expires_on: string | null }>(
            "SELECT id, qty_milli, expires_on FROM stock_lots WHERE warehouse_id = $1 AND product_id = $2 AND qty_milli > 0 FOR UPDATE",
            [terminal.rows[0].warehouse_id, sourceProductId],
          );
          if (lots.rows.reduce((sum, lot) => sum + lot.qty_milli, 0) !== sourceBalance.qty_milli) {
            throw new ApiError(409, "MERGE_LOT_BALANCE_MISMATCH", "رصيد الصنف القديم لا يطابق دفعاته؛ راجع المخزون أولاً قبل الضم");
          }
          const targetBalanceResult = await client.query<{ qty_milli: number; inventory_value_minor: number; version: number }>(
            "SELECT qty_milli, inventory_value_minor, version FROM stock_balances WHERE warehouse_id = $1 AND product_id = $2 FOR UPDATE",
            [terminal.rows[0].warehouse_id, body.productId],
          );
          const targetBalance = targetBalanceResult.rows[0]!;
          const targetQtyMilli = targetBalance.qty_milli + sourceBalance.qty_milli;
          const targetValueMinor = targetBalance.inventory_value_minor + sourceBalance.inventory_value_minor;
          const mergeId = randomUUID();
          await client.query(
            "UPDATE stock_balances SET qty_milli = 0, inventory_value_minor = 0, version = version + 1, updated_at = now() WHERE warehouse_id = $1 AND product_id = $2",
            [terminal.rows[0].warehouse_id, sourceProductId],
          );
          await client.query(
            "UPDATE stock_balances SET qty_milli = $3, inventory_value_minor = $4, version = version + 1, updated_at = now() WHERE warehouse_id = $1 AND product_id = $2",
            [terminal.rows[0].warehouse_id, body.productId, targetQtyMilli, targetValueMinor],
          );
          for (const lot of lots.rows) {
            await client.query("UPDATE stock_lots SET qty_milli = 0 WHERE id = $1", [lot.id]);
            await client.query(
              "INSERT INTO stock_lots(warehouse_id, product_id, lot_code, expires_on, qty_milli) VALUES ($1, $2, $3, $4, $5)",
              [terminal.rows[0].warehouse_id, body.productId, `MERGE-${sourceProductId.slice(0, 8)}-${lot.id.slice(0, 8)}`, lot.expires_on, lot.qty_milli],
            );
          }
          await client.query(`
            INSERT INTO stock_movements(warehouse_id, product_id, movement_type, qty_delta_milli,
              value_delta_minor, balance_qty_milli, balance_value_minor, reference_type, reference_id, actor_user_id, reason)
            VALUES ($1, $2, 'TRANSFER_OUT', $3, $4, 0, 0, 'product_merge', $5, $6, 'ضم صنف قديم إلى صنف موحّد')
          `, [terminal.rows[0].warehouse_id, sourceProductId, -sourceBalance.qty_milli, -sourceBalance.inventory_value_minor, mergeId, auth.userId]);
          await client.query(`
            INSERT INTO stock_movements(warehouse_id, product_id, movement_type, qty_delta_milli,
              value_delta_minor, balance_qty_milli, balance_value_minor, reference_type, reference_id, actor_user_id, reason)
            VALUES ($1, $2, 'TRANSFER_IN', $3, $4, $5, $6, 'product_merge', $7, $8, 'ضم صنف قديم إلى صنف موحّد')
          `, [terminal.rows[0].warehouse_id, body.productId, sourceBalance.qty_milli, sourceBalance.inventory_value_minor, targetQtyMilli, targetValueMinor, mergeId, auth.userId]);
          mergedQtyMilli += sourceBalance.qty_milli;
        }
        const remainingBarcodes = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM product_barcodes WHERE product_id = $1", [sourceProductId]);
        if (remainingBarcodes.rows[0]!.count === 0) {
          await client.query("UPDATE products SET active = false, updated_at = now() WHERE id = $1", [sourceProductId]);
        }
        await audit(client, auth, "PRODUCT_MERGED_INTO_PRODUCT", "product", sourceProductId, { targetProductId: body.productId, transferredQtyMilli: sourceBalance.qty_milli });
      }

      await client.query(`
        UPDATE products
        SET name_ar = $2,
            category = $3,
            description = $4,
            search_name = $5,
            price_minor = $6,
            carton_price_minor = $7,
            carton_contents_unit = $8,
            wholesale_price_minor = $9,
            purchase_pack_size = $10,
            retail_package_size = $11,
            retail_package_price_minor = $12,
            retail_package_unit = $13,
            retail_package_label = $14,
            version = version + 1,
            updated_at = now()
        WHERE id = $1
      `, [body.productId, body.nameAr, body.category, body.description, normalizeArabicSearch(body.nameAr), body.priceMinor, cartonPriceMinor, cartonContentsUnit, wholesalePriceMinor, body.purchasePackSize, retailPackage?.unitsPerPackage ?? null, retailPackage?.packagePriceMinor ?? null, retailPackage?.contentsUnit ?? null, retailPackage?.label ?? "PACKAGE"]);
      await audit(client, auth, "PRODUCT_UPDATED", "product", body.productId, {
        previous: {
          nameAr: product.name_ar,
          category: product.category,
          description: product.description,
          priceMinor: product.price_minor,
          cartonPriceMinor: product.carton_price_minor,
          cartonContentsUnit: product.carton_contents_unit,
          wholesalePriceMinor: product.wholesale_price_minor,
          purchasePackSize: product.purchase_pack_size,
          retailPackage: product.retail_package_size && product.retail_package_price_minor && product.retail_package_unit ? { unitsPerPackage: product.retail_package_size, packagePriceMinor: product.retail_package_price_minor, contentsUnit: product.retail_package_unit, label: product.retail_package_label } : null,
          availableQtyMilli: currentBalance.qty_milli,
        },
        next: {
          nameAr: body.nameAr,
          category: body.category,
          description: body.description,
          priceMinor: body.priceMinor,
          cartonPriceMinor,
          cartonContentsUnit,
          wholesalePriceMinor,
          purchasePackSize: body.purchasePackSize,
          retailPackage,
          availableQtyMilli: body.availableQtyMilli + mergedQtyMilli,
        },
      });
      const finalBalance = await client.query<{ version: number }>(
        "SELECT version FROM stock_balances WHERE warehouse_id = $1 AND product_id = $2",
        [terminal.rows[0].warehouse_id, body.productId],
      );
      return { id: body.productId, stockVersion: finalBalance.rows[0]!.version };
    });
  });

  app.put("/v1/products/:productId/price", async (request) => {
    const auth = requirePermission(request, "PRODUCT_WRITE");
    const body = updateProductPriceRequestSchema.parse({
      productId: String((request.params as { productId?: string }).productId ?? ""),
      ...(request.body as object),
    });
    if (body.wholesalePriceMinor !== undefined && !auth.permissions.has("VIEW_COST")) throw new ApiError(403, "FORBIDDEN", "ليس لديك صلاحية تعديل سعر الجملة الداخلي");
    return transaction(db, async (client) => {
      const current = await client.query<{ id: string; name_ar: string; price_minor: number; wholesale_price_minor: number }>(
        "SELECT id, name_ar, price_minor, wholesale_price_minor FROM products WHERE id = $1 AND active FOR UPDATE",
        [body.productId],
      );
      if (!current.rows[0]) throw new ApiError(404, "PRODUCT_NOT_FOUND", "الصنف غير موجود أو غير نشط");
      const product = current.rows[0];
      await client.query("UPDATE products SET price_minor = COALESCE($2, price_minor), wholesale_price_minor = COALESCE($3, wholesale_price_minor), updated_at = now() WHERE id = $1", [body.productId, body.priceMinor ?? null, body.wholesalePriceMinor ?? null]);
      await audit(client, auth, "PRODUCT_PRICE_UPDATED", "product", body.productId, {
        nameAr: product.name_ar,
        previousPriceMinor: product.price_minor,
        priceMinor: body.priceMinor ?? product.price_minor,
        previousWholesalePriceMinor: product.wholesale_price_minor,
        wholesalePriceMinor: body.wholesalePriceMinor ?? product.wholesale_price_minor,
      });
      return { id: body.productId, priceMinor: body.priceMinor ?? product.price_minor, wholesalePriceMinor: body.wholesalePriceMinor ?? product.wholesale_price_minor };
    });
  });

  app.delete("/v1/products/:productId", async (request) => {
    const auth = requirePermission(request, "PRODUCT_WRITE");
    const body = archiveProductRequestSchema.parse({
      productId: String((request.params as { productId?: string }).productId ?? ""),
    });
    return transaction(db, async (client) => {
      const current = await client.query<{ id: string; name_ar: string }>(
        "SELECT id, name_ar FROM products WHERE id = $1 AND active FOR UPDATE",
        [body.productId],
      );
      if (!current.rows[0]) throw new ApiError(404, "PRODUCT_NOT_FOUND", "الصنف غير موجود أو حُذف بالفعل");

      const balances = await client.query<{ qty_milli: number }>(
        "SELECT qty_milli FROM stock_balances WHERE product_id = $1 FOR UPDATE",
        [body.productId],
      );
      const remainingQtyMilli = balances.rows.reduce((total, balance) => total + balance.qty_milli, 0);
      if (remainingQtyMilli !== 0) {
        throw new ApiError(409, "PRODUCT_HAS_STOCK", "لا يمكن حذف صنف له رصيد متاح. صفّر الرصيد أولاً بحركة جرد أو تسوية مسجلة.");
      }

      // A never-used draft product can be removed physically.  Once it has a
      // financial or stock history, keep that immutable history and archive the
      // card instead; re-entering its barcode will restore and overwrite it.
      const history = await client.query<{
        has_sale: boolean;
        has_purchase: boolean;
        has_movement: boolean;
        has_count: boolean;
        has_lot: boolean;
      }>(`
        SELECT
          EXISTS(SELECT 1 FROM sale_lines WHERE product_id = $1) AS has_sale,
          EXISTS(SELECT 1 FROM purchase_receipt_lines WHERE product_id = $1) AS has_purchase,
          EXISTS(SELECT 1 FROM stock_movements WHERE product_id = $1) AS has_movement,
          EXISTS(SELECT 1 FROM stock_counts WHERE product_id = $1) AS has_count,
          EXISTS(SELECT 1 FROM stock_lots WHERE product_id = $1) AS has_lot
      `, [body.productId]);
      const used = history.rows[0]!;
      if (!used.has_sale && !used.has_purchase && !used.has_movement && !used.has_count && !used.has_lot) {
        await client.query("DELETE FROM weighted_product_labels WHERE product_id = $1", [body.productId]);
        await client.query("DELETE FROM product_barcodes WHERE product_id = $1", [body.productId]);
        await client.query("DELETE FROM stock_balances WHERE product_id = $1", [body.productId]);
        await client.query("DELETE FROM products WHERE id = $1", [body.productId]);
        await audit(client, auth, "PRODUCT_PURGED", "product", body.productId, { nameAr: current.rows[0].name_ar });
        return { id: body.productId, purged: true, archived: false };
      }

      await client.query("UPDATE products SET active = false, updated_at = now(), version = version + 1 WHERE id = $1", [body.productId]);
      await audit(client, auth, "PRODUCT_ARCHIVED", "product", body.productId, {
        nameAr: current.rows[0].name_ar,
        remainingQtyMilli,
      });
      return { id: body.productId, purged: false, archived: true };
    });
  });

  app.post("/v1/products", async (request, reply) => {
    const auth = requirePermission(request, "PRODUCT_WRITE");
    const body = createProductRequestSchema.parse(request.body);
    const barcodeMappings = body.barcodeMappings ?? body.barcodes.map((barcode) => ({ barcode, saleUnit: "UNIT" as const }));
    if (new Set(barcodeMappings.map((item) => item.barcode)).size !== barcodeMappings.length || new Set(barcodeMappings.map((item) => item.saleUnit)).size !== barcodeMappings.length) {
      throw new ApiError(422, "BARCODE_MAPPING_DUPLICATE", "كل باركود ووحدة بيع يجب تسجيلهما مرة واحدة فقط");
    }
    if (barcodeMappings.some((item) => item.saleUnit === "PACKAGE") && !body.retailPackage) throw new ApiError(422, "PACKAGE_BARCODE_INVALID", "سجل باركود العبوة بعد تحديد بيع العبوة الكاملة");
    if (barcodeMappings.some((item) => item.saleUnit === "CARTON") && !body.cartonPriceMinor) throw new ApiError(422, "CARTON_BARCODE_INVALID", "سجل باركود الكرتونة بعد تحديد سعر بيع الكرتونة");
    if (body.retailPackage && body.unitKind !== "PIECE") {
      throw new ApiError(422, "RETAIL_PACKAGE_UNIT_INVALID", "بيع العبوة الكاملة متاح للأصناف التي تباع بالقطعة فقط");
    }
    if (body.unitKind === "PIECE" && (body.openingQtyMilli % 1000 !== 0 || body.reorderLevelMilli % 1000 !== 0)) {
      throw new ApiError(422, "PIECE_FRACTION", "صنف القطعة لا يقبل كمية كسرية");
    }
    if (body.openingTotalCostMinor === undefined && (body.openingQtyMilli === 0) !== (body.openingUnitCostMinor === 0)) {
      throw new ApiError(422, "OPENING_VALUE_MISMATCH", "الكمية والقيمة الافتتاحيتان يجب أن تكونا صفرًا معًا أو موجبتين معًا");
    }
    if (body.openingTotalCostMinor !== undefined && ((body.openingQtyMilli === 0) !== (body.openingTotalCostMinor === 0))) {
      throw new ApiError(422, "OPENING_VALUE_MISMATCH", "إجمالي تكلفة الرصيد الافتتاحي يجب أن يكون صفرًا مع كمية صفر، أو موجبًا مع كمية موجبة");
    }
    const openingValueMinor = body.openingTotalCostMinor ?? (body.openingQtyMilli === 0 ? 0 : toSafeNumber(calculateLineMinor(BigInt(body.openingUnitCostMinor), BigInt(body.openingQtyMilli)), "openingValueMinor"));
    const product = await transaction(db, async (client) => {
      const terminal = await client.query<{ warehouse_id: string }>("SELECT warehouse_id FROM terminals WHERE id = $1 AND active", [auth.terminalId]);
      if (!terminal.rows[0]) throw new ApiError(409, "TERMINAL_INVALID", "نقطة البيع غير صالحة");
      // A barcode is the durable identity of a retail item.  When the cashier
      // receives its carton/package details after first registering the loose
      // unit, turn this request into an update of that same item instead of
      // failing on the global barcode uniqueness constraint.
      const incomingBarcodes = [...new Set(barcodeMappings.map((mapping) => mapping.barcode))].sort();
      for (const barcode of incomingBarcodes) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [barcode]);
      }
      const existingOwners = await client.query<{
        barcode: string;
        id: string;
        active: boolean;
        unit_kind: "PIECE" | "WEIGHT";
        weight_unit: "KILOGRAM" | "GRAM" | "LITER" | "MILLILITER";
      }>(`
        SELECT pb.barcode, p.id, p.active, p.unit_kind, p.weight_unit
        FROM product_barcodes pb
        JOIN products p ON p.id = pb.product_id
        WHERE pb.barcode = ANY($1::text[])
        FOR UPDATE OF p
      `, [incomingBarcodes]);
       const existingProductIds = new Set(existingOwners.rows.map((owner) => owner.id));
       const unitBarcode = barcodeMappings.find((mapping) => mapping.saleUnit === "UNIT")?.barcode;
       // The loose-unit barcode is the stable identity when the cashier enters a
       // carton/package configuration. If it is absent, choose deterministically
       // so a retry reaches the same product record.
       const existing = existingOwners.rows.find((owner) => owner.barcode === unitBarcode)
         ?? [...existingOwners.rows].sort((left, right) => left.id.localeCompare(right.id))[0];
       const sourceProductIds = [...existingProductIds].filter((productId) => productId !== existing?.id);
       if (existing) {
         const restored = !existing.active;
         if (existingOwners.rows.some((owner) => owner.unit_kind !== body.unitKind)) throw new ApiError(422, "MERGE_UNIT_KIND_MISMATCH", "لا يمكن دمج صنف يباع بالوزن مع صنف يباع بالقطعة أو العكس");
         if (existingOwners.rows.some((owner) => owner.unit_kind === "WEIGHT" && owner.weight_unit !== body.weightUnit)) throw new ApiError(422, "MERGE_WEIGHT_UNIT_MISMATCH", "لا يمكن دمج كيلو/جرام/لتر/ملليلتر كوحدات مختلفة");

        const warehouseId = terminal.rows[0].warehouse_id;
        await client.query(`
          UPDATE products
          SET active = true, name_ar = $2, search_name = $3, sku = NULLIF($4, ''), category = $5,
              weight_unit = $6, price_minor = $7, carton_price_minor = $8, carton_contents_unit = $9,
              retail_package_size = $10, retail_package_price_minor = $11, retail_package_unit = $12,
              retail_package_label = $13, wholesale_price_minor = $14, purchase_pack_size = $15,
              reorder_level_milli = $16, version = version + 1, updated_at = now()
          WHERE id = $1
        `, [existing.id, body.nameAr, normalizeArabicSearch(body.nameAr), body.sku ?? "", body.category,
          body.weightUnit, body.priceMinor, body.cartonPriceMinor ?? null, body.cartonContentsUnit ?? null,
          body.retailPackage?.unitsPerPackage ?? null, body.retailPackage?.packagePriceMinor ?? null,
          body.retailPackage?.contentsUnit ?? null, body.retailPackage?.label ?? "PACKAGE",
          body.wholesalePriceMinor ?? body.openingUnitCostMinor, body.purchasePackSize, body.reorderLevelMilli]);

         for (const mapping of barcodeMappings) {
           const conversionQtyMilli = mapping.saleUnit === "PACKAGE"
             ? body.retailPackage!.unitsPerPackage * 1000
            : mapping.saleUnit === "CARTON" ? body.purchasePackSize * 1000 : 1000;
           const updatedMapping = await client.query(
             "UPDATE product_barcodes SET product_id = $1, conversion_qty_milli = $3, sale_unit = $4 WHERE barcode = $2",
             [existing.id, mapping.barcode, conversionQtyMilli, mapping.saleUnit],
           );
          if (updatedMapping.rowCount === 0) {
            await client.query(
              "INSERT INTO product_barcodes(product_id, barcode, conversion_qty_milli, sale_unit) VALUES ($1, $2, $3, $4)",
              [existing.id, mapping.barcode, conversionQtyMilli, mapping.saleUnit],
             );
           }
         }

         // A loose barcode and a carton/package barcode may have been entered
         // as separate products in an earlier version of the catalogue. Treat
         // this save as the explicit correction: retain the target product,
         // move every source barcode to it, and transfer stock through ledger
         // entries rather than silently changing balances.
         let mergedSourceQtyMilli = 0;
         for (const sourceProductId of sourceProductIds) {
           const otherWarehouses = await client.query<{ warehouse_id: string }>(
             "SELECT warehouse_id FROM stock_balances WHERE product_id = $1 AND warehouse_id <> $2 AND qty_milli > 0 FOR UPDATE",
             [sourceProductId, warehouseId],
           );
           if (otherWarehouses.rows.length) {
             throw new ApiError(409, "MERGE_MULTI_WAREHOUSE", "لا يمكن دمج صنف له رصيد في مخزن آخر؛ انقله أو سوِّ رصيده من ذلك المخزن أولاً");
           }
           const sourceBalanceResult = await client.query<{ qty_milli: number; inventory_value_minor: number }>(
             "SELECT qty_milli, inventory_value_minor FROM stock_balances WHERE warehouse_id = $1 AND product_id = $2 FOR UPDATE",
             [warehouseId, sourceProductId],
           );
           const sourceBalance = sourceBalanceResult.rows[0];
           if (!sourceBalance) throw new ApiError(404, "MERGE_SOURCE_BALANCE_MISSING", "رصيد أحد الباركودات القديمة غير مهيأ في المخزن");
           const sourceLots = await client.query<{ id: string; qty_milli: number; expires_on: string | null }>(
             "SELECT id, qty_milli, expires_on FROM stock_lots WHERE warehouse_id = $1 AND product_id = $2 AND qty_milli > 0 ORDER BY (expires_on IS NULL), expires_on, received_at, id FOR UPDATE",
             [warehouseId, sourceProductId],
           );
           if (sourceLots.rows.reduce((sum, lot) => sum + lot.qty_milli, 0) !== sourceBalance.qty_milli) {
             throw new ApiError(409, "MERGE_LOT_BALANCE_MISMATCH", "رصيد أحد الباركودات القديمة لا يطابق دفعاته؛ راجع المخزون أولاً قبل الحفظ");
           }
           const targetBalanceResult = await client.query<{ qty_milli: number; inventory_value_minor: number }>(
             "SELECT qty_milli, inventory_value_minor FROM stock_balances WHERE warehouse_id = $1 AND product_id = $2 FOR UPDATE",
             [warehouseId, existing.id],
           );
           const targetBalance = targetBalanceResult.rows[0];
           if (!targetBalance) throw new ApiError(404, "STOCK_BALANCE_MISSING", "رصيد الصنف الأساسي غير مهيأ في المخزن");
           const targetQtyMilli = targetBalance.qty_milli + sourceBalance.qty_milli;
           const targetValueMinor = targetBalance.inventory_value_minor + sourceBalance.inventory_value_minor;
           const mergeId = randomUUID();
           await client.query("UPDATE product_barcodes SET product_id = $1 WHERE product_id = $2", [existing.id, sourceProductId]);
           await client.query(
             "UPDATE stock_balances SET qty_milli = 0, inventory_value_minor = 0, version = version + 1, updated_at = now() WHERE warehouse_id = $1 AND product_id = $2",
             [warehouseId, sourceProductId],
           );
           await client.query(
             "UPDATE stock_balances SET qty_milli = $3, inventory_value_minor = $4, version = version + 1, updated_at = now() WHERE warehouse_id = $1 AND product_id = $2",
             [warehouseId, existing.id, targetQtyMilli, targetValueMinor],
           );
           for (const lot of sourceLots.rows) {
             await client.query("UPDATE stock_lots SET qty_milli = 0 WHERE id = $1", [lot.id]);
             await client.query(
               "INSERT INTO stock_lots(warehouse_id, product_id, lot_code, expires_on, qty_milli) VALUES ($1, $2, $3, $4, $5)",
               [warehouseId, existing.id, `MERGE-${sourceProductId.slice(0, 8)}-${lot.id.slice(0, 8)}`, lot.expires_on, lot.qty_milli],
             );
           }
           if (sourceBalance.qty_milli > 0 || sourceBalance.inventory_value_minor > 0) {
             await client.query(`
               INSERT INTO stock_movements(warehouse_id, product_id, movement_type, qty_delta_milli,
                 value_delta_minor, balance_qty_milli, balance_value_minor, reference_type, reference_id, actor_user_id, reason)
               VALUES ($1, $2, 'TRANSFER_OUT', $3, $4, 0, 0, 'product_barcode_merge', $5, $6, 'ضم باركود عبوة أو كرتونة إلى الصنف الموحد')
             `, [warehouseId, sourceProductId, -sourceBalance.qty_milli, -sourceBalance.inventory_value_minor, mergeId, auth.userId]);
             await client.query(`
               INSERT INTO stock_movements(warehouse_id, product_id, movement_type, qty_delta_milli,
                 value_delta_minor, balance_qty_milli, balance_value_minor, reference_type, reference_id, actor_user_id, reason)
               VALUES ($1, $2, 'TRANSFER_IN', $3, $4, $5, $6, 'product_barcode_merge', $7, $8, 'ضم باركود عبوة أو كرتونة إلى الصنف الموحد')
             `, [warehouseId, existing.id, sourceBalance.qty_milli, sourceBalance.inventory_value_minor, targetQtyMilli, targetValueMinor, mergeId, auth.userId]);
           }
           await client.query("UPDATE products SET active = false, updated_at = now(), version = version + 1 WHERE id = $1", [sourceProductId]);
           await audit(client, auth, "PRODUCT_BARCODE_PRODUCTS_UNIFIED", "product", sourceProductId, {
             targetProductId: existing.id,
             transferredQtyMilli: sourceBalance.qty_milli,
             transferredValueMinor: sourceBalance.inventory_value_minor,
           });
           mergedSourceQtyMilli += sourceBalance.qty_milli;
         }

         let resultingQtyMilli: number | undefined;
        if (body.openingQtyMilli > 0) {
          const balanceResult = await client.query<{ qty_milli: number; inventory_value_minor: number; version: number }>(
            "SELECT qty_milli, inventory_value_minor, version FROM stock_balances WHERE warehouse_id = $1 AND product_id = $2 FOR UPDATE",
            [warehouseId, existing.id],
          );
          const balance = balanceResult.rows[0];
          if (!balance) throw new ApiError(404, "STOCK_BALANCE_MISSING", "رصيد الصنف الموجود غير مهيأ في المخزن");
          const newQtyMilli = balance.qty_milli + body.openingQtyMilli;
          const newValueMinor = balance.inventory_value_minor + openingValueMinor;
          const count = await client.query<{ id: string }>(`
            INSERT INTO stock_counts(warehouse_id, product_id, expected_qty_milli, actual_qty_milli, expected_version,
              value_delta_minor, reason, user_id, approved_by)
            VALUES ($1, $2, $3, $4, $5, $6, 'دمج إدخال بباركود مسجل', $7, $7)
            RETURNING id
          `, [warehouseId, existing.id, balance.qty_milli, newQtyMilli, balance.version, openingValueMinor, auth.userId]);
          await client.query(
            "UPDATE stock_balances SET qty_milli = $3, inventory_value_minor = $4, version = version + 1, updated_at = now() WHERE warehouse_id = $1 AND product_id = $2",
            [warehouseId, existing.id, newQtyMilli, newValueMinor],
          );
          const lot = await client.query<{ id: string }>(
            "INSERT INTO stock_lots(warehouse_id, product_id, lot_code, qty_milli) VALUES ($1, $2, $3, $4) RETURNING id",
            [warehouseId, existing.id, `BARCODE-MERGE-${Date.now()}`, body.openingQtyMilli],
          );
          await client.query(`
            INSERT INTO stock_movements(warehouse_id, product_id, movement_type, qty_delta_milli,
              value_delta_minor, balance_qty_milli, balance_value_minor, reference_type, reference_id, actor_user_id, reason)
            VALUES ($1, $2, 'COUNT_ADJUSTMENT', $3, $4, $5, $6, 'product_barcode_merge', $7, $8, 'دمج إدخال كرتونة أو عبوة بباركود مسجل')
          `, [warehouseId, existing.id, body.openingQtyMilli, openingValueMinor, newQtyMilli, newValueMinor, count.rows[0]!.id, auth.userId]);
          await audit(client, auth, "PRODUCT_BARCODE_MERGE_STOCK_ADDED", "stock_lot", lot.rows[0]!.id, {
            productId: existing.id, qtyMilli: body.openingQtyMilli, valueMinor: openingValueMinor,
          });
          resultingQtyMilli = newQtyMilli;
        }
         await audit(client, auth, "PRODUCT_BARCODE_MERGED", "product", existing.id, {
           incomingBarcodes, openingQtyMilli: body.openingQtyMilli, openingValueMinor,
           resultingQtyMilli, mergedSourceQtyMilli, mergedAs: "existing_product", restored,
         });
        return { id: existing.id, merged: true, restored };
      }
      const result = await client.query<{ id: string }>(`
        INSERT INTO products(name_ar, search_name, sku, category, unit_kind, weight_unit, price_minor, carton_price_minor, carton_contents_unit, retail_package_size, retail_package_price_minor, retail_package_unit, retail_package_label, wholesale_price_minor, purchase_pack_size, reorder_level_milli)
        VALUES ($1, $2, NULLIF($3, ''), $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id
      `, [body.nameAr, normalizeArabicSearch(body.nameAr), body.sku ?? "", body.category, body.unitKind, body.weightUnit, body.priceMinor, body.cartonPriceMinor ?? null, body.cartonContentsUnit ?? null, body.retailPackage?.unitsPerPackage ?? null, body.retailPackage?.packagePriceMinor ?? null, body.retailPackage?.contentsUnit ?? null, body.retailPackage?.label ?? "PACKAGE", body.wholesalePriceMinor ?? body.openingUnitCostMinor, body.purchasePackSize, body.reorderLevelMilli]);
      const id = result.rows[0]!.id;
      for (const mapping of barcodeMappings) {
        await client.query("INSERT INTO product_barcodes(product_id, barcode, conversion_qty_milli, sale_unit) VALUES ($1, $2, $3, $4)", [id, mapping.barcode, mapping.saleUnit === "PACKAGE" ? body.retailPackage!.unitsPerPackage * 1000 : mapping.saleUnit === "CARTON" ? body.purchasePackSize * 1000 : 1000, mapping.saleUnit]);
      }
      const warehouseId = terminal.rows[0].warehouse_id;
      await client.query("INSERT INTO stock_balances(warehouse_id, product_id, qty_milli, inventory_value_minor, version) VALUES ($1, $2, $3, $4, $5)", [warehouseId, id, body.openingQtyMilli, openingValueMinor, body.openingQtyMilli > 0 ? 1 : 0]);
      if (body.openingQtyMilli > 0) {
        const lot = await client.query<{ id: string }>("INSERT INTO stock_lots(warehouse_id, product_id, lot_code, qty_milli) VALUES ($1, $2, 'OPENING', $3) RETURNING id", [warehouseId, id, body.openingQtyMilli]);
        await client.query(`INSERT INTO stock_movements(warehouse_id, product_id, movement_type, qty_delta_milli,
          value_delta_minor, balance_qty_milli, balance_value_minor, reference_type, reference_id, actor_user_id, reason)
          VALUES ($1, $2, 'OPENING', $3, $4, $3, $4, 'stock_lot', $5, $6, 'رصيد افتتاحي عند إنشاء الصنف')`,
        [warehouseId, id, body.openingQtyMilli, openingValueMinor, lot.rows[0]!.id, auth.userId]);
      }
      await audit(client, auth, "PRODUCT_CREATED", "product", id, { barcodes: body.barcodes, openingQtyMilli: body.openingQtyMilli, openingValueMinor, wholesalePriceMinor: body.wholesalePriceMinor ?? body.openingUnitCostMinor, purchasePackSize: body.purchasePackSize, retailPackage: body.retailPackage, priceMinor: body.priceMinor, cartonPriceMinor: body.cartonPriceMinor, weightUnit: body.weightUnit });
      return { id, merged: false };
    });
    return reply.status(product.merged ? 200 : 201).send(product);
  });

  app.post("/v1/quotes", async (request, reply) => {
    const auth = requirePermission(request, "SALE_POST");
    const body = quoteRequestSchema.parse(request.body);
    if (body.terminalId !== auth.terminalId) throw new ApiError(403, "TERMINAL_MISMATCH", "الجلسة مرتبطة بنقطة بيع أخرى");
    const productLines = body.lines.filter((line): line is typeof line & { productId: string } => Boolean(line.productId));
    const manualLines = body.lines.filter((line): line is typeof line & { productId?: undefined; manualNameAr: string; manualPriceMinor: number } => !line.productId);
    const aggregated = new Map<string, { productId: string; saleUnit: "UNIT" | "PACKAGE" | "CARTON"; qtyMilli: number }>();
    const labelLines = productLines.filter((line) => line.weightedLabelBarcode);
    // A final amount entered for weighed goods must stay a distinct line.  If
    // it were aggregated, the exact cashier amount could be silently lost.
    const enteredTotalLines = productLines.filter((line) => line.enteredTotalMinor !== undefined);
    for (const line of productLines) {
      if (line.weightedLabelBarcode || line.enteredTotalMinor !== undefined) continue;
      const key = `${line.productId}:${line.saleUnit}`;
      const current = aggregated.get(key);
      aggregated.set(key, { productId: line.productId, saleUnit: line.saleUnit, qtyMilli: (current?.qtyMilli ?? 0) + line.qtyMilli });
    }
    const ids = [...new Set(productLines.map((line) => line.productId))].sort();
    const quote = await transaction(db, async (client) => {
      const shift = await client.query<{ warehouse_id: string }>(`
        SELECT t.warehouse_id FROM shifts s JOIN terminals t ON t.id = s.terminal_id
        WHERE s.id = $1 AND s.terminal_id = $2 AND s.user_id = $3 AND s.status = 'OPEN'
      `, [body.shiftId, auth.terminalId, auth.userId]);
      if (!shift.rows[0]) throw new ApiError(409, "SHIFT_CLOSED", "لا توجد وردية مفتوحة لهذا الكاشير ونقطة البيع");
      const labelCodes = labelLines.map((line) => line.weightedLabelBarcode!);
      if (new Set(labelCodes).size !== labelCodes.length) throw new ApiError(422, "WEIGHT_LABEL_DUPLICATED", "لا يمكن مسح ملصق الوزن نفسه أكثر من مرة في الفاتورة.");
      const labels = labelCodes.length === 0 ? [] : (await client.query<{ barcode: string; product_id: string; qty_milli: number; unit_price_minor: number; used_sale_id: string | null }>(
        "SELECT barcode, product_id, qty_milli, unit_price_minor, used_sale_id FROM weighted_product_labels WHERE barcode = ANY($1::text[])", [labelCodes],
      )).rows;
      if (labels.length !== labelCodes.length) throw new ApiError(404, "WEIGHT_LABEL_NOT_FOUND", "أحد ملصقات الوزن غير موجود.");
      const labelsByBarcode = new Map(labels.map((label) => [label.barcode, label]));
      const rows = await client.query<QuoteProductRow>(`
        SELECT p.id, p.name_ar, p.description, p.category, p.unit_kind, p.price_minor, p.carton_price_minor, p.purchase_pack_size, p.retail_package_size, p.retail_package_price_minor, p.retail_package_unit, p.reorder_level_milli, sb.version AS stock_version,
               sb.qty_milli, ARRAY[]::text[] AS barcodes, sb.warehouse_id
        FROM products p JOIN stock_balances sb ON sb.product_id = p.id
        WHERE p.id = ANY($1::uuid[]) AND p.active AND sb.warehouse_id = $2
        ORDER BY p.id
      `, [ids, shift.rows[0].warehouse_id]);
      if (rows.rows.length !== ids.length) throw new ApiError(404, "PRODUCT_NOT_FOUND", "أحد الأصناف غير موجود أو غير متاح");
      const rowsById = new Map(rows.rows.map((row) => [row.id, row]));
      const requestedQty = new Map<string, number>();
      for (const line of productLines) requestedQty.set(line.productId, (requestedQty.get(line.productId) ?? 0) + line.qtyMilli);
      for (const row of rows.rows) {
        if ((requestedQty.get(row.id) ?? 0) > row.qty_milli) throw new ApiError(409, "INSUFFICIENT_STOCK", `Insufficient stock: ${row.name_ar}`, { productId: row.id, availableQtyMilli: row.qty_milli });
      }
      const requested: Array<{ productId: string; qtyMilli: number; saleUnit: "UNIT" | "PACKAGE" | "CARTON"; weightedLabelBarcode?: string; enteredTotalMinor?: number }> = [
        ...aggregated.values(),
        ...labelLines.map((line) => ({ productId: line.productId, qtyMilli: line.qtyMilli, saleUnit: "UNIT" as const, weightedLabelBarcode: line.weightedLabelBarcode! })),
        ...enteredTotalLines.map((line) => ({ productId: line.productId, qtyMilli: line.qtyMilli, saleUnit: "UNIT" as const, enteredTotalMinor: line.enteredTotalMinor! })),
      ];
      const priced: PricedQuoteLine[] = [
        ...requested.map((input) => {
        const row = rowsById.get(input.productId)!;
        const qtyMilli = input.qtyMilli;
        const label = input.weightedLabelBarcode ? labelsByBarcode.get(input.weightedLabelBarcode) : undefined;
        if (input.weightedLabelBarcode && (!label || label.used_sale_id || label.product_id !== row.id || label.qty_milli !== qtyMilli || row.unit_kind !== "WEIGHT")) throw new ApiError(409, "WEIGHT_LABEL_INVALID", "ملصق الوزن غير صالح أو استُخدم من قبل.");
        if (input.enteredTotalMinor !== undefined && (row.unit_kind !== "WEIGHT" || input.saleUnit !== "UNIT" || input.weightedLabelBarcode)) {
          throw new ApiError(422, "WEIGHT_AMOUNT_INVALID", "السعر النهائي المباشر متاح للمنتج الموزون غير المطبوع فقط.");
        }
        if (row.price_minor <= 0) throw new ApiError(422, "PRICE_NOT_SET", `\u062d\u062f\u062f \u0633\u0639\u0631 \u0628\u064a\u0639 \u0644\u0644\u0635\u0646\u0641 ${row.name_ar} \u0642\u0628\u0644 \u0625\u062a\u0645\u0627\u0645 \u0627\u0644\u0628\u064a\u0639`);
        if (row.unit_kind === "PIECE" && qtyMilli % 1000 !== 0) throw new ApiError(422, "PIECE_FRACTION", `الصنف ${row.name_ar} يباع بالقطعة`);
        if (qtyMilli > row.qty_milli) throw new ApiError(409, "INSUFFICIENT_STOCK", `المخزون غير كافٍ: ${row.name_ar}`, { productId: row.id, availableQtyMilli: row.qty_milli });
        if (input.saleUnit === "CARTON") {
          if (row.unit_kind !== "PIECE" || !row.carton_price_minor || row.purchase_pack_size < 2) {
            throw new ApiError(422, "RETAIL_CARTON_NOT_CONFIGURED", `Retail carton is not configured for ${row.name_ar}`);
          }
          const cartonQtyMilli = row.purchase_pack_size * 1000;
          if (qtyMilli % cartonQtyMilli !== 0) throw new ApiError(422, "CARTON_QUANTITY_INVALID", `Carton quantity is invalid for ${row.name_ar}`);
          const cartonCount = qtyMilli / cartonQtyMilli;
          return { lineId: randomUUID(), unitPriceMinor: BigInt(row.carton_price_minor), qtyMilli: BigInt(qtyMilli), grossMinor: BigInt(row.carton_price_minor) * BigInt(cartonCount), packageSize: row.purchase_pack_size, row, saleUnit: input.saleUnit, weightedLabelBarcode: input.weightedLabelBarcode };
        }
        if (input.saleUnit === "PACKAGE") {
          if (row.unit_kind !== "PIECE" || !row.retail_package_size || !row.retail_package_price_minor || !row.retail_package_unit) {
            throw new ApiError(422, "RETAIL_PACKAGE_NOT_CONFIGURED", `Retail package is not configured for ${row.name_ar}`);
          }
          const packageQtyMilli = row.retail_package_size * 1000;
          if (qtyMilli % packageQtyMilli !== 0) throw new ApiError(422, "PACKAGE_QUANTITY_INVALID", `Package quantity is invalid for ${row.name_ar}`);
          const packageCount = qtyMilli / packageQtyMilli;
          return { lineId: randomUUID(), unitPriceMinor: BigInt(row.retail_package_price_minor), qtyMilli: BigInt(qtyMilli), grossMinor: BigInt(row.retail_package_price_minor) * BigInt(packageCount), packageSize: row.retail_package_size, row, saleUnit: input.saleUnit, weightedLabelBarcode: input.weightedLabelBarcode };
        }
        return {
          lineId: randomUUID(),
          unitPriceMinor: BigInt(label?.unit_price_minor ?? row.price_minor),
          qtyMilli: BigInt(qtyMilli),
          grossMinor: input.enteredTotalMinor !== undefined
            ? BigInt(input.enteredTotalMinor)
            : calculateLineMinor(BigInt(label?.unit_price_minor ?? row.price_minor), BigInt(qtyMilli)),
          row,
          saleUnit: input.saleUnit,
          weightedLabelBarcode: input.weightedLabelBarcode,
        };
        }),
        ...manualLines.map((line) => ({
          lineId: randomUUID(),
          unitPriceMinor: BigInt(line.manualPriceMinor),
          qtyMilli: 1000n,
          grossMinor: BigInt(line.manualPriceMinor),
          manualItem: true as const,
          manualNameAr: line.manualNameAr,
          saleUnit: "UNIT" as const,
        })),
      ];
      const allocated = allocateInvoiceDiscount(priced, BigInt(body.discountMinor));
      const subtotalMinor = allocated.reduce((sum, line) => sum + line.grossMinor, 0n);
      if (body.discountMinor > 0) {
        if (!auth.permissions.has("DISCOUNT")) {
          const maxDiscount = subtotalMinor * BigInt(auth.discountLimitBps) / 10_000n;
          if (BigInt(body.discountMinor) > maxDiscount) throw new ApiError(403, "DISCOUNT_APPROVAL_REQUIRED", "الخصم يتجاوز صلاحية الكاشير ويحتاج موافقة مدير");
        }
      }
      const expiresAt = new Date(Date.now() + 5 * 60_000);
      const lines = allocated.map((line) => {
        const original = priced.find((item) => item.lineId === line.lineId)!;
        if (original.manualItem) {
          return {
            lineId: line.lineId,
            manualItem: true,
            // Kept only for typed receipt rendering. The sales route checks
            // manualItem and never resolves or persists this as a product.
            productId: "00000000-0000-4000-8000-000000000000",
            nameAr: original.manualNameAr,
            unitKind: "PIECE" as const,
            saleUnit: "UNIT" as const,
            qtyMilli: toSafeNumber(line.qtyMilli, "qtyMilli"),
            unitPriceMinor: toSafeNumber(line.unitPriceMinor, "unitPriceMinor"),
            grossMinor: toSafeNumber(line.grossMinor, "grossMinor"),
            discountMinor: toSafeNumber(line.discountMinor, "discountMinor"),
            netMinor: toSafeNumber(line.netMinor, "netMinor"),
            stockVersion: 0,
          };
        }
        const row = original.row;
        if (!row) throw new Error("invoice quote line is missing its catalogue row");
        return {
          lineId: line.lineId,
          productId: row.id,
          nameAr: row.name_ar,
          unitKind: row.unit_kind,
          saleUnit: original.saleUnit,
          ...(original.packageSize ? { packageSize: original.packageSize } : {}),
          qtyMilli: toSafeNumber(line.qtyMilli, "qtyMilli"),
          unitPriceMinor: toSafeNumber(line.unitPriceMinor, "unitPriceMinor"),
          grossMinor: toSafeNumber(line.grossMinor, "grossMinor"),
          discountMinor: toSafeNumber(line.discountMinor, "discountMinor"),
          netMinor: toSafeNumber(line.netMinor, "netMinor"),
          stockVersion: row.stock_version,
          ...(original.weightedLabelBarcode ? { weightedLabelBarcode: original.weightedLabelBarcode } : {}),
        };
      });
      const saved = await client.query<{ id: string }>(`
        INSERT INTO quotes(terminal_id, shift_id, user_id, subtotal_minor, discount_minor, total_minor, lines_json, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) RETURNING id
      `, [auth.terminalId, body.shiftId, auth.userId, Number(subtotalMinor), body.discountMinor, Number(subtotalMinor - BigInt(body.discountMinor)), JSON.stringify(lines), expiresAt]);
      return { quoteId: saved.rows[0]!.id, expiresAt: expiresAt.toISOString(), lines, subtotalMinor: Number(subtotalMinor), discountMinor: body.discountMinor, totalMinor: Number(subtotalMinor - BigInt(body.discountMinor)) };
    });
    return reply.status(201).send(quote);
  });
}
