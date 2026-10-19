"""
SYNTHETIC development dataset generator.

!!! This data is fabricated. It exists ONLY to exercise and test the
!!! pipeline. Any model metric computed on it says nothing about real-world
!!! performance, because we designed both the data and the patterns.

Why synthetic? Inspection of the repository found no independently labelled
transaction data (only a 15-row demo CSV whose `isRecurring` column is
rule-like and unverified). Synthetic data lets us create *known* ground truth,
including hard negatives (rent, utilities, EMIs: recurring but NOT
subscriptions) and ambiguous cases.

Reproducible: the same seed always yields byte-identical output.
"""

from __future__ import annotations

import calendar
from datetime import date, timedelta

import numpy as np
import pandas as pd

from .merchant_normalizer import normalize_merchant

START = date(2024, 1, 1)
END = date(2026, 8, 31)

# (raw description template, typical prices). "{id}" -> random 4-digit ref.
SUB_MONTHLY = [
    ("POS DEBIT - NETFLIX.COM* {id}", [199, 499, 649]),
    ("UPI/SPOTIFY AB/{id}", [119, 179]),
    ("OPENAI *CHATGPT SUBSCR", [1999]),
    ("FIGMA MONTHLY {id}", [1250]),
    ("GOOGLE *YOUTUBE PREMIUM", [129, 189]),
    ("APPLE MUSIC SUBSCRIPTION", [99]),
    ("SLACK TECHNOLOGIES {id}", [700]),
    ("ZOOM.US 888-799", [1300]),
    ("CURSOR AI IDE", [1700]),
    ("GITHUB *COPILOT", [830]),
    ("DISNEY+ HOTSTAR {id}", [299]),
    ("VERCEL INC", [1700]),
    ("NOTION LABS INC", [800]),
    ("CULT.FIT MEMBERSHIP", [1499]),
    ("UPI/KINDLEVERSE READS/{id}", [169]),
    ("AUTOPAY STREAMBOX PLUS", [349]),
]
SUB_YEARLY = [
    ("AMAZON PRIME ANNUAL", [1499]),
    ("DROPBOX PLUS ANNUAL", [9900]),
    ("GOOGLE ONE 2TB YEARLY", [6500]),
    ("APPLE.COM/BILL ICLOUD", [900]),
    ("ADOBE *CREATIVE CLOUD ANNUAL", [19000]),
    ("RAZORPAY*NEWSDAILY ANNUAL", [999]),
]
IRREGULAR = [
    ("SWIGGY BANGALORE", 420), ("UBER TRIP {id}", 230), ("STARBUCKS COFFEE", 350),
    ("BLINKIT COMMERCE", 640), ("ZOMATO ORDER", 480), ("BIGBASKET {id}", 1500),
    ("POS PURCHASE - CROSSWORD BOOKS", 700), ("PVR CINEMAS", 600),
    ("INDIAN OIL PETROL PUMP", 2000), ("DMART READY", 1800),
]
UTILITY = [
    ("MSEDCL ELECTRICITY BILL", 1800), ("MAHANAGAR GAS LTD", 750),
    ("BWSSB WATER CHARGES", 400), ("TATA POWER ELECTRICITY", 2200),
]
RENT = [("NEFT RENT TO LANDLORD", None), ("IMPS HOUSE RENT", None)]
EMI = [("BAJAJ FINSERV EMI", None), ("HOME CREDIT EMI", None)]
AMBIG_SHORT = [("PIXELPLAY GAMES", 299), ("SKILLHUB COURSES", 999), ("MEDITATE APP", 199)]
AMBIG_SEMI = [("LOCAL GYM KIOSK", 900), ("CLOUDKITCHEN MEALPASS", 1200), ("PARKING WALLET TOPUP", 500)]

ARCHETYPE_LABEL = {
    "monthly_stable": "subscription",
    "monthly_price_increase": "subscription",
    "monthly_cancelled": "subscription",
    "yearly": "subscription",
    "irregular_spend": "non_subscription",
    "utility_bill": "non_subscription",
    "rent": "non_subscription",
    "emi_installment": "non_subscription",
    "ambiguous_short_history": "ambiguous",
    "ambiguous_semi_regular": "ambiguous",
}


def _add_months(d: date, months: int, day: int) -> date:
    y, m = divmod(d.month - 1 + months, 12)
    year, month = d.year + y, m + 1
    return date(year, month, min(day, calendar.monthrange(year, month)[1]))


class _Gen:
    def __init__(self, seed: int):
        self.rng = np.random.default_rng(seed)

    def rid(self) -> str:
        return f"{int(self.rng.integers(1000, 10000))}"

    def rand_date(self, lo: date, hi: date) -> date:
        return lo + timedelta(days=int(self.rng.integers(0, (hi - lo).days + 1)))

    def monthly(self, start: date, n: int, jitter: int) -> list:
        day = start.day
        out = []
        for k in range(n):
            d = _add_months(start, k, day) + timedelta(days=int(self.rng.integers(0, jitter + 1)))
            if d > END:
                break
            out.append(d)
        return out


def generate_synthetic_transactions(seed: int = 42, n_users: int = 40) -> pd.DataFrame:
    """Return raw synthetic transactions (+ ground-truth archetype/label columns)."""
    g = _Gen(seed)
    rng = g.rng
    rows = []

    for u in range(n_users):
        user = f"synthetic_user_{u:03d}"
        main_acct = f"SYNBANK •••• {int(rng.integers(1000, 10000))}"
        groups = []  # (archetype, template, list[(date, amount)])

        # --- subscriptions -------------------------------------------------
        n_month = int(rng.integers(3, 7))
        for idx in rng.choice(len(SUB_MONTHLY), size=n_month, replace=False):
            tpl, prices = SUB_MONTHLY[idx]
            price = float(rng.choice(prices))
            arche = str(rng.choice(["monthly_stable", "monthly_price_increase", "monthly_cancelled"],
                                   p=[0.6, 0.2, 0.2]))
            start = g.rand_date(START, date(2025, 3, 1))
            if arche == "monthly_cancelled":
                dates = g.monthly(start, int(rng.integers(4, 11)), jitter=2)
            else:
                dates = g.monthly(start, 60, jitter=2)
            amts = [price] * len(dates)
            if arche == "monthly_price_increase" and len(dates) >= 5:
                k = int(rng.integers(3, len(dates) - 1))
                new_price = float(round(price * rng.uniform(1.10, 1.35)))
                amts = [price] * k + [new_price] * (len(dates) - k)
            groups.append((arche, tpl, list(zip(dates, amts))))

        for idx in rng.choice(len(SUB_YEARLY), size=int(rng.integers(0, 3)), replace=False):
            tpl, prices = SUB_YEARLY[idx]
            start = g.rand_date(START, date(2024, 12, 31))
            dates = []
            for k in range(3):
                d = date(start.year + k, start.month, min(start.day, 28)) + timedelta(days=int(rng.integers(0, 4)))
                if d <= END:
                    dates.append(d)
            groups.append(("yearly", tpl, [(d, float(prices[0])) for d in dates]))

        # --- non-subscriptions ---------------------------------------------
        for idx in rng.choice(len(IRREGULAR), size=int(rng.integers(3, 6)), replace=False):
            tpl, base = IRREGULAR[idx]
            lo = g.rand_date(START, date(2025, 6, 1))
            n = int(rng.integers(6, 41))
            dates = sorted(g.rand_date(lo, END) for _ in range(n))
            amts = [float(round(base * rng.lognormal(0, 0.45))) or 1.0 for _ in dates]
            groups.append(("irregular_spend", tpl, list(zip(dates, amts))))

        for idx in rng.choice(len(UTILITY), size=int(rng.integers(1, 3)), replace=False):
            tpl, base = UTILITY[idx]
            start = g.rand_date(START, date(2024, 12, 31))
            dates = g.monthly(start, 60, jitter=5)
            amts = [float(max(50, round(base * (1 + rng.normal(0, 0.18))))) for _ in dates]
            groups.append(("utility_bill", tpl, list(zip(dates, amts))))

        if rng.random() < 0.6:
            tpl, _ = RENT[int(rng.integers(0, len(RENT)))]
            rent = float(rng.integers(24, 71) * 500)
            start = date(2024, int(rng.integers(1, 7)), int(rng.integers(1, 6)))
            dates = g.monthly(start, 60, jitter=3)
            amts = [rent if k < 11 else float(round(rent * 1.07 / 100) * 100) for k in range(len(dates))]
            groups.append(("rent", tpl, list(zip(dates, amts))))

        if rng.random() < 0.4:
            tpl, _ = EMI[int(rng.integers(0, len(EMI)))]
            emi = float(rng.integers(20, 120) * 100)
            start = g.rand_date(START, date(2025, 9, 1))
            dates = g.monthly(start, int(rng.choice([6, 9, 12, 24])), jitter=1)
            groups.append(("emi_installment", tpl, [(d, emi) for d in dates]))

        # --- ambiguous -------------------------------------------------------
        if rng.random() < 0.5:
            tpl, base = AMBIG_SHORT[int(rng.integers(0, len(AMBIG_SHORT)))]
            d1 = g.rand_date(START, date(2026, 6, 1))
            d2 = d1 + timedelta(days=int(rng.integers(28, 34)))
            groups.append(("ambiguous_short_history", tpl, [(d1, float(base)), (d2, float(base))]))
        if rng.random() < 0.5:
            tpl, base = AMBIG_SEMI[int(rng.integers(0, len(AMBIG_SEMI)))]
            d = g.rand_date(START, date(2025, 12, 1))
            pts = []
            for _ in range(int(rng.integers(5, 10))):
                if d > END:
                    break
                pts.append((d, float(round(base * rng.uniform(0.85, 1.15)))))
                d = d + timedelta(days=int(rng.integers(20, 51)))
            groups.append(("ambiguous_semi_regular", tpl, pts))

        # --- emit rows -------------------------------------------------------
        seen_keys = {}
        for arche, tpl, pts in groups:
            key = normalize_merchant(tpl.replace("{id}", "1234")).canonicalKey
            if key in seen_keys and seen_keys[key] != arche:
                raise AssertionError(f"merchant key collision {key}: {seen_keys[key]} vs {arche}")
            seen_keys[key] = arche
            for d, amt in pts:
                rows.append({
                    "date": d, "merchant": tpl.replace("{id}", g.rid()), "amount": amt,
                    "account": main_acct, "currency": "INR", "user_id": user,
                    "archetype": arche, "label": ARCHETYPE_LABEL[arche], "label_source": "synthetic",
                })

    df = pd.DataFrame(rows)
    df = df.sort_values(["user_id", "date", "merchant"], kind="mergesort").reset_index(drop=True)
    df["reference"] = [f"SYN-{i:07d}" for i in range(len(df))]

    df = _inject_quality_issues(df, rng)

    # Mixed date formats (10% day-first) to exercise the date parser.
    as_text = []
    for d in df["date"]:
        if isinstance(d, date) and rng.random() < 0.10:
            as_text.append(d.strftime("%d/%m/%Y"))
        elif isinstance(d, date):
            as_text.append(d.isoformat())
        else:
            as_text.append(str(d))
    df["date"] = as_text
    df["amount"] = df["amount"].map(lambda a: a if isinstance(a, str) else f"{a:.2f}")
    cols = ["reference", "date", "merchant", "amount", "account", "currency", "user_id",
            "archetype", "label", "label_source"]
    return df[cols]


def _inject_quality_issues(df: pd.DataFrame, rng) -> pd.DataFrame:
    """Add realistic dirty records so preprocessing paths are exercised."""
    extra = []
    sub_idx = df.index[df["label"] == "subscription"].to_numpy()

    # 1) Genuine double charges: new bank record (new reference), same day/amount.
    for i in rng.choice(sub_idx, size=max(1, len(sub_idx) // 150), replace=False):
        r = df.loc[i].to_dict()
        r["reference"] = r["reference"] + "-DC"
        extra.append(r)
    # 2) Same bank record imported twice (identical reference) -> verified duplicate.
    for i in rng.choice(df.index.to_numpy(), size=max(1, len(df) // 200), replace=False):
        extra.append(df.loc[i].to_dict())
    # 3) Invalid / unusable rows. Labels kept only so the columns line up;
    #    these rows are expected to be EXCLUDED by preprocessing.
    template = df.iloc[0].to_dict()
    bad = [
        {"date": "31/02/2026", "reason": "invalid date"},
        {"date": "not-a-date", "reason": "invalid date"},
        {"merchant": "", "reason": "missing merchant"},
        {"amount": "-499.00", "reason": "refund"},
        {"amount": "0.00", "reason": "zero-amount card verification"},
        {"amount": "abc", "reason": "invalid amount"},
        {"currency": "USD", "reason": "foreign currency"},
    ]
    for k, b in enumerate(bad):
        r = dict(template)
        r.update({kk: vv for kk, vv in b.items() if kk != "reason"})
        r["reference"] = f"SYN-BAD-{k:03d}"
        extra.append(r)
    out = pd.concat([df, pd.DataFrame(extra)], ignore_index=True)
    return out
