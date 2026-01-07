# Attestation Cost Estimates

## Assumptions

- **AR Price:** $3.93 USD (as of January 2025)
- **Arweave storage cost:** ~1 AR per GB (one-time, permanent)
- **R2 storage:** $0.015 per GB per month
- **R2 writes:** $4.50 per million operations

## Manifest Size Estimates

| Size | Description | Bytes |
|------|-------------|-------|
| Small | Metadata only | ~2 KB |
| Medium | Wiki article | ~30 KB |
| Large | Book chapter | ~100 KB |

---

## Arweave Costs

### Cost Per Attestation

| Size | AR per attestation | USD per attestation |
|------|-------------------|---------------------|
| Small (2 KB) | 0.000002 AR | $0.000008 |
| Medium (30 KB) | 0.00003 AR | $0.00012 |
| Large (100 KB) | 0.0001 AR | $0.00039 |

### Daily Costs

| Volume/Day | Small (2KB) | Medium (30KB) | Large (100KB) |
|------------|-------------|---------------|---------------|
| 1,000 | 0.002 AR ($0.008) | 0.03 AR ($0.12) | 0.1 AR ($0.39) |
| 10,000 | 0.02 AR ($0.08) | 0.3 AR ($1.18) | 1 AR ($3.93) |
| 100,000 | 0.2 AR ($0.79) | 3 AR ($11.79) | 10 AR ($39.30) |

### Monthly Costs (30 days)

| Volume/Day | Small (2KB) | Medium (30KB) | Large (100KB) |
|------------|-------------|---------------|---------------|
| 1,000 | 0.06 AR ($0.24) | 0.9 AR ($3.54) | 3 AR ($11.79) |
| 10,000 | 0.6 AR ($2.36) | 9 AR ($35.37) | 30 AR ($117.90) |
| 100,000 | 6 AR ($23.58) | 90 AR ($353.70) | 300 AR ($1,179) |

---

## Arweave vs R2 Comparison

### Scenario: 10k attestations/day at 30KB each

**Monthly data added:** 9 GB

**Per-month costs:**
- Arweave (one-time): $35.37
- R2 writes: $1.35
- R2 storage: accumulates over time

### Cumulative Cost Over Time

| Timeframe | Arweave | R2 | Cheaper |
|-----------|---------|-----|---------|
| 1 year | $424 | $22 | R2 |
| 5 years | $2,122 | $200 | R2 |
| 10 years | $4,244 | $700 | R2 |
| 20 years | $8,489 | $2,500 | R2 |
| **42 years** | **$17,826** | **$17,826** | **Break-even** |
| 50 years | $21,222 | $25,000 | Arweave |

### Break-even Analysis

```
Arweave: Linear cost growth = $35.37 × N months
R2: Quadratic cost growth = $0.0675N² + $1.4175N

Break-even: N ≈ 503 months ≈ 42 years
```

---

## Why Arweave Despite Higher Cost?

Arweave's value is **permanence**, not cost savings:

1. **No ongoing operational dependency** - Data persists without maintaining accounts/payments
2. **Immutable storage** - Cannot be altered or deleted
3. **Censorship resistant** - Decentralized network
4. **No service discontinuation risk** - Not dependent on a single company
5. **Verifiable chain** - Attestations form a cryptographically linked chain on-chain

For attestations that need to exist and be verifiable forever, the premium is justified.

---

## Scaling Notes

- Current throughput: ~166k attestations/day (BATCH_SIZE=50)
- Can increase to ~216k/day with BATCH_SIZE=100
- Cloudflare Worker subrequest limit: 1000 (constraint: ~4N+2 per batch)

---

*Last updated: January 2025*
*AR price should be verified before budgeting*
