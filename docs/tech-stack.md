# Tech Stack

## Selected Stack

| Layer                | Technology            |
| -------------------- | --------------------- |
| Runtime              | Node.js               |
| Language             | TypeScript            |
| HTTP Framework       | Fastify               |
| Database             | PostgreSQL            |
| Database Client      | `pg`                  |
| Request Validation   | Fastify JSON Schema   |
| Per-Entry Validation | Zod                   |
| Migrations           | `node-pg-migrate`     |
| Testing              | Vitest                |
| API Testing          | `Fastify.inject()`    |
| Load Testing         | k6                    |
| Logging              | Pino                  |
| Docker Image         | `node:<version>-slim` |
| Development          | `tsx`                 |
| Production Build     | `tsc`                 |
| Package Manager      | npm                   |
| CI                   | GitHub Actions        |

---

# 1. HTTP Framework — Fastify

## Alternatives

* Express
* Native Node.js HTTP

## Why Fastify

* Designed for high-performance APIs
* Good for JSON-heavy workloads
* Built-in JSON Schema validation
* Good error handling
* Less work than using native HTTP
* Better fit for this performance-focused project than Express

## Trade-Offs

* More Fastify-specific concepts
* TypeScript types and runtime schemas must stay consistent
* Cannot validate every `POST /logs` entry at the route level because one invalid log must not reject the entire batch

---

# 2. Database Client — `pg`

## Alternatives

* Drizzle
* Prisma

## Why `pg`

The project uses many PostgreSQL-specific features:

* JSONB
* `ILIKE`
* `date_bin`
* custom indexes
* cursor pagination
* aggregations
* `EXPLAIN ANALYZE`

`pg` gives us direct control over the SQL and supports parameterized queries and connection pooling.

## Trade-Offs

* Less type safety than an ORM
* More SQL must be written manually
* Dynamic SQL must be built carefully

Keep database logic separate from routes:

```text
Route
  ↓
Service
  ↓
Query Builder / Repository
  ↓
pg
  ↓
PostgreSQL
```

---

# 3. Validation — Fastify JSON Schema + Zod

## Alternatives

* Fastify JSON Schema for everything
* Zod for everything
* Manual validation

## Why Two Validators?

`POST /logs` supports partial success.

```text
valid
invalid
valid
```

must still accept the two valid logs.

Therefore:

```text
Fastify JSON Schema
→ Validate top-level request structure

Zod
→ Validate each log separately
```

Fastify checks:

* body is an object
* `logs` exists
* `logs` is an array

Zod checks each log's:

* timestamp
* level
* service
* message
* attributes

## Why Zod?

* Easy per-entry validation
* `safeParse()` works well for partial success
* Good TypeScript integration
* Less manual validation code

## Trade-Offs

* Adds runtime overhead
* Errors may need to be converted to our API format

If Zod becomes a performance bottleneck, replace it with manual validation.

---

# 4. Migrations — `node-pg-migrate`

## Alternatives

* Drizzle migrations
* Plain SQL with a custom migration runner

## Why `node-pg-migrate`

The project requires migrations before the application becomes healthy.

```text
App starts
  ↓
Connect to PostgreSQL
  ↓
Run migrations
  ↓
Start accepting requests
  ↓
GET /health → 200
```

Reasons:

* Designed for PostgreSQL
* Works naturally with `pg`
* Tracks completed migrations
* Runs migrations in order
* Supports raw SQL
* Avoids building our own migration system

## Why Not Drizzle?

We are not using Drizzle for database access, so adding it only for migrations is unnecessary.

## Why Not Custom Migrations?

We would need to build migration:

* tracking
* ordering
* failure handling
* duplicate prevention

## Trade-Offs

* Adds another dependency
* Some migrations may still use raw SQL

---

# 5. Testing — Vitest

## Alternatives

* Jest
* Node.js built-in test runner

## Why Vitest

* Good TypeScript support
* Good ESM support
* Simple setup
* Easy assertions with `expect`
* Good mocking support
* Fast development experience
* Works well in CI

## Why Not Jest?

Jest is powerful but generally requires more configuration for modern TypeScript/ESM projects.

## Why Not Node's Test Runner?

It requires no dependency, but Vitest provides better testing and mocking ergonomics.

## Trade-Offs

* Adds a development dependency

---

# 6. API Integration Testing — `Fastify.inject()`

## Alternatives

* `fetch`
* `undici`

## Why `Fastify.inject()`

It tests Fastify routes without opening a real network port.

Reasons:

* Fast
* Simple
* Works with Vitest
* Easy to test status codes and responses
* Good for API contract tests

Example:

```ts
const response = await app.inject({
  method: "POST",
  url: "/logs",
  payload: {
    logs: [...]
  }
});
```

## Testing Strategy

```text
Unit tests
→ Vitest

API tests
→ Vitest + Fastify.inject()

Database tests
→ Vitest + real PostgreSQL

Docker smoke tests
→ Real HTTP requests
```

## Trade-Offs

* Does not test the real network layer
* Real HTTP tests are still required for Docker and port `8080`

---

# 7. Load Testing — k6

## Alternatives

* Autocannon
* Custom Node.js load generator

## Why k6

We need to test:

* 15,000+ logs/sec
* ingestion and aggregation concurrently
* p50 / p95 / p99 latency
* error rates
* sustained load
* different batch sizes
* aggregation p95 below 1 second

k6 can run separate workloads at the same time:

```text
k6
│
├── POST /logs continuously
│
└── GET /logs/aggregate once/sec
```

## Why Not Autocannon?

Autocannon is useful for quick endpoint benchmarks, but k6 is better for complex and repeatable load scenarios.

We can still use:

```text
Autocannon
→ Quick development tests

k6
→ Final performance tests
```

## Why Not a Custom Load Generator?

We would have to build:

* concurrency control
* rate control
* latency measurements
* percentiles
* error tracking
* reporting

That takes time away from the actual project.

## Trade-Offs

* Requires separate load-test scripts
* The machine running k6 must have enough resources

---

# 8. Logging — Fastify / Pino

## Alternatives

* `console.log`
* Another logging library

## Why Pino?

Fastify already integrates with Pino.

Reasons:

* Structured JSON logs
* Supports log levels
* Low overhead
* Easy request logging
* No additional logging library needed

Use logging for important events:

```text
Application started
Database connected
Migrations completed
Unexpected errors
Retention results
Batch failures
```

Do not log every ingested log entry.

At 15,000 logs/sec, excessive logging could hurt performance.

## Trade-Offs

* Logging still uses CPU and I/O
* Log levels must be configured carefully during load testing

---

# 9. Docker Base Image — `node:<version>-slim`

## Alternatives

* `node:<version>-alpine`
* Full `node:<version>` image

## Why `slim`?

* Smaller than the full Node image
* Debian-based
* Good software compatibility
* Easier to debug than Alpine
* Good balance between size and reliability

## Why Not Alpine?

Alpine is smaller but uses `musl` instead of `glibc`, which can cause compatibility problems with some native dependencies.

Smaller image size also does not mean faster application performance.

## Why Not the Full Image?

It contains many packages we do not need and produces a larger image.

## Trade-Offs

* Larger than Alpine

---

# 10. TypeScript Execution — `tsx` + `tsc`

## Development

Use:

```bash
tsx watch src/server.ts
```

This runs TypeScript directly and automatically reloads during development.

## Production

Use:

```text
TypeScript
   ↓
tsc
   ↓
JavaScript
   ↓
Node.js
```

Example:

```bash
npm run build
node dist/server.js
```

## Why?

* `tsx` makes development easier
* `tsc` catches type errors during the build
* Production runs plain JavaScript
* Works well with Docker and CI

## Trade-Offs

* Production requires a build step

---

# 11. Package Manager — npm

## Alternatives

* pnpm
* Yarn

## Why npm?

* Included with Node.js
* Simple
* No extra setup
* `package-lock.json` gives reproducible installs
* `npm ci` works well in Docker and CI
* Enough for a single backend service

## Why Not pnpm?

pnpm is faster and more disk-efficient, but its main advantages matter more in large projects and monorepos.

## Why Not Yarn?

Yarn has useful advanced features, but we do not need them for this project.

## Trade-Offs

* pnpm may install faster and use less disk space

---

# 12. CI — GitHub Actions

## Alternatives

* GitLab CI
* CircleCI
* Local testing only

## Why GitHub Actions?

The project repository is hosted on GitHub, so GitHub Actions integrates naturally with it.

Reasons:

* Runs automatically on pushes and pull requests
* Good Node.js support
* Works with `npm ci`
* Can run PostgreSQL for integration tests
* Can run builds, linting and tests
* No separate CI platform required

## CI Pipeline

```text
Push / Pull Request
        ↓
npm ci
        ↓
TypeScript build
        ↓
Lint
        ↓
Unit tests
        ↓
Start PostgreSQL
        ↓
Run migrations
        ↓
Integration / contract tests
        ↓
Docker smoke test
```

Use real PostgreSQL because important features such as:

* JSONB
* migrations
* `date_bin`
* indexes
* cursor queries

cannot be properly verified with mocks alone.

The Docker smoke test should verify:

```text
GET /health
POST /logs
GET /logs
GET /logs/aggregate
```

through:

```text
localhost:8080
```

## Trade-Offs

* Integration and Docker tests make CI slower
* CI does not replace the final k6 performance tests

---

# Final Stack

```text
Node.js
└── TypeScript
    │
    ├── Fastify
    │   ├── Fastify JSON Schema
    │   │   └── Top-level request validation
    │   ├── Fastify.inject()
    │   │   └── API testing
    │   └── Pino
    │       └── Application logging
    │
    ├── Zod
    │   └── Per-entry validation
    │
    ├── pg
    │   └── PostgreSQL
    │
    ├── node-pg-migrate
    │   └── Database migrations
    │
    ├── Vitest
    │   └── Unit and integration tests
    │
    ├── k6
    │   └── Load testing
    │
    ├── tsx
    │   └── Development
    │
    ├── tsc
    │   └── Production build
    │
    ├── npm
    │   └── Package management
    │
    ├── GitHub Actions
    │   └── CI
    │
    └── Docker
        └── node:<version>-slim
            └── Production image
```
