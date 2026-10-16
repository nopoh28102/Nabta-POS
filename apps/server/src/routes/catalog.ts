import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { archiveProductRequestSchema, createProductRequestSchema, productCsvImportRequestSchema, productExportRequestSchema, quoteRequestSchema, updateProductPriceRequestSchema, updateProductRequestSchema } from "@nabta/contracts";
import { allocateInvoiceDiscount, calculateInventoryIssueValue, calculateLineMinor, normalizeArabicSearch, toSafeNumber } from "@nabta/domain";
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
  price_minor: number;
  wholesale_price_minor: number;
  reorder_level_milli: number;
  stock_version: number;
  qty_milli: number;
  warehouse_id: string;
  barcodes: string[];
  image_barcode: string | null;
}

interface QuoteProductRow extends CatalogRow {
  warehouse_id: string;
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
  const header = records.shift()?.map((value) => value.replace(/^\uFEFF/, "").trim());
  const hasWholesale = header?.join(",") === internalExpected.join(",");
  if (!header || (!hasWholesale && header.join(",") !== expected.join(","))) return { rows: [], errors: ["رؤوس الأعمدة يجب أن تكون: " + expected.join(",") + " أو " + internalExpected.join(",")] };
  const errors: string[] = [];
  const rows: ImportRow[] = [];
  records.forEach((values, index) => {
    const line = index + 2;
    if (values.length !== (hasWholesale ? internalExpected.length : expected.length)) { errors.push("السطر " + line + ": عدد الأعمدة غير صحيح"); return; }
    const [nameAr, category, unitKind, priceMinor, barcode, reorderLevelMilli, openingQtyMilli, openingUnitCostMinor, wholesalePriceMinor] = values.map((value) => value.trim());
    try {
      const parsed = createProductRequestSchema.parse({
        nameAr, category, unitKind, priceMinor: Number(priceMinor), barcodes: [barcode],
        reorderLevelMilli: Number(reorderLevelMilli), openingQtyMilli: Number(openingQtyMilli), openingUnitCostMinor: Number(openingUnitCostMinor), wholesalePriceMinor: hasWholesale ? Number(wholesalePriceMinor) : Number(openingUnitCostMinor),
      });
      rows.push({ nameAr: parsed.nameAr, category: parsed.category, unitKind: parsed.unitKind, priceMinor: parsed.priceMinor, barcode: parsed.barcodes[0]!, reorderLevelMilli: parsed.reorderLevelMilli, openingQtyMilli: parsed.openingQtyMilli, openingUnitCostMinor: parsed.openingUnitCostMinor, wholesalePriceMinor: parsed.wholesalePriceMinor ?? parsed.openingUnitCostMinor });
    } catch (error) { errors.push("السطر " + line + ": " + (error instanceof Error ? error.message : "بيانات غير صحيحة")); }
  });
  const seen = new Set<string>();
  for (const item of rows) if (seen.has(item.barcode)) errors.push("الباركود مكرر داخل الملف: " + item.barcode); else seen.add(item.barcode);
  return { rows, errors };
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

export function registerCatalogRoutes(app: FastifyInstance, db: Database): void {
  app.post("/v1/product-barcodes/generate", async (request) => {
    requirePermission(request, "PRODUCT_WRITE");
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const barcode = "NABTA-" + randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
      const existing = await db.query<{ barcode: string }>("SELECT barcode FROM product_barcodes WHERE barcode = $1", [barcode]);
      if (!existing.rows[0]) return { barcode, symbology: "CODE39", scope: "INTERNAL" as const };
    }
    throw new ApiError(503, "BARCODE_GENERATION_RETRY", "تعذر توليد باركود فريد؛ أعد المحاولة");
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

  app.get("/v1/products/export", async (request, reply) => {
    const auth = requirePermission(request, "EXPORT");
    const query = productExportRequestSchema.parse(request.query);
    if (query.mode === "INTERNAL" && !auth.permissions.has("VIEW_COST")) {
      throw new ApiError(403, "FORBIDDEN", "ليس لديك صلاحية تصدير سعر الجملة الداخلي");
    }
    const normalized = normalizeArabicSearch(query.query ?? "");
    const result = await db.query<CatalogRow>(`
      SELECT p.id, p.name_ar, p.category, p.unit_kind, p.price_minor, p.wholesale_price_minor, p.reorder_level_milli, p.version,
             sb.qty_milli, sb.warehouse_id,
             COALESCE(array_agg(pb.barcode ORDER BY pb.barcode) FILTER (WHERE pb.barcode IS NOT NULL), '{}') AS barcodes
      FROM terminals t JOIN products p ON p.active
      LEFT JOIN stock_balances sb ON sb.product_id = p.id AND sb.warehouse_id = t.warehouse_id
      LEFT JOIN product_barcodes pb ON pb.product_id = p.id
      WHERE t.id = $1
        AND ($2 = '' OR pb.barcode = $2 OR p.search_name LIKE '%' || $3 || '%' OR lower(p.sku) LIKE '%' || lower($2) || '%')
        AND (cardinality($4::uuid[]) = 0 OR p.id = ANY($4::uuid[]))
      GROUP BY p.id, sb.qty_milli, sb.warehouse_id ORDER BY p.name_ar
    `, [auth.terminalId, query.query ?? "", normalized, query.productIds ?? []]);
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
        SELECT p.id, p.name_ar, p.category, p.unit_kind, p.price_minor, p.wholesale_price_minor, p.reorder_level_milli, p.version,
               COALESCE(sb.qty_milli, 0) AS qty_milli, sb.warehouse_id,
               COALESCE(array_agg(pb.barcode ORDER BY pb.barcode) FILTER (WHERE pb.barcode IS NOT NULL), '{}') AS barcodes
        FROM terminals t
        JOIN products p ON p.active
        LEFT JOIN stock_balances sb ON sb.product_id = p.id AND sb.warehouse_id = t.warehouse_id
        LEFT JOIN product_barcodes pb ON pb.product_id = p.id
        WHERE t.id = $1
          AND ($2 = '' OR pb.barcode = $2 OR p.search_name LIKE '%' || $3 || '%' OR lower(p.sku) LIKE '%' || lower($2) || '%')
          AND (cardinality($4::uuid[]) = 0 OR p.id = ANY($4::uuid[]))
       GROUP BY p.id, sb.qty_milli, sb.warehouse_id, sb.version
        ORDER BY p.name_ar
      `, [auth.terminalId, query.query ?? "", normalized, query.productIds ?? []]),
    ]);
    return {
      storeName: store.rows[0]?.store_name ?? "نبتة",
      generatedAt: new Date().toISOString(),
      mode: query.mode,
      items: products.rows.map((product) => ({
        nameAr: product.name_ar,
        category: product.category,
        barcode: product.barcodes[0] ?? null,
        unitKind: product.unit_kind,
        availableQtyMilli: product.qty_milli,
        priceMinor: product.price_minor,
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
      const barcodes = parsed.rows.map((item) => item.barcode);
      const existing = await client.query<{ barcode: string }>("SELECT barcode FROM product_barcodes WHERE barcode = ANY($1::text[])", [barcodes]);
      if (existing.rows.length) throw new ApiError(409, "BARCODE_EXISTS", "يوجد باركود مسجل مسبقاً", { barcodes: existing.rows.map((item) => item.barcode) });
      for (const item of parsed.rows) {
        if (item.unitKind === "PIECE" && (item.openingQtyMilli % 1000 !== 0 || item.reorderLevelMilli % 1000 !== 0)) throw new ApiError(422, "PIECE_FRACTION", "أحد أصناف القطعة يحتوي كمية كسرية");
        const openingValueMinor = item.openingQtyMilli === 0 ? 0 : toSafeNumber(calculateLineMinor(BigInt(item.openingUnitCostMinor), BigInt(item.openingQtyMilli)), "openingValueMinor");
        const product = await client.query<{ id: string }>("INSERT INTO products(name_ar, search_name, category, unit_kind, price_minor, wholesale_price_minor, reorder_level_milli) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id", [item.nameAr, normalizeArabicSearch(item.nameAr), item.category, item.unitKind, item.priceMinor, item.wholesalePriceMinor, item.reorderLevelMilli]);
        const id = product.rows[0]!.id;
        await client.query("INSERT INTO product_barcodes(product_id, barcode) VALUES ($1, $2)", [id, item.barcode]);
        await client.query("INSERT INTO stock_balances(warehouse_id, product_id, qty_milli, inventory_value_minor, version) VALUES ($1, $2, $3, $4, $5)", [terminal.rows[0].warehouse_id, id, item.openingQtyMilli, openingValueMinor, item.openingQtyMilli > 0 ? 1 : 0]);
        if (item.openingQtyMilli > 0) {
          const lot = await client.query<{ id: string }>("INSERT INTO stock_lots(warehouse_id, product_id, lot_code, qty_milli) VALUES ($1, $2, 'CSV-OPENING', $3) RETURNING id", [terminal.rows[0].warehouse_id, id, item.openingQtyMilli]);
          await client.query("INSERT INTO stock_movements(warehouse_id, product_id, movement_type, qty_delta_milli, value_delta_minor, balance_qty_milli, balance_value_minor, reference_type, reference_id, actor_user_id, reason) VALUES ($1, $2, 'OPENING', $3, $4, $3, $4, 'csv_import', $5, $6, 'استيراد أصناف CSV')", [terminal.rows[0].warehouse_id, id, item.openingQtyMilli, openingValueMinor, lot.rows[0]!.id, auth.userId]);
        }
        await audit(client, auth, "PRODUCT_IMPORTED", "product", id, { barcode: item.barcode });
      }
      const response = { importedCount: parsed.rows.length, errors: [] };
      await client.query("UPDATE idempotency_requests SET status = 'COMPLETED', response_status = 201, response_body = $3::jsonb, completed_at = now() WHERE user_id = $1 AND key = $2", [auth.userId, key, JSON.stringify(response)]);
      return response;
    });
    return reply.status(201).send(result);
  });

  app.get("/v1/catalog", async (request) => {
    const auth = requireAuth(request);
    const query = typeof (request.query as Record<string, unknown>).query === "string" ? String((request.query as Record<string, unknown>).query).trim() : "";
    const category = typeof (request.query as Record<string, unknown>).category === "string" ? String((request.query as Record<string, unknown>).category).trim() : "";
    const normalized = normalizeArabicSearch(query);
    const result = await db.query<CatalogRow>(`
      SELECT p.id, p.name_ar, p.description, p.category, p.unit_kind, p.price_minor, p.wholesale_price_minor, p.reorder_level_milli,
             COALESCE(sb.qty_milli, 0) AS qty_milli,
             COALESCE(sb.version, 0) AS stock_version,
             sb.warehouse_id,
             COALESCE(array_agg(pb.barcode ORDER BY pb.barcode) FILTER (WHERE pb.barcode IS NOT NULL), '{}') AS barcodes,
             (
               SELECT ref.barcode
               FROM product_barcodes reference_barcode
               JOIN product_reference_catalog ref ON ref.barcode = reference_barcode.barcode
               WHERE reference_barcode.product_id = p.id AND ref.image_asset_path IS NOT NULL
               ORDER BY reference_barcode.created_at, ref.barcode
               LIMIT 1
             ) AS image_barcode
      FROM terminals t
      JOIN products p ON p.active
      LEFT JOIN stock_balances sb ON sb.product_id = p.id AND sb.warehouse_id = t.warehouse_id
      LEFT JOIN product_barcodes pb ON pb.product_id = p.id
      WHERE t.id = $1
        AND ($2 = '' OR pb.barcode = $2 OR p.search_name LIKE '%' || $3 || '%' OR lower(p.sku) LIKE '%' || lower($2) || '%')
        AND ($4 = '' OR p.category = $4)
      GROUP BY p.id, sb.qty_milli, sb.warehouse_id, sb.version
      ORDER BY CASE WHEN $2 <> '' AND bool_or(pb.barcode = $2) THEN 0 ELSE 1 END, p.name_ar
       -- The desktop renderer paginates product cards and table rows itself.
       -- Keep the local catalog complete so a high barcode cannot disappear
       -- simply because it sorts after the first 3,500 products.
       LIMIT 10000
    `, [auth.terminalId, query, normalized, category]);
    return {
      products: result.rows.map((row) => ({
        id: row.id, warehouseId: row.warehouse_id, nameAr: row.name_ar, description: row.description, category: row.category, unitKind: row.unit_kind,
        priceMinor: row.price_minor, ...(auth.permissions.has("VIEW_COST") ? { wholesalePriceMinor: row.wholesale_price_minor } : {}), availableQtyMilli: row.qty_milli, reorderLevelMilli: row.reorder_level_milli,
        barcodes: row.barcodes, ...(row.image_barcode ? { imageBarcode: row.image_barcode } : {}), version: row.stock_version,
      })),
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
        description: string;
        price_minor: number;
        wholesale_price_minor: number;
        unit_kind: "PIECE" | "WEIGHT";
      }>(
        "SELECT id, name_ar, description, price_minor, wholesale_price_minor, unit_kind FROM products WHERE id = $1 AND active FOR UPDATE",
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

      await client.query(`
        UPDATE products
        SET name_ar = $2,
            description = $3,
            search_name = $4,
            price_minor = $5,
            wholesale_price_minor = $6,
            version = version + 1,
            updated_at = now()
        WHERE id = $1
      `, [body.productId, body.nameAr, body.description, normalizeArabicSearch(body.nameAr), body.priceMinor, wholesalePriceMinor]);
      await audit(client, auth, "PRODUCT_UPDATED", "product", body.productId, {
        previous: {
          nameAr: product.name_ar,
          description: product.description,
          priceMinor: product.price_minor,
          wholesalePriceMinor: product.wholesale_price_minor,
          availableQtyMilli: currentBalance.qty_milli,
        },
        next: {
          nameAr: body.nameAr,
          description: body.description,
          priceMinor: body.priceMinor,
          wholesalePriceMinor,
          availableQtyMilli: body.availableQtyMilli,
        },
      });
      return { id: body.productId, stockVersion: currentBalance.version + (delta === 0 ? 0 : 1) };
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

      await client.query("UPDATE products SET active = false, updated_at = now(), version = version + 1 WHERE id = $1", [body.productId]);
      await audit(client, auth, "PRODUCT_ARCHIVED", "product", body.productId, {
        nameAr: current.rows[0].name_ar,
        remainingQtyMilli,
      });
      return { id: body.productId, archived: true };
    });
  });

  app.post("/v1/products", async (request, reply) => {
    const auth = requirePermission(request, "PRODUCT_WRITE");
    const body = createProductRequestSchema.parse(request.body);
    if (body.unitKind === "PIECE" && (body.openingQtyMilli % 1000 !== 0 || body.reorderLevelMilli % 1000 !== 0)) {
      throw new ApiError(422, "PIECE_FRACTION", "صنف القطعة لا يقبل كمية كسرية");
    }
    if ((body.openingQtyMilli === 0) !== (body.openingUnitCostMinor === 0)) {
      throw new ApiError(422, "OPENING_VALUE_MISMATCH", "الكمية والقيمة الافتتاحيتان يجب أن تكونا صفرًا معًا أو موجبتين معًا");
    }
    const openingValueMinor = body.openingQtyMilli === 0 ? 0 : toSafeNumber(calculateLineMinor(BigInt(body.openingUnitCostMinor), BigInt(body.openingQtyMilli)), "openingValueMinor");
    const product = await transaction(db, async (client) => {
      const terminal = await client.query<{ warehouse_id: string }>("SELECT warehouse_id FROM terminals WHERE id = $1 AND active", [auth.terminalId]);
      if (!terminal.rows[0]) throw new ApiError(409, "TERMINAL_INVALID", "نقطة البيع غير صالحة");
      const result = await client.query<{ id: string }>(`
        INSERT INTO products(name_ar, search_name, sku, category, unit_kind, price_minor, wholesale_price_minor, reorder_level_milli)
        VALUES ($1, $2, NULLIF($3, ''), $4, $5, $6, $7, $8) RETURNING id
      `, [body.nameAr, normalizeArabicSearch(body.nameAr), body.sku ?? "", body.category, body.unitKind, body.priceMinor, body.wholesalePriceMinor ?? body.openingUnitCostMinor, body.reorderLevelMilli]);
      const id = result.rows[0]!.id;
      for (const barcode of [...new Set(body.barcodes)]) {
        await client.query("INSERT INTO product_barcodes(product_id, barcode) VALUES ($1, $2)", [id, barcode]);
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
      await audit(client, auth, "PRODUCT_CREATED", "product", id, { barcodes: body.barcodes, openingQtyMilli: body.openingQtyMilli, wholesalePriceMinor: body.wholesalePriceMinor ?? body.openingUnitCostMinor, priceMinor: body.priceMinor });
      return { id };
    });
    return reply.status(201).send(product);
  });

  app.post("/v1/quotes", async (request, reply) => {
    const auth = requirePermission(request, "SALE_POST");
    const body = quoteRequestSchema.parse(request.body);
    if (body.terminalId !== auth.terminalId) throw new ApiError(403, "TERMINAL_MISMATCH", "الجلسة مرتبطة بنقطة بيع أخرى");
    const aggregated = new Map<string, number>();
    for (const line of body.lines) aggregated.set(line.productId, (aggregated.get(line.productId) ?? 0) + line.qtyMilli);
    const ids = [...aggregated.keys()].sort();
    const quote = await transaction(db, async (client) => {
      const shift = await client.query<{ warehouse_id: string }>(`
        SELECT t.warehouse_id FROM shifts s JOIN terminals t ON t.id = s.terminal_id
        WHERE s.id = $1 AND s.terminal_id = $2 AND s.user_id = $3 AND s.status = 'OPEN'
      `, [body.shiftId, auth.terminalId, auth.userId]);
      if (!shift.rows[0]) throw new ApiError(409, "SHIFT_CLOSED", "لا توجد وردية مفتوحة لهذا الكاشير ونقطة البيع");
      const rows = await client.query<QuoteProductRow>(`
        SELECT p.id, p.name_ar, p.description, p.category, p.unit_kind, p.price_minor, p.reorder_level_milli, sb.version AS stock_version,
               sb.qty_milli, ARRAY[]::text[] AS barcodes, sb.warehouse_id
        FROM products p JOIN stock_balances sb ON sb.product_id = p.id
        WHERE p.id = ANY($1::uuid[]) AND p.active AND sb.warehouse_id = $2
        ORDER BY p.id
      `, [ids, shift.rows[0].warehouse_id]);
      if (rows.rows.length !== ids.length) throw new ApiError(404, "PRODUCT_NOT_FOUND", "أحد الأصناف غير موجود أو غير متاح");
      const priced = rows.rows.map((row) => {
        const qtyMilli = aggregated.get(row.id)!;
        if (row.price_minor <= 0) throw new ApiError(422, "PRICE_NOT_SET", `\u062d\u062f\u062f \u0633\u0639\u0631 \u0628\u064a\u0639 \u0644\u0644\u0635\u0646\u0641 ${row.name_ar} \u0642\u0628\u0644 \u0625\u062a\u0645\u0627\u0645 \u0627\u0644\u0628\u064a\u0639`);
        if (row.unit_kind === "PIECE" && qtyMilli % 1000 !== 0) throw new ApiError(422, "PIECE_FRACTION", `الصنف ${row.name_ar} يباع بالقطعة`);
        if (qtyMilli > row.qty_milli) throw new ApiError(409, "INSUFFICIENT_STOCK", `المخزون غير كافٍ: ${row.name_ar}`, { productId: row.id, availableQtyMilli: row.qty_milli });
        return { lineId: randomUUID(), unitPriceMinor: BigInt(row.price_minor), qtyMilli: BigInt(qtyMilli), row };
      });
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
        return {
          lineId: line.lineId,
          productId: original.row.id,
          nameAr: original.row.name_ar,
          unitKind: original.row.unit_kind,
          qtyMilli: toSafeNumber(line.qtyMilli, "qtyMilli"),
          unitPriceMinor: toSafeNumber(line.unitPriceMinor, "unitPriceMinor"),
          grossMinor: toSafeNumber(line.grossMinor, "grossMinor"),
          discountMinor: toSafeNumber(line.discountMinor, "discountMinor"),
          netMinor: toSafeNumber(line.netMinor, "netMinor"),
          stockVersion: original.row.stock_version,
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
