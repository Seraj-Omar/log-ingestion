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

## Baseline Ingestion Benchmark

Start the current service on `http://localhost:8080`, then run the k6 ingestion-only baseline:

```bash
k6 run load-tests/ingestion.js
```

The script uses a constant request arrival rate and reports accepted logs separately from request throughput. `BASE_URL`, `BATCH_SIZE`, `RATE`, `DURATION`, `PRE_ALLOCATED_VUS`, and `MAX_VUS` are configurable through environment variables.

These examples target approximately 15,000 logs/sec at different batch sizes:

```bash
BATCH_SIZE=100 RATE=150 DURATION=30s k6 run load-tests/ingestion.js
BATCH_SIZE=250 RATE=60 DURATION=30s k6 run load-tests/ingestion.js
BATCH_SIZE=500 RATE=30 DURATION=30s k6 run load-tests/ingestion.js
BATCH_SIZE=1000 RATE=15 DURATION=30s k6 run load-tests/ingestion.js
```

Higher target arrival rates can be requested without implying the service will achieve them:

```bash
# Target: 20,000 logs/sec
BATCH_SIZE=500 RATE=40 DURATION=30s k6 run load-tests/ingestion.js

# Target: 25,000 logs/sec
BATCH_SIZE=500 RATE=50 DURATION=30s k6 run load-tests/ingestion.js
```

Use a short correctness smoke test before collecting a baseline:

```bash
BATCH_SIZE=10 RATE=1 DURATION=3s k6 run load-tests/ingestion.js
```

## End-to-End Contract Benchmark

`load-tests/load.js` runs ingestion together with one log query and one
aggregation per second, checks visibility, and verifies the final persisted
count. Its contract-aligned defaults schedule 15,000 logs/second for 60
seconds (900,000 logs):

```bash
k6 run load-tests/load.js
```

Use a longer run to verify sustained stability after the one-million-row
baseline:

```bash
TARGET_LPS=15000 BATCH_SIZE=500 DURATION=300s k6 run load-tests/load.js
```

`TARGET_LPS`, `BATCH_SIZE`, `DURATION`, `SERVICE_COUNT`, `BASE_URL`, and
`SUMMARY_PATH` are configurable. The benchmark treats overload responses as
failures, but reports them separately from transport timeouts so graceful
backpressure can be distinguished from a process crash.

## Isolated Integration Database

Integration tests use a dedicated Compose project and volume so benchmark data
cannot leak into test queries:

```bash
npm run test:db:up
npm run test:integration
npm run test:db:down
```

`test:db:down` removes only the dedicated `log-ingestion-test` database volume.
