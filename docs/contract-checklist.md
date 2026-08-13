# Contract Checklist

Check an item only after it is **implemented and tested**.

---

# GET /health

* [ ] Returns `200` only when:

  * PostgreSQL is connected
  * migrations are complete
  * app is ready
* [ ] Always unauthenticated

---

# POST /logs

## Request

* [ ] Malformed JSON → `400`
* [ ] Missing/invalid `logs` array → `400`
* [ ] Empty batch → `400`
* [ ] Single-entry batch works

## Log Validation

Each log must have:

* [ ] Valid ISO timestamp
* [ ] Timestamp not more than 5 minutes in future
* [ ] Valid level: `debug | info | warn | error`
* [ ] Non-empty string `service`
* [ ] Non-empty string `message`

Attributes:

* [ ] Optional
* [ ] Must be an object
* [ ] Values can only be:

  * string
  * number
  * boolean
* [ ] Nested objects rejected
* [ ] Arrays rejected

## Batch Behavior

* [ ] Valid entries are stored
* [ ] Invalid entries are rejected individually
* [ ] Rejections include `index` and `reason`
* [ ] Partial success → `200`
* [ ] All invalid → `400`
* [ ] One invalid log does not reject valid logs
* [ ] Return success only after logs are durably stored

## Overload

When the bounded ingestion capacity is exhausted:

* [ ] Return `503`
* [ ] Return `Retry-After: 1`
* [ ] Return `{ "error": "ingestion overloaded" }`
* [ ] Do not start persistence for the rejected batch

---

# GET /logs

## Filters

* [ ] `service` — exact match
* [ ] `level` — exact match
* [ ] `since` — inclusive
* [ ] `until` — exclusive
* [ ] `attr.<key>` — string comparison
* [ ] `q` — case-insensitive substring search
* [ ] Filters can be combined

## Validation

* [ ] Invalid timestamps → `400`
* [ ] `until <= since` → `400`
* [ ] Invalid level → `400`

## Limit

* [ ] Default = `100`
* [ ] Minimum = `1`
* [ ] Maximum = `1000`
* [ ] Invalid/non-numeric limit → `400`

## Pagination

* [ ] Results ordered by `timestamp DESC`
* [ ] Equal timestamps have deterministic ordering
* [ ] Valid cursor returns next page
* [ ] Invalid cursor → `400`
* [ ] No duplicates or skipped logs
* [ ] `next_cursor = null` when finished

---

# GET /logs/aggregate

## Required

* [ ] `since`
* [ ] `until`
* [ ] `bucket`

Missing/invalid required parameters → `400`

## Buckets

Support:

* [ ] `1m`
* [ ] `5m`
* [ ] `1h`
* [ ] `1d`

Unsupported bucket → `400`

## Grouping

Support:

* [ ] No grouping → `group: null`
* [ ] `group_by=service`
* [ ] `group_by=level`

Invalid `group_by` → `400`

## Filters

Support:

* [ ] `service`
* [ ] `level`
* [ ] `attr.<key>`
* [ ] `q`

## Results

* [ ] Correct counts
* [ ] Ordered by bucket start ascending
* [ ] One result per bucket/group
* [ ] Empty buckets may be omitted

---

# Error Handling

* [ ] Invalid client input never causes `500`
* [ ] Query errors use:

```json
{
  "error": "<description>"
}
```

* [ ] Ingestion rejection uses:

```json
{
  "index": 0,
  "reason": "<description>"
}
```

---

# Docker / Startup

* [ ] App listens on port `8080`
* [ ] Available at `localhost:8080`
* [ ] `docker compose up` starts everything
* [ ] No `.env` required by default
* [ ] PostgreSQL starts automatically
* [ ] Migrations run automatically
* [ ] PostgreSQL is the source of truth

---

# Security

* [ ] Use parameterized SQL
* [ ] Never concatenate user values directly into SQL
* [ ] Dynamic filters are safe from SQL injection

---

# Architecture

Keep responsibilities separated:

```text
Route
  ↓
Service
  ↓
Query Builder / Repository
  ↓
PostgreSQL
```

* [ ] Validation separated from routes
* [ ] SQL/query building separated from routes
* [ ] Database logic separated from HTTP logic

---

# Performance

* [ ] `15,000+ logs/sec`
* [ ] Around `1,000,000` stored logs
* [ ] Aggregation p95 `< 1 second`
* [ ] Queries remain fast during ingestion
* [ ] New logs queryable within `20 seconds`
* [ ] ~1 aggregation request/sec during ingestion
* [ ] No crashes or dropped accepted requests

Limits:

```text
Application:
0.5 CPU
256 MB RAM

PostgreSQL:
1 CPU
1 GB RAM
```

---

# CI

* [ ] Install dependencies
* [ ] Build TypeScript
* [ ] Lint
* [ ] Run tests
* [ ] Run database integration tests
* [ ] Run API contract tests
* [ ] Run Docker smoke test

---

# README

Document:

* [ ] Setup
* [ ] API
* [ ] Architecture
* [ ] Schema
* [ ] Indexes
* [ ] Attribute strategy
* [ ] Retention strategy
* [ ] Load-testing method
* [ ] Performance results
* [ ] Bottlenecks and optimizations
* [ ] Known limitations

---

# Demo

Be able to explain:

* [ ] Architecture
* [ ] Ingestion flow
* [ ] Query flow
* [ ] Schema
* [ ] Attribute storage
* [ ] Index choices
* [ ] Retention strategy
* [ ] `EXPLAIN ANALYZE`
* [ ] Performance trade-offs
