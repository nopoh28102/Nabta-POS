import rawReferences from "./data/product-reference.json" with { type: "json" };

export interface ProductReference {
  barcode: string;
  nameAr: string;
  category: string;
  subcategory: string;
  size: string;
  manufacturer: string;
  description: string;
  imageUrl: string;
  notes: string;
}

const references = new Map<string, ProductReference>(
  (rawReferences as ProductReference[]).map((reference) => [reference.barcode, reference]),
);

export function findProductReference(barcode: string): ProductReference | null {
  return references.get(barcode) ?? null;
}
