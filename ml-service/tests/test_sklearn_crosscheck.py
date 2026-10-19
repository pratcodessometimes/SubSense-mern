"""Optional: compare the NumPy models with scikit-learn. Skipped when sklearn is not installed."""

import numpy as np

from _helpers import skip


def _sk():
    try:
        import sklearn  # noqa: F401
    except ImportError:
        skip("scikit-learn not installed (pip install scikit-learn to enable this cross-check)")


def _blobs():
    rng = np.random.default_rng(0)
    X = np.vstack([rng.normal(c, 1.0, size=(80, 3)) for c in ([0, 0, 0], [2, 2, 0], [0, 2, 2])])
    return X, np.repeat(np.arange(3), 80)


def test_logistic_regression_agrees_with_sklearn():
    _sk()
    from sklearn.linear_model import LogisticRegression as SkLR

    from subsense_ml.models import LogisticRegression, StandardScaler
    X, y = _blobs()
    Z = StandardScaler().fit(X).transform(X)
    ours = LogisticRegression(3, l2=1e-2).fit(Z, y).predict(Z)
    # our objective: mean CE + l2/2 ||W||^2  <=>  sklearn C = 1 / (n * l2)
    theirs = SkLR(C=1 / (len(y) * 1e-2), max_iter=5000).fit(Z, y).predict(Z)
    assert (ours == theirs).mean() >= 0.97


def test_decision_tree_agrees_with_sklearn():
    _sk()
    from sklearn.tree import DecisionTreeClassifier as SkDT

    from subsense_ml.models import DecisionTreeClassifier
    X, y = _blobs()
    ours = DecisionTreeClassifier(3, max_depth=3, min_samples_leaf=5).fit(X, y).predict(X)
    theirs = SkDT(max_depth=3, min_samples_leaf=5, random_state=0).fit(X, y).predict(X)
    assert (ours == theirs).mean() >= 0.95


def test_isolation_forest_ranking_agrees_with_sklearn():
    _sk()
    from sklearn.ensemble import IsolationForest as SkIF

    from subsense_ml.anomaly import IsolationForest
    rng = np.random.default_rng(1)
    X = np.vstack([rng.normal(0, 1, size=(400, 2)), rng.uniform(-6, 6, size=(20, 2))])
    ours = IsolationForest(n_estimators=200, random_state=0).fit(X).score_samples(X)
    theirs = -SkIF(n_estimators=200, random_state=0).fit(X).score_samples(X)
    r1, r2 = np.argsort(np.argsort(ours)), np.argsort(np.argsort(theirs))
    assert np.corrcoef(r1, r2)[0, 1] > 0.9
