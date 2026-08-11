# Ingestion Design

## Goal

Sustain **15,000+ logs/sec** while keeping queries responsive.

---

# 1. Write Strategy — Multi-Row INSERT

## Alternative

* One INSERT per log

## Why

* Fewer SQL commands
* Fewer database round trips
* Matches the batch-based `POST /logs` API
* Better for high-throughput ingestion

## Trade-Off

* Larger batches create larger SQL statements
* Batch size must be benchmarked

---

# 2. Transaction Strategy

Use one multi-row INSERT per database batch.

Do not use explicit `BEGIN / COMMIT` when the batch only needs one INSERT.

Use explicit transactions only when multiple database operations must succeed together.

## Durability

* Wait for PostgreSQL to commit before returning `200`
* Keep synchronous commit enabled

## Why

* Multi-row INSERT is already atomic
* One commit covers many logs
* Meets the durability requirement
* WAL allows PostgreSQL to recover committed data

## Trade-Off

Synchronous commits add some latency, but they prevent acknowledged logs from being lost after a crash.

---

# 3. Multi-Row INSERT vs COPY

## Initial Choice

Use multi-row INSERT.

## Alternative

* PostgreSQL `COPY`

## Why

* Simpler
* Works directly with `pg`
* Easy parameterization
* Easy JSONB handling
* Easier to maintain and debug

## Optimization

If multi-row INSERT cannot reach the required throughput, benchmark `COPY`.

## Trade-Off

```text
Multi-row INSERT
→ simpler
→ possibly lower maximum throughput

COPY
→ potentially faster
→ more complex
```

---

# 4. Batch Size

## Start With

```text
500 logs/batch
```

## Benchmark

```text
100
250
500
1000
possibly 5000
```

## Why

Larger batches reduce database overhead.

Very large batches increase:

* memory usage
* request latency
* SQL size

## Trade-Off

```text
Small batch
→ lower latency
→ more database overhead

Large batch
→ higher throughput
→ more memory and latency
```

---

# 5. Connection Pooling — `pg.Pool`

## Start With

```text
4–8 connections
```

## Benchmark

```text
2
4
8
12
```

## Why

* Reuses database connections
* Avoids connection setup overhead
* Limits pressure on PostgreSQL
* PostgreSQL only has 1 CPU

## Trade-Off

```text
Pool too small
→ requests wait

Pool too large
→ more database contention
```

The goal is to **limit useful concurrency**, not maximize the number of connections.

---

# 6. Backpressure

## Strategy

* Limit database concurrency with `pg.Pool`
* Do not allow unlimited queue growth
* Use `429` or `503` only when overloaded
* Never return `200` before PostgreSQL commits

## Why

* Protects application memory
* Protects PostgreSQL
* Prevents crashes during overload

## Trade-Off

```text
No backpressure
→ more short-term acceptance
→ risk of crashes

Backpressure
→ safer
→ rejected requests reduce throughput
```

Backpressure is a last-resort safety mechanism.

---

# Final Flow

```text
POST /logs
    ↓
Validate request
    ↓
Validate each log
    ↓
Separate valid / rejected
    ↓
Multi-row INSERT valid logs
    ↓
PostgreSQL commit
    ↓
Return response
```

---

# Current Decisions

* Multi-row INSERT
* One HTTP batch → one DB batch initially
* Start with 500 logs/batch
* Use `pg.Pool`
* Start with 4–8 DB connections
* Keep synchronous durability
* Use backpressure only when overloaded
* Consider `COPY` only if benchmarks show it is needed

---

# Benchmark Later

* Batch size
* Pool size
* Multi-row INSERT vs COPY
* Validation overhead
