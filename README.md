# Log Ingestion and Query Service

A high-throughput log ingestion, querying, and aggregation service built with **Node.js, TypeScript, Fastify, and PostgreSQL**.

The service accepts batched logs, validates entries independently, persists accepted logs durably to PostgreSQL, and provides filtered querying and time-bucketed aggregation.

The implementation is designed for constrained resources and targets **15,000+ logs/second**, with local endurance testing sustaining approximately **19,500 logs/second** under the specified Docker resource limits.

---

## Features

- Batched log ingestion
- Per-log validation with partial batch acceptance
- Durable PostgreSQL persistence before HTTP success
- Bounded ingestion backpressure
- Cross-request write batching
- Cursor-based pagination
- Service, level, time-range, attribute, and text filtering
- Time-bucketed aggregations
- Daily PostgreSQL partitions
- Configurable retention
- Automatic database migrations
- Health/readiness checks
- Prometheus-compatible operational metrics
- Ingestion, query, aggregation, and process observability
- Docker Compose zero-config startup
- Unit and integration test suites
- GitHub Actions CI
- k6 performance and endurance testing

---

## Tech Stack

- **Node.js 22**
- **TypeScript**
- **Fastify**
- **PostgreSQL 17**
- **pg**
- **Zod**
- **node-pg-migrate**
- **Vitest**
- **k6**
- **Docker / Docker Compose**
- **GitHub Actions**

---

# Quick Start

## Requirements

Only Docker and Docker Compose are required for the default setup.

Start the complete system with:

```bash
docker compose up --build
```

The API becomes available at:

```text
http://localhost:8080
```

Check readiness:

```bash
curl -i http://localhost:8080/health
```

A healthy service returns:

```text
HTTP/1.1 200 OK
```

No `.env` file is required for the default setup.

To stop the application:

```bash
docker compose down
```

To also remove the PostgreSQL data volume:

```bash
docker compose down -v
```

---

# API

## `GET /health`

Reports whether the application and PostgreSQL database are ready.

The endpoint returns:

- `200` when startup preparation has completed and PostgreSQL is reachable.
- `503` while starting or when PostgreSQL is unavailable.

---

# `GET /metrics`

Exposes Prometheus-compatible operational metrics for the service.

Example:

```bash
curl http://localhost:8080/metrics
```

The endpoint exposes ingestion, query, aggregation, and process metrics.

Key metrics include:

- `ingestion_requests_total`
- `logs_accepted_total`
- `logs_rejected_total`
- `ingestion_db_writes_total`
- `ingestion_db_write_logs_total`
- `ingestion_in_flight_requests`
- `ingestion_in_flight_logs`
- `ingestion_in_flight_bytes`
- `ingestion_db_write_duration_seconds`
- `query_requests_total`
- `query_duration_seconds`
- `aggregation_requests_total`
- `aggregation_duration_seconds`
- `process_resident_memory_bytes`
- `process_heap_used_bytes`
- `process_uptime_seconds`

Latency metrics are exposed as Prometheus histograms.

The metrics endpoint is additive and does not change the required ingestion, query, or aggregation API contracts.

---

# `POST /logs`

Ingests a batch of logs.

## Request

```json
{
  "logs": [
    {
      "timestamp": "2026-08-15T10:00:00.000Z",
      "level": "info",
      "service": "checkout",
      "message": "Payment accepted",
      "attributes": {
        "user_id": "42",
        "region": "eu-west",
        "sampled": true
      }
    }
  ]
}
```

## Log Fields

| Field | Requirement |
|---|---|
| `timestamp` | Valid ISO timestamp, no more than 5 minutes in the future |
| `level` | `debug`, `info`, `warn`, or `error` |
| `service` | Non-empty string |
| `message` | Non-empty string |
| `attributes` | Flat object containing string, number, or boolean values |

Nested objects and arrays are not accepted as attribute values.

## Successful Response

```json
{
  "accepted": 1,
  "rejected": []
}
```

## Partial Success

Logs are validated independently.

If part of a batch is invalid, valid entries are still persisted:

```json
{
  "accepted": 2,
  "rejected": [
    {
      "index": 1,
      "reason": "invalid level: 'critical'"
    }
  ]
}
```

The rejection index refers to the original position in the submitted batch.

If at least one log is valid, the request returns `200`.

If the entire batch is invalid, or the top-level request is malformed, the request returns `400`.

---

# Durability

A successful ingestion response is returned **only after accepted logs have been persisted successfully to PostgreSQL**.

The request flow is:

```text
POST /logs
    │
    ▼
Envelope validation
    │
    ▼
Per-log validation
    │
    ▼
Bounded ingestion queue
    │
    ▼
Cross-request batching
    │
    ▼
PostgreSQL INSERT
    │
    ▼
Database success
    │
    ▼
HTTP 200
```

PostgreSQL remains the source of truth.

The service never acknowledges accepted logs before persistence succeeds.

If persistence fails, the request is not acknowledged as successful.

---

# Backpressure

The ingestion path uses a bounded producer-consumer design.

```text
HTTP requests
   producers
      │
      ▼
bounded ingestion queue
      │
      ▼
single batching consumer
      │
      ▼
PostgreSQL
```

The queue is bounded by:

- number of requests
- number of logs
- retained request bytes

If ingestion capacity is exhausted, the service returns:

```text
503 Service Unavailable
```

with:

```text
Retry-After: 1
```

This prevents unbounded memory growth and prevents unlimited database work from accumulating during overload.

Requests admitted by the ingestion queue still wait for PostgreSQL persistence before receiving a successful response.

---

# `GET /logs`

Queries stored logs.

Supported filters:

| Parameter | Description |
|---|---|
| `service` | Exact service match |
| `level` | Exact log level |
| `since` | Inclusive timestamp lower bound |
| `until` | Exclusive timestamp upper bound |
| `attr.<key>` | Attribute string comparison |
| `q` | Case-insensitive message substring |
| `limit` | Number of logs, default `100`, maximum `1000` |
| `cursor` | Opaque pagination cursor |

All filters can be combined.

Example:

```bash
curl "http://localhost:8080/logs?service=checkout&level=error&limit=100"
```

Attribute example:

```bash
curl "http://localhost:8080/logs?attr.user_id=42"
```

Text search example:

```bash
curl "http://localhost:8080/logs?q=payment"
```

## Ordering

Results use deterministic ordering:

```text
timestamp DESC, id DESC
```

The `id` acts as a tie-breaker when multiple logs have the same timestamp.

---

# Cursor Pagination

Pagination uses an opaque cursor rather than offset pagination.

Example response:

```json
{
  "logs": [],
  "next_cursor": null
}
```

When another page is available, `next_cursor` contains an opaque token that can be supplied to the next request:

```bash
curl "http://localhost:8080/logs?limit=100&cursor=<cursor>"
```

Internally, pagination follows:

```sql
(timestamp, id) < (cursor_timestamp, cursor_id)
```

with:

```sql
ORDER BY timestamp DESC, id DESC
```

This avoids the increasing cost and instability associated with large SQL offsets.

---

# `GET /logs/aggregate`

Returns time-bucketed log counts.

Required parameters:

- `since`
- `until`
- `bucket`

Supported buckets:

- `1m`
- `5m`
- `1h`
- `1d`

Optional grouping:

- `service`
- `level`

The endpoint also supports the same filtering concepts used by `GET /logs`:

- service
- level
- attributes
- message search

Example:

```bash
curl \
"http://localhost:8080/logs/aggregate?since=2026-08-15T10:00:00.000Z&until=2026-08-15T11:00:00.000Z&bucket=5m&group_by=service"
```

Example response:

```json
{
  "buckets": [
    {
      "start": "2026-08-15T10:00:00.000Z",
      "group": "checkout",
      "count": 120
    }
  ]
}
```

When no grouping is requested:

```json
{
  "buckets": [
    {
      "start": "2026-08-15T10:00:00.000Z",
      "group": null,
      "count": 120
    }
  ]
}
```

Buckets are returned in ascending time order.

Aggregation uses PostgreSQL `date_bin()`.

---

# Database Design

The main logical schema is:

```text
logs
├── id          BIGINT
├── timestamp   TIMESTAMPTZ
├── level       TEXT
├── service     TEXT
├── message     TEXT
└── attributes  JSONB
```

The primary key is:

```text
(timestamp, id)
```

The table is partitioned by timestamp.

The schema combines fixed relational columns for common searchable fields with JSONB for flexible attributes.

---

# Partitioning

Logs are stored in **daily PostgreSQL range partitions**.

Conceptually:

```text
logs
├── logs_2026_08_14
├── logs_2026_08_15
├── logs_2026_08_16
└── ...
```

Daily partitioning was chosen because log data is naturally time-based.

It also allows retention to remove old data by dropping complete partitions rather than performing large row-by-row deletes.

The service:

- creates required partitions automatically
- prevents repeated DDL through an in-memory partition cache
- coalesces concurrent creation of the same partition
- safely coordinates partition creation and deletion
- supports historical timestamps when required

---

# Retention

The default retention period is:

```text
30 days
```

Expired daily partitions are dropped during database preparation.

The retention period can be configured using:

```text
RETENTION_DAYS
```

Example:

```bash
RETENTION_DAYS=45 docker compose up --build
```

Dropping partitions avoids the table bloat and heavy vacuum work associated with deleting millions of expired rows individually.

---

# Indexes

The service uses a small number of targeted indexes.

## Service + Time

```sql
(service, timestamp DESC, id DESC)
```

Optimizes service-filtered log queries while preserving pagination order.

## Message Search

```text
GIN(message gin_trgm_ops)
```

Supports case-insensitive substring search through PostgreSQL `pg_trgm`.

## Timestamp

```text
BRIN(timestamp)
```

Provides a compact index for large time-ordered datasets and time-range scans.

The BRIN index uses:

```text
pages_per_range = 32
autosummarize = on
```

Index count is intentionally limited because every additional index increases ingestion cost.

---

# SQL Safety

Dynamic query values are parameterized.

This includes:

- service values
- level values
- timestamps
- attribute keys
- attribute values
- text-search values
- cursor values

User-provided values are never directly concatenated into SQL query text as query values.

Partition identifiers are separately validated before dynamic partition DDL is executed.

The automated test suite includes SQL-injection-looking inputs to verify that they are handled safely.

---

# Ingestion Batching

HTTP requests are not written to PostgreSQL one log at a time.

Validated requests are coalesced into larger multi-row `INSERT` operations.

The default configuration uses:

```text
Database batch target:     2,000 logs
Maximum INSERT chunk:     10,000 logs
Tail batching delay:          10 ms
PostgreSQL writers:             1
```

This reduces:

- network round trips
- SQL statement overhead
- transaction overhead
- WAL/commit overhead per log

while preserving durability.

Oversized writes are split into transactional chunks so the HTTP request remains atomic.

---

# Resource Constraints

Docker Compose configures the service using the target resource limits.

## Application

```text
CPU:    0.5
Memory: 256 MB
```

## PostgreSQL

```text
CPU:    1
Memory: 1 GB
```

The ingestion queue is bounded specifically to avoid uncontrolled memory growth under these limits.

---

# Performance

Performance was benchmarked locally using the same Docker resource constraints defined for the service.

The benchmark runs ingestion concurrently with:

- `1` query/second
- `1` aggregation/second
- read-after-write visibility probes
- final persistence verification

## 5-Minute Endurance Test

The highest clean sustained rate tested was **19,500 logs/second**.

Configuration:

```text
Target ingestion:       19,500 logs/s
Duration:               300 seconds
Batch size:             500 logs/request
Request rate:           39 POST/s
Concurrent querying:    1 request/s
Concurrent aggregation: 1 request/s
Visibility probes:      enabled
```

Measured results:

| Metric | Result |
|---|---:|
| Actual ingestion rate | **19,501.67 logs/s** |
| Accepted logs | **5,850,500** |
| Persisted logs | **5,850,500** |
| Accepted but missing | **0** |
| POST success | **100%** |
| HTTP 429 responses | **0** |
| HTTP 503 responses | **0** |
| Dropped ingestion iterations | **0** |
| POST timeouts | **0** |
| POST latency p95 | **144.02 ms** |
| Query success | **100%** |
| Query latency p95 | **77.30 ms** |
| Aggregate success | **100%** |
| Aggregate latency p95 | **568.17 ms** |
| Visibility success | **100%** |
| Visibility latency p95 | **8 ms** |
| Worst measured visibility | **15 ms** |

The service therefore sustained approximately **19.5k durable logs/second for five minutes** while queries, aggregations, and freshness probes ran concurrently.

Every accepted log was confirmed persisted in PostgreSQL:

```text
accepted logs - persisted logs = 0
```

---

## Metrics-Enabled Validation

After operational metrics were added, the required **15,000 logs/second** workload was rerun for five minutes under the same Docker resource limits.

| Metric | Result |
|---|---:|
| Actual ingestion rate | **15,001.67 logs/s** |
| Accepted logs | **4,500,500** |
| Persisted logs | **4,500,500** |
| POST success | **100%** |
| HTTP 503 responses | **0** |
| Dropped ingestion iterations | **0** |
| POST latency p95 | **41.86 ms** |
| Query latency p95 | **69.04 ms** |
| Aggregate latency p95 | **203.93 ms** |
| Worst measured visibility | **14 ms** |

The metrics endpoint reported approximately **500.6 logs per database write**, an average database write duration of approximately **16 ms**, application RSS of approximately **76 MB**, and heap usage of approximately **14.6 MB**.

This confirms that operational metrics remain compatible with the required **15,000 logs/second** workload while the application stays well below its 256 MB memory limit.

---

## Capacity and Overload Behavior

Additional two-minute capacity tests were used to determine where bounded backpressure begins.

| Target | Actual Accepted Rate | POST Success | 503 Responses | POST p95 | Accepted Logs Persisted |
|---:|---:|---:|---:|---:|---:|
| 15,000/s | 15,004/s | 100% | 0 | 37.96 ms | 100% |
| 17,500/s | 17,504/s | 100% | 0 | 78.45 ms | 100% |
| 19,000/s | 19,004/s | 100% | 0 | 92.24 ms | 100% |
| 19,500/s | 19,504/s | 100% | 0 | 67.49 ms | 100% |
| 20,000/s | 19,963/s | 99.79% | 10 | 163.40 ms | 100% |
| 25,000/s | 24,854/s | 99.40% | 36 | 262.43 ms | 100% |
| 30,000/s | 28,808/s | 96.03% | 286 | 1,656.38 ms | 100% |

The clean operating boundary observed during these tests was between approximately **19.5k and 20k logs/second**.

Above that point, the bounded ingestion queue begins returning `503 Service Unavailable` responses rather than allowing memory usage or queued database work to grow without control.

Even during overload tests, all accepted logs were persisted successfully.

These measurements are local benchmark results under the documented Docker resource limits and should not be interpreted as universal production throughput guarantees.

---

# Load Testing

The primary k6 benchmark is:

```bash
npm run benchmark
```

Equivalent to:

```bash
k6 run load-tests/load.js
```

Example 15k test:

```bash
DURATION=120s \
TARGET_LPS=15000 \
BATCH_SIZE=500 \
PRE_ALLOCATED_VUS=200 \
MAX_VUS=400 \
k6 run load-tests/load.js
```

Example 5-minute 19.5k endurance test:

```bash
DURATION=300s \
TARGET_LPS=19500 \
BATCH_SIZE=500 \
PRE_ALLOCATED_VUS=250 \
MAX_VUS=500 \
k6 run load-tests/load.js
```

The benchmark runs ingestion concurrently with:

- queries
- aggregations
- read-after-write visibility checks
- final persistence verification

A staged benchmark is also available:

```bash
npm run benchmark:staged
```

---

# Testing

Install dependencies:

```bash
npm ci
```

## Unit Tests

```bash
npm run test:unit
```

Current suite:

```text
23 test files
311 unit tests
```

## Integration Tests

Start the isolated test database:

```bash
npm run test:db:up
```

Run:

```bash
npm run test:integration
```

Stop and remove it:

```bash
npm run test:db:down
```

Current suite:

```text
10 integration test files
84 integration tests
```

Total:

```text
395 automated tests
```

The integration suite exercises the service against a real PostgreSQL instance rather than mocking the database.

---

# Full Local Validation

Run:

```bash
npm run build
npm run typecheck
npm run test:unit
npm run lint
npm run test:db:up
npm run test:integration
npm run test:db:down
```

---

# Continuous Integration

GitHub Actions runs CI automatically for:

- pushes to `main`
- pull requests targeting `main`

The CI workflow executes:

```text
npm ci
    ↓
build
    ↓
typecheck
    ↓
unit tests
    ↓
lint
    ↓
Docker PostgreSQL + migrations
    ↓
integration tests
    ↓
cleanup
```

The workflow is defined in:

```text
.github/workflows/ci.yml
```

---

# Database Migrations

Migrations live in:

```text
src/database/migrations/
```

Current migrations:

```text
001_create_logs_table
002_add_service_time_index
003_add_message_trigram_index
004_add_timestamp_brin_index
005_tune_partition_autovacuum
```

Docker Compose runs migrations automatically before the application starts.

The startup sequence is:

```text
PostgreSQL starts
        ↓
PostgreSQL becomes healthy
        ↓
migrations run successfully
        ↓
application starts
        ↓
database preparation
        ↓
rolling partitions ensured
        ↓
retention applied
        ↓
application marked ready
        ↓
HTTP server listens on 0.0.0.0:8080
```

Manual migration command:

```bash
npm run migrate
```

Create a new migration:

```bash
npm run migrate:create -- migration_name
```

---

# Configuration

Important settings and their Docker Compose defaults:

| Variable | Default |
|---|---:|
| `RETENTION_DAYS` | `30` |
| `MAX_IN_FLIGHT_INGESTIONS` | `2048` |
| `MAX_IN_FLIGHT_INGESTION_LOGS` | `50000` |
| `MAX_IN_FLIGHT_INGESTION_BYTES` | `67108864` |
| `INGESTION_BATCH_SIZE` | `2000` |
| `INGESTION_BATCH_DELAY_MS` | `10` |
| `HOST` | `0.0.0.0` |
| `PORT` | `8080` |

The defaults work without requiring configuration.

---

# Project Structure

```text
.
├── .github/
│   └── workflows/
│       └── ci.yml
│
├── docs/
│   ├── aggregation-design.md
│   ├── architecture.md
│   ├── contract-checklist.md
│   ├── ingestion-design.md
│   ├── load-testing-plan.md
│   ├── performance-constraints.md
│   ├── query-and-index-design.md
│   ├── retention-design.md
│   ├── schema-design.md
│   └── tech-stack.md
│
├── load-tests/
│
├── src/
│   ├── config/
│   ├── database/
│   │   └── migrations/
│   ├── metrics/
│   ├── queries/
│   ├── repositories/
│   ├── routes/
│   ├── schemas/
│   ├── services/
│   ├── utils/
│   ├── app.ts
│   └── server.ts
│
├── tests/
│   ├── config/
│   ├── contract/
│   ├── database/
│   ├── metrics/
│   ├── queries/
│   ├── repositories/
│   ├── routes/
│   ├── schemas/
│   ├── services/
│   └── utils/
│
├── Dockerfile
├── docker-compose.yml
├── package.json
└── README.md
```

---

# Architecture

The application follows a layered structure:

```text
HTTP Routes
     │
     ▼
Services
     │
     ▼
Query Builders / Repositories
     │
     ▼
pg Pool
     │
     ▼
PostgreSQL
```

The ingestion path adds a bounded batching layer:

```text
POST /logs
     │
     ▼
Validation
     │
     ▼
IngestionBatcher
     │
     ▼
Multi-row INSERT
     │
     ▼
PostgreSQL
```

This keeps HTTP concerns, business behavior, SQL construction, and database access separated while avoiding unnecessary abstraction on the performance-critical ingestion path.

---

# Design Priorities

The implementation prioritizes:

1. **Correctness**
   - strict request validation
   - deterministic query semantics
   - parameterized SQL
   - explicit contract tests

2. **Durability**
   - PostgreSQL is the source of truth
   - no successful acknowledgment before persistence
   - accepted requests remain durable under overload

3. **Throughput**
   - multi-row inserts
   - cross-request batching
   - controlled indexing
   - bounded database concurrency

4. **Bounded Resource Usage**
   - bounded ingestion queue
   - request/log/byte admission limits
   - controlled PostgreSQL concurrency
   - explicit Docker CPU and memory limits

5. **Operational Simplicity**
   - Docker Compose startup
   - automatic migrations
   - automatic partition management
   - automatic retention
   - readiness checks
   - Prometheus-compatible operational metrics
   - ingestion, query, aggregation, and process observability

6. **Testability**
   - unit tests
   - PostgreSQL integration tests
   - API contract tests
   - load tests
   - endurance tests
   - continuous integration

---

# Summary

The service provides a complete log ingestion pipeline with:

- durable batched writes
- independent per-log validation
- bounded backpressure
- deterministic cursor pagination
- flexible filtering
- time-bucketed aggregation
- automatic daily partition management
- partition-based retention
- automated migrations
- Prometheus-compatible operational metrics
- comprehensive automated testing
- reproducible Docker startup
- CI validation
- sustained high-throughput ingestion under strict resource limits

Under the documented local Docker constraints, the service sustained approximately **19,500 logs/second for five minutes**, with **100% successful ingestion, zero overload responses, and zero accepted-log loss**, while queries, aggregations, and visibility checks ran concurrently.

With operational metrics enabled, the service also sustained the required **15,000 logs/second** workload for five minutes with **100% ingestion success and zero overload responses**.