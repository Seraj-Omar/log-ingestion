# Query and Index Design

## Goal

Keep `GET /logs` fast on 1,000,000+ rows while preserving high ingestion throughput. The project requires freely combinable filters, deterministic timestamp ordering, cursor pagination, substring message search, and strong query performance during ingestion.

---

# 1. Main Ordering Index

Use:

```sql
(timestamp DESC, id DESC)
```

## Why

* Supports required `timestamp DESC` sorting
* `id` provides deterministic tie-breaking
* Helps time-range queries
* Supports cursor pagination
* Works well with `LIMIT`

## Trade-Off

* Adds B-tree maintenance on every insert

---

# 2. B-tree vs BRIN

## B-tree

Use as the main index.

```text
(timestamp DESC, id DESC)
```

### Why

* Precise
* Supports ordering
* Good for recent-log queries
* Good for `LIMIT`
* Good for cursor pagination

## BRIN

Do not add initially.

### Why

BRIN is:

* very small
* cheap to maintain
* good for very large time-ordered tables

But it is less precise and does not help our ordered pagination as well as B-tree.

### Decision

```text
B-tree → keep
BRIN → benchmark later if needed
```

---

# 3. Service and Level Indexes

## Service

Use:

```sql
(service, timestamp DESC, id DESC)
```

### Why

Supports:

```text
service filter
+
timestamp ordering
+
pagination
```

## Level

Candidate:

```sql
(level, timestamp DESC, id DESC)
```

But benchmark before keeping it.

### Why

`level` has only four possible values, so it may not be selective enough to justify another index.

### Decision

```text
Service index → keep
Level index → benchmark first
```

The service index is created on the partitioned parent so existing and future
partitions receive matching child indexes. PostgreSQL cannot create an index
concurrently on a partitioned parent, so migration `002` requires a bounded
write-unavailable deployment window while it indexes an existing dataset.

---

# 4. JSONB Attribute Indexing

Attribute queries use:

```sql
attributes ->> key = value
```

Example:

```sql
attributes ->> 'user_id' = '42'
```

## Initial Decision

Do not add a JSONB index initially.

## Why

* Keeps ingestion faster
* Arbitrary keys make expression indexes hard to generalize
* Generic GIN indexes add write cost
* We should only add them if benchmarks show attribute queries are too slow

## Benchmark Later

```text
No JSONB index
GIN jsonb_ops
GIN jsonb_path_ops
Expression indexes for hot attributes
```

---

# 5. Message Search

The API requires:

```text
q=declined
```

as a case-insensitive substring search.

Use:

```sql
message ILIKE '%' || $1 || '%'
```

## Candidate Index

```sql
GIN(message gin_trgm_ops)
```

using PostgreSQL `pg_trgm`.

## Why

* Designed for substring searches
* Helps `GET /logs`
* Also helps filtered aggregation queries using `q`

## Trade-Off

* Adds index size
* Adds WAL
* Slows ingestion

### Decision

```text
GIN trigram index → strong candidate
Benchmark write cost before finalizing
```

---

# 6. Dynamic Query Building

Filters may be freely combined:

```text
service
level
since
until
attr.*
q
cursor
```

The project requires safe parameterized SQL, and SQL injection is disqualifying.

## Strategy

Maintain:

```text
conditions[]
values[]
```

Example:

```sql
WHERE service = $1
AND level = $2
AND timestamp >= $3
```

with:

```text
values:
["checkout", "error", "..."]
```

## Rules

```text
User values
→ always parameters

SQL structure
→ application-controlled only

Attribute keys and values
→ parameterized

Never directly interpolate user input into SQL
```

## Architecture

```text
Route
↓
Validate query
↓
Query Service
↓
Query Builder
↓
Repository
↓
pg.Pool
↓
PostgreSQL
```

---

# 7. Cursor Pagination

Use **keyset pagination**, not OFFSET.

## Ordering

```sql
ORDER BY timestamp DESC, id DESC
```

## Cursor Contents

```text
timestamp
+
id
```

## Next Page Query

```sql
(timestamp, id) < ($cursorTimestamp, $cursorId)
```

## Cursor Format

```text
timestamp + id
↓
serialize
↓
Base64 encode
↓
opaque cursor
```

## Next Page Detection

If the requested limit is:

```text
100
```

query:

```text
101 rows
```

If 101 rows are returned:

```text
there is another page
```

Return the first 100 and generate a cursor.

If 100 or fewer are returned:

```text
next_cursor = null
```

## Why

* Efficient deep pagination
* No expensive large `OFFSET`
* Deterministic
* Handles duplicate timestamps
* Works with the main `(timestamp, id)` index
* No extra `COUNT(*)` query needed

---

# Initial Index Set

```text
Keep:
(timestamp DESC, id DESC)

Likely:
(service, timestamp DESC, id DESC)

Benchmark:
(level, timestamp DESC, id DESC)

Attributes:
no index initially

Message:
GIN trigram candidate
```

---

# Benchmark Before Finalizing

Measure:

```text
Ingestion logs/sec
Query p95
Aggregation p95
Index size
CPU usage
RAM usage
```

Compare performance with and without optional indexes.

The final index set should be based on measured results, not assumptions.
These choices as hypotheses until benchmarking proves them.
