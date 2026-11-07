# صور منتجات تطبيق العملاء

## المبدأ

نبتة لا تستقبل صور المنتجات ولا تحفظ ملفات صور أو روابط Cloudinary في قاعدة بياناتها. تظل نبتة مسؤولة فقط عن المنتج والباركود والسعر والتوافر.

- تُرفع الصور المعتمدة إلى مجلد Cloudinary: `shaimaa-market/products`.
- تُحفظ خريطة `الباركود ← رابط Cloudinary` داخل Worker تطبيق العملاء في Cloudflare.
- يضيف الـWorker الصورة إلى بيانات المتجر قبل إرسالها للمتصفح، ولا يرسل الباركود إلى العميل.
- إذا لم توجد صورة معتمدة لباركود منتج، يظهر شعار التطبيق بدلًا منها.

## عند وصول الدمب

1. نقرأ المنتجات والباركودات المتاحة من الدمب.
2. نطابق فقط صورًا تملك حق استعمالها: صورة المورد، الشركة المنتجة، أو صورة التقطها المتجر.
3. نرفع الصور إلى Cloudinary وننشئ ملف الخريطة في `cloudflare/customer-storefront/src/product-images.ts`.
4. ننشر Worker؛ لا توجد ترحيلة قاعدة بيانات ولا تغيير في بيانات نبتة.

## أداة الرفع

`scripts/upload-approved-cloudinary-images.mjs` ترفع المصادر المعتمدة فقط وتنتج ملف JSON يحتوي `productImages`.

```powershell
$env:CLOUDINARY_CLOUD_NAME="..."
$env:CLOUDINARY_API_KEY="..."
$env:CLOUDINARY_API_SECRET="..."
node scripts/upload-approved-cloudinary-images.mjs approved-images.json result.json
```

لا تستخدم الأداة أي رابط أو رمز دخول لنبتة، ولا تتصل بقاعدة بياناتها.
