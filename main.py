import os
import time
import html
import hashlib
import asyncio
import logging
import requests
from fastapi import FastAPI, Request
from telegram import LinkPreviewOptions, Update
from telegram.constants import ChatAction, ParseMode
from telegram.ext import (
    Application, CommandHandler,
    MessageHandler, filters, ContextTypes
)

from search_utils import to_english, rank_products

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("deals48")

# ==========================
# ENVIRONMENT VARIABLES
# ==========================
BOT_TOKEN = os.getenv("BOT_TOKEN")
ALI_APP_KEY = os.getenv("ALI_APP_KEY")
ALI_APP_SECRET = os.getenv("ALI_APP_SECRET")
TRACKING_ID = os.getenv("TRACKING_ID", "deals48bot")

# اختيارية: تحسين الأسعار والشحن حسب بلد المستخدم (مثال: IL / ILS / EN)
SHIP_TO_COUNTRY = os.getenv("SHIP_TO_COUNTRY")
TARGET_CURRENCY = os.getenv("TARGET_CURRENCY")
TARGET_LANGUAGE = os.getenv("TARGET_LANGUAGE", "EN")
RESULTS_LIMIT = int(os.getenv("RESULTS_LIMIT", "4"))
FETCH_SIZE = 50  # نجلب عددًا أكبر ثم نفلتر ونرتب محليًا بالصلة

# حقول موثوقة كانت تعمل أصلًا، نستعملها كخطة بديلة إن رفضت الواجهة الحقول الموسعة
BASE_FIELDS = "product_id,product_title,product_main_image_url,product_detail_url,sale_price"
EXTENDED_FIELDS = BASE_FIELDS + ",promotion_link,original_price,discount,evaluate_rate,lastest_volume,sale_price_currency"

# ==========================
# TELEGRAM BOT INIT
# ==========================
application = Application.builder().token(BOT_TOKEN).build()


# ==========================
# SIGN FUNCTION (AliExpress)
# ==========================
def create_sign(params, secret):
    sorted_params = "".join(f"{k}{v}" for k, v in sorted(params.items()))
    sign_str = secret + sorted_params + secret
    return hashlib.md5(sign_str.encode("utf-8")).hexdigest().upper()


# ==========================
# AliExpress PRODUCT SEARCH
# ==========================
def extract_products(data):
    """يستخرج قائمة المنتجات من الاستجابة، سواء كانت داخل resp_result.result أو مباشرة."""
    response = data.get("aliexpress_affiliate_product_query_response") or {}
    node = (response.get("resp_result") or {}).get("result") or response
    items = (node.get("products") or {}).get("product") or []
    if isinstance(items, dict):  # منتج واحد قد يرجع كائنًا لا قائمة
        items = [items]
    return items


def parse_item(item):
    return {
        "id": item.get("product_id"),
        "title": item.get("product_title") or "",
        "image": item.get("product_main_image_url"),
        "price": item.get("sale_price"),
        "currency": item.get("sale_price_currency") or "",
        "original_price": item.get("original_price"),
        "discount": item.get("discount"),
        "rating": item.get("evaluate_rate"),
        "sales": item.get("lastest_volume"),
        # رابط الإحالة (promotion_link) يحمل tracking_id الخاص بك، لذلك نفضله على الرابط العادي
        "url": item.get("promotion_link") or item.get("product_detail_url"),
    }


def _query_api(keyword, fields):
    params = {
        "app_key": ALI_APP_KEY,
        "method": "aliexpress.affiliate.product.query",
        "timestamp": int(time.time() * 1000),
        "sign_method": "md5",
        "format": "json",
        "v": "2.0",
        "keywords": keyword,  # الاسم الصحيح للمعامل (بالجمع). "keyword" كان يُتجاهل فتأتي نتائج عامة
        "fields": fields,
        "page_no": 1,
        "page_size": FETCH_SIZE,
        "tracking_id": TRACKING_ID,
    }
    if SHIP_TO_COUNTRY:
        params["ship_to_country"] = SHIP_TO_COUNTRY
    if TARGET_CURRENCY:
        params["target_currency"] = TARGET_CURRENCY
    if TARGET_LANGUAGE:
        params["target_language"] = TARGET_LANGUAGE

    params["sign"] = create_sign(params, ALI_APP_SECRET)

    try:
        r = requests.post("https://api.aliexpress.com/sync", data=params, timeout=15)
        log.debug("RAW API RESPONSE: %s", r.text)
        data = r.json()
    except (requests.RequestException, ValueError) as exc:
        log.error("AliExpress request failed: %s", exc)
        return None

    if "error_response" in data:
        log.error("AliExpress API error: %s", data["error_response"])
        return None
    return extract_products(data)


async def ali_search(user_query):
    if not ALI_APP_KEY or not ALI_APP_SECRET:
        log.error("ALI_APP_KEY / ALI_APP_SECRET are not set")
        return [], user_query

    # علي إكسبرس أدق بكثير مع الإنجليزية: نترجم العربي/العبري قبل البحث
    keyword = await asyncio.to_thread(to_english, user_query)
    log.info("search: %r -> %r", user_query, keyword)

    items = await asyncio.to_thread(_query_api, keyword, EXTENDED_FIELDS)
    if not items:
        # ربما رفضت الواجهة أحد الحقول الموسعة: نجرّب بالحقول الأساسية
        items = await asyncio.to_thread(_query_api, keyword, BASE_FIELDS)
    if not items:
        return [], keyword

    products = [parse_item(i) for i in items]
    return rank_products(products, keyword, limit=RESULTS_LIMIT), keyword


# ==========================
# FORMATTING
# ==========================
def format_product(index, p):
    title = p["title"].strip()
    if len(title) > 90:
        title = title[:87].rstrip() + "..."

    price = p["price"]
    price_line = f"💰 {html.escape(str(price))} {html.escape(p['currency'])}".rstrip() if price else "💰 —"
    if p["original_price"] and p["original_price"] != price:
        price_line += f" <s>{html.escape(str(p['original_price']))}</s>"
    if p["discount"]:
        price_line += f" ({html.escape(str(p['discount']))})"

    extras = []
    if p["rating"]:
        extras.append(f"⭐ {html.escape(str(p['rating']))}")
    if p["sales"]:
        extras.append(f"🛒 {html.escape(str(p['sales']))} مبيعات")

    lines = [f"<b>{index}. {html.escape(title)}</b>", price_line]
    if extras:
        lines.append(" · ".join(extras))
    if p["url"]:
        lines.append(f'🔗 <a href="{html.escape(p["url"], quote=True)}">رابط الشراء</a>')
    return "\n".join(lines)


# ==========================
# HANDLERS
# ==========================
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("أهلاً! أرسل اسم المنتج للبحث 👇")


async def search_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_query = update.message.text.strip()
    if not user_query:
        return

    await context.bot.send_chat_action(update.effective_chat.id, ChatAction.TYPING)

    try:
        products, keyword = await ali_search(user_query)
    except Exception:  # noqa: BLE001
        log.exception("search failed")
        await update.message.reply_text("⚠️ حدث خطأ أثناء البحث، حاول مرة أخرى بعد قليل.")
        return

    if not products:
        await update.message.reply_text("❌ لم أجد نتائج، جرّب كلمة أخرى.")
        return

    header = f"🔍 نتائج البحث عن: <b>{html.escape(user_query)}</b>"
    if keyword.lower() != user_query.lower():
        header += f"\n🌐 تم البحث بـ: {html.escape(keyword)}"
    body = "\n\n".join(format_product(i, p) for i, p in enumerate(products, 1))

    await update.message.reply_text(
        f"{header}\n\n{body}",
        parse_mode=ParseMode.HTML,
        link_preview_options=LinkPreviewOptions(is_disabled=True),
    )


# Register handlers
application.add_handler(CommandHandler("start", start))
application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, search_handler))


# ==========================
# FASTAPI WEBHOOK SERVER
# ==========================
app = FastAPI()


@app.post("/webhook")
async def telegram_webhook(request: Request):
    data = await request.json()
    update = Update.de_json(data, application.bot)

    # 🔥 مهم جداً — يجب تهيئة التطبيق قبل معالجة التحديثات
    if not application._initialized:
        await application.initialize()

    await application.process_update(update)
    return {"ok": True}


@app.get("/")
async def home():
    return {"status": "Bot is running!"}


# ==========================
# STARTUP MESSAGE
# ==========================
@app.on_event("startup")
async def startup_event():
    # تهيئة مبكرة حتى لا تتسابق أول طلبات متزامنة على initialize()
    if not application._initialized:
        await application.initialize()
    log.info("Bot initialized!")


if __name__ == "__main__":
    # يجعل `python main.py` (أمر Dockerfile) يشغّل الخادم فعلًا
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
