# Schema Design

## 1. Attribute Strategy — Hybrid Relational + JSONB

### Fixed Fields

* `id`
* `timestamp`
* `level`
* `service`
* `message`

### Dynamic Field

* `attributes JSONB`

### Why

* Simple schema
* One row per log
* Fast writes
* Fixed fields are easy to index
* Arbitrary attributes remain flexible
* PostgreSQL supports JSONB queries and GIN indexes

### Trade-Offs

* Attribute queries may need GIN or expression indexes
* More indexes can slow ingestion
* Attribute-query performance must be benchmarked

---

# 2. ID — `BIGINT`

## Alternatives

* UUID
* UUIDv7

## Why

* Small index size
* Fast comparisons
* Good insert locality
* Simple database-generated IDs
* Good tie-breaker for cursor pagination
* No need for distributed ID generation

## Trade-Offs

* IDs are predictable
* Not globally unique outside this database

These are not important problems for this project.

---

# 3. Timestamp — `TIMESTAMPTZ`

## Alternatives

* `TIMESTAMP`
* `TEXT`

## Why

* Native time comparisons
* Works well with indexes
* Supports `date_bin` and other time functions
* Handles ISO 8601 timestamps naturally
* Avoids timezone ambiguity
* Useful for aggregation and retention

## Trade-Off

* Timezone handling must remain consistent

---

# 4. Level — `TEXT + CHECK`

Example:

```sql
level TEXT NOT NULL
CHECK (level IN ('debug', 'info', 'warn', 'error'))
```

## Why

* Simple
* Readable
* Database enforces valid levels
* Easy to maintain
* Avoids unnecessary enum or integer mapping

## Trade-Offs

* Slightly more storage than an integer
* Database constraint and application validation must stay aligned

---

# 5. Attribute Comparison

The API says attribute values are compared as strings.

So these:

```json
{"user_id": 42}
```

and:

```json
{"user_id": "42"}
```

should both match:

```text
attr.user_id=42
```

Use PostgreSQL's `->>` operator to extract the JSONB value as text.

Example:

```sql
attributes ->> 'user_id' = '42'
```

## Why

* Matches the API contract
* Works for string, number, and boolean values
* Keeps original JSONB types in storage
* No need to convert all attributes to strings before storing them

Example:

```json
{"retries": 3}
{"retries": "3"}
```

Both match:

```text
attr.retries=3
```

through:

```sql
attributes ->> 'retries' = '3'
```

---

# Final Candidate Schema

```text
logs
├── id          BIGINT
├── timestamp   TIMESTAMPTZ
├── level       TEXT + CHECK
├── service     TEXT
├── message     TEXT
└── attributes  JSONB
```
