"""
Python port of backend/src/services/merchantNormalizer.js.

WHY a port instead of calling Node?
    The ML pipeline must group transactions *exactly* the way the production
    rule engine does, otherwise ML features and rule-based results would refer
    to different "merchants". Re-implementing the (small, dependency-free)
    function in Python keeps the ML module self-contained, and a parity test
    (tests/test_merchant_normalizer.py) compares this port against outputs
    produced by the real JavaScript function, so drift is caught automatically.

If you change the JavaScript normalizer, regenerate the parity fixture with:
    node scripts/generate_normalizer_fixture.mjs
"""

from __future__ import annotations

import re
from dataclasses import dataclass, asdict
from typing import Optional

# re.ASCII makes \b and \s behave like JavaScript's (ASCII-only) versions.
_F = re.IGNORECASE | re.ASCII

# (pattern, canonical name, slug, category, serviceDomain) — same order as JS,
# because the FIRST match wins.
_KNOWN_MERCHANTS = [
    (r"\b(netflix)\b", "Netflix", "netflix", "Streaming", "video_streaming"),
    (r"\b(spotify)\b", "Spotify", "spotify", "Music", "music_streaming"),
    (r"\b(aws|amazon\s*web\s*services)\b", "AWS", "aws", "Cloud", "cloud_infrastructure"),
    (r"\b(adobe|creative\s*cloud|photoshop)\b", "Adobe Creative Cloud", "adobe", "Software", "creative_suite"),
    (r"\b(google\s*one|google\s*storage)\b", "Google One", "google-one", "Cloud", "cloud_storage"),
    (r"\b(dropbox)\b", "Dropbox", "dropbox", "Cloud", "cloud_storage"),
    (r"\b(prime|amazon\s*prime|prime\s*video)\b", "Amazon Prime", "prime", "Streaming", "video_streaming"),
    (r"\b(disney\s*\+?\s*hotstar|hotstar)\b", "Disney+ Hotstar", "disney", "Streaming", "video_streaming"),
    (r"\b(notion)\b", "Notion", "notion", "SaaS", "productivity_notes"),
    (r"\b(cult\.?\s*fit|cure\.?\s*fit)\b", "Cult.fit", "cult-fit", "Fitness", "gym_fitness"),
    (r"\b(figma)\b", "Figma", "figma", "Software", "design_tool"),
    (r"\b(chatgpt|openai)\b", "ChatGPT Plus", "chatgpt", "SaaS", "ai_assistant"),
    (r"\b(github\s*copilot|github)\b", "GitHub Copilot", "github-copilot", "Software", "ai_coding"),
    (r"\b(cursor\s*pro|cursor|anysphere)\b", "Cursor Pro", "cursor-pro", "Software", "ai_coding"),
    (r"\b(vercel)\b", "Vercel Pro", "vercel-pro", "Cloud", "cloud_hosting"),
    (r"\b(youtube\s*premium|youtube\s*music)\b", "YouTube Premium", "youtube-premium", "Streaming", "video_streaming"),
    (r"\b(apple\s*music)\b", "Apple Music", "apple-music", "Music", "music_streaming"),
    (r"\b(icloud|apple\.com\/bill)\b", "iCloud+", "icloud", "Cloud", "cloud_storage"),
    (r"\b(slack)\b", "Slack", "slack", "SaaS", "team_chat"),
    (r"\b(zoom)\b", "Zoom", "zoom", "SaaS", "video_conferencing"),
    (r"\b(swiggy)\b", "Swiggy", "swiggy", "Food", None),
    (r"\b(zomato)\b", "Zomato", "zomato", "Food", None),
    (r"\b(uber)\b", "Uber", "uber", "Transport", None),
    (r"\b(blinkit)\b", "Blinkit", "blinkit", "Groceries", None),
    (r"\b(bigbasket)\b", "BigBasket", "bigbasket", "Groceries", None),
    (r"\b(starbucks)\b", "Starbucks", "starbucks", "Food", None),
]
_KNOWN = [(re.compile(p, _F), c, s, cat, d) for p, c, s, cat, d in _KNOWN_MERCHANTS]

_PREFIX = re.compile(
    r"^(pos\s*(?:debit|purchase)?|ach\s*(?:debit|payment)?|card\s*purchase|payment\s*to|"
    r"auto[- ]?debit|autopay|standing\s*order|billdesk\*?|payu\*?|razorpay\*?|"
    r"upi[/_-]+(?:cr[/_-]+)?|nach[/_-]+|in[/_-]+|www\.|https?:\/\/(?:www\.)?)\s*",
    _F,
)
_SUFFIX = re.compile(
    r"\s*(?:\.com|\.in|\.org|\.net|\.io|\.ai|\.app|\.co|\.tv|\.cc|\.me|"
    r"\b(?:inc|llc|ltd|pvt\s*ltd|private\s*limited|limited|corp|corporation|co|services|"
    r"payments?|billing|subscription|membership|digital|online|international|india|us|uk|gmbh)\b"
    r"|\*|\#|\/|-)+\s*$",
    _F,
)
_TRAILING_ID = re.compile(r"\s*(?:[*#\-_:]+\s*[0-9a-zA-Z]+|\b\d{4,}\b|\bxxxx\b)\s*$", _F)


@dataclass(frozen=True)
class NormalizedMerchant:
    cleanName: str
    canonicalKey: str
    slug: str
    category: str
    serviceDomain: Optional[str]

    def to_dict(self) -> dict:
        return asdict(self)


def normalize_merchant(raw) -> NormalizedMerchant:
    """Normalize a raw bank description. Mirrors normalizeMerchant() in JS."""
    if not raw or not isinstance(raw, str):
        return NormalizedMerchant("Unknown Merchant", "unknown", "unknown", "General", None)

    trimmed = raw.strip()

    for regex, canonical, slug, category, domain in _KNOWN:
        if regex.search(trimmed):
            return NormalizedMerchant(canonical, slug, slug, category, domain)

    cleaned = _PREFIX.sub("", trimmed, count=1)
    cleaned = _TRAILING_ID.sub("", cleaned)
    cleaned = _SUFFIX.sub("", cleaned)
    cleaned = re.sub(r"[*_#/\\-]+", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if not cleaned:
        cleaned = trimmed

    def _title(word: str) -> str:
        if len(word) <= 1:
            return word.upper()
        return word[0].upper() + word[1:].lower()

    title_cased = " ".join(_title(w) for w in cleaned.split(" "))
    key = re.sub(r"[^a-z0-9]+", "-", title_cased.lower())
    key = re.sub(r"(^-|-$)", "", key)
    key = key or "general"
    return NormalizedMerchant(title_cased, key, key, "General", None)
