# Aggregation Design

## Goal

Return time-bucketed log counts efficiently while ingestion is active.

The API requires:

* `since`
* `until`
* `bucket`
* optional `group_by`
* optional filters such as `service`, `level`, `attr.*`, and `q`

---

# 1. Bucket Strategy — `date_bin()`

Use PostgreSQL:

```sql
date_bin(...)
```

Supported mappings:

```text
1m → 1 minute
5m → 5 minutes
1h → 1 hour
1d → 1 day
```

Use a fixed origin such as:

```text
1970-01-01 00:00:00 UTC
```

## Why

* Supports all required bucket sizes
* Handles `5m` naturally
* One consistent implementation
* Produces deterministic bucket boundaries

## Alternative

`date_trunc()`

## Trade-Off

`date_trunc()` is simple for minute/hour/day but awkward for 5-minute buckets.

---

# 2. Aggregation Flow

```text
Validate request
↓
Filter by since / until
↓
Apply service / level / attr / q filters
↓
Calculate date_bin()
↓
GROUP BY bucket
↓
Optional GROUP BY service / level
↓
COUNT(*)
↓
ORDER BY bucket ASC
```

The time range should be applied before aggregation so PostgreSQL processes as few rows as possible.

---

# 3. Grouping

Supported:

```text
group_by=service
group_by=level
```

Without `group_by`:

```json
"group": null
```

---

# 4. Performance Strategy

Useful candidate indexes:

```text
(timestamp DESC, id DESC)
→ general time filtering

(service, timestamp DESC, id DESC)
→ service + time

(level, timestamp DESC, id DESC)
→ benchmark

JSONB index
→ benchmark if attribute queries are slow

Trigram message index
→ benchmark if q queries are slow
```

The main goal is:

```text
reduce matching rows first
↓
aggregate second
```

---

# 5. Version 1 Decision

Use normal PostgreSQL aggregation directly over filtered log rows.

Do not use pre-aggregated rollup tables initially.

## Why

* Simple
* PostgreSQL remains the only source of truth
* No synchronization complexity
* Required time range already limits each aggregation
* Easier to maintain and explain

## Trade-Off

Large time ranges or expensive `attr.*` / `q` filters may still scan many rows.

These must be tested with:

```text
EXPLAIN ANALYZE
+
concurrent load testing
```

The target is aggregation latency below **1 second p95 while ingestion is active**.
