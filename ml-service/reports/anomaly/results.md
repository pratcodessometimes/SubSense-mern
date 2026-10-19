# Phase 3.2 — Anomaly detection results

> ⚠️ **Synthetic data with anomalies injected by us.** This measures whether the detectors find the anomaly types we planted. It is not evidence about real billing errors or fraud.

## Protocol

- Scope: payments inside groups labelled 'subscription' (synthetic); 175 groups.
- A payment is scored only with its previous 6 payments (needs ≥ 3); robust deviation flags |z| > 3.5.
- Isolation Forest: 200 trees, features ['amount_log_ratio', 'interval_log_ratio'], fitted on train-split groups; threshold 0.610167 chosen by max F1 on train.
- Scored payments: train 2433, test 1035.
- Test payment types: {'normal': 953, 'amount_spike': 7, 'duplicate_charge': 7, 'generated_double_charge': 4, 'natural_price_change': 57, 'off_cycle': 7}.

## Test results

| Method | Precision | Recall | F1 | Avg. precision | ROC-AUC | False-flag rate on normal payments | Price-rise payments flagged |
|---|---|---|---|---|---|---|---|
| robust_deviation | 0.846 | 0.880 | 0.863 | 0.953 | 0.998 | 0.0042 | 30/57 |
| isolation_forest | 0.875 | 0.840 | 0.857 | 0.960 | 0.999 | 0.0031 | 29/57 |

## Recall by anomaly type

| Type | robust_deviation | isolation_forest |
|---|---|---|
| amount_spike | 1.000 | 1.000 |
| duplicate_charge | 1.000 | 1.000 |
| generated_double_charge | 1.000 | 1.000 |
| off_cycle | 0.571 | 0.429 |

