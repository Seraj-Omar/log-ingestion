# Retention Design

## Goal

Remove expired logs efficiently without causing large deletes, table bloat, or major disruption to ingestion and queries.

---

## Options Considered

### Standard `DELETE`

```sql
DELETE FROM logs
WHERE timestamp < $1;
```

Simple, but large deletes can:

* Create dead tuples
* Increase table bloat
* Require more VACUUM work
* Consume CPU, disk I/O, and WAL

---

### Chunked `DELETE`

Delete old rows in smaller batches.

```text
delete small batch
→ commit
→ repeat
```

This reduces the impact of one large delete, but it still creates dead tuples and requires VACUUM.

---

### PostgreSQL Partitioning

Split logs into time-based partitions.

Example:

```text
logs
├── logs_2026_08_10
├── logs_2026_08_11
└── logs_2026_08_12
```

Expired data can be removed by dropping an old partition instead of deleting rows individually.

---

# Selected Strategy

Use PostgreSQL daily range partitioning by:

```text
timestamp
```

with one partition per day.

Example:

```text
logs_2026_08_10
```

contains logs from:

```text
2026-08-10 00:00 UTC
```

until:

```text
2026-08-11 00:00 UTC
```

---

## Why Daily Partitions

The default retention period is:

```text
30 days
```

Daily partitions allow old data to be removed with day-level precision.

Monthly partitions could contain both expired and still-valid logs.

---

## Configuration

Use:

```text
RETENTION_DAYS
```

Default:

```text
30
```

If it is not provided, the service automatically uses 30 days.

This keeps:

```bash
docker compose up
```

working without additional configuration.

---

## Partition Lifecycle

At startup:

```text
run migrations
→ ensure today's partition exists
→ ensure tomorrow's partition exists
→ service becomes healthy
```

Periodically:

```text
create future partition
→ calculate retention cutoff
→ drop fully expired partitions
```

Only fully expired partitions should be removed.

---

## Ingestion

Application code always inserts into the main logical table:

```sql
INSERT INTO logs (...)
VALUES (...);
```

PostgreSQL decides which daily partition stores each row.

---

## Failure Behavior

If retention cleanup fails:

```text
log the error
→ keep ingestion and queries running
→ retry later
```

If required migrations fail during startup, the service should not report itself as healthy.

---

## Advantages

* Very fast removal of old data
* Avoids large row-by-row deletes
* Reduces dead tuples
* Reduces VACUUM pressure
* Fits naturally with time-based logs
* Can benefit time-range queries through partition pruning

---

## Trade-Offs

* More implementation complexity
* Partitions must be created automatically
* Partition boundaries must be correct
* Partition behavior still needs benchmarking

---

# Final Decision

```text
Strategy:
Daily PostgreSQL range partitioning

Partition key:
timestamp

Retention:
RETENTION_DAYS

Default:
30 days

Cleanup:
Drop fully expired partitions

Partition preparation:
Today + tomorrow
```

Partitioning is chosen because it matches the project's time-based, high-ingestion workload and avoids the cleanup cost of repeatedly deleting large numbers of rows.
