import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PGlite } = require("../apps/server/node_modules/@electric-sql/pglite");
const { pgcrypto } = require("../apps/server/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.cjs");

const [dataDir, backupPath] = process.argv.slice(2);
if (!dataDir || !backupPath) {
  throw new Error("Usage: node scripts/apply-estimated-retail-prices.mjs <pglite-data-dir> <backup-file>");
}

const estimateNote = "\u0633\u0639\u0631 \u0628\u064A\u0639 \u062A\u0642\u062F\u064A\u0631\u064A \u0645\u0628\u062F\u0626\u064A \u2014 \u0631\u0627\u062C\u0639\u0647 \u0642\u0628\u0644 \u0627\u0644\u0628\u064A\u0639";
const knownEstimateMarker = "\u0633\u0639\u0631 \u0628\u064A\u0639 \u062A\u0642\u062F\u064A\u0631\u064A \u0645\u0628\u062F\u0626\u064A";

function grams(text) {
  const normalized = text.toLowerCase().replace(/,/g, ".");
  const kilograms = normalized.match(/(\d+(?:\.\d+)?)\s*(?:kg|kilo|\u0643\u062C\u0645|\u0643\u064A\u0644\u0648)/i);
  if (kilograms) return Number(kilograms[1]) * 1000;
  const value = normalized.match(/(\d+(?:\.\d+)?)\s*(?:g|gr|gm|gram|\u062C\u0645|\u062C\u0631\u0627\u0645)/i);
  return value ? Number(value[1]) : null;
}

function millilitres(text) {
  const normalized = text.toLowerCase().replace(/,/g, ".");
  const litres = normalized.match(/(\d+(?:\.\d+)?)\s*(?:l|litre|liter|\u0644\u062A\u0631)/i);
  if (litres) return Number(litres[1]) * 1000;
  const value = normalized.match(/(\d+(?:\.\d+)?)\s*(?:ml|millilitre|milliliter|\u0645\u0644)/i);
  return value ? Number(value[1]) : null;
}

function has(text, expression) {
  return expression.test(text);
}

function estimatePriceEgp(row) {
  // Product descriptions often mention related goods (for example a cutting board
  // can mention cheese). Classify from the sellable name and category only.
  const text = `${row.name_ar} ${row.category}`.toLowerCase();
  const g = grams(text);
  const ml = millilitres(text);

  if (has(text, /\boil\b|\u0632\u064A\u062A/)) return { rule: "oil", egp: ml && ml <= 550 ? 70 : ml && ml <= 800 ? 95 : 125 };
  if (has(text, /\bsugar\b|\u0633\u0643\u0631/)) return { rule: "sugar", egp: g && g >= 4000 ? 170 : g && g <= 500 ? 20 : 35 };
  if (has(text, /\bwater\b|\u0645\u064A\u0627\u0647/)) return { rule: "water", egp: ml && ml <= 350 ? 7 : ml && ml <= 650 ? 10 : ml && ml <= 1600 ? 15 : 30 };
  if (has(text, /\bjuice\b|\u0639\u0635\u064A\u0631/)) return { rule: "juice", egp: ml && ml <= 300 ? 15 : ml && ml <= 550 ? 25 : ml && ml <= 1100 ? 45 : 75 };
  if (has(text, /\bcola\b|\bsoda\b|\bsoft drink\b|\u0645\u0634\u0631\u0648\u0628 \u063A\u0627\u0632\u064A/)) return { rule: "soft-drink", egp: ml && ml <= 350 ? 18 : ml && ml <= 600 ? 25 : 40 };
  if (has(text, /\bpasta\b|\bmacaroni\b|\bspaghetti\b|\u0645\u0643\u0631\u0648\u0646/)) return { rule: "pasta", egp: g && g <= 500 ? 20 : 45 };
  if (has(text, /\bsnacks?\b|\u0633\u0646\u0627\u0643\u0633/)) return { rule: "snacks", egp: 20 };
  if (has(text, /\bcheese\b|\u062C\u0628\u0646/)) return { rule: "cheese", egp: g && g <= 150 ? 30 : g && g <= 300 ? 55 : g && g <= 600 ? 100 : 190 };
  if (has(text, /\bchocolate\b|\u0634\u0648\u0643\u0648\u0644\u0627\u062A/)) return { rule: "chocolate", egp: g && g <= 60 ? 20 : g && g <= 150 ? 35 : 70 };
  if (has(text, /\bchips?\b|\bcrisps?\b|\u0634\u064A\u0628\u0633/)) return { rule: "chips", egp: g && g <= 50 ? 10 : 20 };
  if (has(text, /\bbiscuit\b|\bcookie\b|\bwafer\b|\u0628\u0633\u0643\u0648\u064A\u062A|\u0648\u064A\u0641\u0631/)) return { rule: "biscuits", egp: g && g <= 100 ? 15 : 30 };
  if (has(text, /milk|yogurt|dairy|\u0644\u0628\u0646|\u0632\u0628\u0627\u062F\u064A/)) return { rule: "dairy", egp: 35 };
  if (has(text, /detergent|cleaner|bleach|soap|\u0645\u0646\u0638\u0641|\u0643\u0644\u0648\u0631/)) return { rule: "household", egp: 65 };
  if (has(text, /shampoo|cream|lotion|deodorant|tooth|\u0634\u0627\u0645\u0628\u0648|\u0645\u0639\u062C\u0648\u0646/)) return { rule: "personal-care", egp: 85 };
  if (has(text, /spice|herb|pepper|cumin|\u062A\u0648\u0627\u0628\u0644|\u0628\u0647\u0627\u0631\u0627\u062A/)) return { rule: "spices", egp: 45 };
  return { rule: "general", egp: 50 };
}

const db = new PGlite(dataDir, { extensions: { pgcrypto } });
await db.waitReady;
try {
  const products = await db.query(`
    SELECT id, name_ar, description, category
    FROM products
    WHERE active AND (price_minor = 0 OR description LIKE '%' || $1 || '%')
    ORDER BY created_at, id
  `, [knownEstimateMarker]);
  if (!products.rows.length) {
    console.log(JSON.stringify({ updated: 0, reason: "no-zero-priced-products" }));
  } else {
    await mkdir(dirname(backupPath), { recursive: true });
    const dump = await db.dumpDataDir();
    await writeFile(backupPath, Buffer.from(await dump.arrayBuffer()), { flag: "wx" });
    const summary = new Map();
    for (let offset = 0; offset < products.rows.length; offset += 200) {
      const batch = products.rows.slice(offset, offset + 200);
      await db.transaction(async (tx) => {
        for (const product of batch) {
          const estimate = estimatePriceEgp(product);
          summary.set(estimate.rule, (summary.get(estimate.rule) ?? 0) + 1);
          const description = product.description.includes(knownEstimateMarker)
            ? product.description
            : [product.description.trim(), estimateNote].filter(Boolean).join(" | ");
          await tx.query(
            "UPDATE products SET price_minor = $2, description = $3, updated_at = now(), version = version + 1 WHERE id = $1 AND (price_minor = 0 OR description LIKE '%' || $4 || '%')",
            [product.id, estimate.egp * 100, description, knownEstimateMarker],
          );
        }
      });
    }
    console.log(JSON.stringify({ updated: products.rows.length, backupPath, byRule: Object.fromEntries(summary) }, null, 2));
  }
} finally {
  await db.close();
}
