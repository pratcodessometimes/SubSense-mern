"""
Small, dependency-free (NumPy only) classifiers for Phase 3.2.

WHY NOT scikit-learn?
    scikit-learn was not installed on the development machine and the package
    index was unreachable, so results could not have been produced with it.
    These implementations follow the standard textbook algorithms (the same
    ones scikit-learn implements) and are unit-tested. When scikit-learn is
    installed, tests/test_sklearn_crosscheck.py compares them against it.

All models share the interface:
    fit(X, y, sample_weight=None) -> self      y: integer class ids 0..k-1
    predict_proba(X) -> (n, k) array
    predict(X) -> (n,) integer class ids
Ties are always broken deterministically (lowest index wins).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np


def balanced_sample_weights(y: np.ndarray, n_classes: int) -> np.ndarray:
    """weight_c = n / (k * n_c)  — every class contributes equally in total."""
    counts = np.bincount(y, minlength=n_classes).astype(float)
    per_class = np.where(counts > 0, len(y) / (n_classes * np.maximum(counts, 1)), 0.0)
    return per_class[y]


# ---------------------------------------------------------------------------
# Preprocessing (fit on TRAIN only, then applied to test -> no leakage)
# ---------------------------------------------------------------------------
class MedianImputer:
    def fit(self, X: np.ndarray):
        with np.errstate(all="ignore"):
            med = np.nanmedian(np.where(np.isfinite(X), X, np.nan), axis=0)
        self.medians_ = np.where(np.isnan(med), 0.0, med)
        return self

    def transform(self, X: np.ndarray) -> np.ndarray:
        X = np.array(X, dtype=float, copy=True)
        bad = ~np.isfinite(X)
        X[bad] = np.take(self.medians_, np.nonzero(bad)[1])
        return X


class StandardScaler:
    def fit(self, X: np.ndarray):
        self.mean_ = X.mean(axis=0)
        std = X.std(axis=0)
        self.scale_ = np.where(std > 1e-12, std, 1.0)
        return self

    def transform(self, X: np.ndarray) -> np.ndarray:
        return (X - self.mean_) / self.scale_


# ---------------------------------------------------------------------------
# Baseline: always predict the most frequent (weighted) class
# ---------------------------------------------------------------------------
class MajorityClassifier:
    def __init__(self, n_classes: int):
        self.n_classes = n_classes

    def fit(self, X, y, sample_weight=None):
        w = np.ones(len(y)) if sample_weight is None else sample_weight
        self.class_ = int(np.argmax(np.bincount(y, weights=w, minlength=self.n_classes)))
        return self

    def predict_proba(self, X):
        p = np.zeros((len(X), self.n_classes))
        p[:, self.class_] = 1.0
        return p

    def predict(self, X):
        return np.full(len(X), self.class_, dtype=int)


# ---------------------------------------------------------------------------
# Multinomial logistic regression (softmax) with L2, full-batch gradient descent
# ---------------------------------------------------------------------------
class LogisticRegression:
    """Interpretable linear model. Expects standardized, NaN-free X."""

    def __init__(self, n_classes: int, l2: float = 1e-2, lr: float = 0.5,
                 max_iter: int = 5000, tol: float = 1e-7):
        self.n_classes, self.l2, self.lr, self.max_iter, self.tol = n_classes, l2, lr, max_iter, tol

    @staticmethod
    def _softmax(z):
        z = z - z.max(axis=1, keepdims=True)
        e = np.exp(z)
        return e / e.sum(axis=1, keepdims=True)

    def fit(self, X, y, sample_weight=None):
        n, d = X.shape
        k = self.n_classes
        w = np.ones(n) if sample_weight is None else np.asarray(sample_weight, float)
        w = w / w.sum()
        Y = np.eye(k)[y]
        self.coef_ = np.zeros((d, k))       # zero init -> fully deterministic
        self.intercept_ = np.zeros(k)
        prev = np.inf
        for it in range(self.max_iter):
            P = self._softmax(X @ self.coef_ + self.intercept_)
            loss = -np.sum(w * np.log(np.sum(P * Y, axis=1) + 1e-15)) + 0.5 * self.l2 * np.sum(self.coef_ ** 2)
            G = (P - Y) * w[:, None]
            self.coef_ -= self.lr * (X.T @ G + self.l2 * self.coef_)
            self.intercept_ -= self.lr * G.sum(axis=0)
            if abs(prev - loss) < self.tol:
                break
            prev = loss
        self.n_iter_, self.loss_ = it + 1, float(loss)
        return self

    def predict_proba(self, X):
        return self._softmax(X @ self.coef_ + self.intercept_)

    def predict(self, X):
        return np.argmax(self.predict_proba(X), axis=1)


# ---------------------------------------------------------------------------
# CART decision tree (Gini impurity, weighted)
# ---------------------------------------------------------------------------
@dataclass
class _Node:
    feature: int = -1
    threshold: float = 0.0
    left: int = -1
    right: int = -1
    value: np.ndarray = None   # weighted class distribution (sums to 1)
    n_samples: int = 0


class DecisionTreeClassifier:
    def __init__(self, n_classes: int, max_depth: int = 5, min_samples_leaf: int = 5,
                 max_features: int | None = None, random_state: int | None = None):
        self.n_classes = n_classes
        self.max_depth = max_depth
        self.min_samples_leaf = min_samples_leaf
        self.max_features = max_features
        self.random_state = random_state

    def fit(self, X, y, sample_weight=None, rng: np.random.Generator | None = None):
        X = np.asarray(X, float)
        if not np.isfinite(X).all():
            raise ValueError("DecisionTreeClassifier needs NaN-free input (impute first)")
        n, d = X.shape
        w = np.ones(n) if sample_weight is None else np.asarray(sample_weight, float)
        self._rng = rng if rng is not None else np.random.default_rng(self.random_state)
        self.n_features_ = d
        self.nodes_: list[_Node] = []
        self._importance = np.zeros(d)
        self._Y = np.eye(self.n_classes)[y] * w[:, None]
        self._X = X
        self._build(np.arange(n), depth=0)
        total = self._importance.sum()
        self.feature_importances_ = self._importance / total if total > 0 else self._importance
        del self._X, self._Y
        return self

    def _gini(self, counts):
        tot = counts.sum(axis=-1)
        with np.errstate(invalid="ignore", divide="ignore"):
            p = counts / tot[..., None]
        return np.where(tot > 0, 1.0 - np.sum(p * p, axis=-1), 0.0)

    def _build(self, idx, depth) -> int:
        counts = self._Y[idx].sum(axis=0)
        node_id = len(self.nodes_)
        tot = counts.sum()
        self.nodes_.append(_Node(value=counts / tot if tot > 0 else counts, n_samples=len(idx)))
        parent_imp = self._gini(counts) * tot

        if depth >= self.max_depth or len(idx) < 2 * self.min_samples_leaf or parent_imp <= 1e-12:
            return node_id

        feats = np.arange(self.n_features_)
        if self.max_features is not None and self.max_features < self.n_features_:
            feats = np.sort(self._rng.choice(self.n_features_, self.max_features, replace=False))

        best = (parent_imp - 1e-12, -1, 0.0)  # (impurity, feature, threshold)
        m = self.min_samples_leaf
        Yi = self._Y[idx]
        for f in feats:
            x = self._X[idx, f]
            order = np.argsort(x, kind="mergesort")
            xs = x[order]
            cum = np.cumsum(Yi[order], axis=0)
            left = cum[m - 1: len(idx) - m]                 # left sizes m .. n-m
            pos = np.arange(m - 1, len(idx) - m)
            valid = xs[pos] < xs[pos + 1]
            if not valid.any():
                continue
            right = counts - left
            imp = self._gini(left) * left.sum(1) + self._gini(right) * right.sum(1)
            imp = np.where(valid, imp, np.inf)
            j = int(np.argmin(imp))
            if imp[j] < best[0]:
                best = (float(imp[j]), int(f), float((xs[pos[j]] + xs[pos[j] + 1]) / 2))

        _, f, thr = best
        if f < 0:
            return node_id
        self._importance[f] += parent_imp - best[0]
        mask = self._X[idx, f] <= thr
        node = self.nodes_[node_id]
        node.feature, node.threshold = f, thr
        node.left = self._build(idx[mask], depth + 1)
        node.right = self._build(idx[~mask], depth + 1)
        return node_id

    def predict_proba(self, X):
        X = np.asarray(X, float)
        feat = np.array([nd.feature for nd in self.nodes_])
        thr = np.array([nd.threshold for nd in self.nodes_])
        left = np.array([nd.left for nd in self.nodes_])
        right = np.array([nd.right for nd in self.nodes_])
        cur = np.zeros(len(X), dtype=int)
        while True:
            internal = feat[cur] >= 0
            if not internal.any():
                break
            i = np.nonzero(internal)[0]
            go_left = X[i, feat[cur[i]]] <= thr[cur[i]]
            cur[i] = np.where(go_left, left[cur[i]], right[cur[i]])
        return np.vstack([self.nodes_[c].value for c in cur])

    def predict(self, X):
        return np.argmax(self.predict_proba(X), axis=1)

    @property
    def depth_(self) -> int:
        def _d(i):
            nd = self.nodes_[i]
            return 0 if nd.feature < 0 else 1 + max(_d(nd.left), _d(nd.right))
        return _d(0)

    def export_text(self, feature_names, class_names, decimals: int = 3) -> str:
        lines = []

        def _walk(i, indent):
            nd = self.nodes_[i]
            pad = "|   " * indent
            if nd.feature < 0:
                k = int(np.argmax(nd.value))
                lines.append(f"{pad}|--- class: {class_names[k]}  (n={nd.n_samples}, "
                             f"p={nd.value[k]:.2f})")
                return
            name = feature_names[nd.feature]
            lines.append(f"{pad}|--- {name} <= {nd.threshold:.{decimals}f}")
            _walk(nd.left, indent + 1)
            lines.append(f"{pad}|--- {name} >  {nd.threshold:.{decimals}f}")
            _walk(nd.right, indent + 1)

        _walk(0, 0)
        return "\n".join(lines)

    def to_dict(self) -> dict:
        return {"nodes": [{"feature": n.feature, "threshold": n.threshold, "left": n.left, "right": n.right,
                           "value": [round(float(v), 6) for v in n.value], "n": n.n_samples} for n in self.nodes_]}


# ---------------------------------------------------------------------------
# Random forest = many decision trees on bootstrap samples + random features
# ---------------------------------------------------------------------------
class RandomForestClassifier:
    def __init__(self, n_classes: int, n_estimators: int = 100, max_depth: int = 10,
                 min_samples_leaf: int = 2, max_features: str | int = "sqrt", random_state: int = 0):
        self.n_classes = n_classes
        self.n_estimators = n_estimators
        self.max_depth = max_depth
        self.min_samples_leaf = min_samples_leaf
        self.max_features = max_features
        self.random_state = random_state

    def fit(self, X, y, sample_weight=None):
        X = np.asarray(X, float)
        n, d = X.shape
        w = np.ones(n) if sample_weight is None else np.asarray(sample_weight, float)
        mf = max(1, int(math.sqrt(d))) if self.max_features == "sqrt" else self.max_features
        rng = np.random.default_rng(self.random_state)
        self.estimators_ = []
        imp = np.zeros(d)
        for _ in range(self.n_estimators):
            boot = rng.integers(0, n, size=n)
            tree = DecisionTreeClassifier(self.n_classes, self.max_depth, self.min_samples_leaf, mf)
            tree.fit(X[boot], y[boot], w[boot], rng=rng)
            self.estimators_.append(tree)
            imp += tree.feature_importances_
        self.feature_importances_ = imp / self.n_estimators
        return self

    def predict_proba(self, X):
        return np.mean([t.predict_proba(X) for t in self.estimators_], axis=0)

    def predict(self, X):
        return np.argmax(self.predict_proba(X), axis=1)
