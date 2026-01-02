require("dotenv").config();

const axios = require("axios");
const crypto = require("crypto");
const sharp = require("sharp");
const http = require("http");
const TelegramBot = require("node-telegram-bot-api");

/* =========================
   ENV
========================= */
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");

const PUBLIC_URL = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL;
if (!PUBLIC_URL) throw new Error("Missing PUBLIC_URL (or RENDER_EXTERNAL_URL)");

const AE_APP_KEY = process.env.AE_APP_KEY;
const AE_APP_SECRET = process.env.AE_APP_SECRET;
const TRACKING_ID = process.env.TRACKING_ID;

if (!AE_APP_KEY || !AE_APP_SECRET) throw new Error("Missing AE_APP_KEY or AE_APP_SECRET");
if (!TRACKING_ID) throw new Error("Missing TRACKING_ID");

const DEBUG = String(process.env.DEBUG || "").trim() === "1";

// لو target_currency رجع USD: حوّله لشيكل
const USD_TO_ILS_RATE = Number(process.env.USD_TO_ILS_RATE || "0");
// اختياري لو صار CNY رغم كل شيء:
const CNY_TO_ILS_RATE = Number(process.env.CNY_TO_ILS_RATE || "0");

/* =========================
   Telegram webhook server
========================= */
const bot = new TelegramBot(token);
const WEBHOOK_PATH = `/bot${token}`;
const PORT = Number(process.env.PORT || 10000);

bot.setWebHook(`${PUBLIC_URL}${WEBHOOK_PATH}`);
console.log("Webhook set ✅");

http
  .createServer((req, res) => {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("OK");
    }

    if (req.method === "POST" && req.url === WEBHOOK_PATH) {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const update = JSON.parse(body);
          if (DEBUG) console.log("Incoming update ✅", update?.update_id);
          bot.processUpdate(update);
        } catch (e) {
          console.error("Bad JSON update:", e.message);
        }
        res.writeHead(200);
        res.end("OK");
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  })
  .listen(PORT, () => console.log("Server listening on", PORT));

/* =========================
   TOP helpers
========================= */
function topTimestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours()
  )}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function signTopMd5(params, secret) {
  const keys = Object.keys(params).sort();
  let base = secret;
  for (const k of keys) {
    const v = params[k];
    if (v !== undefined && v !== null && v !== "") base += `${k}${v}`;
  }
  base += secret;
  return crypto.createHash("md5").update(base, "utf8").digest("hex").toUpperCase();
}

function sanitizeForLog(obj) {
  const s = typeof obj === "string" ? obj : JSON.stringify(obj);
  return s
    .replace(/"sign"\s*:\s*"[^"]+"/g, '"sign":"***"')
    .replace(/"app_key"\s*:\s*"[^"]+"/g, '"app_key":"***"')
    .replace(/"token"\s*:\s*"[^"]+"/g, '"token":"***"')
    .slice(0, 1800);
}

async function topPost(gateway, method, bizParams) {
  const params = {
    method,
    app_key: AE_APP_KEY,
    timestamp: topTimestamp(),
    format: "json",
    v: "2.0",
    sign_method: "md5",
    ...bizParams,
  };
  params.sign = signTopMd5(params, AE_APP_SECRET);

  const res = await axios.post(gateway, new URLSearchParams(params), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 25000,
  });

  return res.data;
}

/* =========================
   Gateways fallback
========================= */
function buildGatewayList() {
  const envGw = (process.env.AE_GATEWAY || "").trim();
  const list = [
    envGw,
    "https://eco.taobao.com/router/rest",
    "https://api.taobao.com/router/rest",
  ].filter(Boolean);

  return [...new Set(list)];
}

function gwLabel(gw) {
  if (!gw) return "none";
  if (gw.includes("eco.taobao.com")) return "eco";
  if (gw.includes("api.taobao.com")) return "api";
  return "env";
}

/* =========================
   Extract response
========================= */
function extractProducts(apiData) {
  const root =
    apiData?.aliexpress_affiliate_product_query_response ||
    apiData?.aliexpress_affiliate_product_query_resp ||
    apiData;

  const products =
    root?.resp_result?.result?.products?.product ||
    root?.resp_result?.result?.products ||
    root?.result?.products?.product ||
    root?.result?.products ||
    [];

  return Array.isArray(products) ? products : [];
}

function getApiErrorSummary(apiData) {
  const root = apiData || {};
  const err =
    root?.error_response ||
    root?.errorResponse ||
    root?.resp_result?.error_response ||
    root?.resp_result?.errorResponse ||
    null;
  if (err) return err;

  const msg =
    root?.resp_result?.error_msg ||
    root?.resp_result?.errorMessage ||
    root?.error_msg ||
    root?.errorMessage ||
    root?.msg ||
    null;

  if (msg) return { message: msg };
  return null;
}

/* =========================
   Arabic -> English hint (improve search)
========================= */
function arabicToEnglishHint(q) {
  const s = (q || "").trim().toLowerCase();
  const map = [
    [/شاحن\s*65w/g, "65w gan charger pd"],
    [/شاحن\s*100w/g, "100w gan charger pd"],
    [/65\s*واط/g, "65w"],
    [/100\s*واط/g, "100w"],
    [/شاحن/g, "charger pd"],
    [/محول/g, "adapter"],
    [/كابل/g, "usb c cable"],
    [/باور\s*بانك/g, "power bank"],
    [/بنك\s*طاقة/g, "power bank"],
    [/ساعة\s*ذكية/g, "smartwatch"],
    [/سماعات/g, "earbuds"],
  ];
  let out = s;
  for (const [re, rep] of map) out = out.replace(re, rep);
  if (out === s) return null;
  return out;
}

/* =========================
   AliExpress Product Query (fallback)
   ✅ Try ILS first, then USD
========================= */
async function affiliateProductQueryWithFallback(keyword) {
  const gateways = buildGatewayList();

  // ✅ IMPORTANT: include target_* fields to avoid CNY
  const fields = [
    "product_title",
    "product_main_image_url",
    "product_detail_url",
    "lastest_volume",
    "evaluate_rate",
    "product_id",
    "app_sale_price",
    "app_sale_price_currency",
    "sale_price",
    "sale_price_currency",
    "original_price",
    "original_price_currency",
    "target_app_sale_price",
    "target_app_sale_price_currency",
    "target_sale_price",
    "target_sale_price_currency",
  ].join(",");

  const attempts = [];
  attempts.push({ kw: keyword, withFields: true });
  attempts.push({ kw: keyword, withFields: false });

  const en = arabicToEnglishHint(keyword);
  if (en) {
    attempts.push({ kw: en, withFields: true });
    attempts.push({ kw: en, withFields: false });
  }

  // ✅ Try ILS first then USD (so you get ₪ directly if supported)
  const currencyAttempts = ["ILS", "USD"];

  let lastInfo = null;

  for (const gateway of gateways) {
    for (const targetCurrency of currencyAttempts) {
      for (const a of attempts) {
        const biz = {
          keywords: a.kw,
          page_no: 1,
          page_size: 50,
          sort: "LAST_VOLUME_DESC",
          target_language: "AR",
          target_currency: targetCurrency,
          ship_to_country: "IL",
          tracking_id: TRACKING_ID,
        };
        if (a.withFields) biz.fields = fields;

        let data;
        try {
          if (DEBUG)
            console.log(
              `API TRY -> gw=${gwLabel(gateway)} cur=${targetCurrency} kw="${a.kw}" fields=${a.withFields}`
            );
          data = await topPost(gateway, "aliexpress.affiliate.product.query", biz);
        } catch (e) {
          lastInfo = {
            gw: gwLabel(gateway),
            cur: targetCurrency,
            kw: a.kw,
            withFields: a.withFields,
            networkError: e?.message,
          };
          console.log("API NET ERR:", sanitizeForLog(lastInfo));
          continue;
        }

        const err = getApiErrorSummary(data);
        const products = extractProducts(data);

        lastInfo = {
          gw: gwLabel(gateway),
          cur: targetCurrency,
          kw: a.kw,
          withFields: a.withFields,
          productsCount: products.length,
          hasError: !!err,
          error: err || null,
        };

        if (DEBUG) console.log("API RESP (short):", sanitizeForLog(lastInfo));

        if (products.length > 0) return { products, usedKeyword: a.kw, gateway, targetCurrency };
      }
    }
  }

  if (DEBUG) console.log("API FINAL FAIL:", sanitizeForLog(lastInfo || { note: "no_attempts" }));
  return { products: [], usedKeyword: keyword, gateway: null, targetCurrency: null };
}

/* =========================
   Title short (NO ... / NO cut word)
========================= */
function cleanTitle(title, maxWords = 9) {
  if (!title) return "منتج";

  let t = String(title);

  t = t
    .replace(/[™®©]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\b(Hot|New|Best|Sale|Original|202\d|Free\s*Shipping|Shipping|Discount|Top|Choice)\b/gi, "")
    .replace(/\b(For|With|And|Or|The|A|An)\b/gi, "")
    .replace(/\b(حار|جديد|الأفضل|تخفيض|خصم|عرض|أصلي|شحن\s*مجاني|توصيل)\b/gi, "")
    .replace(/[.،,:;|/\\()[\]{}"“”'’…]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!t) return "منتج";

  const words = t.split(" ").filter(Boolean);
  return words.slice(0, maxWords).join(" ").trim() || "منتج";
}

/* =========================
   Currency + rating helpers
========================= */
function numFromAny(x) {
  if (x === null || x === undefined) return null;
  const m = String(x).match(/(\d+(\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

function priceToILS(priceNum, currency) {
  if (!Number.isFinite(priceNum)) return null;
  const cur = String(currency || "").toUpperCase();

  if (cur === "ILS") return priceNum;
  if (cur === "USD" && USD_TO_ILS_RATE > 0) return priceNum * USD_TO_ILS_RATE;
  if (cur === "CNY" && CNY_TO_ILS_RATE > 0) return priceNum * CNY_TO_ILS_RATE;

  return null;
}

function formatPrice(priceNum, currency) {
  const ils = priceToILS(priceNum, currency);
  if (ils !== null) return `₪${ils.toFixed(2)}`;

  if (priceNum === null || priceNum === undefined) return "—";
  const cur = String(currency || "").toUpperCase() || "USD";
  return `${cur} ${Number(priceNum).toFixed(2)}`;
}

function ratingTo5(raw) {
  const n = numFromAny(raw);
  if (!Number.isFinite(n)) return null;
  if (n > 5 && n <= 100) return Math.round((n / 20) * 10) / 10; // 98 => 4.9
  if (n >= 0 && n <= 5) return Math.round(n * 10) / 10;
  return null;
}

/* =========================
   STRONG INTENT FILTER (better relevance)
========================= */
function normText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractNumberUnit(query) {
  const q = normText(query);
  const watt = q.match(/(\d{2,4})\s*(w|واط)\b/);
  const mah = q.match(/(\d{4,6})\s*(mah)\b/);
  return {
    watt: watt ? Number(watt[1]) : null,
    mah: mah ? Number(mah[1]) : null,
  };
}

function extractIntent(query) {
  const q = normText(query);
  const wantsCable = /\b(كابل|cable|سلك|wire)\b/.test(q);
  const wantsCharger = /\b(شاحن|charger|adapter|محول)\b/.test(q) && !wantsCable;
  const wantsPowerBank = (/\b(باور|power)\b/.test(q) && /\b(بانك|bank)\b/.test(q)) || /\b(power bank)\b/.test(q);
  const wantsWatch = (/\b(ساعة)\b/.test(q) && /\b(ذكية|smart)\b/.test(q)) || /\b(smartwatch)\b/.test(q);
  return { wantsCharger, wantsCable, wantsPowerBank, wantsWatch };
}

function titleHasWatt(title, watt) {
  if (!watt) return true;
  const t = normText(title);
  const re = new RegExp(`\\b${watt}\\s*(w|واط)\\b`, "i");
  if (!re.test(t)) return false;

  // لو ظهر أكثر من وات، لازم يحتوي المطلوب
  const all = [...t.matchAll(/(\d{2,4})\s*(w|واط)\b/g)].map((m) => Number(m[1]));
  if (all.length && !all.includes(watt)) return false;

  return true;
}

function titleHasMah(title, mah) {
  if (!mah) return true;
  const t = normText(title);
  const re = new RegExp(`\\b${mah}\\s*(mah)\\b`, "i");
  return re.test(t);
}

function containsAny(text, list) {
  const t = normText(text);
  return list.some((x) => t.includes(x));
}

function queryTokens(query) {
  const q = normText(query)
    .split(" ")
    .filter((w) => w.length >= 2)
    .filter((w) => !["ابحث", "عن", "لي"].includes(w));
  return [...new Set(q)];
}

function minTokenMatch(title, query, minHits = 1) {
  const t = normText(title);
  const toks = queryTokens(query);
  if (!toks.length) return true;

  const filtered = toks.filter((w) => !/^\d+$/.test(w));
  if (!filtered.length) return true;

  let hits = 0;
  for (const w of filtered) {
    if (t.includes(w)) hits++;
    if (hits >= minHits) return true;
  }
  return false;
}

// For chargers: prefer PD/GaN/USB-C, and penalize accessories
function chargerBoostScore(title) {
  const t = normText(title);
  let s = 0;
  if (/\bgan\b/.test(t)) s += 3;
  if (/\bpd\b/.test(t) || t.includes("power delivery")) s += 2;
  if (t.includes("usb c") || t.includes("usb-c") || t.includes("type c")) s += 2;
  if (/\bqc\b/.test(t)) s += 1;
  if (t.includes("case") || t.includes("cover") || t.includes("holder") || t.includes("stand")) s -= 3;
  return s;
}

function isObviouslyAccessory(title) {
  const banCommon = [
    "holder","stand","dock","hub","mount","bracket","case","cover","skin","sticker",
    "حامل","ستاند","قاعدة","كفر","جراب","غطاء","ملصق","موزع","هاب"
  ];
  return containsAny(title, banCommon);
}

// ✅ strong filter
function passesStrongIntent(productTitle, query) {
  const { watt, mah } = extractNumberUnit(query);
  const intent = extractIntent(query);
  const title = productTitle || "";

  if (!titleHasWatt(title, watt)) return false;
  if (!titleHasMah(title, mah)) return false;
  if (isObviouslyAccessory(title)) return false;

  // stronger token match for charger queries
  const minHits = intent.wantsCharger ? 2 : 1;
  if (!minTokenMatch(title, query, minHits)) return false;

  if (intent.wantsCharger) {
    const must = ["charger", "adapter", "شاحن", "محول", "gan", "pd"];
    const ban = ["cable", "كابل", "wire", "سلك"];
    if (!containsAny(title, must)) return false;
    if (containsAny(title, ban)) return false;
  }

  if (intent.wantsCable) {
    const must = ["cable", "كابل", "wire", "سلك", "usb c", "usb-c", "type c"];
    if (!containsAny(title, must)) return false;
  }

  if (intent.wantsPowerBank) {
    const must = ["power bank", "battery bank", "باور", "بانك"];
    if (!containsAny(title, must)) return false;
  }

  if (intent.wantsWatch) {
    const must = ["smartwatch", "watch", "ساعة", "ذكية"];
    if (!containsAny(title, must)) return false;
  }

  return true;
}

// ✅ relaxed but still smart (avoid cables when user wants charger)
function passesRelaxedButSmart(productTitle, query) {
  const { watt, mah } = extractNumberUnit(query);
  const intent = extractIntent(query);
  const title = productTitle || "";

  if (!titleHasWatt(title, watt)) return false;
  if (!titleHasMah(title, mah)) return false;
  if (isObviouslyAccessory(title)) return false;

  if (intent.wantsCharger) {
    const must = ["charger", "adapter", "شاحن", "محول", "gan", "pd"];
    const ban = ["cable", "كابل", "wire", "سلك"];
    if (!containsAny(title, must)) return false;
    if (containsAny(title, ban)) return false;
  }

  // token match أخف
  if (!minTokenMatch(title, query, 1)) return false;

  return true;
}

/* =========================
   DEDUPE helpers
========================= */
function extractItemIdFromUrl(url) {
  try {
    const u = String(url || "");
    const m = u.match(/\/item\/(\d+)\.html/i) || u.match(/item\/(\d+)/i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function normalizeImageKey(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return String(url || "").split("?")[0];
  }
}

function normalizeTitleKey(t) {
  return normText(t).replace(/\s+/g, " ").trim();
}

function pickTop4Unique(sortedCandidates) {
  const chosen = [];
  const seenIds = new Set();
  const seenImages = new Set();
  const seenTitle = new Set();

  for (const p of sortedCandidates) {
    if (chosen.length >= 4) break;

    const pid = p.productId || null;
    const imgKey = p.imageKey || p.image || "";
    const titleKey = normalizeTitleKey(p.shortTitle || p.title || "");

    if (pid && seenIds.has(pid)) continue;
    if (imgKey && seenImages.has(imgKey)) continue;
    if (titleKey && seenTitle.has(titleKey)) continue;

    if (pid) seenIds.add(pid);
    if (imgKey) seenImages.add(imgKey);
    if (titleKey) seenTitle.add(titleKey);

    chosen.push(p);
  }

  return chosen;
}

/* =========================
   Normalize products
   ✅ IMPORTANT: target_* FIRST (avoid CNY)
========================= */
function normalizeProducts(rawProducts) {
  return rawProducts
    .map((p) => {
      const title = p?.product_title || p?.title || "منتج";
      const shortTitle = cleanTitle(title, 9);

      const image =
        p?.product_main_image_url ||
        p?.product_main_image ||
        p?.product_small_image_urls?.string?.[0] ||
        p?.product_small_image_urls?.[0] ||
        p?.image_url ||
        "";

      const detailUrl = p?.product_detail_url || p?.product_url || p?.url || "";

      // ✅ target_* FIRST
      const priceRaw =
        p?.target_app_sale_price ||
        p?.target_sale_price ||
        p?.app_sale_price ||
        p?.sale_price ||
        p?.original_price ||
        "";

      const priceNum = numFromAny(priceRaw);

      // ✅ target currency FIRST
      const currency =
        p?.target_app_sale_price_currency ||
        p?.target_sale_price_currency ||
        p?.app_sale_price_currency ||
        p?.sale_price_currency ||
        p?.original_price_currency ||
        "USD";

      const orders = Number(p?.lastest_volume ?? p?.last_volume ?? p?.volume ?? p?.sales_count ?? 0) || 0;

      const ratingRaw = p?.evaluate_rate || p?.avg_evaluate_rate || p?.rating || null;
      const rating5 = ratingTo5(ratingRaw);

      const productId =
        String(p?.product_id || p?.item_id || p?.productId || "").trim() ||
        extractItemIdFromUrl(detailUrl) ||
        null;

      const imageKey = image ? normalizeImageKey(image) : "";
      const priceILS = priceToILS(priceNum, currency);
      const boost = chargerBoostScore(title);

      return {
        title,
        shortTitle,
        image,
        imageKey,
        detailUrl,
        priceNum,
        currency,
        priceILS,
        orders,
        rating5,
        productId,
        affiliateLink: "",
        boost,
      };
    })
    .filter((x) => x.image && x.detailUrl);
}

/* =========================
   Affiliate link generate
========================= */
async function affiliateLinkGenerate(sourceUrls) {
  const gateways = buildGatewayList();
  for (const gateway of gateways) {
    try {
      const data = await topPost(gateway, "aliexpress.affiliate.link.generate", {
        promotion_link_type: 0,
        source_values: sourceUrls.join(","),
        tracking_id: TRACKING_ID,
      });
      return data;
    } catch (e) {
      console.error("link.generate failed:", gwLabel(gateway), e?.message);
    }
  }
  return null;
}

function extractPromotionLinks(apiData) {
  if (!apiData) return [];
  const root =
    apiData?.aliexpress_affiliate_link_generate_response ||
    apiData?.aliexpress_affiliate_link_generate_resp ||
    apiData;

  const arr =
    root?.resp_result?.result?.promotion_links?.promotion_link ||
    root?.result?.promotion_links?.promotion_link ||
    [];

  return Array.isArray(arr) ? arr : [];
}

/* =========================
   Collage 2x2 (NO TEXT) + smaller numbers
========================= */
function numberBadgeSVG(num) {
  // أصغر من قبل
  return `
  <svg width="70" height="70">
    <circle cx="35" cy="35" r="30" fill="#ff5a2a"/>
    <text x="35" y="48" font-size="36" text-anchor="middle"
          fill="#ffffff" font-family="Arial" font-weight="800">${num}</text>
  </svg>`;
}

async function fetchImageBuffer(url) {
  const res = await axios.get(url, { responseType: "arraybuffer", timeout: 25000 });
  return Buffer.from(res.data);
}

async function buildCollage(items) {
  const SIZE = 1000;
  const HALF = SIZE / 2;

  const base = sharp({
    create: {
      width: SIZE,
      height: SIZE,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  });

  const layers = [];

  for (let i = 0; i < 4; i++) {
    const left = (i % 2) * HALF;
    const top = i < 2 ? 0 : HALF;

    const buf = await fetchImageBuffer(items[i].image);

    const img = await sharp(buf)
      .resize(HALF, HALF, { fit: "cover" })
      .toBuffer();

    layers.push({ input: img, left, top });

    // رقم فقط
    layers.push({
      input: Buffer.from(numberBadgeSVG(i + 1)),
      left: left + 14,
      top: top + 14,
    });
  }

  layers.push({
    input: Buffer.from(`
      <svg width="${SIZE}" height="${SIZE}">
        <rect x="${HALF - 2}" y="0" width="4" height="${SIZE}" fill="#ffffff" opacity="0.95"/>
        <rect x="0" y="${HALF - 2}" width="${SIZE}" height="4" fill="#ffffff" opacity="0.95"/>
      </svg>
    `),
    left: 0,
    top: 0,
  });

  return base.composite(layers).jpeg({ quality: 85 }).toBuffer();
}

/* =========================
   Caption (order: Sales -> Rating -> Price)
========================= */
function buildCaption(query, items) {
  let msg = `🔎 البحث: ${query}\n\n`;

  items.forEach((p, i) => {
    const link = p.affiliateLink || p.detailUrl || "—";
    const priceText = formatPrice(p.priceNum, p.currency);
    const ratingText = p.rating5 ? `${p.rating5}/5` : "—";

    msg += `${i + 1}️⃣ ${p.shortTitle}\n`;
    msg += `🛒 المبيعات: ${p.orders}\n`;
    msg += `⭐ التقييم: ${ratingText}\n`;
    msg += `💰 السعر: ${priceText}\n`;
    msg += `${link}\n\n`;
  });

  return msg.trim();
}

/* =========================
   Telegram handlers
========================= */
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
`🤖 مرحبًا بكم في علي بوت AI"! 🎉

بوتنا الذكي يعرف كيف يعثر لكم على أفضل المنتجات على علي إكسبريس — اعتمادًا على التقييمات، المراجعات، وعمليات الشراء الحقيقية 🔍

فقط اكتبوا:
💬 ابحث عن... ثم اسم المنتج الذي تريدونه

وخلال ثوانٍ ستحصلون على أفضل 4 صفقات وأكثرها توفيرًا على الإنترنت 💥

⚡️ نصيحة صغيرة: كلما كانت كتابتكم أدق — كانت النتائج أقرب لما تريدون 🎯`
  );
});

function parseQuery(text) {
  const t = (text || "").trim();
  return t
    .replace(/^\s*ابحث(\s+لي)?\s+عن\s+/i, "")
    .replace(/^\s*ابحث\s+/i, "")
    .trim();
}

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  if (!text || text.startsWith("/")) return;

  const query = parseQuery(text);
  if (!query) return bot.sendMessage(chatId, 'اكتب مثلًا: "ابحث عن شاحن 65W"');

  try {
    bot.sendChatAction(chatId, "upload_photo");

    const { products: rawProducts, gateway, targetCurrency } =
      await affiliateProductQueryWithFallback(query);

    const normAll = normalizeProducts(rawProducts);

    // فلترة على مراحل (أقوى نتائج)
    let candidates = normAll.filter((p) => passesStrongIntent(p.title, query));

    if (candidates.length < 4) {
      candidates = normAll.filter((p) => passesRelaxedButSmart(p.title, query));
    }

    if (candidates.length < 4) {
      // آخر محاولة: وات/mah فقط + منع الاكسسوارات والكابلات إذا المستخدم يريد شاحن
      const { watt, mah } = extractNumberUnit(query);
      const intent = extractIntent(query);

      candidates = normAll.filter((p) => {
        if (!titleHasWatt(p.title, watt)) return false;
        if (!titleHasMah(p.title, mah)) return false;
        if (isObviouslyAccessory(p.title)) return false;

        if (intent.wantsCharger) {
          const ban = ["cable", "كابل", "wire", "سلك"];
          if (containsAny(p.title, ban)) return false;
        }
        return true;
      });
    }

    if (candidates.length < 4) candidates = normAll;

    // تحسينات ترتيب داخلية (تعزيز GaN/PD للشواحن)
    candidates.sort((a, b) => (b.boost || 0) - (a.boost || 0));

    // ✅ ترتيبك النهائي: المبيعات ثم التقييم ثم السعر
    candidates.sort((a, b) => {
      const oa = Number(a.orders || 0);
      const ob = Number(b.orders || 0);
      if (ob !== oa) return ob - oa;

      const ra = Number(a.rating5 || 0);
      const rb = Number(b.rating5 || 0);
      if (rb !== ra) return rb - ra;

      const pa = Number.isFinite(a.priceILS) ? a.priceILS : (Number(a.priceNum) || 999999);
      const pb = Number.isFinite(b.priceILS) ? b.priceILS : (Number(b.priceNum) || 999999);
      return pa - pb;
    });

    // ✅ منع التكرار (ID + صورة + عنوان)
    const top4 = pickTop4Unique(candidates);

    console.log(
      `raw:${rawProducts.length} normalized:${normAll.length} candidates:${candidates.length} picked:${top4.length} (gw=${gwLabel(
        gateway
      )} cur=${targetCurrency || "?"})`
    );

    if (top4.length < 4) {
      return bot.sendMessage(chatId, "ما لقيت 4 نتائج مناسبة. جرّب كلمة ثانية 🙂");
    }

    // affiliate links
    const urls = top4.map((p) => p.detailUrl).filter(Boolean);
    if (urls.length) {
      const linkData = await affiliateLinkGenerate(urls);
      if (linkData) {
        const linksArr = extractPromotionLinks(linkData);
        const linkMap = new Map();
        for (const row of linksArr) {
          if (row?.source_value && row?.promotion_link) linkMap.set(row.source_value, row.promotion_link);
        }
        top4.forEach((p) => {
          p.affiliateLink = p.detailUrl ? (linkMap.get(p.detailUrl) || "") : "";
        });
      }
    }

    const collage = await buildCollage(top4);
    const caption = buildCaption(query, top4);

    await bot.sendPhoto(chatId, collage, { caption });
  } catch (err) {
    console.error("BOT ERROR:", sanitizeForLog(err?.response?.data || err.message));
    bot.sendMessage(chatId, "صار خطأ 😅 جرّب مرة ثانية.");
  }
});

console.log("Deals48 bot running (webhook mode)...");
