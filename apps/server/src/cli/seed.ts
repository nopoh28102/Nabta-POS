import { createConfiguredDatabase, transaction } from "../db.js";
import { loadConfig } from "../config.js";
import { normalizeArabicSearch } from "@nabta/domain";

const config = loadConfig();
if (config.NODE_ENV === "production") throw new Error("The development seed is disabled in production");
const db = await createConfiguredDatabase(config);

const products = [
  ["حليب كامل الدسم", "ألبان وأجبان", "PIECE", 4800, "6221000000011", 48_000, 182_400],
  ["زيت دوار الشمس", "مواد غذائية", "PIECE", 9200, "6221000000028", 24_000, 182_400],
  ["أرز أبيض مصري", "مواد غذائية", "PIECE", 3500, "6221000000035", 65_000, 175_500],
  ["جبنة بيضاء", "ألبان وأجبان", "WEIGHT", 16000, "6221000000042", 12_500, 156_250],
] as const;

try {
  await transaction(db, async (client) => {
    const setup = await client.query<{ setup_completed: boolean }>("SELECT setup_completed FROM system_state WHERE singleton");
    if (!setup.rows[0]?.setup_completed) throw new Error("Run first-time setup before the optional seed");
    const warehouse = await client.query<{ id: string }>("SELECT id FROM warehouses WHERE is_default LIMIT 1");
    const owner = await client.query<{ id: string }>("SELECT id FROM users WHERE role = 'OWNER' ORDER BY created_at LIMIT 1");
    if (!warehouse.rows[0] || !owner.rows[0]) throw new Error("Setup data is incomplete");
    for (const [name, category, unit, price, barcode, qty, value] of products) {
      const exists = await client.query("SELECT 1 FROM product_barcodes WHERE barcode = $1", [barcode]);
      if ((exists.rowCount ?? 0) > 0) continue;
      const product = await client.query<{ id: string }>(`
        INSERT INTO products(name_ar, search_name, category, unit_kind, price_minor, reorder_level_milli)
        VALUES ($1, $2, $3, $4, $5, $6) RETURNING id
      `, [name, normalizeArabicSearch(name), category, unit, price, unit === "PIECE" ? 10_000 : 3_000]);
      const productId = product.rows[0]!.id;
      await client.query("INSERT INTO product_barcodes(product_id, barcode) VALUES ($1, $2)", [productId, barcode]);
      await client.query("INSERT INTO stock_balances(warehouse_id, product_id, qty_milli, inventory_value_minor, version) VALUES ($1, $2, $3, $4, 1)", [warehouse.rows[0].id, productId, qty, value]);
      const lot = await client.query<{ id: string }>("INSERT INTO stock_lots(warehouse_id, product_id, lot_code, qty_milli) VALUES ($1, $2, $3, $4) RETURNING id", [warehouse.rows[0].id, productId, "DEV-OPENING", qty]);
      await client.query(`
        INSERT INTO stock_movements(warehouse_id, product_id, movement_type, qty_delta_milli, value_delta_minor,
          balance_qty_milli, balance_value_minor, reference_type, reference_id, actor_user_id, reason)
        VALUES ($1, $2, 'OPENING', $3, $4, $3, $4, 'seed_lot', $5, $6, 'عينة تطوير معزولة')
      `, [warehouse.rows[0].id, productId, qty, value, lot.rows[0]!.id, owner.rows[0].id]);
    }
  });
  process.stdout.write("Development seed completed.\n");
} finally {
  await db.end();
}
