import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { weightedLabelCreateRequestSchema, weightedLabelMarkPrintedRequestSchema } from "@nabta/contracts";
import { calculateLineMinor, toSafeNumber } from "@nabta/domain";
import type { Database, DbClient } from "../db.js";
import { transaction } from "../db.js";
import { ApiError } from "../errors.js";
import { requirePermission } from "../auth.js";
import { audit } from "../audit.js";

function ean13CheckDigit(base: string): string {
  const sum = [...base].reduce((total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
  return String((10 - (sum % 10)) % 10);
}

function candidateBarcode(): string {
  const digits = randomUUID().replaceAll("-", "").split("").map((value) => (parseInt(value, 16) % 10).toString()).join("").slice(0, 9);
  const base = `209${digits}`;
  return `${base}${ean13CheckDigit(base)}`;
}

async function generateLabelBarcode(db: DbClient): Promise<string> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const barcode = candidateBarcode();
    const collision = await db.query<{ found: boolean }>(`
      SELECT EXISTS(SELECT 1 FROM product_barcodes WHERE barcode = $1)
          OR EXISTS(SELECT 1 FROM weighted_product_labels WHERE barcode = $1) AS found
    `, [barcode]);
    if (!collision.rows[0]?.found) return barcode;
  }
  throw new ApiError(503, "WEIGHT_LABEL_BARCODE_UNAVAILABLE", "تعذر توليد باركود ميزان فريد؛ أعد المحاولة.");
}

interface LabelRow {
  barcode: string;
  product_id: string;
  name_ar: string;
  weight_unit: "KILOGRAM" | "GRAM" | "LITER" | "MILLILITER";
  qty_milli: number;
  unit_price_minor: number;
  total_minor: number;
  created_at: Date;
  print_count: number;
  used_at: Date | null;
}

function labelDto(row: LabelRow) {
  return {
    barcode: row.barcode, productId: row.product_id, nameAr: row.name_ar, weightUnit: row.weight_unit,
    qtyMilli: row.qty_milli, unitPriceMinor: row.unit_price_minor, totalMinor: row.total_minor,
    createdAt: row.created_at.toISOString(), printCount: row.print_count,
    ...(row.used_at ? { usedAt: row.used_at.toISOString() } : {}),
  };
}

export function registerWeightedLabelRoutes(app: FastifyInstance, db: Database): void {
  app.post("/v1/weighted-labels", async (request, reply) => {
    const auth = requirePermission(request, "PRODUCT_WRITE");
    const body = weightedLabelCreateRequestSchema.parse(request.body);
    const result = await transaction(db, async (client) => {
      const product = await client.query<{ id: string; name_ar: string; unit_kind: string; weight_unit: "KILOGRAM" | "GRAM" | "LITER" | "MILLILITER"; price_minor: number }>(
        "SELECT id, name_ar, unit_kind, weight_unit, price_minor FROM products WHERE id = $1 AND active FOR SHARE",
        [body.productId],
      );
      const row = product.rows[0];
      if (!row || row.unit_kind !== "WEIGHT") throw new ApiError(422, "WEIGHTED_PRODUCT_REQUIRED", "اختر صنفًا مسجلاً للبيع بالوزن.");
      const qtyMilli = body.mode === "AMOUNT"
        ? Math.floor((body.amountMinor! * 1000) / row.price_minor)
        : body.qtyMilli!;
      if (!Number.isSafeInteger(qtyMilli) || qtyMilli < 1) throw new ApiError(422, "AMOUNT_TOO_SMALL", "المبلغ أقل من سعر جرام واحد لهذا الصنف.");
      const totalMinor = toSafeNumber(calculateLineMinor(BigInt(row.price_minor), BigInt(qtyMilli)), "labelTotalMinor");
      const barcode = await generateLabelBarcode(client);
      const created = await client.query<LabelRow>(`
        INSERT INTO weighted_product_labels(barcode, product_id, qty_milli, unit_price_minor, total_minor, created_by)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING barcode, product_id, $7::text AS name_ar, $8::text AS weight_unit, qty_milli, unit_price_minor, total_minor, created_at, print_count, used_at
      `, [barcode, row.id, qtyMilli, row.price_minor, totalMinor, auth.userId, row.name_ar, row.weight_unit]);
      if (body.printOnPrimary) {
        await client.query(`
          INSERT INTO mobile_weighted_label_print_jobs(barcode, requested_by_user_id)
          VALUES ($1, $2)
          ON CONFLICT (barcode) DO NOTHING
        `, [barcode, auth.userId]);
      }
      await audit(client, auth, "WEIGHT_LABEL_CREATED", "weighted_product_label", barcode, { productId: row.id, qtyMilli, unitPriceMinor: row.price_minor, totalMinor });
      return labelDto(created.rows[0]!);
    });
    return reply.status(201).send({ label: result });
  });

  app.get("/v1/weighted-labels", async (request) => {
    requirePermission(request, "PRODUCT_WRITE");
    const query = request.query as { productId?: string };
    const result = await db.query<LabelRow>(`
      SELECT l.barcode, l.product_id, p.name_ar, p.weight_unit, l.qty_milli, l.unit_price_minor, l.total_minor, l.created_at, l.print_count, l.used_at
      FROM weighted_product_labels l JOIN products p ON p.id = l.product_id
      WHERE ($1::uuid IS NULL OR l.product_id = $1::uuid)
      ORDER BY l.created_at DESC LIMIT 120
    `, [query.productId ?? null]);
    return { labels: result.rows.map(labelDto) };
  });

  app.get<{ Params: { barcode: string } }>("/v1/weighted-labels/:barcode", async (request) => {
    const auth = requirePermission(request, "SALE_POST");
    const barcode = request.params.barcode;
  const result = await db.query<LabelRow & { id: string; description: string; category: string; unit_kind: "PIECE" | "WEIGHT"; price_minor: number; carton_price_minor: number | null; wholesale_price_minor: number; purchase_pack_size: number; reorder_level_milli: number; label_qty_milli: number; qty_milli: number; stock_version: number; warehouse_id: string; barcodes: string[] }>(`
      SELECT l.barcode, l.product_id, p.id, p.name_ar, p.description, p.category, p.unit_kind, p.weight_unit, p.price_minor, p.carton_price_minor,
             p.wholesale_price_minor, p.purchase_pack_size, p.reorder_level_milli, l.qty_milli AS label_qty_milli,
             l.unit_price_minor, l.total_minor, l.created_at, l.print_count, l.used_at,
             sb.qty_milli, sb.version AS stock_version, sb.warehouse_id,
             COALESCE(array(SELECT pb.barcode FROM product_barcodes pb WHERE pb.product_id = p.id ORDER BY pb.barcode), '{}') AS barcodes
      FROM weighted_product_labels l
      JOIN products p ON p.id = l.product_id AND p.active
      JOIN terminals t ON t.id = $2
      JOIN stock_balances sb ON sb.product_id = p.id AND sb.warehouse_id = t.warehouse_id
      WHERE l.barcode = $1
    `, [barcode, auth.terminalId]);
    const row = result.rows[0];
    if (!row) throw new ApiError(404, "WEIGHT_LABEL_NOT_FOUND", "باركود الوزن غير مسجل لهذه نقطة البيع.");
    if (row.used_at) throw new ApiError(409, "WEIGHT_LABEL_USED", "تم بيع هذا الملصق بالفعل ولا يمكن استخدامه مرة أخرى.");
    return {
      label: labelDto({ ...row, qty_milli: row.label_qty_milli }),
      product: { id: row.id, warehouseId: row.warehouse_id, nameAr: row.name_ar, description: row.description, category: row.category,
        unitKind: row.unit_kind, weightUnit: row.weight_unit, purchasePackSize: row.purchase_pack_size, priceMinor: row.price_minor,
        ...(row.carton_price_minor ? { cartonPriceMinor: row.carton_price_minor } : {}), wholesalePriceMinor: row.wholesale_price_minor,
        availableQtyMilli: row.qty_milli, reorderLevelMilli: row.reorder_level_milli, barcodes: row.barcodes, version: row.stock_version },
    };
  });

  app.post("/v1/weighted-labels/printed", async (request) => {
    const auth = requirePermission(request, "PRODUCT_WRITE");
    const body = weightedLabelMarkPrintedRequestSchema.parse(request.body);
    const updated = await db.query("UPDATE weighted_product_labels SET print_count = print_count + 1, last_printed_at = now() WHERE barcode = $1", [body.barcode]);
    if (!updated.rowCount) throw new ApiError(404, "WEIGHT_LABEL_NOT_FOUND", "ملصق الوزن غير موجود.");
    await audit(db, auth, "WEIGHT_LABEL_PRINTED", "weighted_product_label", body.barcode, {});
    return { ok: true };
  });
}
