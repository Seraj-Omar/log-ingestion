# Log Ingestion and Query Service

A high-throughput log ingestion, querying, and aggregation service built with **Node.js, TypeScript, Fastify, and PostgreSQL**.

The service accepts batched logs, validates entries independently, persists accepted logs durably to PostgreSQL, and provides filtered querying and time-bucketed aggregation.

The implementation is designed for constrained resources and targets **15,000+ logs/second**. The final end-to-end endurance benchmark sustained **15,000 logs/second for five minutes**, persisting **4.5 million logs with 100% ingestion success and zero accepted-log loss** under the specified Docker resource limits.

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
- Live log tailing over Server-Sent Events (SSE)
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
- **pg-copy-streams**
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
PostgreSQL COPY FROM STDIN
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

# `GET /logs/tail`

Streams newly persisted logs in real time using Server-Sent Events (SSE).

Example:

```bash
curl -N http://localhost:8080/logs/tail
```

A connected client first receives:

```text
: connected
```

Persisted logs are then streamed as SSE events:

```text
event: logs
data: {"logs":[...]}
```

Live-tail behavior:

- logs are published only after PostgreSQL persistence succeeds
- a heartbeat is sent every 15 seconds
- disconnected clients are removed automatically
- slow clients do not block ingestion
- when a client is backpressured, live events may be skipped until its socket drains

Live tail is best-effort observability. PostgreSQL remains the durable source of truth.

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

## User ID Attribute

```sql
((attributes ->> 'user_id'), timestamp DESC, id DESC)
```

Provides an optimized path for the frequently queried `user_id` attribute while preserving generic JSONB attribute filtering for arbitrary attribute keys.

A targeted expression index is used instead of indexing every possible JSONB attribute because additional indexes increase ingestion cost.

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

Validated requests are coalesced by a bounded cross-request batcher and persisted using PostgreSQL `COPY FROM STDIN`.

The default configuration uses:

```text
Database batch target:      2,000 logs
Tail batching delay:           10 ms
PostgreSQL writers:             1
Shared PostgreSQL pool size:    3
```

`COPY FROM STDIN` reduces SQL parsing and statement overhead while allowing log data to be streamed to PostgreSQL efficiently.

A request is acknowledged only after the COPY operation containing its accepted logs succeeds. PostgreSQL therefore remains the durable source of truth.

The batching layer also bounds outstanding work by request count, log count, and retained request bytes so overload cannot create an unbounded database work queue.

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

Performance was measured locally using the Docker resource constraints configured for the project:

```text
Application:   PostgreSQL:
0.5 CPU        1 CPU
256 MB RAM     1 GB RAM
```

## Final 5-Minute End-to-End Benchmark

The final build was tested for five minutes at the required **15,000 logs/second** while queries, aggregations, read-after-write visibility checks, and final persistence verification ran concurrently.

Configuration:

```text
Target ingestion:       15,000 logs/s
Duration:               300 seconds
Batch size:             500 logs/request
Request rate:           30 POST/s
Concurrent querying:    1 request/s
Concurrent aggregation: 1 request/s
Visibility probes:      enabled
```

Measured results:

| Metric | Result |
|---|---:|
| Scheduled ingestion rate | **15,000.00 logs/s** |
| Accepted benchmark logs | **4,500,000** |
| Persisted benchmark logs | **4,500,000** |
| Completed ingestion POSTs | **9,000 / 9,000** |
| POST success | **100.00%** |
| HTTP 429 responses | **0** |
| HTTP 503 responses | **0** |
| Dropped ingestion iterations | **0** |
| POST timeouts | **0** |
| POST latency p95 | **42.35 ms** |
| GET success | **100.00%** |
| GET latency p95 | **19.87 ms** |
| Aggregation success | **100.00%** |
| Aggregation latency p95 | **294.39 ms** |
| Visibility success | **100.00%** |
| Visibility latency p95 | **6 ms** |
| Worst measured visibility | **10 ms** |
| Accepted minus persisted | **0** |
| Application RSS after benchmark | **~78.5 MB** |
| Application heap usage | **~15.6 MB** |

The final drain confirmed:

```text
accepted logs - persisted logs = 0
```

The application therefore sustained the required ingestion workload for five minutes while remaining well below its 256 MB memory limit.

Internal operational metrics recorded approximately:

```text
4.50 million persisted logs
8,929 database COPY operations
~504 logs per COPY operation
~17.2 ms average COPY duration
~4.6 ms average query duration
~111.5 ms average aggregation duration
```

These measurements are local benchmark results under the documented Docker limits and should not be interpreted as universal production throughput guarantees.

---

## Stress and Overload Testing

Additional workloads were intentionally run beyond the required benchmark.

With reads disabled, the COPY-based ingestion path sustained approximately **20,000 logs/second for one minute with 0% ingestion failures**.

A substantially heavier mixed workload consisting of:

```text
15,000 logs/s
10 normal queries/s
10 attribute queries/s
1 aggregation/s
```

eventually saturated the 1-CPU PostgreSQL container during a five-minute run.

Under that stress workload:

```text
ingestion failures: 20.69%
aggregation p95:    2.32 s
```

This workload is intentionally much heavier than the primary end-to-end benchmark and demonstrates the behavior of the bounded backpressure mechanism under database saturation.

When capacity is exhausted, ingestion requests are rejected with `503 Service Unavailable` rather than allowing queued database work and memory usage to grow without bound.

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

Final five-minute benchmark:

```bash
DURATION=300s \
TARGET_LPS=15000 \
BATCH_SIZE=500 \
PRE_ALLOCATED_VUS=200 \
MAX_VUS=400 \
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
25 test files
324 unit tests
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
408 automated tests
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
006_add_user_id_attribute_index
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
│   ├── live-tail/
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
│   ├── live-tail/
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
COPY FROM STDIN
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
   - streamed PostgreSQL `COPY FROM STDIN`
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
   - live log tailing over SSE

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
- live log tailing over SSE
- comprehensive automated testing
- reproducible Docker startup
- CI validation
- sustained high-throughput ingestion under strict resource limits

Under the documented Docker constraints, the final build sustained **15,000 logs/second for five minutes**, accepting and persisting **4.5 million benchmark logs with 100% POST success, zero overload responses, zero dropped ingestion iterations, and zero accepted-log loss**.

During the same run, query p95 was **19.87 ms**, aggregation p95 was **294.39 ms**, worst measured visibility was **10 ms**, and application RSS remained approximately **78.5 MB**.

Operational metrics and live-tail SSE remain additive features and do not change the required API contract. PostgreSQL remains the durable source of truth for both reads and writes.
