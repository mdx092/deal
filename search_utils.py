"""أدوات البحث: ترجمة الاستعلام، تطبيع النص، وترتيب المنتجات حسب الصلة.

دوال نقية قدر الإمكان (باستثناء to_english التي تستدعي الشبكة) حتى يسهل اختبارها.
"""
import difflib
import logging
import re

import requests

log = logging.getLogger(__name__)

_NON_ASCII = re.compile(r"[^\x00-\x7F]")
_WORD = re.compile(r"\w+", re.UNICODE)
_TASHKEEL = re.compile(r"[ؐ-ًؚ-ٰٟـ]")

# كلمات لا تدل على المنتج نفسه، فلا نحسبها عند قياس الصلة
STOPWORDS = {
    "for", "the", "and", "with", "of", "a", "an", "in", "to", "on", "at", "by",
    "from", "new", "hot", "sale", "free", "shipping", "best", "pcs", "pc",
    "من", "في", "مع", "على", "الى", "إلى", "عن", "او", "أو",
}

_translation_cache = {}


def normalize(text):
    """حروف صغيرة + توحيد الحروف العربية المتشابهة + حذف التشكيل."""
    text = (text or "").lower()
    text = _TASHKEEL.sub("", text)
    text = re.sub("[إأآا]", "ا", text)
    text = text.replace("ى", "ي").replace("ة", "ه")
    return text


def stem(token):
    """تجريد بسيط للجمع الإنجليزي (glasses -> glass, cables -> cable)."""
    if len(token) > 4 and token.endswith("ies"):
        return token[:-3] + "y"
    if len(token) > 4 and token.endswith(("sses", "ches", "shes", "xes")):
        return token[:-2]
    if len(token) > 3 and token.endswith("s") and not token.endswith("ss"):
        return token[:-1]
    if len(token) > 4 and token.startswith("ال"):
        return token[2:]
    return token


def tokens(text):
    out = []
    for word in _WORD.findall(normalize(text)):
        if word in STOPWORDS:
            continue
        if len(word) < 2 and not word.isdigit():
            continue
        out.append(stem(word))
    return out


def to_english(text):
    """يترجم الاستعلام غير الإنجليزي (عربي/عبري/...) للإنجليزية.

    علي إكسبرس يعطي نتائج أدق بكثير مع الكلمات الإنجليزية. إن فشلت الترجمة
    نرجع النص الأصلي كما هو ولا نكسر البحث.
    يستخدم نقطة ترجمة غير رسمية مجانية؛ يمكن استبدالها بخدمة رسمية لاحقًا.
    """
    text = (text or "").strip()
    if not text or not _NON_ASCII.search(text):
        return text
    if text in _translation_cache:
        return _translation_cache[text]
    try:
        r = requests.get(
            "https://translate.googleapis.com/translate_a/single",
            params={"client": "gtx", "sl": "auto", "tl": "en", "dt": "t", "q": text},
            timeout=5,
        )
        r.raise_for_status()
        data = r.json()
        translated = "".join(seg[0] for seg in data[0] if seg and seg[0]).strip()
        if translated:
            _translation_cache[text] = translated  # لا نخزّن حالات الفشل
            return translated
    except Exception as exc:  # noqa: BLE001 - أي فشل يعني الرجوع للنص الأصلي
        log.warning("translation failed, using original query: %s", exc)
    return text


def _token_matches(q_token, title_tokens):
    if q_token in title_tokens:
        return True
    if len(q_token) >= 4:
        for t in title_tokens:
            if len(t) >= 4 and (t.startswith(q_token) or q_token.startswith(t)):
                return True
            if difflib.SequenceMatcher(None, q_token, t).ratio() >= 0.84:
                return True  # أخطاء إملائية بسيطة
    return False


def relevance(query, title):
    """يرجع (نسبة الكلمات المطابقة، الدرجة الكلية).

    الدرجة = نسبة الكلمات المطابقة + مكافأة إذا ورد الاستعلام كاملًا في العنوان.
    """
    q_tokens = tokens(query)
    if not q_tokens:
        return 1.0, 1.0
    title_tokens = set(tokens(title))
    matched = sum(1 for q in q_tokens if _token_matches(q, title_tokens))
    fraction = matched / len(q_tokens)
    score = fraction
    if " ".join(q_tokens) in " ".join(tokens(title)):
        score += 0.25
    return fraction, score


def rank_products(products, query, limit=4, min_fraction=0.6):
    """يزيل المكرر، يستبعد غير ذي الصلة، ويرتب حسب الصلة.

    - عند تساوي الصلة يبقى ترتيب الواجهة الأصلي (وهو يقرّب المبيعات/الجودة).
    - إن لم ينجح أي منتج في الحد الأدنى للصلة نرجع أفضل المتاح بدل قائمة فارغة.
    """
    if not tokens(query):
        return products[:limit]

    seen_ids, seen_titles = set(), set()
    scored = []
    for pos, product in enumerate(products):
        pid = str(product.get("id") or "")
        title_key = normalize(product.get("title") or "")[:60]
        if (pid and pid in seen_ids) or title_key in seen_titles:
            continue
        seen_ids.add(pid)
        seen_titles.add(title_key)
        fraction, score = relevance(query, product.get("title") or "")
        scored.append((score, fraction, pos, product))

    good = [s for s in scored if s[1] >= min_fraction]
    pool = good or scored
    pool.sort(key=lambda s: (-s[0], s[2]))
    return [s[3] for s in pool[:limit]]
