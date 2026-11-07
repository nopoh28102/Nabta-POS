import { chromium } from "@playwright/test";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const root = process.cwd();
const pngDataUrl = (imagePath) => `data:image/png;base64,${readFileSync(imagePath).toString("base64")}`;
const userSettingsImage = pngDataUrl(resolve("C:/Users/ahmed/AppData/Local/Temp/codex-clipboard-3882665d-6aa2-4cce-93e9-ad9ab9ead721.png"));
const terminalImage = pngDataUrl(resolve("C:/Users/ahmed/AppData/Local/Temp/codex-clipboard-9b754637-3254-46be-8d9e-81a47ee2ed4b.png"));
const kashierImage = "https://raw.githubusercontent.com/Kashier-payments/Kashier-Odoo-15-Payment-Add-on/main/steps/apikey_mid_test.png";
const cloudflareImage = "https://isaacfei.com/_astro/cloudflare-worker-set-secrets.C23WVDfJ_Z1KTpiu.webp";

const html = String.raw`<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>دليل تفعيل Kashier</title>
<style>
@page { size: A4; margin: 14mm; }
* { box-sizing: border-box; } body { font-family: "Segoe UI", Tahoma, Arial, sans-serif; color:#152534; line-height:1.65; font-size:12.2px; }
h1 { color:#047857; font-size:27px; margin:0 0 6px; } h2 { color:#075985; font-size:19px; border-bottom:2px solid #99f6e4; padding-bottom:5px; margin-top:18px; } h3 { color:#0f766e; font-size:15px; margin:11px 0 4px; }
.subtitle { color:#475569; font-size:14px; margin-bottom:20px; }.box { border:1px solid #cbd5e1; border-radius:10px; padding:12px 14px; margin:10px 0; background:#fff; }.warn { background:#fff7ed; border-color:#fdba74; }.ok { background:#ecfdf5; border-color:#6ee7b7; }.danger { background:#fef2f2; border-color:#fca5a5; }
.step { display:grid; grid-template-columns:32px 1fr; gap:8px; align-items:start; margin:11px 0; }.num { background:#059669; color:#fff; width:27px; height:27px; border-radius:50%; text-align:center; font-weight:700; padding-top:2px; }
code { direction:ltr; unicode-bidi:embed; background:#f1f5f9; color:#0f172a; padding:2px 5px; border-radius:4px; font-size:10.5px; word-break:break-all; }
img { max-width:100%; border:1px solid #cbd5e1; border-radius:8px; margin:8px 0; }.caption { color:#475569; font-size:10.5px; margin-top:-3px; }.page { break-before:page; }.grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; }.field { border:1px solid #dbeafe; border-radius:8px; padding:8px; }.field b { color:#075985; }.footer { color:#64748b; font-size:9px; border-top:1px solid #cbd5e1; padding-top:6px; margin-top:18px; }
ul { margin:5px 0 5px; } .small {font-size:10.7px; }
</style></head><body>
<h1>دليل تفعيل بوابة Kashier في Nabta POS</h1>
<div class="subtitle">نسخة عملية مصوّرة — ابدأ ببيئة TEST ثم انتقل إلى LIVE بعد نجاح الاختبار.</div>
<div class="box danger"><b>قاعدة أمان:</b> لا ترسل أي مفتاح في واتساب أو بريد أو GitHub. أدخله بنفسك في لوحة Kashier أو Cloudflare أو Nabta فقط.</div>

<h2>1. خريطة الحقول الموجودة في Nabta</h2>
<img src="${userSettingsImage}" alt="Nabta payment settings screenshot"><div class="caption">صورة حقيقية من تبويب بوابة الدفع في برنامجك.</div>
<div class="grid">
<div class="field"><b>Merchant ID</b><br>من لوحة Kashier؛ يظهر غالباً بصيغة <code>MID-...</code>.</div>
<div class="field"><b>Kashier Secret Key</b><br>من بيانات التكامل التي يصدرها Kashier لحسابك. لا تضعه في Cloudflare.</div>
<div class="field"><b>Kashier API Key</b><br>مفتاح طلبات API. أنشئه/انسخه من لوحة Kashier أو اطلبه من دعم Kashier إذا لم يظهر.</div>
<div class="field"><b>Payment API Key للتوقيع</b><br>مفتاح التوقيع الخاص بالـWebhook. يوجد في قسم Payment API Keys.</div>
<div class="field"><b>Webhook URL</b><br>انسخ رابط Worker TEST أو LIVE أدناه حسب البيئة.</div>
<div class="field"><b>Merchant Redirect URL</b><br>رابط HTTPS عام تملكه يعيد العميل إليه بعد صفحة Kashier المستضافة؛ ليس رابطاً محلياً ولا <code>localhost</code>.</div>
<div class="field"><b>Cloudflare Event Relay URL</b><br>انسخ رابط Worker الأساسي فقط، من دون <code>/kashier/TEST</code> أو <code>/kashier/LIVE</code>.</div>
<div class="field"><b>Cloudflare Relay Bearer Token</b><br>قيمة عشوائية تنشئها أنت وتضع النسخة نفسها في Cloudflare وNabta.</div>
</div>

<h2>2. من أين تحصل على Merchant ID وPayment API Key</h2>
<div class="step"><span class="num">1</span><div>افتح <code>https://merchant.kashier.io</code> وسجّل الدخول أو أنشئ حساب تاجر.</div></div>
<div class="step"><span class="num">2</span><div>في وضع الاختبار TEST: افتح <b>Integrate now → Payment API Keys</b>.</div></div>
<div class="step"><span class="num">3</span><div>اضغط <b>Generate API</b>، اكتب اسماً واضحاً مثل <code>Nabta-POS-TEST</code>، ثم انسخ المفتاح فور ظهوره إلى حقل <b>Payment API Key</b> في Nabta.</div></div>
<div class="step"><span class="num">4</span><div>انسخ Merchant ID الظاهر تحت اسم الحساب، مثل <code>MID-xx-xx</code>، وضعه في حقل <b>Merchant ID</b>.</div></div>
<img src="${kashierImage}" alt="Kashier payment API keys screenshot"><div class="caption">صورة حقيقية من الإضافة الرسمية لـKashier: قسم Payment API Keys وزر Generate API.</div>
<div class="box warn"><b>Secret Key وAPI Key:</b> تختلف تسميتهما ومكانهما حسب نوع عقد Kashier (POS أو Payment Sessions). ابحث عنهما في بيانات التكامل/قناة التاجر، وإذا لم يظهرا افتح تذكرة لدعم Kashier واطلب تحديداً: <i>TEST Secret Key وTEST API Key لتكامل Nabta POS</i>.</div>

<h2>3. إعداد Cloudflare مرة واحدة</h2>
<div class="step"><span class="num">1</span><div>Cloudflare → <b>Workers & Pages</b> → <b>nabta-kashier-webhook-relay</b> → <b>Settings</b> → <b>Variables and Secrets</b>.</div></div>
<div class="step"><span class="num">2</span><div>اختر <b>Add variable</b> ثم النوع <b>Secret</b> لكل قيمة؛ لا تستخدم Text variable للمفاتيح.</div></div>
<img src="${cloudflareImage}" alt="Cloudflare variables and secrets screenshot"><div class="caption">صورة حقيقية لواجهة Workers: Variables and Secrets مع نافذة إضافة Secret.</div>
<div class="box ok"><b>أضف هذه الأسرار:</b><ul><li><code>KASHIER_TEST_PAYMENT_API_KEY</code> = نفس Payment API Key للاختبار من Kashier.</li><li><code>KASHIER_LIVE_PAYMENT_API_KEY</code> = لا تضفه إلا عند تفعيل LIVE.</li><li><code>RELAY_BEARER_TOKEN</code> = رمز عشوائي قوي بطول 32 حرفاً فأكثر.</li></ul></div>
<div class="box"><b>Webhook للاختبار:</b><br><code>https://nabta-kashier-webhook-relay.mahmoudnabih989.workers.dev/kashier/TEST</code><br><b>Webhook لـLIVE لاحقاً:</b><br><code>https://nabta-kashier-webhook-relay.mahmoudnabih989.workers.dev/kashier/LIVE</code><br><b>رابط Event Relay في Nabta (لبيئتي TEST وLIVE):</b><br><code>https://nabta-kashier-webhook-relay.mahmoudnabih989.workers.dev</code></div>

<div class="page"></div><h2>4. إدخال القيم في Nabta</h2>
<div class="step"><span class="num">1</span><div>سجّل الدخول بمالك النظام، ثم: <b>الإعدادات → المدفوعات والتكاملات → وضع الاختبار TEST</b>.</div></div>
<div class="step"><span class="num">2</span><div>أدخل Merchant ID وSecret Key وAPI Key وPayment API Key الخاصة بـTEST.</div></div>
<div class="step"><span class="num">3</span><div>ضع رابط Webhook TEST في حقل <b>Webhook URL</b>، ثم ضع رابط Worker الأساسي فقط في حقل <b>Cloudflare Event Relay URL</b>.</div></div>
<div class="step"><span class="num">4</span><div>ضع قيمة <code>RELAY_BEARER_TOKEN</code> نفسها في حقل <b>Cloudflare Relay Bearer Token</b>.</div></div>
<div class="step"><span class="num">5</span><div>ضع Merchant Redirect URL عاماً عبر HTTPS إذا كنت ستستخدم صفحة الدفع المستضافة. لا يلزم لماكينة Kashier POS فقط.</div></div>
<div class="step"><span class="num">6</span><div>فعّل الوسائل التي أكد Kashier أنها متاحة لحساب TEST فقط، ثم أدخل كلمة مرور المالك واضغط حفظ.</div></div>

<h2>5. ربط ماكينة Kashier</h2>
<img src="${terminalImage}" alt="Nabta Kashier terminal binding screenshot"><div class="caption">صورة حقيقية من قسم ربط ماكينة Kashier في Nabta.</div>
<div class="step"><span class="num">1</span><div><b>Serial Number للماكينة:</b> انسخه من ملصق الجهاز، قائمة معلومات الجهاز، أو من لوحة Kashier؛ لا تخمّنه.</div></div>
<div class="step"><span class="num">2</span><div><b>معرّف نقطة البيع في Nabta:</b> هو UUID الخاص بالطرف/نقطة البيع؛ اختره من بيانات نقطة البيع في البرنامج أو انسخه من إعدادها.</div></div>
<div class="step"><span class="num">3</span><div>اترك خيار «الماكينة نشطة» مفعلاً واضغط حفظ الربط. اربط كل ماكينة بنقطة البيع الصحيحة فقط.</div></div>

<h2>6. الاختبار ثم LIVE</h2>
<div class="box"><b>اختبار TEST الإلزامي:</b><ol><li>اضغط اختبار الاتصال.</li><li>افتح وردية وأنشئ فاتورة صغيرة.</li><li>اختر Kashier POS وأتمم دفع TEST.</li><li>تحقق أن الفاتورة لا تسجل قبل نجاح <code>SUCCEEDED</code>.</li><li>اضغط «مراجعة وتسوية المعلّق» وتأكد من وصول الحدث.</li><li>اختبر فشل دفع؛ يجب ألا يتأثر المخزون أو تنشأ فاتورة.</li></ol></div>
<div class="box warn"><b>التحول إلى LIVE:</b> كرر نفس الخطوات بمفاتيح LIVE، وأضف Secret LIVE في Cloudflare، وضع رابط LIVE في لوحة Kashier، ثم نفّذ عملية صغيرة حقيقية بموافقة الإدارة.</div>
<div class="box danger"><b>لا تفعل InstaPay أو Payment Link لمجرد ظهور اسمهما.</b> فعّلهما فقط بعد تأكيد Kashier كتابياً أنهما مفعّلان لحسابك وتوفير بيانات التكامل اللازمة.</div>
<div class="footer">المصادر: أمثلة Kashier الرسمية على GitHub، واجهة Nabta الحالية، وCloudflare Workers. أُعد هذا الدليل ليكون قابلاً للطباعة دون كشف مفاتيحك.</div>
</body></html>`;

const installedChrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const browser = await chromium.launch({
  headless: true,
  ...(existsSync(installedChrome) ? { executablePath: installedChrome } : {})
});
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: "networkidle" });
await page.pdf({ path: resolve(root, "docs/KASHIER-CLOUDFLARE-VISUAL-GUIDE-AR.pdf"), format: "A4", printBackground: true, margin: { top: "12mm", right: "12mm", bottom: "12mm", left: "12mm" } });
await browser.close();
