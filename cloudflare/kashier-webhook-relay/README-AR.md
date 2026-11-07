# مرحّل أحداث Kashier على Cloudflare Workers

## المورد المنشأ

- Worker: `nabta-kashier-webhook-relay`
- D1: `nabta-kashier-events` (EEUR)
- رابط TEST: `https://nabta-kashier-webhook-relay.mahmoudnabih989.workers.dev/kashier/TEST`
- رابط LIVE: `https://nabta-kashier-webhook-relay.mahmoudnabih989.workers.dev/kashier/LIVE`

نُشرت البنية دون أسرار عمداً؛ لذلك سترفض حالياً أي webhook بتوقيع غير قابل للتحقق حتى تُضاف الأسرار أدناه.

هذه وحدة مستقلة لحفظ webhooks Kashier الموقعة في D1 أثناء انقطاع جهاز الكاشير المحلي. لا تستقبل أي مفاتيح Nabta ولا تنشئ بيعاً أو حركة مخزون.

1. أنشئ قاعدة D1 ثم ضع معرّفها في `wrangler.toml`.
2. نفّذ ترحيل D1: `wrangler d1 migrations apply nabta-kashier-events --remote`.
3. أضف أسرار Worker: `KASHIER_TEST_PAYMENT_API_KEY` و`KASHIER_LIVE_PAYMENT_API_KEY` و`RELAY_BEARER_TOKEN`.
4. انشر الـWorker، ثم سجّل `https://<worker>/kashier/TEST` أو `https://<worker>/kashier/LIVE` كـWebhook في إعداد Kashier المقابل.

الاستقبال يعيد `200` للحدث الجديد و`409` للمكرر بعد التحقق من توقيع HMAC-SHA256 وفق حقول `signatureKeys`. قناة قراءة الأحداث `/events` محمية بـBearer token ولا تُعرض للمتصفح. في Nabta، احفظ رابط ingress في حقل `Cloudflare Event Relay URL` واحفظ نفس `RELAY_BEARER_TOKEN` في حقل `Cloudflare Relay Bearer Token`؛ زر المراجعة يسحب الأحداث ويعيد التحقق من التوقيع قبل اعتمادها.

> لا تنشر هذا الملف مع قيمة `database_id` الافتراضية. لا تُدخل مفاتيح Kashier في المستودع أو في متغيرات عامة للعميل.
