import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from search_utils import normalize, rank_products, relevance, stem, tokens, to_english


def product(pid, title):
    return {"id": pid, "title": title}


def test_stem_plurals():
    assert stem("glasses") == "glass"
    assert stem("cables") == "cable"
    assert stem("batteries") == "battery"
    assert stem("glass") == "glass"


def test_normalize_arabic_variants():
    assert normalize("أحذيةٌ") == normalize("احذيه")


def test_tokens_drop_stopwords_and_keep_numbers():
    assert tokens("iPhone 15 case for the new") == ["iphone", "15", "case"]


def test_relevant_beats_irrelevant():
    items = [
        product(1, "LED Strip Lights RGB 5m"),
        product(2, "Wireless Bluetooth Earphones TWS Headphones"),
        product(3, "Phone Holder Car Mount"),
        product(4, "Bluetooth Wireless Earphone Noise Cancelling"),
    ]
    ranked = rank_products(items, "wireless bluetooth earphones", limit=4)
    assert [p["id"] for p in ranked[:2]] == [2, 4]
    assert 1 not in [p["id"] for p in ranked]


def test_all_query_words_required_for_two_words():
    items = [product(1, "Silicone Case Cover"), product(2, "iPhone 15 Silicone Case")]
    ranked = rank_products(items, "iphone case", limit=4)
    assert [p["id"] for p in ranked] == [2]


def test_typo_tolerated():
    fraction, _ = relevance("blutooth speaker", "Portable Bluetooth Speaker")
    assert fraction == 1.0


def test_dedupes_by_id_and_title():
    items = [
        product(1, "USB C Cable 2m"),
        product(1, "USB C Cable 2m"),
        product(2, "usb c cable 2m"),
        product(3, "USB-C Fast Charging Cable 1m"),
    ]
    ranked = rank_products(items, "usb c cable", limit=4)
    assert len(ranked) == 2


def test_ties_keep_api_order():
    items = [product(10, "Smart Watch Men"), product(11, "Smart Watch Women")]
    ranked = rank_products(items, "smart watch", limit=2)
    assert [p["id"] for p in ranked] == [10, 11]


def test_fallback_when_nothing_matches():
    items = [product(1, "Random Thing"), product(2, "Other Item")]
    ranked = rank_products(items, "laptop", limit=2)
    assert len(ranked) == 2  # بدل قائمة فارغة


def test_ascii_query_not_translated():
    assert to_english("wireless mouse") == "wireless mouse"
