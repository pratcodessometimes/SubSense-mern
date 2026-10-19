"""
Phase 3.2 — anomaly detection for unusual AMOUNTS or PAYMENT INTERVALS.

Kept completely separate from subscription classification:
  * classification asks "is this merchant group a subscription?"
  * anomaly detection asks "inside a known recurring group, is THIS payment unusual?"

Method 1 — transparent robust deviation (primary):
    For payment i, look only at the previous WINDOW payments of the same group
    (never at later ones). Compare its amount and its gap-since-previous-payment
    with the median of that history, scaled by the MAD (median absolute
    deviation). |robust z| > 3.5 => anomaly (Iglewicz & Hoaglin's rule of thumb).
    Floors stop a perfectly constant history (MAD = 0) from flagging 1-rupee
    changes. Every flag comes with a human-readable reason.

Method 2 — Isolation Forest (comparison):
    Unsupervised; isolates points that are easy to separate with random splits.
    Fitted on the TRAIN-split groups' deviation features, applied to TEST groups.

Ground truth for evaluation is INJECTED by us into synthetic data, so the
numbers measure whether the detectors find the anomaly types we planted, not
real-world fraud or billing errors.
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd

from .metrics import average_precision, binary_report, roc_auc

WINDOW = 6                  # how many previous payments form the "normal" reference
MIN_HISTORY = 3             # need >= 3 previous payments before scoring
Z_THRESHOLD = 3.5
MAD_TO_STD = 1.4826         # makes MAD comparable to a standard deviation for normal data
AMOUNT_FLOOR_REL = 0.02     # amount deviations under ~2% of the median are never "large"
INTERVAL_FLOOR_DAYS = 2.0
INTERVAL_FLOOR_REL = 0.05

POSITIVE_TYPES = ("amount_spike", "duplicate_charge", "off_cycle", "generated_double_charge")
NATURAL_TYPES = ("natural_price_change",)


# ---------------------------------------------------------------------------
# Leakage-safe per-transaction deviation features
# ---------------------------------------------------------------------------
def score_sequence(day_numbers, amounts) -> list:
    """REFERENCE IMPLEMENTATION of the robust deviation detector for ONE group.

    `day_numbers`: integer UTC day numbers (e.g. days since 1970-01-01), already
    sorted ascending (ties kept in input order). `amounts`: positive floats.
    Returns one dict per payment index i >= MIN_HISTORY, computed ONLY from the
    previous WINDOW payments (indices i-WINDOW .. i-1) — never from i itself or later.

    The Node.js port (backend/src/services/paymentAnomalyService.js) must give the
    same numbers; scripts/export_anomaly_parity_fixture.py exports shared fixtures.
    """
    days = np.asarray(day_numbers, dtype=float)
    amts = np.asarray(amounts, dtype=float)
    out = []
    for i in range(MIN_HISTORY, len(amts)):
        lo = max(0, i - WINDOW)
        w_amt = amts[lo:i]
        w_days = days[lo:i]
        med_a = float(np.median(w_amt))
        mad_a = float(np.median(np.abs(w_amt - med_a)))
        # Zero-MAD guard: a perfectly constant history has MAD = 0, so the scale
        # falls back to 2% of the median (amount) / 2 days or 5% (interval).
        scale_a = max(MAD_TO_STD * mad_a, AMOUNT_FLOOR_REL * med_a, 1e-9)
        amount_z = (amts[i] - med_a) / scale_a

        w_int = np.diff(w_days)
        cur_int = float(days[i] - days[i - 1])
        med_i = float(np.median(w_int))
        mad_i = float(np.median(np.abs(w_int - med_i)))
        scale_i = max(MAD_TO_STD * mad_i, INTERVAL_FLOOR_DAYS, INTERVAL_FLOOR_REL * med_i)
        interval_z = (cur_int - med_i) / scale_i

        score = max(abs(amount_z), abs(interval_z))
        reason = ""
        if score > Z_THRESHOLD:
            if abs(amount_z) >= abs(interval_z):
                reason = "amount_higher_than_usual" if amount_z > 0 else "amount_lower_than_usual"
            else:
                reason = "paid_earlier_than_usual_or_duplicate" if interval_z < 0 else "paid_later_than_usual"
        out.append({
            "index": i, "history_used": i - lo,
            "ref_median_amount": med_a, "ref_median_interval": med_i, "interval_days": cur_int,
            "amount_z": float(amount_z), "interval_z": float(interval_z),
            "robust_score": float(score), "robust_flag": int(score > Z_THRESHOLD), "robust_reason": reason,
        })
    return out


def _day_numbers(dates: pd.Series) -> np.ndarray:
    return (pd.to_datetime(dates).to_numpy().astype("datetime64[D]").astype("int64"))


def deviation_features(clean_tx: pd.DataFrame) -> pd.DataFrame:
    """One row per transaction that has >= MIN_HISTORY earlier payments in its group."""
    rows = []
    keep = [c for c in ("anomaly_type", "archetype", "label") if c in clean_tx.columns]
    for gid, g in clean_tx.groupby("group_id", sort=True):
        g = g.sort_values(["date", "row_id"], kind="mergesort")
        amts = g["amount"].to_numpy(dtype=float)
        for s in score_sequence(_day_numbers(g["date"]), amts):
            i = s["index"]
            med_a, med_i, cur_int = s["ref_median_amount"], s["ref_median_interval"], s["interval_days"]
            rec = {
                "group_id": gid, "row_id": int(g["row_id"].iloc[i]), "date": g["date"].iloc[i],
                "amount": amts[i], "history_used": s["history_used"],
                "ref_median_amount": med_a, "ref_median_interval": med_i, "interval_days": cur_int,
                "amount_z": s["amount_z"], "interval_z": s["interval_z"],
                "amount_log_ratio": math.log(amts[i] / med_a) if med_a > 0 else 0.0,
                "interval_log_ratio": math.log((cur_int + 1.0) / (med_i + 1.0)),
                "robust_score": s["robust_score"], "robust_flag": s["robust_flag"],
                "robust_reason": s["robust_reason"],
            }
            for c in keep:
                rec[c] = g[c].iloc[i]
            rows.append(rec)
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# Isolation Forest (NumPy implementation of Liu, Ting & Zhou, 2008)
# ---------------------------------------------------------------------------
def _c(n: float) -> float:
    """Average path length of an unsuccessful BST search over n points."""
    if n <= 1:
        return 0.0
    if n == 2:
        return 1.0
    return 2.0 * (math.log(n - 1) + 0.5772156649) - 2.0 * (n - 1) / n


class IsolationForest:
    def __init__(self, n_estimators: int = 200, max_samples: int = 256, random_state: int = 0):
        self.n_estimators, self.max_samples, self.random_state = n_estimators, max_samples, random_state

    def fit(self, X: np.ndarray):
        X = np.asarray(X, float)
        rng = np.random.default_rng(self.random_state)
        self.psi_ = min(self.max_samples, len(X))
        limit = math.ceil(math.log2(max(self.psi_, 2)))
        self.trees_ = []
        for _ in range(self.n_estimators):
            sample = X[rng.choice(len(X), self.psi_, replace=False)]
            self.trees_.append(self._grow(sample, 0, limit, rng))
        return self

    def _grow(self, X, depth, limit, rng):
        if depth >= limit or len(X) <= 1:
            return ("leaf", len(X))
        lo, hi = X.min(axis=0), X.max(axis=0)
        splittable = np.nonzero(hi > lo)[0]
        if len(splittable) == 0:
            return ("leaf", len(X))
        f = int(rng.choice(splittable))
        t = float(rng.uniform(lo[f], hi[f]))
        mask = X[:, f] < t
        return ("node", f, t, self._grow(X[mask], depth + 1, limit, rng),
                self._grow(X[~mask], depth + 1, limit, rng))

    def _path(self, x, node, depth=0):
        while node[0] == "node":
            _, f, t, left, right = node
            node = left if x[f] < t else right
            depth += 1
        return depth + _c(node[1])

    def score_samples(self, X: np.ndarray) -> np.ndarray:
        """Anomaly score in (0, 1]; higher = more anomalous (~0.5 = normal)."""
        X = np.asarray(X, float)
        mean_path = np.array([np.mean([self._path(x, t) for t in self.trees_]) for x in X])
        return 2.0 ** (-mean_path / _c(self.psi_))


IF_FEATURES = ["amount_log_ratio", "interval_log_ratio"]


# ---------------------------------------------------------------------------
# Synthetic anomaly injection (evaluation ground truth)
# ---------------------------------------------------------------------------
def inject_anomalies(clean_tx: pd.DataFrame, seed: int = 42, group_rate: float = 0.35) -> pd.DataFrame:
    """Copy `clean_tx` (recurring groups) and plant ONE known anomaly in a share of groups.

    anomaly_type values:
        ""                         normal payment
        amount_spike               amount x1.5-3.0
        duplicate_charge           extra identical charge 0-2 days after a real one
        off_cycle                  payment moved 8-14 days off its usual day (monthly only)
        generated_double_charge    double charges already planted by the Phase 3.1 generator
        natural_price_change       first <= WINDOW payments after a genuine price rise
                                   (not an error; excluded from precision/recall, reported apart)
    """
    rng = np.random.default_rng(seed)
    df = clean_tx.sort_values(["group_id", "date", "row_id"], kind="mergesort").reset_index(drop=True).copy()
    df["anomaly_type"] = ""
    if "reference" in df.columns:
        df.loc[df["reference"].astype(str).str.endswith("-DC"), "anomaly_type"] = "generated_double_charge"

    # Mark genuine price changes (known from the generator archetype).
    if "archetype" in df.columns:
        for _, g in df[df["archetype"] == "monthly_price_increase"].groupby("group_id"):
            amts = g["amount"].to_numpy()
            change = np.nonzero(amts != amts[0])[0]
            if len(change):
                idx = g.index[change[0]: change[0] + WINDOW]
                df.loc[idx, "anomaly_type"] = df.loc[idx, "anomaly_type"].where(
                    df.loc[idx, "anomaly_type"] != "", "natural_price_change")

    next_row_id = int(df["row_id"].max()) + 1
    extra = []
    for gid in sorted(df["group_id"].unique()):
        if rng.random() >= group_rate:
            continue
        g = df[df["group_id"] == gid]
        candidates = [i for i in g.index[MIN_HISTORY + 1:] if df.at[i, "anomaly_type"] == ""]
        if not candidates:
            continue
        i = int(rng.choice(candidates))
        med_gap = float(np.median(np.diff(g["date"].to_numpy()).astype("timedelta64[D]").astype(float)))
        kinds = ["amount_spike", "duplicate_charge"] + (["off_cycle"] if med_gap < 60 else [])
        kind = str(rng.choice(kinds))
        if kind == "amount_spike":
            df.at[i, "amount"] = round(float(df.at[i, "amount"]) * float(rng.uniform(1.5, 3.0)), 2)
            df.at[i, "anomaly_type"] = kind
        elif kind == "duplicate_charge":
            row = df.loc[i].copy()
            row["date"] = row["date"] + pd.Timedelta(days=int(rng.integers(0, 3)))
            row["row_id"] = next_row_id
            row["anomaly_type"] = kind
            next_row_id += 1
            extra.append(row)
        else:
            pos = list(g.index).index(i)
            prev_d, cur_d = g["date"].iloc[pos - 1], g["date"].iloc[pos]
            next_d = g["date"].iloc[pos + 1] if pos + 1 < len(g) else cur_d + pd.Timedelta(days=60)
            shift = int(rng.integers(8, 15)) * (1 if rng.random() < 0.5 else -1)
            new_d = cur_d + pd.Timedelta(days=shift)
            if prev_d < new_d < next_d:
                df.at[i, "date"] = new_d
                df.at[i, "anomaly_type"] = kind
    if extra:
        df = pd.concat([df, pd.DataFrame(extra)], ignore_index=True)
    return df.sort_values(["group_id", "date", "row_id"], kind="mergesort").reset_index(drop=True)


# ---------------------------------------------------------------------------
# Experiment
# ---------------------------------------------------------------------------
def _calibrate_threshold(scores: np.ndarray, y: np.ndarray) -> float:
    """Pick the score threshold with the best F1 on the TRAINING split."""
    best_t, best_f1 = float(np.max(scores)) + 1, -1.0
    for t in np.unique(scores):
        f1 = binary_report(y, scores >= t)["f1"]
        if f1 > best_f1:
            best_f1, best_t = f1, float(t)
    return best_t


def _summarise(df: pd.DataFrame, flag_col: str, score_col: str) -> dict:
    evald = df[~df["anomaly_type"].isin(NATURAL_TYPES)]
    y = evald["anomaly_type"].isin(POSITIVE_TYPES).to_numpy()
    rep = binary_report(y, evald[flag_col].to_numpy().astype(bool))
    rep["average_precision"] = round(average_precision(y, evald[score_col]), 4)
    rep["roc_auc"] = round(roc_auc(y, evald[score_col]), 4)
    rep["n_scored"] = int(len(evald))
    rep["n_positive"] = int(y.sum())
    rep["recall_by_type"] = {
        t: round(float(evald.loc[evald["anomaly_type"] == t, flag_col].mean()), 4)
        for t in POSITIVE_TYPES if (evald["anomaly_type"] == t).any()}
    nat = df[df["anomaly_type"].isin(NATURAL_TYPES)]
    rep["natural_price_change_rows"] = int(len(nat))
    rep["natural_price_change_flagged"] = int(nat[flag_col].sum())
    rep["flag_rate_on_normal_rows"] = round(float(evald.loc[~y, flag_col].mean()), 4) if (~y).any() else 0.0
    return rep


def run_anomaly_experiment(build, seed: int = 42, if_trees: int = 200) -> dict:
    """Score payments in SUBSCRIPTION groups (known recurring) of the synthetic build."""
    split = build.features.groupby("group_id")["split"].first()
    labels = build.features.groupby("group_id")["label"].first()
    rec_groups = labels[labels == "subscription"].index
    base = build.clean[build.clean["group_id"].isin(rec_groups)]
    injected = inject_anomalies(base, seed=seed)
    feats = deviation_features(injected)
    feats["split"] = feats["group_id"].map(split)
    train, test = feats[feats["split"] == "train"].copy(), feats[feats["split"] == "test"].copy()

    forest = IsolationForest(n_estimators=if_trees, random_state=seed).fit(train[IF_FEATURES].to_numpy())
    train["if_score"] = forest.score_samples(train[IF_FEATURES].to_numpy())
    test["if_score"] = forest.score_samples(test[IF_FEATURES].to_numpy())
    tr_eval = train[~train["anomaly_type"].isin(NATURAL_TYPES)]
    thr = _calibrate_threshold(tr_eval["if_score"].to_numpy(),
                               tr_eval["anomaly_type"].isin(POSITIVE_TYPES).to_numpy())
    train["if_flag"] = (train["if_score"] >= thr).astype(int)
    test["if_flag"] = (test["if_score"] >= thr).astype(int)

    results = {
        "protocol": {
            "scope": "payments inside groups labelled 'subscription' (synthetic)",
            "window": WINDOW, "min_history": MIN_HISTORY, "robust_z_threshold": Z_THRESHOLD,
            "isolation_forest": {"n_estimators": if_trees, "max_samples": 256, "features": IF_FEATURES,
                                 "threshold_calibrated_on": "train split (max F1)",
                                 "threshold": round(thr, 6)},
            "seed": seed,
            "n_groups": int(feats["group_id"].nunique()),
            "n_scored_train": int(len(train)), "n_scored_test": int(len(test)),
            "test_anomaly_type_counts": {k if k else "normal": int(v) for k, v in
                                         test["anomaly_type"].value_counts().sort_index().items()},
        },
        "test": {
            "robust_deviation": _summarise(test, "robust_flag", "robust_score"),
            "isolation_forest": _summarise(test, "if_flag", "if_score"),
        },
    }
    return {"results": results, "scored_test": test, "scored_train": train, "forest": forest}
