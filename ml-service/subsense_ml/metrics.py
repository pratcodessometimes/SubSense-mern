"""Evaluation metrics (NumPy only). Accuracy alone is never reported on its own."""

from __future__ import annotations

from typing import Callable, Sequence

import numpy as np


def confusion_matrix(y_true: Sequence, y_pred: Sequence, labels: Sequence) -> np.ndarray:
    """Rows = true class, columns = predicted class (same order as `labels`)."""
    index = {l: i for i, l in enumerate(labels)}
    cm = np.zeros((len(labels), len(labels)), dtype=int)
    for t, p in zip(y_true, y_pred):
        cm[index[t], index[p]] += 1
    return cm


def classification_report(y_true: Sequence, y_pred: Sequence, labels: Sequence) -> dict:
    """Per-class precision/recall/F1/support plus macro & weighted averages.

    A precision whose denominator is 0 (class never predicted) is reported as
    0.0 and listed in `undefined_precision`, so it is visible, not hidden.
    """
    cm = confusion_matrix(y_true, y_pred, labels)
    tp = np.diag(cm).astype(float)
    pred_pos = cm.sum(axis=0).astype(float)
    support = cm.sum(axis=1).astype(float)
    precision = np.divide(tp, pred_pos, out=np.zeros_like(tp), where=pred_pos > 0)
    recall = np.divide(tp, support, out=np.zeros_like(tp), where=support > 0)
    denom = precision + recall
    f1 = np.divide(2 * precision * recall, denom, out=np.zeros_like(tp), where=denom > 0)
    present = support > 0
    report = {
        "per_class": {
            str(l): {"precision": round(float(precision[i]), 4), "recall": round(float(recall[i]), 4),
                     "f1": round(float(f1[i]), 4), "support": int(support[i])}
            for i, l in enumerate(labels)
        },
        "macro_f1": round(float(f1[present].mean()), 4) if present.any() else 0.0,
        "macro_precision": round(float(precision[present].mean()), 4) if present.any() else 0.0,
        "macro_recall": round(float(recall[present].mean()), 4) if present.any() else 0.0,
        "weighted_f1": round(float(np.sum(f1 * support) / support.sum()), 4) if support.sum() else 0.0,
        "accuracy": round(float(tp.sum() / cm.sum()), 4) if cm.sum() else 0.0,
        "n": int(cm.sum()),
        "undefined_precision": [str(l) for i, l in enumerate(labels) if pred_pos[i] == 0 and support[i] > 0],
        "confusion_matrix": {"labels": [str(l) for l in labels], "matrix": cm.tolist()},
    }
    return report


def macro_f1(y_true, y_pred, labels) -> float:
    return classification_report(y_true, y_pred, labels)["macro_f1"]


def group_bootstrap_ci(y_true, y_pred, groups, metric: Callable, n_boot: int = 1000,
                       alpha: float = 0.05, seed: int = 0) -> tuple:
    """Confidence interval that resamples whole GROUPS (not rows), because rows
    from the same merchant group are correlated."""
    y_true, y_pred, groups = np.asarray(y_true), np.asarray(y_pred), np.asarray(groups)
    uniq = np.unique(groups)
    members = {g: np.nonzero(groups == g)[0] for g in uniq}
    rng = np.random.default_rng(seed)
    stats = []
    for _ in range(n_boot):
        pick = rng.choice(uniq, size=len(uniq), replace=True)
        idx = np.concatenate([members[g] for g in pick])
        stats.append(metric(y_true[idx], y_pred[idx]))
    lo, hi = np.quantile(stats, [alpha / 2, 1 - alpha / 2])
    return round(float(lo), 4), round(float(hi), 4)


def roc_auc(y_true: Sequence[int], scores: Sequence[float]) -> float:
    """Probability that a random positive scores higher than a random negative (ties = 0.5)."""
    y, s = np.asarray(y_true).astype(int), np.asarray(scores, float)
    pos, neg = s[y == 1], s[y == 0]
    if len(pos) == 0 or len(neg) == 0:
        return float("nan")
    order = np.argsort(s, kind="mergesort")
    ranks = np.empty(len(s))
    sorted_s = s[order]
    i = 0
    while i < len(s):                     # average ranks for ties
        j = i
        while j + 1 < len(s) and sorted_s[j + 1] == sorted_s[i]:
            j += 1
        ranks[order[i:j + 1]] = (i + j) / 2 + 1
        i = j + 1
    r_pos = ranks[y == 1].sum()
    return float((r_pos - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg)))


def average_precision(y_true: Sequence[int], scores: Sequence[float]) -> float:
    """Area under the precision-recall curve (step-wise), threshold-free."""
    y, s = np.asarray(y_true).astype(int), np.asarray(scores, float)
    if y.sum() == 0:
        return float("nan")
    order = np.argsort(-s, kind="mergesort")
    y = y[order]
    tp = np.cumsum(y)
    precision = tp / np.arange(1, len(y) + 1)
    return float(np.sum(precision[y == 1]) / y.sum())


def binary_report(y_true: Sequence[int], y_pred: Sequence[int]) -> dict:
    y, p = np.asarray(y_true).astype(int), np.asarray(y_pred).astype(int)
    tp = int(np.sum((y == 1) & (p == 1)))
    fp = int(np.sum((y == 0) & (p == 1)))
    fn = int(np.sum((y == 1) & (p == 0)))
    tn = int(np.sum((y == 0) & (p == 0)))
    prec = tp / (tp + fp) if tp + fp else 0.0
    rec = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * prec * rec / (prec + rec) if prec + rec else 0.0
    return {"tp": tp, "fp": fp, "fn": fn, "tn": tn, "precision": round(prec, 4),
            "recall": round(rec, 4), "f1": round(f1, 4)}
