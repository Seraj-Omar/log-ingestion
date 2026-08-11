# Load Testing Plan

## Goal
Prove the system can sustain 15k+ logs/sec while keeping aggregation <1s p95.

## Test Environment
- App: 0.5 CPU / 256 MB
- PostgreSQL: 1 CPU / 1 GB
- Dataset: ~1,000,000 logs

## Benchmark Variables
Batch sizes:
100, 250, 500, 1000, possibly 5000

Pool sizes:
2, 4, 8, 12

Ingestion rates:
10k, 15k, 20k, 25k+

Concurrent workload:
1 aggregation/sec

## Measure
- logs/sec
- p50 / p95 / p99
- failed requests
- aggregation latency
- CPU / RAM
- DB size
- index size

## Optimization Method
Change one variable at a time.

Compare:
- batch sizes
- pool sizes
- indexes
- INSERT vs COPY
- validation overhead

## Query Analysis
Use:
EXPLAIN (ANALYZE, BUFFERS)

Test:
- latest logs
- time range
- service filter
- level filter
- attribute filter
- message search
- cursor pagination
- aggregation
