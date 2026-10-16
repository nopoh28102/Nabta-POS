import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";

const output = resolve(import.meta.dirname, "../apps/desktop/build");
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
  const typeBytes = Buffer.from(type, "ascii");
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length, 0);
  typeBytes.copy(header, 4);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, body])), 0);
  return Buffer.concat([header, body, checksum]);
}

function png(width, height, pixels) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    pixels.copy(raw, row + 1, y * width * 4, (y + 1) * width * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function ellipse(x, y, cx, cy, rx, ry, angle) {
  const dx = x - cx; const dy = y - cy;
  const cos = Math.cos(angle); const sin = Math.sin(angle);
  const u = (dx * cos + dy * sin) / rx;
  const v = (-dx * sin + dy * cos) / ry;
  return u * u + v * v <= 1;
}

function segment(x, y, ax, ay, bx, by, width) {
  const dx = bx - ax; const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (ax + dx * t), y - (ay + dy * t)) <= width;
}

function roundedSquare(x, y) {
  const min = 0.045; const max = 0.955; const radius = 0.22;
  const nx = Math.max(min + radius, Math.min(max - radius, x));
  const ny = Math.max(min + radius, Math.min(max - radius, y));
  return Math.hypot(x - nx, y - ny) <= radius;
}

function sample(x, y) {
  if (!roundedSquare(x, y)) return [0, 0, 0, 0];
  const shade = Math.max(0, Math.min(1, (x + y) / 1.9));
  let color = [Math.round(41 - 32 * shade), Math.round(217 - 100 * shade), Math.round(147 - 62 * shade), 255];
  if (Math.hypot(x - 0.5, y - 0.5) < 0.32) color = [10, 48, 40, 61];
  if (segment(x, y, 0.50, 0.73, 0.52, 0.48, 0.032)) color = [255, 255, 255, 255];
  if (ellipse(x, y, 0.50, 0.38, 0.23, 0.11, -0.68)) color = [255, 255, 255, 255];
  if (ellipse(x, y, 0.38, 0.50, 0.16, 0.08, 0.64)) color = [217, 255, 233, 255];
  if (Math.hypot(x - 0.5, y - 0.73) < 0.039) color = [217, 255, 233, 255];
  return color;
}

function raster(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const samples = 4;
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const sum = [0, 0, 0, 0];
    for (let sy = 0; sy < samples; sy += 1) for (let sx = 0; sx < samples; sx += 1) {
      const color = sample((x + (sx + 0.5) / samples) / size, (y + (sy + 0.5) / samples) / size);
      color.forEach((value, index) => { sum[index] += value; });
    }
    const offset = (y * size + x) * 4;
    sum.forEach((value, index) => { pixels[offset + index] = Math.round(value / (samples * samples)); });
  }
  return png(size, size, pixels);
}

function ico(images) {
  const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const entries = images.map(({ size, data }) => {
    const entry = Buffer.alloc(16);
    entry[0] = size === 256 ? 0 : size; entry[1] = size === 256 ? 0 : size;
    entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6); entry.writeUInt32LE(data.length, 8); entry.writeUInt32LE(offset, 12);
    offset += data.length; return entry;
  });
  return Buffer.concat([header, ...entries, ...images.map((image) => image.data)]);
}

await mkdir(resolve(output, "icons"), { recursive: true });
const images = sizes.map((size) => ({ size, data: raster(size) }));
await Promise.all(images.map(({ size, data }) => writeFile(resolve(output, "icons", `nabta-${size}.png`), data)));
await writeFile(resolve(output, "icon.png"), images.at(-1).data);
await writeFile(resolve(output, "icon.ico"), ico(images.filter(({ size }) => [16, 20, 24, 32, 40, 48, 64, 128, 256].includes(size))));
