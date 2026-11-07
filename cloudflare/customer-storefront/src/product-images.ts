/**
 * Public product-image manifest for the customer storefront only.
 *
 * Keys are Nabta barcodes and values are Cloudinary delivery URLs.  Nabta's
 * local database intentionally does not store product images or image URLs.
 * This file is filled from an approved product dump when images are uploaded.
 */
export const productImages: Readonly<Record<string, string>> = {};
