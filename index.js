import TelegramBot from "node-telegram-bot-api";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

// ================= CONFIG =================
const BOT_TOKEN = process.env.BOT_TOKEN;
const RAPID_API_KEY = process.env.RAPID_API_KEY;
const RAPID_API_HOST = "aliexpress-datahub.p.rapidapi.com";

if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN");
if (!RAPID_API_KEY) throw new Error("Missing RAPID_API_KEY");

// ================= BOT =================
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

console.log("🤖 Bot started");

// ================= UTILS =================
function isMeaningfulQuery(q) {
  if (!q) return false;
  if (q.length < 3) return false;
  if (!/[a-zA-Z\u0600-\u06FF]/.test(q)) return false;
  if (q.length > 15 && !q.includes(" ")) return false;
  return true;
}

function normalizeProduct(p) {
  return {
    title: p.product_title || "",
    price: p.app_sale_price || p.sale_price || "",
    image: p.product_main_image_url,
    link: p.product_detail_url,
  };
}

function relevanceScore(query, title) {
  const qWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const t = title.toLowerCase();
  return qWords.filter(w => t.includes(w)).length;
}

// ================= ALIEXPRESS SEARCH =================
async function searchAliExpress(keyword) {
  const url = `https://${RAPID_API_HOST}/item_search?q=${encodeURIComponent(
    keyword
  )}&page=1&pageSize=20&sort=SALE_PRICE_ASC`;

  const res = await fetch(url, {
    headers: {
      "X-RapidAPI-Key": RAPID_API_KEY,
      "X-RapidAPI-Host": RAPID_API_HOST,
    },
  });

  if (!res.ok) return [];

  const json = await res.json();
  return json?.data?.products || [];
}

// ================= MAIN SEARCH =================
async function searchBestProducts(query) {
  if (!isMeaningfulQuery(query)) return [];

  const raw = await searchAliExpress(query);
  if (!raw.length) return [];

  const normalized = raw.map(normalizeProduct);

  const filtered = normalized
    .map(p => ({
      ...p,
      score: relevanceScore(query, p.title),
    }))
    .filter(p => p.score >= 1)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return filtered;
}

// ================= TELEGRAM HANDLER =================
bot.on("message", async msg => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();

  if (!text) return;

  if (!isMeaningfulQuery(text)) {
    bot.sendMessage(
      chatId,
      "❌ الطلب غير واضح\n\n✍️ اكتب اسم منتج حقيقي مثل:\n• سماعة بلوتوث\n• شاحن 65W\n• ساعة ذكية"
    );
    return;
  }

  bot.sendMessage(chatId, "🔍 أبحث عن أفضل العروض…");

  try {
    const products = await searchBestProducts(text);

    if (!products.length) {
      bot.sendMessage(
        chatId,
        "😕 لم أجد منتجات مطابقة تمامًا لطلبك.\nجرّب كتابة اسم أوضح."
      );
      return;
    }

    for (const p of products) {
      bot.sendPhoto(chatId, p.image, {
        caption: `🛒 ${p.title}\n💰 السعر: ${p.price}\n🔗 ${p.link}`,
      });
    }
  } catch (e) {
    console.error(e);
    bot.sendMessage(chatId, "❌ حدث خطأ أثناء البحث.");
  }
});
