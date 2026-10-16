# سياسة الخصوصية | Nabta POS Privacy Policy

**آخر تحديث / Last updated:** 16 October 2026

[العربية](#العربية) · [English](#english)

---

## العربية

### 1. من نحن ونطاق السياسة

**نبتة (Nabta POS)** تطبيق نقاط بيع مفتوح المصدر لأجهزة Windows، مخصص لإدارة المبيعات والمخزون والعملاء والموردين في الأنشطة التجارية. هذه السياسة تصف طريقة تعامل **التطبيق المنشور في هذا المستودع** مع البيانات، وليس أي خدمة خارجية يربطها المستخدم بنفسه.

- **المشروع والمصدر:** https://github.com/nopoh28102/Nabta-POS
- **الإصدارات الرسمية:** https://github.com/nopoh28102/Nabta-POS/releases
- **الترخيص:** MIT
- **التواصل بشأن الخصوصية:** [إنشاء طلب خاص بالخصوصية عبر مستودع GitHub](https://github.com/nopoh28102/Nabta-POS/issues/new) — **لا تنشر بيانات عملائك أو كلمات مرورك أو معلومات حساسة في طلب عام.** ابدأ بوصف عام فقط، واطلب وسيلة تواصل خاصة عند الحاجة.

### 2. البيانات التي يعالجها البرنامج

بحسب المزايا المستخدمة، قد يسجل البرنامج معلومات عن المنتجات والأسعار والباركود والمخزون، وعمليات البيع والمرتجعات والمشتريات والفواتير والدفعات، وحسابات الموظفين وصلاحياتهم وسجلات العمليات، وأسماء العملاء والموردين وأرقام هواتفهم وأرصدة الحسابات إن أدخلها مستخدم المتجر، وإعدادات الأجهزة والطابعات والنسخ الاحتياطية.

**صاحب المتجر الذي يُدخل هذه المعلومات مسؤول عن وجود أساس مناسب لجمعها والتعامل معها** وعن منح مستخدمي النظام الصلاحيات المناسبة.

### 3. أين تُخزّن البيانات؟

الوضع المكتبي الافتراضي يستخدم خادمًا مدمجًا على الجهاز نفسه عبر عنوان الحلقة المحلية `127.0.0.1`، مع قاعدة بيانات تشغيلية محلية. تُنشأ النسخ الاحتياطية في مسار محلي قابل للإدارة، وقد يختار المستخدم نقلها إلى مساحة أخرى.

لا يتطلب الاستخدام المحلي الاعتيادي إرسال سجلات المبيعات والعملاء تلقائيًا إلى خادم سحابي يديره مشروع Nabta POS. **لكن هذا لا يعني أن التطبيق يعمل دائمًا دون أي اتصال خارجي**: فالتحديثات والروابط والخدمات الاختيارية والأجهزة المتصلة قد تستخدم الشبكة. كما يمكن لإعدادات نشر الخادم المنفصلة تغيير مكان حفظ البيانات ومسؤولية إدارتها.

### 4. تحديثات التطبيق والجهات الخارجية

يفحص تطبيق Windows المعبأ توفر إصدارات أحدث من **GitHub Releases**. لا يبدأ تنزيل التحديث وتثبيته تلقائيًا دون اختيار المستخدم من الرسائل المعروضة. يؤدي الاتصال بـ GitHub عادةً إلى وصول معلومات اتصال أساسية مثل عنوان IP إلى GitHub، وفقًا [لسياسة خصوصية GitHub](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).

قد تتواصل وظائف الأجهزة الاختيارية (قارئات الباركود أو الطابعات) مع التعريفات والأجهزة التي جهزها صاحب المتجر. وقد تنطبق سياسات مستقلة على أي خدمة خارجية يضيفها المستخدم. **لا نطلب من المستخدمين رفع قاعدة بيانات متاجرهم إلى GitHub أو SignPath من أجل التحديث أو التوقيع الرقمي.**

### 5. النسخ الاحتياطية وفترات الاحتفاظ

يدعم البرنامج نسخًا احتياطية يدوية وآلية. في الإعدادات الحالية، الفترة الافتراضية للنسخ الآلي **كل 3 أيام**، مع الاحتفاظ بالنسخ الآلية لمدة افتراضية قدرها **30 يومًا** إذا كانت الميزة مفعّلة ومسار النسخ معدًا بصورة صحيحة. قد تختلف الإعدادات بحسب النشر والتعديلات. لا تُحذف النسخ اليدوية تلقائيًا بنفس سياسة النسخ الآلية.

تبقى السجلات التشغيلية عمومًا في قاعدة بيانات المتجر حتى يحذفها المستخدم عبر وظائف الإدارة المناسبة أو يزيل ملفات البيانات وفقًا لسياسات الاحتفاظ القانونية والمحاسبية السارية. **إزالة البرنامج لا تعني بالضرورة إزالة قواعد البيانات أو النسخ الاحتياطية.**

### 6. الحماية والمسؤولية

يستخدم البرنامج آليات لحسابات الموظفين والصلاحيات ويحتفظ بسجلات عمليات، لكن لا توجد برمجية تضمن حماية مطلقة. ننصح بتأمين جهاز Windows، وتحديث التطبيق، وتقييد الوصول إلى ملفات قاعدة البيانات والنسخ، وتأمين الشبكة المحلية عند تفعيل أي خدمة متصلة بها. لا تشارك النسخ الاحتياطية التي تحتوي على بيانات شخصية علنًا.

### 7. الوصول والتعديل والحذف

يمكن لصاحب المتجر استخدام وظائف التطبيق الملائمة لإدارة البيانات وتصحيحها وتصديرها وحذف ما تسمح به وظائف النظام، مع مراعاة سجلات المعاملات التي قد يلزم الاحتفاظ بها لأسباب محاسبية أو قانونية. فيما يتعلق بالبيانات المحفوظة على جهاز المتجر، يجب توجيه الطلبات أولًا إلى المسؤول عن ذلك الجهاز أو النشاط التجاري، لأن مطوري المشروع لا يمتلكون بالضرورة نسخة منها.

### 8. التغييرات على السياسة

قد تُحدّث هذه السياسة عند تغيير مزايا التطبيق أو تكاملاته. يُعلن تاريخ التحديث في أعلى الصفحة، ويمكن مراجعة تاريخ التعديلات عبر GitHub. للاطلاع على الكود الحالي، راجع المستودع أعلاه.

---

## English

### 1. Scope and contact

**Nabta POS** is an open-source Windows point-of-sale application for retail businesses. This policy describes the software in the linked repository, not unrelated services configured by users.

- **Source:** https://github.com/nopoh28102/Nabta-POS
- **Releases:** https://github.com/nopoh28102/Nabta-POS/releases
- **License:** MIT
- **Privacy inquiries:** [GitHub issue tracker](https://github.com/nopoh28102/Nabta-POS/issues/new). **Do not post customer records, credentials, or other sensitive information in a public issue.** Submit a general description first and request a private contact method if required.

### 2. Information processed

Depending on enabled features, the application may process product and barcode details, inventory, sales, purchases, returns, invoices, payments, staff account and access information, audit records, customer and supplier names and phone numbers, balances, device settings, and backup records.

Store operators are responsible for their lawful collection and handling of the personal information they enter and for appropriate user permissions.

### 3. Storage and network operation

In its standard packaged desktop mode, Nabta POS communicates with an embedded server on the same device through `127.0.0.1` and stores operational information in a local database. Backups are written to configured local or user-selected destinations.

Normal local operation does not require automatically uploading store sales or customer records to a central cloud service operated by the Nabta POS project. This **does not mean the software never accesses the internet or local network**: update checks, optional integrations, external links, and connected devices may use network connectivity. Alternative server deployments can change where data is stored and who manages it.

### 4. Updates and third-party services

Packaged Windows builds check the public **GitHub Releases** feed for updates. Downloading and installing a discovered update require user action in the application's prompts. GitHub may receive ordinary network connection data, such as IP addresses, under its [privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).

Optional device functionality may interact with scanner, printer, and driver software selected by the operator. Third-party services independently configured by users may apply their own privacy terms. Using GitHub-based updates or code signing does **not** require uploading a store's operational database to GitHub or SignPath.

### 5. Retention and backups

The current application supports manual and automatic backups. Where configured and enabled, the current default automatic schedule is **every 3 days**, with a **30-day automatic-backup retention** setting. Deployments or future versions may differ. Manual backups are not subject to the same automatic deletion policy.

Operational records generally remain on the store's own system until managed through relevant application functions or deleted in accordance with applicable bookkeeping and legal obligations. **Uninstalling the app does not necessarily delete its databases and backups.**

### 6. Security and user rights

The project includes staff permissions and operation auditing, but no software offers absolute security. Operators should protect their Windows devices, update the app, restrict database and backup access, and secure optional local-network services. Do not disclose databases or backups publicly.

Store operators control locally stored records and should respond to relevant access, correction, or deletion requests as applicable. Project maintainers do not necessarily possess copies of those records.

### 7. Changes

This notice may change if the software or integrations change. The revision date appears at the top, and prior revisions are available in the repository's Git history.
