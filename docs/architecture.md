# Architecture

## Tech Stack

* Node.js + TypeScript
* Fastify
* PostgreSQL
* `pg`
* Zod + Fastify JSON Schema
* node-pg-migrate
* Vitest
* k6

---

## High-Level Architecture

```text
                    CLIENTS
                       │
                       │ HTTP
                       ▼
                ┌──────────────┐
                │   Fastify    │
                │ Node.js + TS │
                └──────┬───────┘
                       │
          ┌────────────┼────────────┐
          │            │            │
          ▼            ▼            ▼
       Health       Ingestion      Query
                    Validation    Validation
          │            │            │
          │            ▼            ▼
          │      Ingestion       Query /
          │       Service       Aggregate
          │            │         Service
          │            ▼            │
          │       Repository        ▼
          │            │       Query Builder
          │            │            │
          └────────────┼────────────┘
                       │
                       ▼
                    pg.Pool
                       │
                       ▼
                ┌──────────────┐
                │  PostgreSQL  │
                │              │
                │ logs table   │
                │ JSONB attrs  │
                │ indexes      │
                │ partitions   │
                └──────────────┘
```

---

## Ingestion Flow

```text
POST /logs
→ parse request
→ validate each log
→ separate valid and rejected entries
→ multi-row INSERT
→ PostgreSQL commit
→ return response
```

PostgreSQL must commit the accepted logs before the API returns `200`.

---

## Query Flow

```text
GET /logs
→ validate query parameters
→ decode cursor
→ build parameterized SQL
→ PostgreSQL query
→ create next cursor if needed
→ return logs
```

Results are ordered by:

```text
timestamp DESC, id DESC
```

to provide deterministic cursor pagination.

---

## Aggregation Flow

```text
GET /logs/aggregate
→ validate filters and aggregation parameters
→ build SQL
→ PostgreSQL date_bin()
→ GROUP BY
→ COUNT
→ return buckets
```

Aggregation is performed inside PostgreSQL rather than in Node.js.

---

## Database Schema

```text
id          BIGINT
timestamp   TIMESTAMPTZ
level       TEXT
service     TEXT
message     TEXT
attributes  JSONB
```

Fixed fields use normal relational columns.

Arbitrary log attributes are stored in `JSONB`.

---

## Initial Index

```text
(timestamp DESC, id DESC)
```

This supports:

* Latest-log queries
* Time ordering
* Cursor pagination

Additional indexes will only be added if benchmarking proves they are useful.

---

## Retention

Use daily PostgreSQL range partitions based on:

```text
timestamp
```

Configuration:

```text
RETENTION_DAYS=30
```

Expired data is removed by dropping fully expired partitions.

---

## Application Layers

```text
Routes
  ↓
Services
  ↓
Query Builders / Repositories
  ↓
pg.Pool
  ↓
PostgreSQL
```

Responsibilities are separated so HTTP handlers do not contain database or query-building logic.

---

## Resource Limits

```text
Application:
0.5 CPU
256 MB RAM

PostgreSQL:
1 CPU
1 GB RAM
```

The architecture therefore avoids unnecessary infrastructure such as:

```text
Kafka
Redis
load balancer
multiple application servers
```

for Version 1.

---

## Benchmark Decisions Still Open

The following will be decided through load testing:

* Exact ingestion batch size
* Exact PostgreSQL pool size
* Whether a level index is needed
* Whether a trigram message index is needed
* Whether JSONB indexes are needed
* Whether `COPY` is worth using
* Whether validation needs further optimization

---

## Final Design Principle

Keep the application layer lightweight, batch database writes, push filtering and aggregation into PostgreSQL, and only add optimizations after benchmarking shows they are necessary.
