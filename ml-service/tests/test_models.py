import numpy as np

from _helpers import raises
from subsense_ml.models import (DecisionTreeClassifier, LogisticRegression, MajorityClassifier, MedianImputer,
                                RandomForestClassifier, StandardScaler, balanced_sample_weights)


def blobs(seed=0, n=60):
    rng = np.random.default_rng(seed)
    centers = np.array([[0, 0], [4, 4], [0, 5]])
    X = np.vstack([rng.normal(c, 0.6, size=(n, 2)) for c in centers])
    y = np.repeat(np.arange(3), n)
    return X, y


def test_balanced_weights_give_each_class_equal_total():
    y = np.array([0] * 8 + [1] * 2 + [2] * 10)
    w = balanced_sample_weights(y, 3)
    totals = [w[y == c].sum() for c in range(3)]
    assert np.allclose(totals, totals[0])


def test_imputer_uses_train_medians_only():
    train = np.array([[1.0, np.nan], [3.0, 10.0], [5.0, 20.0]])
    imp = MedianImputer().fit(train)
    assert imp.medians_.tolist() == [3.0, 15.0]
    out = imp.transform(np.array([[np.nan, np.nan], [np.inf, 1.0]]))
    assert out.tolist() == [[3.0, 15.0], [3.0, 1.0]]


def test_scaler_handles_constant_columns():
    X = np.array([[1.0, 7.0], [3.0, 7.0]])
    Z = StandardScaler().fit(X).transform(X)
    assert np.allclose(Z[:, 0], [-1, 1]) and np.allclose(Z[:, 1], 0)


def test_majority_classifier():
    m = MajorityClassifier(3).fit(np.zeros((5, 1)), np.array([2, 2, 1, 0, 2]))
    assert m.predict(np.zeros((2, 1))).tolist() == [2, 2]


def test_logistic_regression_learns_and_is_deterministic():
    X, y = blobs()
    Z = StandardScaler().fit(X).transform(X)
    a = LogisticRegression(3).fit(Z, y)
    b = LogisticRegression(3).fit(Z, y)
    assert (a.predict(Z) == y).mean() > 0.95
    assert np.array_equal(a.coef_, b.coef_)
    assert np.allclose(a.predict_proba(Z).sum(axis=1), 1.0)


def test_decision_tree_finds_exact_threshold():
    X = np.array([[0.1], [0.2], [0.3], [0.7], [0.8], [0.9]])
    y = np.array([0, 0, 0, 1, 1, 1])
    t = DecisionTreeClassifier(2, max_depth=1, min_samples_leaf=1).fit(X, y)
    assert t.nodes_[0].threshold == 0.5
    assert t.predict(np.array([[0.49], [0.51]])).tolist() == [0, 1]
    assert np.isclose(t.feature_importances_.sum(), 1.0)
    assert "x <= 0.500" in t.export_text(["x"], ["a", "b"])


def test_decision_tree_respects_depth_and_leaf_size():
    X, y = blobs()
    t = DecisionTreeClassifier(3, max_depth=2, min_samples_leaf=20).fit(X, y)
    assert t.depth_ <= 2
    assert all(n.n_samples >= 20 for n in t.nodes_ if n.feature < 0)
    assert (t.predict(X) == y).mean() > 0.9


def test_decision_tree_rejects_nan():
    with raises(ValueError, match="NaN"):
        DecisionTreeClassifier(2).fit(np.array([[np.nan], [1.0]]), np.array([0, 1]))


def test_random_forest_seeded_reproducibility():
    X, y = blobs()
    a = RandomForestClassifier(3, n_estimators=10, random_state=1).fit(X, y)
    b = RandomForestClassifier(3, n_estimators=10, random_state=1).fit(X, y)
    c = RandomForestClassifier(3, n_estimators=10, random_state=2).fit(X, y)
    assert np.array_equal(a.predict_proba(X), b.predict_proba(X))
    assert not np.array_equal(a.predict_proba(X), c.predict_proba(X))
    assert (a.predict(X) == y).mean() > 0.95
