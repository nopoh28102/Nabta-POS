/**
 * Upload approved product artwork to Cloudinary and produce a public barcode
 * manifest for the Cloudflare customer storefront. It intentionally refuses unapproved sources;
 * a public store page is not a licence to copy or re-host its product photos.
 *
 * Usage:
 *   CLOUDINARY_CLOUD_NAME=... CLOUDINARY_API_KEY=... CLOUDINARY_API_SECRET=... \
 *   node scripts/upload-approved-cloudinary-images.mjs approved-images.json result.json
 *
 * Input format:
 * [{ "barcode":"622...", "sourceUrl":"https://...", "sourceLicense":"supplier approved", "approved":true }]
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) throw new Error("Usage: node scripts/upload-approved-cloudinary-images.mjs <approved-images.json> <result.json>");

const cloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim();
const apiKey = process.env.CLOUDINARY_API_KEY?.trim();
const apiSecret = process.env.CLOUDINARY_API_SECRET?.trim();
if (!cloudName || !apiKey || !apiSecret) throw new Error("CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET are required");

const assetFolder = process.env.CLOUDINARY_PRODUCT_FOLDER?.trim() || "shaimaa-market/products";
const parsed = JSON.parse(await readFile(inputPath, "utf8"));
if (!Array.isArray(parsed)) throw new Error("The input must be a JSON array");

function approvedItem(value) {
  if (!value || typeof value !== "object") return null;
  const barcode = String(value.barcode ?? "").trim();
  const sourceUrl = String(value.sourceUrl ?? "").trim();
  const sourceLicense = String(value.sourceLicense ?? "").trim();
  if (!/^[A-Za-z0-9-]{1,80}$/.test(barcode) || !/^https:\/\//i.test(sourceUrl) || !sourceLicense || value.approved !== true) return null;
  return { barcode, sourceUrl, sourceLicense };
}

function signature(params) {
  const payload = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== "")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  return createHash("sha1").update(`${payload}${apiSecret}`).digest("hex");
}

function deliveredCardUrl(secureUrl) {
  const marker = "/image/upload/";
  const index = secureUrl.indexOf(marker);
  if (index < 0) throw new Error("Cloudinary did not return an image delivery URL");
  return `${secureUrl.slice(0, index + marker.length)}c_fill,w_640,h_640,g_auto/f_auto/q_auto/${secureUrl.slice(index + marker.length)}`;
}

const candidates = parsed.map(approvedItem).filter(Boolean);
const skipped = parsed.length - candidates.length;
const uploaded = [];
const failed = [];

for (const item of candidates) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signed = {
    asset_folder: assetFolder,
    context: `barcode=${item.barcode}|source_license=${item.sourceLicense.slice(0, 350)}`,
    overwrite: "false",
    public_id: item.barcode,
    tags: "shaimaa-market,product-image,approved-source",
    timestamp: String(timestamp),
    unique_filename: "false",
    use_asset_folder_as_public_id_prefix: "true",
  };
  try {
    const form = new FormData();
    for (const [key, value] of Object.entries(signed)) form.set(key, value);
    form.set("api_key", apiKey);
    form.set("signature", signature(signed));
    form.set("file", item.sourceUrl);
    const response = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/image/upload`, { method: "POST", body: form });
    const body = await response.json();
    if (!response.ok || typeof body.secure_url !== "string") throw new Error(body.error?.message || `Cloudinary HTTP ${response.status}`);
    uploaded.push({
      barcode: item.barcode,
      cloudinaryUrl: deliveredCardUrl(body.secure_url),
      sourceUrl: item.sourceUrl,
      sourceLicense: item.sourceLicense,
      publicId: body.public_id,
    });
  } catch (error) {
    failed.push({ barcode: item.barcode, sourceUrl: item.sourceUrl, message: error instanceof Error ? error.message : "Unknown upload error" });
  }
}

const productImages = Object.fromEntries(uploaded.map(({ barcode, cloudinaryUrl }) => [barcode, cloudinaryUrl]));
const result = { assetFolder, uploaded, productImages, failed, skippedUnapprovedOrInvalid: skipped };
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

console.log(JSON.stringify({ uploaded: uploaded.length, failed: failed.length, skippedUnapprovedOrInvalid: skipped, outputPath }, null, 2));
