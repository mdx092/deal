# Deals48 Telegram Bot (AliExpress Official API) + 4-Product Collage

بوت تلغرام بـ Node.js يستخدم **AliExpress Official Affiliate API** (method: `aliexpress.affiliate.product.query`)
ويُرسل:
- صورة كولاج 4 منتجات (2×2) مع أرقام 1–4
- كابتشن عربي فيه: السعر بالشيكل ₪ + المبيعات + التقييم + رابط أفلييت
- فلترة: **أفضل 4 منتجات حسب أعلى المبيعات/الطلبات**

## تشغيل محلي (اختياري)
1) انسخ `.env.example` إلى `.env` وضع القيم
2) ثبّت وشغّل:
```bash
npm install
npm start
```

> ملاحظة: لا ترفع `.env` على GitHub.

## تشغيل على Render + GitHub
- ارفع الملفات على GitHub (بدون .env)
- Render -> New -> Web Service
- Build Command: `npm install`
- Start Command: `npm start`
- Render -> Environment أضف المتغيرات:
  - TELEGRAM_BOT_TOKEN
  - AE_APP_KEY
  - AE_APP_SECRET
  - AE_GATEWAY
  - TRACKING_ID

## استخدام البوت
- اكتب في تلغرام:
  - `ابحث لي عن شاحن 65W`
  - أو `ابحث لي عن ساعة ذكية`

## ملاحظة مهمة عن الحقول
أحيانًا أسماء حقول "المبيعات" و"التقييم" تختلف حسب استجابة حسابك.
إذا ظهرت لك المبيعات 0 دائمًا، افتح Logs وخذ جزء صغير من عنصر `product` (بدون أسرار) وعدّل الحقول بسهولة.
