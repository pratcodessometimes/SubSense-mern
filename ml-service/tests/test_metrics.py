import math

import numpy as np

from subsense_ml.metrics import (average_precision, binary_report, classification_report, confusion_matrix,
                                 group_bootstrap_ci, macro_f1, roc_auc)

LABELS = ["a", "b", "c"]


def test_confusion_matrix_rows_are_true_labels():
    cm = confusion_matrix(["a", "a", "b", "c"], ["a", "b", "b", "a"], LABELS)
    assert cm.tolist() == [[1, 1, 0], [0, 1, 0], [1, 0, 0]]


def test_per_class_and_macro_values_by_hand():
    y_true = ["a", "a", "a", "b", "b", "c"]
    y_pred = ["a", "a", "b", "b", "b", "a"]
    r = classification_report(y_true, y_pred, LABELS)
    # a: P=2/3, R=2/3 ; b: P=2/3, R=1 ; c: never predicted -> P=0 (undefined), R=0
    assert r["per_class"]["a"] == {"precision": 0.6667, "recall": 0.6667, "f1": 0.6667, "support": 3}
    assert r["per_class"]["b"]["f1"] == 0.8
    assert r["per_class"]["c"]["f1"] == 0.0
    assert r["undefined_precision"] == ["c"]
    assert math.isclose(r["macro_f1"], round((2 / 3 + 0.8 + 0) / 3, 4))
    assert r["accuracy"] == round(4 / 6, 4)


def test_macro_ignores_absent_classes():
    assert macro_f1(["a", "b"], ["a", "b"], LABELS) == 1.0


def test_binary_report():
    r = binary_report([1, 1, 0, 0], [1, 0, 1, 0])
    assert (r["tp"], r["fp"], r["fn"], r["tn"]) == (1, 1, 1, 1) and r["f1"] == 0.5


def test_ranking_metrics():
    assert roc_auc([0, 0, 1, 1], [0.1, 0.2, 0.8, 0.9]) == 1.0
    assert roc_auc([0, 0, 1, 1], [0.9, 0.8, 0.2, 0.1]) == 0.0
    assert roc_auc([0, 1], [0.5, 0.5]) == 0.5
    assert average_precision([0, 1, 1], [0.1, 0.9, 0.8]) == 1.0
    assert math.isclose(average_precision([1, 0, 1], [0.9, 0.8, 0.1]), (1 + 2 / 3) / 2)


def test_group_bootstrap_is_deterministic_and_brackets_estimate():
    rng = np.random.default_rng(0)
    y = rng.choice(LABELS, 200)
    p = np.where(rng.random(200) < 0.8, y, "a")
    groups = np.repeat(np.arange(40), 5)
    f = lambda a, b: macro_f1(a, b, LABELS)  # noqa: E731
    ci1 = group_bootstrap_ci(y, p, groups, f, n_boot=200, seed=3)
    ci2 = group_bootstrap_ci(y, p, groups, f, n_boot=200, seed=3)
    assert ci1 == ci2 and ci1[0] <= f(y, p) <= ci1[1]
