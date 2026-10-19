# Phase 3.2 — Classification results

> ⚠️ **Synthetic data.** Labels come from our own generator (`label_source = synthetic`). These numbers show the pipeline and the comparison method work; they do **not** estimate real-world accuracy.

## Protocol

- Eligible rows: 1768 → train 1298 rows / 369 groups, test 470 rows / 134 groups (hash-based group split, no group in both).
- Train labels: {'ambiguous': 56, 'non_subscription': 708, 'subscription': 534}; test labels: {'ambiguous': 37, 'non_subscription': 222, 'subscription': 211}.
- 5-fold group cross-validation inside train; seed 42; class weights balanced.
- Label sources: ['synthetic'] → real-world claim allowed: **False**.

## Summary (test split)

| Model | Features | CV macro-F1 (mean ± sd) | Test macro-F1 | 95% CI (group bootstrap) | Accuracy | Binary F1 (subscription vs rest) |
|---|---|---|---|---|---|---|
| majority_class | all_features | 0.235 ± 0.014 | 0.214 | [0.185, 0.240] | 0.472 | 0.000 |
| logistic_regression | all_features | 0.880 ± 0.048 | 0.964 | [0.923, 0.987] | 0.983 | 0.988 |
| decision_tree | all_features | 0.892 ± 0.059 | 0.944 | [0.879, 0.986] | 0.975 | 0.976 |
| random_forest | all_features | 0.983 ± 0.017 | 0.977 | [0.954, 0.994] | 0.989 | 0.995 |
| majority_class | no_amount_level | 0.235 ± 0.014 | 0.214 | [0.185, 0.240] | 0.472 | 0.000 |
| logistic_regression | no_amount_level | 0.822 ± 0.039 | 0.909 | [0.862, 0.944] | 0.908 | 0.909 |
| decision_tree | no_amount_level | 0.870 ± 0.054 | 0.906 | [0.837, 0.955] | 0.925 | 0.934 |
| random_forest | no_amount_level | 0.945 ± 0.028 | 0.948 | [0.886, 0.984] | 0.968 | 0.979 |
| rule_baseline | n/a | — | 0.524 | [0.480, 0.566] | 0.755 | 0.803 |

**Rule baseline on its own task** (recurring (subscriptions + rent + utilities + EMIs) vs not recurring): precision 0.927, recall 0.862, F1 0.893 (tp 243, fp 19, fn 39, tn 169). The rules were designed to find recurring payments, so the subscription metrics above penalise them for rent/EMIs they were never meant to exclude.

## Per-class metrics and confusion matrices (test split)

### majority_class__all_features

| Class | Precision | Recall | F1 | Support |
|---|---|---|---|---|
| subscription | 0.000 | 0.000 | 0.000 | 211 |
| non_subscription | 0.472 | 1.000 | 0.642 | 222 |
| ambiguous | 0.000 | 0.000 | 0.000 | 37 |

Never predicted (precision undefined, shown as 0): ['subscription', 'ambiguous']

Confusion matrix (rows = true, columns = predicted):

| true \ pred | subscription | non_subscription | ambiguous |
|---|---|---|---|
| subscription | 0 | 211 | 0 |
| non_subscription | 0 | 222 | 0 |
| ambiguous | 0 | 37 | 0 |

### logistic_regression__all_features

| Class | Precision | Recall | F1 | Support |
|---|---|---|---|---|
| subscription | 0.991 | 0.986 | 0.988 | 211 |
| non_subscription | 1.000 | 0.982 | 0.991 | 222 |
| ambiguous | 0.857 | 0.973 | 0.911 | 37 |

Confusion matrix (rows = true, columns = predicted):

| true \ pred | subscription | non_subscription | ambiguous |
|---|---|---|---|
| subscription | 208 | 0 | 3 |
| non_subscription | 1 | 218 | 3 |
| ambiguous | 1 | 0 | 36 |

### decision_tree__all_features

| Class | Precision | Recall | F1 | Support |
|---|---|---|---|---|
| subscription | 0.972 | 0.981 | 0.976 | 211 |
| non_subscription | 0.996 | 0.987 | 0.991 | 222 |
| ambiguous | 0.865 | 0.865 | 0.865 | 37 |

Confusion matrix (rows = true, columns = predicted):

| true \ pred | subscription | non_subscription | ambiguous |
|---|---|---|---|
| subscription | 207 | 0 | 4 |
| non_subscription | 2 | 219 | 1 |
| ambiguous | 4 | 1 | 32 |

### random_forest__all_features

| Class | Precision | Recall | F1 | Support |
|---|---|---|---|---|
| subscription | 0.995 | 0.995 | 0.995 | 211 |
| non_subscription | 0.987 | 0.996 | 0.991 | 222 |
| ambiguous | 0.971 | 0.919 | 0.944 | 37 |

Confusion matrix (rows = true, columns = predicted):

| true \ pred | subscription | non_subscription | ambiguous |
|---|---|---|---|
| subscription | 210 | 0 | 1 |
| non_subscription | 1 | 221 | 0 |
| ambiguous | 0 | 3 | 34 |

### majority_class__no_amount_level

| Class | Precision | Recall | F1 | Support |
|---|---|---|---|---|
| subscription | 0.000 | 0.000 | 0.000 | 211 |
| non_subscription | 0.472 | 1.000 | 0.642 | 222 |
| ambiguous | 0.000 | 0.000 | 0.000 | 37 |

Never predicted (precision undefined, shown as 0): ['subscription', 'ambiguous']

Confusion matrix (rows = true, columns = predicted):

| true \ pred | subscription | non_subscription | ambiguous |
|---|---|---|---|
| subscription | 0 | 211 | 0 |
| non_subscription | 0 | 222 | 0 |
| ambiguous | 0 | 37 | 0 |

### logistic_regression__no_amount_level

| Class | Precision | Recall | F1 | Support |
|---|---|---|---|---|
| subscription | 0.873 | 0.948 | 0.909 | 211 |
| non_subscription | 0.960 | 0.860 | 0.907 | 222 |
| ambiguous | 0.857 | 0.973 | 0.911 | 37 |

Confusion matrix (rows = true, columns = predicted):

| true \ pred | subscription | non_subscription | ambiguous |
|---|---|---|---|
| subscription | 200 | 8 | 3 |
| non_subscription | 28 | 191 | 3 |
| ambiguous | 1 | 0 | 36 |

### decision_tree__no_amount_level

| Class | Precision | Recall | F1 | Support |
|---|---|---|---|---|
| subscription | 0.896 | 0.976 | 0.934 | 211 |
| non_subscription | 0.975 | 0.887 | 0.929 | 222 |
| ambiguous | 0.842 | 0.865 | 0.853 | 37 |

Confusion matrix (rows = true, columns = predicted):

| true \ pred | subscription | non_subscription | ambiguous |
|---|---|---|---|
| subscription | 206 | 0 | 5 |
| non_subscription | 24 | 197 | 1 |
| ambiguous | 0 | 5 | 32 |

### random_forest__no_amount_level

| Class | Precision | Recall | F1 | Support |
|---|---|---|---|---|
| subscription | 0.959 | 1.000 | 0.979 | 211 |
| non_subscription | 0.973 | 0.964 | 0.968 | 222 |
| ambiguous | 1.000 | 0.811 | 0.895 | 37 |

Confusion matrix (rows = true, columns = predicted):

| true \ pred | subscription | non_subscription | ambiguous |
|---|---|---|---|
| subscription | 211 | 0 | 0 |
| non_subscription | 8 | 214 | 0 |
| ambiguous | 1 | 6 | 30 |

### rule_baseline

| Class | Precision | Recall | F1 | Support |
|---|---|---|---|---|
| subscription | 0.725 | 0.900 | 0.803 | 211 |
| non_subscription | 0.793 | 0.743 | 0.767 | 222 |
| ambiguous | 0.000 | 0.000 | 0.000 | 37 |

Never predicted (precision undefined, shown as 0): ['ambiguous']

Confusion matrix (rows = true, columns = predicted):

| true \ pred | subscription | non_subscription | ambiguous |
|---|---|---|---|
| subscription | 190 | 21 | 0 |
| non_subscription | 57 | 165 | 0 |
| ambiguous | 15 | 22 | 0 |

## Share of test rows predicted 'subscription', by synthetic archetype

| Archetype | True label | n | logistic_regression__all_features | decision_tree__all_features | random_forest__all_features | logistic_regression__no_amount_level | decision_tree__no_amount_level | random_forest__no_amount_level | rule_baseline |
|---|---|---|---|---|---|---|---|---|---|
| ambiguous_semi_regular | ambiguous | 22 | 0.04 | 0.00 | 0.00 | 0.04 | 0.00 | 0.00 | 0.00 |
| ambiguous_short_history | ambiguous | 15 | 0.00 | 0.27 | 0.00 | 0.00 | 0.00 | 0.07 | 1.00 |
| irregular_spend | non_subscription | 151 | 0.01 | 0.01 | 0.00 | 0.00 | 0.01 | 0.00 | 0.03 |
| monthly_cancelled | subscription | 14 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| monthly_price_increase | subscription | 36 | 1.00 | 0.97 | 1.00 | 0.78 | 0.97 | 1.00 | 0.81 |
| monthly_stable | subscription | 133 | 0.98 | 0.98 | 0.99 | 0.98 | 0.97 | 1.00 | 0.90 |
| rent | non_subscription | 36 | 0.00 | 0.00 | 0.00 | 0.78 | 0.56 | 0.22 | 1.00 |
| utility_bill | non_subscription | 35 | 0.00 | 0.03 | 0.03 | 0.00 | 0.09 | 0.00 | 0.49 |
| yearly | subscription | 28 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |

## Decision tree (all features)

Depth 5.

```
|--- amount_range_ratio <= 0.355
|   |--- monthly_period_deviation <= 0.041
|   |   |--- amount_min <= 2022.500
|   |   |   |--- n_transactions <= 2.500
|   |   |   |   |--- amount_mean <= 326.500
|   |   |   |   |   |--- class: ambiguous  (n=7, p=0.98)
|   |   |   |   |--- amount_mean >  326.500
|   |   |   |   |   |--- class: subscription  (n=5, p=0.84)
|   |   |   |--- n_transactions >  2.500
|   |   |   |   |--- n_distinct_amounts <= 3.000
|   |   |   |   |   |--- class: subscription  (n=456, p=1.00)
|   |   |   |   |--- n_distinct_amounts >  3.000
|   |   |   |   |   |--- class: non_subscription  (n=5, p=1.00)
|   |   |--- amount_min >  2022.500
|   |   |   |--- class: non_subscription  (n=102, p=1.00)
|   |--- monthly_period_deviation >  0.041
|   |   |--- monthly_period_deviation <= 0.641
|   |   |   |--- amount_mean <= 1268.188
|   |   |   |   |--- days_since_last <= 11.500
|   |   |   |   |   |--- class: ambiguous  (n=9, p=0.86)
|   |   |   |   |--- days_since_last >  11.500
|   |   |   |   |   |--- class: ambiguous  (n=50, p=0.99)
|   |   |   |--- amount_mean >  1268.188
|   |   |   |   |--- amount_max <= 2022.000
|   |   |   |   |   |--- class: subscription  (n=5, p=1.00)
|   |   |   |   |--- amount_max >  2022.000
|   |   |   |   |   |--- class: non_subscription  (n=5, p=1.00)
|   |   |--- monthly_period_deviation >  0.641
|   |   |   |--- history_span_days <= 281.000
|   |   |   |   |--- class: non_subscription  (n=8, p=1.00)
|   |   |   |--- history_span_days >  281.000
|   |   |   |   |--- class: subscription  (n=66, p=1.00)
|--- amount_range_ratio >  0.355
|   |--- class: non_subscription  (n=580, p=1.00)
```

