# حالة التنفيذ والإصدار

## إصدار Windows 0.1.44 — 2026-10-15

**الحالة:** مكتمل ومختبر.

### النسخ الاحتياطي التلقائي والتحقق من الاستعادة

- أضيف إعداد دائم لمجلد النسخ التلقائي داخل: **الإعدادات ← الإدارة والرقابة ← النسخ والاستعادة**.
- بعد اختيار المجلد، ينشئ البرنامج نسخة كاملة فوراً ثم ينشئ نسخة جديدة كل 3 أيام؛ ويتحقق من كل نسخة تلقائية بفتحها في قاعدة معزولة.
- يحذف فقط النسخ التلقائية التي تجاوز عمرها 30 يوماً، ولا يحذف النسخ اليدوية التي حفظها المالك بنفسه.
- يشمل الأرشيف قاعدة البيانات كاملة: الأصناف والباركود والأسعار والمخزون والمشتريات والمبيعات والفواتير والعملاء والورديات والإعدادات وسجل التدقيق.
- تحفظ قاعدة البيانات ونسخها خارج مجلد البرنامج؛ لذا لا يستبدلها تحديث المثبت. كما أن مجلد النسخ المختار محفوظ داخل قاعدة البرنامج نفسها ويعود بعد إعادة التشغيل أو التحديث.
- تعمل الجدولة في النسخة المحلية المثبتة أيضاً؛ تفحص الاستحقاق بعد اكتمال بدء التشغيل بدقيقة ثم كل ست ساعات، من دون إنشاء نسخة إضافية قبل مرور 3 أيام.

### التحقق المنفذ

- `pnpm typecheck` — ناجح.
- `pnpm test:integration` — ناجح: 15 اختباراً و8 اختبارات PostgreSQL متخطاة لعدم توفر خادم خارجي. يتضمن إنشاء نسخة تلقائية، اختبار استعادتها، وحذف نسخة تلقائية منتهية.
- `pnpm test:e2e` — ناجح: 19 اختبار واجهة.
- `pnpm package:win` — ناجح؛ المثبّت: `apps/desktop/release/Nabta-POS-0.1.44-x64.exe`.
- SHA-256: `29B62E43282153F63015B0709E692DCAEDE8561BC36DB398555F61E16826A486`.

## إصدار Windows 0.1.43 — 2026-10-15

**الحالة:** مكتمل ومختبر.

### بدء دورة جديدة آمنة

- أضيف تبويب **بدء دورة جديدة** ضمن الإعدادات للمالك فقط، وبالرمز السري `281020`.
- ينشئ البرنامج نسخة احتياطية تلقائية قبل أي حذف، ثم يعرض مسارها بعد نجاح العملية.
- تُصفّر عمليات البيع والشراء والفواتير والأرباح والورديات والمصروفات والعملاء، ويُعاد عداد الفواتير للصفر.
- تبقى الأصناف والباركود والأسعار والكميات الحالية كما هي؛ ويعاد تسجيل الكميات كرصد افتتاحي صالح للبيع.
- تمنع العملية إن كانت هناك وردية مفتوحة، وتسجل في سجل تدقيق غير قابل للحذف.
- بعد النجاح تُمسح مسودات الواجهة ويسجل المستخدم الخروج للبدء بدورة نظيفة.

### التحقق المنفذ

- `pnpm typecheck` — ناجح.
- `pnpm test:integration` — ناجح: 14 اختباراً و8 اختبارات PostgreSQL متخطاة لعدم توفر خادم خارجي؛ يتضمن اختبار تصفير فعلي.
- `pnpm exec playwright test` — ناجح: 19 اختبار واجهة.
- `pnpm package:win` — ناجح؛ المثبّت: `apps/desktop/release/Nabta-POS-0.1.43-x64.exe`.
- SHA-256: `1652AA1F0A93DB3CB407EDBAF4CFA1159C2931E31F52437102995686924F8736`.

## إصدار Windows 0.1.21 — 2026-10-13

**الحالة:** تم إنشاء حزمة Windows بنجاح.

### المخرجات

- المثبّت: `apps/desktop/release/Nabta-POS-0.1.21-x64.exe`
- الحجم: 125,471,024 بايت.
- SHA-256: `6288E015B09A5DCE04B2C70A98BE756912F21700CD6E9E656716836258ACD9D4`
- خريطة الكتل: `apps/desktop/release/Nabta-POS-0.1.21-x64.exe.blockmap`

### ما تغيّر

- يمكن للكاشير كتابة ملاحظة اختيارية عند إغلاق الوردية، وتظهر في سجل الشهر وملف Excel المصدر.

### التحقق المنفذ

- `pnpm typecheck` — ناجح.
- `pnpm exec vitest run apps/desktop/src/electron/workbooks.test.ts` — ناجح: 3 اختبارات.
- `pnpm package:win` — ناجح.

## إصدار Windows 0.1.20 — 2026-10-13

**الحالة:** تم إنشاء حزمة Windows بنجاح.

### المخرجات

- المثبّت: `apps/desktop/release/Nabta-POS-0.1.20-x64.exe`
- الحجم: 125,471,068 بايت.
- SHA-256: `CE97EEBAB91EEEDA8B23F5DCBEBE026116142773BDA3B5175DB092D2DD30F106`
- خريطة الكتل: `apps/desktop/release/Nabta-POS-0.1.20-x64.exe.blockmap`

### ما تغيّر

- تعرض صفحة الوردية سجل الشهر المختار: الكاشير، نقطة البيع، حالة الوردية، وقتا الفتح والإغلاق، الرصيد الافتتاحي والمتوقع والفعلي، الفرق، عدد الفواتير، إجمالي البيع وملاحظة الإغلاق.
- بعد إغلاق الوردية يمكن فتح وردية جديدة فورًا لنفس المستخدم. لبدء وردية باسم كاشير آخر يجب تسجيل الدخول بحسابه، فلا يمكن إسناد وردية إلى شخص من دون تحقق.
- أضيف زر تصدير Excel لسجل الشهر للمستخدمين المخولين بالتصدير، مع اختيار مسار الحفظ على الجهاز.
- أضيف اختبار يتأكد من أن ملف سجل الورديات الناتج يفتح بصورة صحيحة في Excel.

### التحقق المنفذ

- `pnpm typecheck` — ناجح.
- `pnpm exec vitest run apps/desktop/src/electron/workbooks.test.ts` — ناجح: 3 اختبارات لملفات Excel.
- `pnpm test:unit` — ناجح: 24 اختبارًا.
- `pnpm test:integration` — ناجح: 13 اختبارًا؛ 8 اختبارات PostgreSQL متخطاة لعدم ضبط `TEST_DATABASE_URL`.
- `pnpm package:win` — ناجح.

## إصدار Windows 0.1.19 — 2026-10-13

**الحالة:** حُسّنت تجربة بدء البيع؛ جارٍ إنشاء حزمة Windows والتحقق منها.

### ما تغيّر

- عند عدم وجود وردية مفتوحة، لا يبقى زر البيع معطلاً بلا توضيح: يتحول إلى «فتح وردية للمتابعة» وينتقل إلى شاشة الوردية.
- اختصار `F4` يتجه كذلك إلى فتح الوردية عند الحاجة؛ وبعد فتحها حتى برصيد افتتاحي `0.00` يعود إلى «إتمام البيع».

## إصدار Windows 0.1.18 — 2026-10-13

**الحالة:** تمت إضافة حذف الصنف الآمن؛ جارٍ إنشاء حزمة Windows والتحقق منها.

### ما تغيّر

- أُضيف زر «حذف الصنف» في إجراءات كل صف داخل صفحة الأصناف.
- يعرض الزر تأكيدًا قبل التنفيذ، ثم يخفي الصنف من قوائم البيع والبحث مع الاحتفاظ بالفواتير وسجل المخزون السابق.
- يُرفض الحذف إذا كان للصنف رصيد متاح، لحماية قيمة المخزون؛ يجب تصفير الرصيد أولًا بحركة جرد أو تسوية مسجلة.
- يتطلب التنفيذ صلاحية `PRODUCT_WRITE` ويُسجَّل في سجل التدقيق.

### التحقق المنفذ

- `pnpm typecheck` و`pnpm test:unit` و`pnpm build` — ناجحة.

## إصدار Windows 0.1.17 — 2026-10-13

**الحالة:** تم إنشاء حزمة Windows بنجاح بعد إصلاح عطل بدء التشغيل في 0.1.16.

### المخرجات

- المثبّت: `apps/desktop/release/Nabta-POS-0.1.17-x64.exe`
- الحجم: 125,468,766 بايت.
- SHA-256: `35D7DB778F52274C710B7C4F33FDDE89C8CE7C42002C264D91C862BAD2080D8A`
- خريطة الكتل: `apps/desktop/release/Nabta-POS-0.1.17-x64.exe.blockmap`

### ما تغيّر

- استُبدل استيراد `Workbook` غير المتوافق من مكتبة `exceljs` بالاستيراد الافتراضي المتوافق مع Electron وESM.
- يمنع ذلك ظهور رسالة `The requested module 'exceljs' does not provide an export named 'Workbook'` عند فتح البرنامج بعد التثبيت.

### التحقق المنفذ

- `pnpm typecheck` — ناجح.
- `pnpm exec vitest run apps/desktop/src/electron/workbooks.test.ts` — ناجح: اختباران لتوليد وفتح ملفي Excel.
- `pnpm --filter @nabta/desktop build` — ناجح.
- جرى استيراد ملف `dist-electron/workbooks.js` المبني مباشرةً وتشغيل تصدير XLSX بنجاح داخل بيئة ESM، وهو المسار الذي كان يسبب العطل.
- `pnpm package:win` — ناجح.

## إصدار Windows 0.1.16 — 2026-10-13

**الحالة:** تم إنشاء حزمة Windows بنجاح.

### المخرجات

- المثبّت: `apps/desktop/release/Nabta-POS-0.1.16-x64.exe`
- الحجم: 125,468,656 بايت.
- SHA-256: `DA66557C145CCAA292B3ED2AF1DA5F175EFEB650361837A6CA20ACF5E5B8EE1D`
- خريطة الكتل: `apps/desktop/release/Nabta-POS-0.1.16-x64.exe.blockmap`

### ما تغيّر

- أصبح اسم «الشيماء» هو الاسم الافتراضي في واجهة المتجر والتقارير إلى أن يُحفظ الاسم من الإعدادات.
- ضُبط قالب الفاتورة لرول 80 مم لطابعة Xprinter XP-Q808K، داخل عرض طباعة آمن 72 مم.
- أضيفت خطوط رأس وجدول وإجمالي واضحة، مع ضمان عدم قص الأعمدة من جانبي الإيصال.
- تبقى حقول الهاتف وواتساب وحساب التواصل والشعار والرسالة الختامية في إعدادات هوية المتجر، وتُرسل إلى كل فاتورة مطبوعة.

### التحقق المنفذ

- `pnpm typecheck` — ناجح.
- `pnpm test:unit` — ناجح: 24 اختبارًا.
- `pnpm test:integration` — ناجح: 13 اختبارًا؛ 8 اختبارات PostgreSQL متخطاة لعدم تعيين `TEST_DATABASE_URL`.
- `pnpm build` و`pnpm package:win` — ناجحان.

### قيد تحقق مادي

- يلزم اختبار طباعة فعلي على XP-Q808K باستخدام رول 80 مم؛ لا تتوفر الطابعة موصّلة في بيئة البناء.

## إصدار Windows 0.1.15 — 2026-10-13

**الحالة:** تم إنشاء حزمة Windows بنجاح.

### المخرجات

- المثبّت: `apps/desktop/release/Nabta-POS-0.1.15-x64.exe`
- الحجم: 125,468,384 بايت.
- SHA-256: `382B04B2D74693AA745181ABFCAF348774530361B3B0D3756C5D7A73A6138AE7`
- خريطة الكتل: `apps/desktop/release/Nabta-POS-0.1.15-x64.exe.blockmap`

### ما تغيّر

- أضيفت مقاسات ملصقات XP-233B الشائعة: 24×14، 30×20، 40×25، 40×30، 50×30، 50×50، 58×30، 58×40، و58×60 مم.
- أضيفت ثلاثة تصاميم لكل مقاس: «قياسي»، «سعر بارز»، و«مضغوط»، مع معاينة فورية في الإعدادات.
- تمرر الطباعة الآن أبعاد الملصق المختارة مباشرة إلى مهمة طباعة Windows بلا هوامش، مع إبقاء طابعة الإيصالات مستقلة.

### التحقق المنفذ

- `pnpm typecheck` — ناجح.
- `pnpm test:unit` — ناجح: 24 اختبارًا.
- `pnpm test:integration` — ناجح: 13 اختبارًا؛ 8 اختبارات PostgreSQL متخطاة لعدم تعيين `TEST_DATABASE_URL`.
- `pnpm exec vitest run apps/desktop/src/electron/workbooks.test.ts` — ناجح: اختباران.
- `pnpm build` و`pnpm package:win` — ناجحان.

### قيد تحقق مادي

- يلزم اختيار الرول المركّب نفسه من الإعدادات واستخدام «طباعة ملصق اختبار» للتحقق من المحاذاة الفعلية للطابعة؛ لا تتوفر XP-233B موصّلة في بيئة البناء.

## إصدار Windows 0.1.14 — 2026-10-13

**الحالة:** تم إنشاء حزمة Windows بنجاح.

### المخرجات

- المثبّت: `apps/desktop/release/Nabta-POS-0.1.14-x64.exe`
- الحجم: 125,467,082 بايت.
- SHA-256: `9BEA99AE9ECEF76EC8B59E462560254BF4216EA226C107E6187035D85A735A8B`
- خريطة الكتل: `apps/desktop/release/Nabta-POS-0.1.14-x64.exe.blockmap`

### ما تغيّر

- استُبدل مولّد ملفات Excel اليدوي بمولّد Excel موثوق في جميع مسارات التصدير الحالية.
- أصلح «تصدير أسعار Excel» و«تصدير جملة Excel» في صفحة الأصناف، ويشمل الإصلاح أيضًا «تصدير المخزون إلى Excel».
- أضيف اختبار يولّد ملفات أسعار ومخزون، ثم يفتح كل ملف ويقرأ بياناته للتحقق من سلامة الملف قبل تسليمه.

### التحقق المنفذ

- `pnpm typecheck` — ناجح.
- `pnpm exec vitest run apps/desktop/src/electron/workbooks.test.ts` — ناجح: اختباران لفتح ملفات Excel الناتجة.
- `pnpm test:integration` — ناجح: 13 اختبارًا؛ 8 اختبارات PostgreSQL متخطاة لعدم تعيين `TEST_DATABASE_URL`.
- `pnpm build` و`pnpm package:win` — ناجحان.
- `pnpm test:e2e` — لم يكتمل: خادم محلي قديم على منفذ الاختبار `7443` منع تهيئة بيئة Playwright. لم يُوقَف لتجنب تعطيل عملية قائمة.

## إصدار Windows 0.1.13 — 2026-10-13

**الحالة:** تم إنشاء حزمة Windows بنجاح.

### المخرجات

- المثبّت: `apps/desktop/release/Nabta-POS-0.1.13-x64.exe`
- الحجم: 121,019,467 بايت.
- SHA-256: `D8D5B2F5A68CD0F7869BE5CE9D68E204EB73CD7533092CD5202F272065D65DF6`
- خريطة الكتل: `apps/desktop/release/Nabta-POS-0.1.13-x64.exe.blockmap`

### ما تغيّر

- زر «تصدير جملة Excel» يفتح نافذة اختيار مكان الحفظ وينشئ ملف Excel محليًا، بدل تنزيل CSV من داخل الصفحة.
- يحتوي ملف الجملة على: الصنف، التصنيف، الباركود، الوحدة، الكمية المتاحة، سعر الجملة، وسعر البيع.
- زر «تصدير أسعار Excel» ينشئ ملفًا عامًا لا يتضمن سعر الجملة.
- تحفظ الصلاحيات سعر الجملة للتصدير الداخلي فقط لمن يملك صلاحية عرض التكاليف، ويدعم التصدير نتيجة البحث الحالية أو الأصناف المعروضة.

### التحقق المنفذ

- `pnpm typecheck` — ناجح.
- `pnpm exec vitest run tests/integration/pglite.integration.test.ts` — ناجح: 12 اختبارًا، ويتحقق من بيانات تصدير الجملة والكمية المتاحة.
- `pnpm test:e2e` — ناجح: 13 من 13 اختبار Electron.
- `pnpm package:win` — ناجح: مثبّت NSIS x64 وخريطة كتل.

## إصدار Windows 0.1.12 — 2026-10-13

**الحالة:** تم إنشاء حزمة Windows بنجاح.

### المخرجات

- المثبّت: `apps/desktop/release/Nabta-POS-0.1.12-x64.exe`
- الحجم: 121,018,203 بايت.
- SHA-256: `35EA13BA24F25778BAD21EDE4533255DE3BFFB9D5E8D75EA7E820C93475B0591`
- خريطة الكتل: `apps/desktop/release/Nabta-POS-0.1.12-x64.exe.blockmap`

### ما تغير

- عولج تزاحم أزرار صف الصنف: بقيت إجراءات الإضافة السريعة وتعديل السعر/الطباعة وطباعة الملصق دون ظهور شريط تمرير بسببها.
- أبقي التصدير العام والداخلي في أعلى صفحة الأصناف ليعمل على نتيجة البحث الحالية، بدل تكراره في كل صف.
- أضيف تحقق قبل إرسال الملصق: يوضح اختيار طابعة الباركود أو تعارضها مع طابعة الإيصالات، ويستبدل الخطأ العام برسالة قابلة للتنفيذ.

### التحقق المنفذ

- `pnpm typecheck` — ناجح.
- `pnpm test:e2e` — ناجح: 13 من 13 اختبار Electron.
- `pnpm package:win` — ناجح: مثبّت NSIS x64.

## Windows release 0.1.24 — 2026-10-13

**Status:** completed and packaged successfully.

### Deliverables

- Installer: `apps/desktop/release/Nabta-POS-0.1.24-x64.exe`
- Size: 125,472,604 bytes.
- SHA-256: `62E4C8AA805F36BB016E3FA726A6E46A2E8F1304AF92D970911456E34BB616F1`
- Block map: `apps/desktop/release/Nabta-POS-0.1.24-x64.exe.blockmap`

### Changes

- Repaired the Arabic labels and accessible label of the product right-click menu; all labels are now encoded safely by the renderer.
- Product cards now keep their unit icon as a fallback when their local product image cannot be read, preventing empty image areas.
- Added a non-destructive catalog-media repair utility. It restores missing cache files from the source workbook without opening or modifying the live product database.
- Rebuilt the current application's catalog media cache: all 3,284 image files from the source workbook are now restored locally.

### Verification performed

- `pnpm typecheck` — passed.
- `pnpm build` — passed.
- `pnpm exec playwright test` — passed: 14 of 14 Electron tests.
- `node --check scripts/repair-catalog-media.mjs` — passed.
- `pnpm package:win` — passed: NSIS x64 installer generated.

## إصدار Windows 0.1.11 — 2026-10-13

**الحالة:** تم إنشاء حزمة Windows بنجاح.

### المخرجات

- المثبّت: `apps/desktop/release/Nabta-POS-0.1.11-x64.exe`
- الحجم: 121,018,328 بايت.
- SHA-256: `4DEE3760F79476F7792F10A43A3AB6BE3D0AD6249D2F5BEB8019BEA88CCC702B`
- خريطة الكتل: `apps/desktop/release/Nabta-POS-0.1.11-x64.exe.blockmap`

### ما تغير

- أضيف زر «طباعة ملصق» بجوار كل صنف في نتائج البحث بصفحة الأصناف، ويرسل الملصق مباشرة إلى طابعة الباركود المحددة.
- فصل إعدادات الطباعة إلى طابعة ملصقات باركود افتراضية `Xprinter XP-233B` وطابعة إيصالات افتراضية `Xprinter XP-Q808K USB`.
- أضيف اختبار مستقل لكل طابعة، وحماية تمنع حفظ الطابعة نفسها لدوري الملصقات والإيصالات.
- الملصقات تستخدم سعر البيع العام والباركود واسم الصنف، ويمكن تغيير مقاسها بين 58×40 و40×30 مم من الإعدادات.

### التحقق المنفذ

- `pnpm typecheck` — ناجح.
- `pnpm test:unit` — ناجح: 24 اختبارًا.
- `pnpm test:e2e` — ناجح: 13 من 13 اختبار Electron.
- `pnpm package:win` — ناجح: مثبّت NSIS x64.

### قيد تحقق مادي

- لا تتوفر طابعتا Xprinter موصولتان في بيئة البناء؛ يلزم من شاشة الإعدادات اختيار اسميهما كما يظهران في Windows ثم استخدام «طباعة ملصق اختبار» و«طباعة اختبار» للتحقق من تعريف الطابعة ومقاس الورق الفعليين.

## إصدار Windows 0.1.10 — 2026-10-13

**الحالة:** تم إنشاء حزمة Windows بنجاح.

### المخرجات

- المثبّت: `apps/desktop/release/Nabta-POS-0.1.10-x64.exe`
- الحجم: 121,016,115 بايت.
- SHA-256: `DD4A374467127C7F05FB56270E3C0AB2B7C6341FC34DCF55F936D700CA28823F`
- خريطة الكتل: `apps/desktop/release/Nabta-POS-0.1.10-x64.exe.blockmap`

### ما تغير

- أضيف سعر جملة داخلي مستقل لكل صنف، منفصل عن تكلفة التوريد المحاسبية وسعر البيع الظاهر للعميل.
- شاشة الأصناف تعرض سعر البيع للجميع، وسعر الجملة للمالك/من لديه صلاحية `VIEW_COST` فقط، مع تعديلهما من بطاقة الصنف.
- فاتورة التوريد والاستلام السريع تسمح بتسجيل تكلفة التوريد وسعر البيع وسعر الجملة معًا؛ تحديث الأسعار يسجل في التدقيق ولا يغير الفواتير السابقة.
- تصدير الأصناف من صفحة الأصناف صار يدعم تصدير سعر البيع العام أو التصدير الداخلي بسعر الجملة، لكامل النتائج أو لصنف محدد من نتيجة البحث.
- قبلت الكميات الوزنية حتى ثلاثة منازل عشرية بدقة الألف: `0.125` و`0.250` و`0.500` و`1.000`، بينما تمنع كسور القطع.
- أضيفت الترحيلة `migrations/005_product_wholesale_price.sql` وتتحقق الحزمة من وجودها داخل بيئة التشغيل.

### التحقق المنفذ

- `pnpm typecheck` — ناجح.
- `pnpm test:unit` — ناجح: 24 اختبارًا.
- `pnpm test:integration` — ناجح: 13 اختبارًا؛ 8 اختبارات PostgreSQL متخطاة لعدم تعيين `TEST_DATABASE_URL`.
- `pnpm test:e2e` — ناجح: 13 من 13 اختبار Electron.
- `pnpm package:win` — ناجح: مثبّت NSIS x64.

## إصدار Windows 0.1.9 — 2026-10-12

**الحالة:** تم إنشاء حزمة Windows بنجاح.

### المخرجات

- المثبّت: `apps/desktop/release/Nabta-POS-0.1.9-x64.exe`
- الحجم: 121,014,666 بايت.
- SHA-256: `DEA4B8FD7A4979FC81B350AD5012A95130F8483D21630D41EF9113D5813BF7FD`
- خريطة الكتل: `apps/desktop/release/Nabta-POS-0.1.9-x64.exe.blockmap`

### ما تغير

- أضيف في «الإعدادات ← النسخ والاستعادة» اختيار مسار واسم ملف عند إنشاء نسخة احتياطية.
- أضيف استيراد ملف `.dump` من مسار خارجي، مع نسخه إلى مخزن نبتة والتحقق من استعادته في قاعدة معزولة قبل تسجيله.
- لا تستبدل العملية بيانات المتجر الحية أثناء التشغيل، وتُرفض مسارات الملفات من عملاء الشبكة؛ تقبل فقط من تطبيق سطح المكتب المحلي عبر loopback.
- سُجل إنشاء النسخ والاستيراد في سجل التدقيق، ورُفع إصدار سطح المكتب إلى `0.1.9`.

### التحقق المنفذ

- `pnpm typecheck` — ناجح.
- `pnpm test:unit` — ناجح: 24 اختبارًا.
- `pnpm test:integration` — ناجح: 13 اختبارًا؛ 8 اختبارات PostgreSQL متخطاة لعدم تعيين `TEST_DATABASE_URL`.
- `pnpm test:e2e` — ناجح: 13 من 13 اختبار Electron.

## إصدار Windows 0.1.8 — 2026-10-12

**الحالة:** تم إنشاء حزمة Windows بنجاح.

### المخرجات

- المثبّت: `apps/desktop/release/Nabta-POS-0.1.8-x64.exe`
- الحجم: 121,012,285 بايت.
- SHA-256: `F77479C72D25CD8AFD701306EF4DF8210550C5F9F759FBEA4D4590829D2E6083`
- خريطة الكتل: `apps/desktop/release/Nabta-POS-0.1.8-x64.exe.blockmap`
- النسخة غير المضغوطة: `apps/desktop/release/win-unpacked/`
- تم التحقق من تضمين `resources/app.asar` ووقت تشغيل الخادم المحلي.

### التحقق المنفذ

- `pnpm install --frozen-lockfile` — ناجح.
- `pnpm typecheck` — ناجح لجميع الحزم.
- `pnpm test:unit` — ناجح: 24 اختبارًا.
- `pnpm test:integration` — ناجح: 12 اختبارًا؛ 8 اختبارات PostgreSQL متخطاة لعدم تعيين `TEST_DATABASE_URL`.
- `pnpm test:e2e` — ناجح: 12 من 12 اختبار Electron.
- `pnpm package:win` — ناجح: مثبّت NSIS ‏x64.
- `pnpm audit --prod --audit-level high` — لا توجد ثغرات معروفة في الاعتمادات الإنتاجية.

### ملاحظات الإصدار

- المثبّت غير موقّع رقميًا عمدًا وفق إعداد `signExecutable: false`. يلزم توقيع Authenticode قبل توزيع عام لتفادي تحذيرات Windows SmartScreen.
- لم يُشغّل اختبار تلقائي مباشر للمثبّت/الملف التنفيذي المعبأ؛ حجبت سياسة التنفيذ المحلية تشغيل ملف EXE وإيقافه من الطرفية. اختبارات Electron الشاملة اجتازت بنجاح قبل التغليف.
## إصدار Windows 0.1.22 — 2026-10-13

**الحالة:** تم إنشاء حزمة Windows بنجاح واستيراد كتالوج البقالة والعطارة إلى قاعدة بيانات التثبيت المحلي.

### المخرجات

- المثبّت: `apps/desktop/release/Nabta-POS-0.1.22-x64.exe`
- الحجم: 125,472,120 بايت.
- SHA-256: `9FC6EE5031D8A1F8963E0C21C3D780877E8B15EB5514B43745349D9103956DEF`
- خريطة الكتل: `apps/desktop/release/Nabta-POS-0.1.22-x64.exe.blockmap`

### ما تغيّر

- أضيفت ترحيلة `006_product_reference_catalog.sql` لدليل أصناف منفصل عن الأصناف القابلة للبيع؛ لذلك لا تُخترع أسعار للصفوف التي لا يتوفر لها سعر معلن.
- استورد ملف الكتالوج المكوّن من 3,284 صفاً إلى دليل البحث، وأضيفت 542 سلعة جديدة قابلة للبيع من الصفوف ذات السعر، بصفر مخزون مبدئي وبسعر جملة صفري حتى يحدده المالك.
- مُنعت إضافة أي باركود موجود أو تكرار للاسم والقسم، مع الإبقاء على الصنف المسجل مسبقاً دون تعديله.
- حُمّلت صور المنتجات كلها (3,284 صورة) داخل تخزين التطبيق المحلي، وتعرض شاشة إضافة الصنف صورة الدليل عند إدخال الباركود.
- أضيف بروتوكول محلي آمن للصور المخزنة، وتحسين لمدير الترحيلات ليسجل الترحيلات المنفذة في النسخ الجديدة تلقائياً.
- حفظت نسخ احتياطية قبل الاستيراد في `Documents/Nabta Backups`، وأولها `before-catalog-import-2026-10-13.dump`.

### التحقق المنفذ

- فحص قاعدة البيانات الحية: 543 صنفاً للبيع و543 باركوداً و3,284 مرجعاً و3,284 صورة محلية.
- `pnpm typecheck` — ناجح.
- `pnpm test:unit` — ناجح: 24 اختباراً.
- `pnpm exec vitest run apps/desktop/src/electron/workbooks.test.ts` — ناجح: 3 اختبارات.
- `pnpm test:e2e` — ناجح: 13 من 13 اختبار Electron.
- `pnpm package:win` — ناجح: مثبّت NSIS x64، وتحقق تضمين ترحيلة الكتالوج ومدير الترحيلات في الحزمة.
## إصدار Windows 0.1.23 — 2026-10-13

**الحالة:** تم إنشاء حزمة Windows بنجاح.

### المخرجات

- المثبّت: `apps/desktop/release/Nabta-POS-0.1.23-x64.exe`
- الحجم: 125,472,796 بايت.
- SHA-256: `470544D55EBE4B34510835290EECF8F7B0C74FA6BF962D5AE34FD8BD32C45086`
- خريطة الكتل: `apps/desktop/release/Nabta-POS-0.1.23-x64.exe.blockmap`

### ما تغيّر

- بطاقات نقطة البيع تستقبل الآن باركود الصورة من دليل الكتالوج وتعرض الصورة المحلية بدلاً من رمز الحقيبة؛ يبقى الرمز الافتراضي فقط للصنف الذي لا يملك صورة.
- الضغط بزر الفأرة الأيمن على أي صف في صفحة الأصناف يفتح قائمة منسدلة للصنف المحدد نفسه: إضافة كمية، سعر/طباعة، طباعة ملصق، أو حذف آمن.
- أضيف اختبار Electron للتأكد من فتح قائمة الكليك يمين وتشغيل إجراء إضافة الكمية للصنف الذي تم اختياره.

### التحقق المنفذ

- `pnpm typecheck` — ناجح.
- استعلام مباشر من قاعدة البيانات — تحقق من إسناد باركود صورة لكل بطاقة من الأصناف المستوردة.
- `pnpm test:e2e` — ناجح: 14 من 14 اختبار Electron.
- `pnpm package:win` — ناجح: مثبّت NSIS x64.

## Windows release 0.1.25 — 2026-10-13

**Status:** completed and packaged successfully.

### Deliverables

- Installer: `apps/desktop/release/Nabta-POS-0.1.25-x64.exe`
- Size: 125,473,446 bytes.
- SHA-256: `1DFD9C412E86D1F68F253764EE87399B65AB0992BEC0B3A5A650905CEF9D7D94`

### Changes

- Added migration `007_materialize_catalog_products.sql`. It creates a sellable product, barcode, and zero stock balance for every catalog reference barcode that does not already exist as a product.
- Catalog products with an unknown price start with retail and wholesale prices of zero. They cannot be quoted or sold until a positive retail price is set, avoiding accidental zero-price sales.
- Updated the catalog importer so fresh imports follow the same rule and materialize every non-duplicate catalog row.

### Verification performed

- Isolated PGlite migration test passed: preserves an existing barcode and creates a missing reference product with zero retail, wholesale, and stock values.
- `pnpm typecheck` — passed.
- `pnpm build` — passed.
- `pnpm exec playwright test` — passed: 14 of 14 Electron tests.
- `pnpm package:win` — passed: NSIS x64 installer generated, including migration 007.

## Windows release 0.1.26 — 2026-10-13

**Status:** hardware integration implemented; installer artifact generated and inspected.

### Hardware work

- Detected local queues: `Xprinter XP-233B` on USB004 for labels and `XP-80` / POS-80 on USB003 for receipts. The app now recognizes the generic POS-80 queue as the 80 mm receipt role on first run.
- Added separate printer-role persistence, role-conflict protection, receipt paper configuration, and explicit bundled-driver launch buttons in Settings.
- Added cash-drawer control through the selected receipt queue using a standard ESC/POS RAW spool job. It is disabled by default, offers Pin 2 / Pin 5 selection, runs only after a successful receipt job when enabled, and includes a manual test button.
- Embedded the official Xprinter label and receipt driver executables in the Windows package. Both embedded files verify as Authenticode `Valid`; checksums and setup instructions are recorded in `docs/HARDWARE-SETUP-AR.md` and `apps/desktop/build/drivers/README-AR.md`.

### Deliverable

- Installer: `apps/desktop/release/Nabta-POS-0.1.26-x64.exe`
- Size: 180,170,048 bytes.
- SHA-256: `A6080EDE90BD38A8F0993CB4A63F4D8CAF9C6A01EFB5EAE9B87A021093793BCB`

### Verification performed

- `pnpm typecheck` — passed.
- `pnpm build` — passed.
- `pnpm exec playwright test` — passed: 14 of 14 Electron tests.
- The packaging process exceeded the shell watchdog after the artifact had been generated; verified the final NSIS artifact, the unpacked `resources/drivers` directory, both driver SHA-256 values, and their Authenticode signatures.

## Windows release 0.1.27 — 2026-10-13

**Status:** completed and packaged successfully.

- Redesigned the thermal sales receipt for 58 mm and 80 mm rolls: stronger store header, invoice/date block, compact item cards, quantities and unit prices, a framed total, and separate paid/change values.
- Keeps the store logo, phone, WhatsApp, social account, and custom footer from Settings without introducing tax or payment data that the sale record does not contain.
- `pnpm typecheck` — passed.
- `pnpm build` — passed.
- `pnpm exec playwright test` — passed: 14 of 14 Electron tests.
- Installer: `apps/desktop/release/Nabta-POS-0.1.27-x64.exe`
- Size: 180,170,532 bytes; SHA-256: `812CEC2B9A4312F1FBA8792F3AD8AE9712542EDCB78CB84FF3E53A09C2280660`.

## Windows release 0.1.28 — 2026-10-13

**Status:** completed and packaged successfully.

- Corrected receipt clipping on thermal printers by adding physical safe-area padding for 80 mm and 58 mm paper; long product names now wrap rather than pushing totals into the non-printable edge.
- `pnpm typecheck`, `pnpm build`, and `pnpm exec playwright test` passed (14/14).
- Installer: `apps/desktop/release/Nabta-POS-0.1.28-x64.exe`
- Size: 180,170,695 bytes; SHA-256: `F3623ADC794D1A02CBB6987D88B72F5DE928F6C0A3951D7A4E5B1F7A72A29DA8`.

## Windows release 0.1.29 — 2026-10-13

**Status:** completed and packaged successfully.

- Applied the selected receipt composition: centered store mark and name, sales-invoice badge, invoice metadata, a distinct purchases heading, separated item totals, framed grand total, paid/change boxes, and branded footer.
- Preserved physical printable safety margins: the 80 mm layout uses a 72 mm receipt body with 2.4 mm side padding (67.2 mm safe content width); the 58 mm layout uses a 48 mm body with 1.8 mm side padding (44.4 mm safe content width).
- Long product names are constrained to wrap within the product column, so prices and totals do not extend into the printer's non-printable edge.
- `pnpm typecheck` — passed.
- `pnpm build` — passed.
- `pnpm exec playwright test` — passed: 14 of 14 Electron tests.
- `pnpm package:win` — passed: NSIS x64 installer generated.
- Installer: `apps/desktop/release/Nabta-POS-0.1.29-x64.exe`
- Size: 180,170,832 bytes; SHA-256: `6568EEF7EAA9B8D6E0EBDE2EC57557F20FA1DF589AEC9232BB369BB566E6F185`.

## Windows release 0.1.30 — 2026-10-13

**Status:** completed and packaged successfully.

- Replaced the barcode-label print layout with the approved Sheimaa design: store name and divider at the top, a large centered barcode and human-readable code, then product name and bold retail price at the bottom.
- Barcode labels now use Code 128 generation for both supplier and internal barcodes. This is materially more space-efficient than the previous Code 39 renderer for long internal codes, while preserving separate quiet zones inside the label and at its physical edges.
- The recommended default for new terminals is now 50 × 30 mm. Existing saved printer media settings are preserved. The label settings screen previews the new composition and continues to offer all other supported media sizes.
- Product names of up to 40 characters use one line; longer names use two lines; exceptionally long names reduce only their own font size. The barcode, price, and required scan margins never share that space.
- Added `bwip-js` 4.11.4 (MIT) to render production Code 128 SVG barcodes locally in the Electron main process; no online service is used.
- `pnpm typecheck` — passed.
- `pnpm build` — passed.
- `pnpm exec playwright test` — passed: 14 of 14 Electron tests.
- `pnpm package:win` — passed: NSIS x64 installer generated.
- Installer: `apps/desktop/release/Nabta-POS-0.1.30-x64.exe`
- Size: 181,860,941 bytes; SHA-256: `D8C0B988B375A9E6FE3A65A1FD061D8C55997AB62F0A8D8418AE5598C22A1445`.

## Windows release 0.1.31 — 2026-10-13

**Status:** completed and packaged successfully.

- Fixed the hardware-settings checkbox display state after an asynchronous settings load. Automatic receipt printing and automatic cash-drawer opening now use controlled UI values, so they reflect the value actually saved for the cash register after reload.
- Fixed the hardware-save failure path: the screen no longer presents unsaved selections as saved; it restores the last confirmed settings when a local save fails.
- Added an Electron end-to-end persistence test that saves both branch settings checkboxes and device settings checkboxes, verifies the device settings JSON on disk, reloads the renderer, and confirms every saved checkbox remains selected.
- `pnpm typecheck` — passed.
- `pnpm exec playwright test` — passed: 15 of 15 Electron tests.
- `pnpm package:win` created the artifact before the shell watchdog expired; the NSIS installer and block map were then inspected directly.
- Installer: `apps/desktop/release/Nabta-POS-0.1.31-x64.exe`
- Size: 181,860,933 bytes; SHA-256: `69CC998D9CA128BD1234C14CFB33A4B695192D226251F960BCA67E9A854F1255`.

## Windows release 0.1.32 — 2026-10-13

**Status:** completed and packaged successfully.

- Refined the 50 × 30 mm Sheimaa label based on the physical print photo: increased the physical top, bottom, and side safe margins; moved the product details up from the lower edge; and added extra horizontal clearance around both the product name and price.
- Fixed Code 128 SVG rendering to use its assigned physical height instead of preserving its very wide natural aspect ratio. The barcode now prints taller and darker while retaining its safe width and quiet zones.
- Labels 25 mm high and below now use the compact safe layout automatically so their content cannot overlap the physical edge.
- `pnpm typecheck` — passed.
- `pnpm build` — passed.
- `pnpm exec playwright test` — passed: 15 of 15 Electron tests.
- `pnpm package:win` — passed: NSIS x64 installer generated.
- Installer: `apps/desktop/release/Nabta-POS-0.1.32-x64.exe`
- Size: 181,860,931 bytes; SHA-256: `E134B9A921ADBE9E1B3998793C8752038C13AD3FD36B382ECAD7ABB3877858D1`.

## Windows release 0.1.33 â€” 2026-10-13

**Status:** completed and packaged successfully.

- Added the exact 20 Ã— 10 mm XP-233B label size to the persisted hardware settings and settings-screen picker.
- Selecting 20 Ã— 10 mm automatically applies the dedicated micro-label layout. It uses one truncated product-name line and a compact numeric price line, giving the remaining printable height to the barcode and avoiding clipped lower content.
- The micro layout is restricted to 20 Ã— 10 mm; selecting another size restores a regular label layout. The settings screen warns that long product codes are close to the practical scan limit on 20 mm media and need a physical scan test.
- Added an Electron end-to-end persistence check that selects 20 Ã— 10 mm, confirms the micro layout is chosen automatically, verifies both values in `hardware-settings.json`, and confirms they remain selected after application reload.

### Verification performed

- `pnpm typecheck` â€” passed.
- `pnpm build` â€” passed.
- `pnpm exec playwright test` â€” passed: 15 of 15 Electron tests.
- `pnpm package:win` â€” completed successfully; final NSIS x64 installer and block map were verified directly.
- Installer: `apps/desktop/release/Nabta-POS-0.1.33-x64.exe`
- Size: 181,862,047 bytes; SHA-256: `93AC79A6857EE305CA20317AE197ECCA68A30F9E34B0A2A722C80E0ED2ED3702`.

## Windows release 0.1.34 â€” 2026-10-14

**Status:** completed and packaged successfully.

- Refined the standard 58 Ã— 30 mm shelf-label composition from a physical XP-233B print: enlarged and strengthened the product name and price, moved the lower details upward, and increased the barcode's physical side clearance.
- A valid numeric 13-digit barcode now prints as EAN-13 automatically. Alphanumeric or invalid supplier codes continue to use Code 128, so internal product codes remain supported.
- Changed the label test specimen from the very long `NABTA-TEST-001` Code 128 value to a valid EAN-13 test barcode. The physical test now represents the barcode format used by ordinary retail products.

### Verification performed

- `pnpm typecheck` â€” passed.
- `pnpm build` â€” passed.
- `pnpm exec playwright test` â€” passed: 15 of 15 Electron tests.
- `pnpm package:win` â€” completed successfully; final NSIS x64 installer and block map were verified directly.
- Installer: `apps/desktop/release/Nabta-POS-0.1.34-x64.exe`
- Size: 181,862,355 bytes; SHA-256: `015EA8B7881E46848FA90FB84207BF39DB618D53E1C3D1852B19B6C0C2096AF7`.

## Windows release 0.1.35 â€” 2026-10-14

**Status:** implemented; verification and packaging recorded below.

- Replaced the unsafe experimental 20 × 10, 24 × 14, and 30 × 20 label choices with a curated XP-233B retail-label catalog. The default and detected roll profile is now 58 × 30 mm.
- On saving hardware settings, Nabta synchronizes the selected profile into the installed `Xprinter XP-233B` Windows queue and reads the driver ticket back to verify the exact dimensions. The same guard runs before the first label print after a restart, preventing the driver from retaining a stale 3 × 4 inch stock.
- Verified against the connected `Xprinter XP-233B` on `USB004`: the driver now reports `58000 × 30000` microns for the 58 × 30 profile instead of `78700 × 101600` microns.
- Preserved 52 mm of safe content width on 58 mm media (the printer's official maximum print width is 56 mm), so the EAN-13 quiet zones and product details do not reach the physical edge.

### Verification performed

- `pnpm typecheck` — passed.
- `pnpm build` — passed.
- `pnpm exec playwright test` — passed: 15 of 15 Electron tests.
- Native Windows queue verification — passed on the connected `Xprinter XP-233B` / `USB004`: the selected driver ticket is `58000 × 30000` microns.
- `pnpm package:win` — NSIS x64 installer and block map generated successfully.
- Installer: `apps/desktop/release/Nabta-POS-0.1.35-x64.exe`
- Size: 181,865,809 bytes; SHA-256: `A2C132798A0E7C3F047B3854C9AEE06136BF4BA6CFB921DBB89055D6CC59EB5D`.
- The installer is not code-signed; Windows can show its normal publisher warning until a code-signing certificate is used.

## Windows release 0.1.36 — 2026-10-14

**Status:** completed and packaged successfully.

- Completed the local catalog materialization migration. Every product-reference barcode is now represented by an active sellable product with an independent stock balance, including products whose price is still zero. The catalog endpoint returns up to 3,500 matching products instead of the former small page limit.
- Imported and localized the 3,284-row supplied catalog into the local database, retaining the original barcode/reference information and descriptions where supplied. Existing product records are updated safely rather than duplicated. A backup was created before the import at `Documents/Nabta Backups/before-catalog-completion-2026-10-14.dump`.
- Added a protected full product editor to the selected product's context menu. Authorized owners/managers can change Arabic name, retail price, internal wholesale price, description, and available quantity. Quantity changes create an audited stock-count adjustment instead of silently overwriting stock.
- Barcode printing from both the products table and the selected-product context menu now opens a copy-count dialog (1–100) before printing.
- Added the `description` product field and migration `008_product_editor_and_catalog_completion.sql`; the packaged server runtime carries the migration for clean installations and upgrades.

### Verification performed

- `pnpm typecheck` — passed.
- `pnpm test:unit` — passed: 15 Node tests and 9 Vitest tests.
- `pnpm build` — passed.
- `pnpm exec playwright test` — passed: 15 of 15 Electron end-to-end tests, including product editing and label copy selection.
- `pnpm package:win` — passed: NSIS x64 installer and block map generated.
- Installer: `apps/desktop/release/Nabta-POS-0.1.36-x64.exe`
- Size: 181,867,781 bytes; SHA-256: `4B8F560D7533856B261583481462C5E6B377FBB8D6736F7F7E97C97456ED0725`.

## Windows release 0.1.37 — 2026-10-14

**Status:** completed and packaged successfully.

- Fixed the catalog-rendering bottleneck exposed by the 3,284-product catalog. Point of sale now renders a maximum of 60 product cards at a time, and the product-management table renders 100 rows at a time. Both screens provide explicit previous/next page controls while search, barcode lookup, quantities, pricing, and all product records remain intact.
- This prevents thousands of product-card DOM nodes and image requests from being created in one frame, which keeps first paint, screen navigation, and point-of-sale interaction responsive on normal Windows hardware.

### Verification performed

- `pnpm typecheck` — passed.
- `pnpm test:unit` — passed: 15 Node tests and 9 Vitest tests.
- `pnpm exec playwright test` — passed: 15 of 15 Electron end-to-end tests after the paging change.
- `pnpm package:win` — passed: NSIS x64 installer and block map generated.
- Installer: `apps/desktop/release/Nabta-POS-0.1.37-x64.exe`
- Size: 181,868,155 bytes; SHA-256: `3AD62C8FC9C3559F1CD0A47C1188541368115DFFEB949979BEFC604273E41C12`.

## Windows release 0.1.38 — 2026-10-14

**Status:** completed and packaged successfully.

- Rebalanced the product-management table for wide Arabic desktop screens. Product name is deliberately capped, long names use at most two lines, and the barcode, unit, public price, wholesale price, availability, status, and actions each have an assigned practical width.
- The action controls are compact and can wrap inside their own column, instead of expanding the full table. Horizontal scrolling is now only needed below the table's usable desktop width, not because a long product name claims most of the screen.
- Updated the product-editor end-to-end scenario to locate a product through the same quick search used by staff, so the regression test remains valid with paged tables.

### Verification performed

- `pnpm typecheck` — passed.
- `pnpm test:unit` — passed: 15 Node tests and 9 Vitest tests.
- `pnpm exec playwright test` — passed: 15 of 15 Electron end-to-end tests, including the no-horizontal-page-overflow check.
- `pnpm package:win` — passed: NSIS x64 installer and block map generated.
- Installer: `apps/desktop/release/Nabta-POS-0.1.38-x64.exe`
- Size: 181,868,460 bytes; SHA-256: `00D7F73BE27DFB33DED4F8638856A90732988178A161071BA829A07EB4BC13F5`.

## Egyptian grocery catalog expansion — 2026-10-15

**Status:** completed in the active local Nabta database.

- Added 1,715 verified retail products from the public Egypt Products Barcode Database complete list, bringing the active sellable catalog from 3,285 to exactly 5,000 products.
- Existing barcodes were preserved and skipped. Every new product has a verified 8-, 12-, or 13-digit GTIN/EAN-style barcode, a product record, and a zero-quantity balance in the default warehouse.
- Prices and wholesale prices were deliberately left at zero for the newly added reference products. This avoids inventing commercial prices; they are ready for staff to set through the product editor or import workflow.
- Created the pre-import restore point: `C:\Users\ahmed\Documents\Nabta Backups\before-egyptproducts-catalog-2026-10-15-024754.dump`.
- Added the repeatable importer: `scripts/import-egyptproducts-catalog.mjs`. It validates check digits, excludes existing barcodes, retries transient source timeouts, and creates a backup before writing.

### Verification performed

- `node --check scripts/import-egyptproducts-catalog.mjs` — passed.
- Direct database integrity check — passed: 5,000 active products, 5,000 distinct barcodes, 0 malformed barcodes, and 0 active products without a default-warehouse stock balance.

## Windows release 0.1.39 — 2026-10-15

**Status:** packaged successfully.

- Published the installer build after the catalog-import tooling and the local 5,000-product catalog update.
- Updating on this computer preserves its local catalog. On a different computer, install the application, then restore the catalog backup from the Settings > Backups page to transfer the same 5,000 products.

### Verification performed

- `pnpm package:win` — passed.
- Installer and accompanying block-map file were verified directly.
- Installer: `apps/desktop/release/Nabta-POS-0.1.39-x64.exe`
- Size: 181,868,477 bytes; SHA-256: `1B2184896EA39A116BE536216D1CF375B58455D83181509A27A2E6F0DF300013`.

## Egyptian grocery catalog completion — 2026-10-15

**Status:** completed in the active local Nabta database.

- Reviewed the shopper-facing grocery groups requested by the owner: oils, sugar, drinks and juices, chocolate, chips, biscuits, cheese, and pasta.
- Expanded the verified Egyptian barcode catalog from 5,000 to 6,770 active products. The importer first selected grocery-priority terms, then imported the remaining verified items available in the same source, rather than creating guessed barcodes.
- Created restore points before both phases. The final pre-import backup is `C:\Users\ahmed\Documents\Nabta Backups\before-full-egypt-catalog-2026-10-15-034504.dump`.

### Verification performed

- `node --check scripts/import-egyptproducts-catalog.mjs` — passed.
- `pnpm typecheck` — passed.
- Direct database integrity check — passed: 6,770 active products, 6,770 distinct barcodes, and zero active products missing a default-warehouse stock balance.

## Estimated retail-price initialization — 2026-10-15

**Status:** completed in the active local Nabta database; requires owner review before operational use.

- Kept all existing non-zero retail prices unchanged and did not invent wholesale prices.
- Added an initial retail estimate to 6,226 previously zero-priced products. Estimates use product-name and product-category rules plus package-size tiers for oil, sugar, water, juice, soft drinks, pasta, cheese, chocolate, chips, biscuits, dairy, household items, personal care, and spices.
- Every affected item has the Arabic description marker `سعر بيع تقديري مبدئي — راجعه قبل البيع`, so it is distinguishable from an owner-entered price.
- Refined the classifier after a sample review: product descriptions are no longer used for type detection, preventing incidental text such as a cutting-board description mentioning cheese from setting a cheese price.
- Created restore points before both passes; the final pre-refinement backup is `C:\Users\ahmed\Documents\Nabta Backups\before-refined-estimated-prices-2026-10-15-041334.dump`.

### Verification performed

- `node --check scripts/apply-estimated-retail-prices.mjs` — passed.
- `pnpm typecheck` — passed.
- Direct database check — passed: 6,770 active products, 0 zero-priced active products, and 6,226 products marked as estimated.
## تكامل الفواتير والتحقق الشامل — 2026-10-15

**الحالة:** مكتمل ومُجمّع بنجاح.

- أُصلح ظهور رسالة `البيانات المرسلة غير صالحة` في صفحة الفواتير. جسر تطبيق سطح المكتب يرسل `limit` داخل الرابط كنص، وأصبح عقد الخادم يحوّل القيمة بأمان إلى عدد صحيح ضمن الحدود المسموح بها.
- أُضيف اختبار تكاملي لمسار `/v1/invoices?kind=ALL&limit=300` واختبار Electron يفتح صفحة الفواتير من خلال الجسر نفسه ويتأكد من عدم ظهور رسالة الخطأ.
- حفظ إعدادات الأجهزة لم يعد ينتظر بطء إيقاظ تعريف أو طابور Xprinter؛ تُحفظ الإعدادات فورًا، بينما تستمر مطابقة مقاس الملصق والتحقق منه تلقائيًا قبل كل عملية طباعة ملصق.
- أُعيد اختبار تدفقات الصفحات: البيع والدفع، الكميات الموزونة، البحث وتعديل الأصناف، استلام الكميات وقائمة النواقص، الموردون والعملاء، الإيصالات والفواتير، حفظ الإعدادات، النسخ الاحتياطي، التقارير، وعدم وجود تجاوز أفقي في واجهة العربية RTL.

### التحقق المنفذ

- `pnpm typecheck` — ناجح.
- `pnpm test:unit` — ناجح: 15 اختبارًا ماليًا/منطقيًا و9 اختبارات Vitest.
- `pnpm test:integration` — ناجح: 13 اختبارًا؛ 8 حالات خاصة بـ PostgreSQL متخطاة في التشغيل المضمن.
- `pnpm test:e2e` — ناجح: 16 من 16 اختبار Electron شامل.
- `pnpm --filter @nabta/desktop exec electron-builder --win dir --x64 --publish never` — ناجح بعد عزل مجلد إخراج قديم من بناء متوقف.
- `pnpm --filter @nabta/desktop exec electron-builder --win nsis --x64 --publish never` — ناجح: تكوّن مثبّت NSIS x64 وملف block map.
- المثبّت: `apps/desktop/release/Nabta-POS-0.1.40-x64.exe`
- الحجم: 181,868,505 بايت؛ SHA-256: `18A81BB5CB42DE853F8AB3E2F733C92C0A341660AB7C7FC79B06640C513CD1B5`.
## إصلاح اختفاء الأصناف بعد مسح الباركود — 2026-10-15

**الحالة:** مكتمل ومُجمّع بنجاح.

- فُصل بحث الباركود غير الموجود في الذاكرة عن تحديث الكتالوج المعروض. نتيجة البحث الدقيقة تُستخدم لإضافة الصنف إلى السلة فقط، ولا تستبدل بعد ذلك قائمة الأصناف في نقطة البيع أو صفحة الأصناف.
- أُلغي حد الكتالوج السابق البالغ 3,500 صنف في مسار الخادم، واستُبدل بحد محلي آمن قدره 10,000 صنف. تظل الواجهة خفيفة لأنها تعرض 60 بطاقة فقط في صفحة نقطة البيع و100 صف في صفحة الأصناف في كل مرة.
- أُضيف اختبار Electron ينشئ صنفًا على الخادم بعد تحميل الواجهة، ثم يمسح باركوده ويتأكد أن جميع بطاقات الكتالوج السابقة تظل ظاهرة.

### التحقق المنفذ

- `pnpm typecheck` — ناجح.
- `pnpm test:integration` — ناجح: 13 اختبارًا؛ 8 حالات PostgreSQL متخطاة في التشغيل المضمن.
- `pnpm test:e2e` — ناجح: 17 من 17 اختبار Electron شامل، بما فيه اختبار عدم اختفاء الكتالوج بعد المسح.
- `pnpm package:win` — ناجح: تكوّن مثبّت NSIS x64 وملف block map.
- المثبّت: `apps/desktop/release/Nabta-POS-0.1.41-x64.exe`
- الحجم: 181,868,802 بايت؛ SHA-256: `1FE1AA43A036AD4EEF01B3C19BD5433684674117158F8514AA40FF819611C93E`.
## الوضع النهاري — 2026-10-15

**الحالة:** مكتمل ومختبر.

- أضيف زر واضح للتبديل بين الوضع النهاري والليلي في شاشة تسجيل الدخول وفي الشريط العلوي داخل البرنامج.
- يحفظ البرنامج اختيار المظهر محليًا ويطبقه فورًا عند إعادة فتح الواجهة أو إعادة تحميلها.
- الوضع النهاري يستخدم ألوانًا دلالية موحّدة للصفحات والجداول والحقول والنوافذ المنبثقة، مع تباين مناسب للنصوص والحالات والتنبيهات.
- أضيف اختبار Electron يتأكد من حفظ الوضع النهاري بعد إعادة تحميل نافذة البرنامج.

### التحقق المنفذ

- `pnpm typecheck` — ناجح.
- `pnpm test:e2e` — ناجح: 18 من 18 اختبار Electron شامل، بما فيها اختبار حفظ الوضع النهاري.
- `pnpm package:win` — ناجح: تم إنشاء مثبت NSIS x64 للإصدار 0.1.42.
- المثبت: `apps/desktop/release/Nabta-POS-0.1.42-x64.exe`.
- الحجم: 181,869,087 بايت؛ SHA-256: `E56DA36840AF2B1F5BA508590D475A77E9AAF6C49675DE4F51A69CF7AD0047A9`.
## منع تكرار أوامر الطباعة — 2026-10-16

**الحالة:** مكتمل ومُجمّع في الإصدار 0.1.45.

- أضيف قفل فوري في نافذة الدفع يمنع تكرار إرسال عملية البيع قبل أن تعيد الواجهة رسم الزر المعطّل.
- أضيفت قائمة انتظار مستقلة لكل طابعة في عملية سطح المكتب، مع دمج الطلبات المتطابقة أثناء التنفيذ. لذلك لا يمكن للضغط المتكرر على طباعة نفس الإيصال أو الملصق إنشاء أكثر من مهمة واحدة في قائمة انتظار ويندوز.
- طُبّقت الحماية على إيصالات البيع وملصقات الباركود وفواتير التوريد وقائمة الشراء والتقارير المطبوعة.
- أضيف حد انتظار 30 ثانية لاستدعاء برنامج تشغيل الطابعة. عند تجاوز المهلة تظهر رسالة واضحة ولا يعيد البرنامج المحاولة تلقائياً، لتفادي طباعة نسخ إضافية.
- تعرض الأزرار أثناء التنفيذ حالة «جارٍ إصدار الفاتورة» أو «جارٍ إرسال الطباعة» وتبقى الواجهة قابلة للاستخدام.

### التحقق المنفذ

- `pnpm --filter @nabta/desktop typecheck` — ناجح.
- `pnpm build` — ناجح.
- `pnpm test:e2e` — ناجح: 19 من 19 اختبار Electron شامل.
- `pnpm package:win` — ناجح.
- المثبت: `apps/desktop/release/Nabta-POS-0.1.45-x64.exe`.
- الحجم: 182,149,260 بايت؛ SHA-256: `3D43F56EAE1451AF2DE183F4D9F49B3020C5ED3CB76A784D6DB84495F6B29BAC`.
## GitHub Releases والتحديث التلقائي — 2026-10-16

**الحالة:** مكتمل ومتحقق منه بإصدار Windows عام `v0.1.50`.

- رُفع المصدر إلى المستودع `nopoh28102/Nabta-POS` على الفرع `main`، مع استبعاد قواعد البيانات والنسخ المحلية وبيانات المستخدم من Git.
- أُضيف مسار GitHub Actions يبني نسخة Windows عند كل وسم إصدار بصيغة `v*`، وينشر المثبّت وبيانات التحديث في GitHub Releases.
- صار تطبيق سطح المكتب، عند تشغيل نسخة مثبّتة، يتحقق من وجود تحديث بعد 15 ثانية ويطلب موافقة المستخدم قبل تنزيله أو إعادة التشغيل لتثبيته.
- صُححت عملية التغليف لتبني كتالوج المنتجات والخادم المضمّن محليًا في كل بناء، فلا تعتمد على ملفات قديمة موجودة على جهاز المطوّر.

### التحقق المنفذ

- `pnpm typecheck` — ناجح.
- `pnpm --filter @nabta/desktop build` — ناجح.
- GitHub Actions run `38847484340` — ناجح.
- GitHub Release `v0.1.50` — منشور ويحتوي `Nabta-POS-0.1.50-x64.exe` و`latest.yml`.
- ملاحظة: توقيع كود Windows غير مضاف بعد؛ قد يعرض Windows SmartScreen تحذيرًا عند أول تثبيت.
