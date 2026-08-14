import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

const ENV =
  typeof globalThis !== "undefined" && globalThis.__ENV
    ? globalThis.__ENV
    : {};

const PROFILE_SHAPES = {
  stress: [
    { multiplier: 1, seconds: 30 },
    { multiplier: 1.5, seconds: 60 },
    { multiplier: 2, seconds: 60 },
  ],
  spike: [
    { multiplier: 0.5, seconds: 30 },
    { multiplier: 2, seconds: 10 },
    { multiplier: 0.5, seconds: 60 },
  ],
  breakpoint: [
    { multiplier: 1, seconds: 30 },
    { multiplier: 1.5, seconds: 30 },
    { multiplier: 2, seconds: 30 },
    { multiplier: 3, seconds: 30 },
  ],
};

function positiveInteger(name, value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}

const PROFILE = String(ENV.PROFILE || "stress").toLowerCase();

if (!Object.prototype.hasOwnProperty.call(PROFILE_SHAPES, PROFILE)) {
  throw new Error("PROFILE must be stress, spike, or breakpoint");
}

const BASE_URL = ENV.BASE_URL || "http://127.0.0.1:8080";
const BATCH_SIZE = positiveInteger(
  "BATCH_SIZE",
  Number(ENV.BATCH_SIZE || 50),
);
const BASE_TARGET_LPS = positiveInteger(
  "BASE_TARGET_LPS",
  Number(ENV.BASE_TARGET_LPS || 15000),
);
const SUMMARY_PATH =
  ENV.SUMMARY_PATH || "staged-ingestion-summary.json";
const REQUEST_TIMEOUT = ENV.REQUEST_TIMEOUT || "10s";
const SERVICE_COUNT = 20;

if (typeof SUMMARY_PATH !== "string" || SUMMARY_PATH.trim() === "") {
  throw new Error("SUMMARY_PATH must be a non-empty string");
}

const profileShape = PROFILE_SHAPES[PROFILE];
let stageStartSeconds = 0;
const ingestionStages = profileShape.map(({ multiplier, seconds }, index) => {
  const targetLogsPerSecond = BASE_TARGET_LPS * multiplier;
  const targetRequestsPerSecond = targetLogsPerSecond / BATCH_SIZE;

  if (
    !Number.isInteger(targetLogsPerSecond) ||
    !Number.isInteger(targetRequestsPerSecond) ||
    targetRequestsPerSecond <= 0
  ) {
    throw new Error(
      "Each profile target must be exactly divisible by BATCH_SIZE",
    );
  }

  const stage = {
    index: index + 1,
    multiplier,
    seconds,
    startSeconds: stageStartSeconds,
    targetLogsPerSecond,
    targetRequestsPerSecond,
  };

  stageStartSeconds += seconds;
  return stage;
});

const TOTAL_PROFILE_SECONDS = stageStartSeconds;
const PEAK_REQUEST_RATE = Math.max(
  ...ingestionStages.map((stage) => stage.targetRequestsPerSecond),
);
const PEAK_PRE_ALLOCATED_VUS = positiveInteger(
  "PRE_ALLOCATED_VUS",
  ENV.PRE_ALLOCATED_VUS === undefined
    ? Math.max(40, Math.ceil(PEAK_REQUEST_RATE / 4))
    : Number(ENV.PRE_ALLOCATED_VUS),
);
const PEAK_MAX_VUS = positiveInteger(
  "MAX_VUS",
  ENV.MAX_VUS === undefined
    ? Math.max(160, PEAK_REQUEST_RATE)
    : Number(ENV.MAX_VUS),
);
const READ_PRE_ALLOCATED_VUS = positiveInteger(
  "READ_PRE_ALLOCATED_VUS",
  Number(ENV.READ_PRE_ALLOCATED_VUS || 3),
);
const READ_MAX_VUS = positiveInteger(
  "READ_MAX_VUS",
  Number(ENV.READ_MAX_VUS || 20),
);

if (PEAK_MAX_VUS < PEAK_PRE_ALLOCATED_VUS) {
  throw new Error(
    "MAX_VUS must be greater than or equal to PRE_ALLOCATED_VUS",
  );
}

if (READ_MAX_VUS < READ_PRE_ALLOCATED_VUS) {
  throw new Error(
    "READ_MAX_VUS must be greater than or equal to READ_PRE_ALLOCATED_VUS",
  );
}

function proportionalVUs(peakVUs, requestRate) {
  return Math.max(1, Math.ceil((peakVUs * requestRate) / PEAK_REQUEST_RATE));
}

const EXPECTED_SCHEDULED_REQUESTS = ingestionStages.reduce(
  (total, stage) =>
    total + stage.targetRequestsPerSecond * stage.seconds,
  0,
);
const EXPECTED_SCHEDULED_LOGS = EXPECTED_SCHEDULED_REQUESTS * BATCH_SIZE;

const acceptedLogs = new Counter("accepted_logs");
const rejectedLogs = new Counter("rejected_logs");
const completedIngestionRequests = new Counter(
  "completed_ingestion_requests",
);
const postResponses200 = new Counter("post_responses_200");
const postResponses429 = new Counter("post_responses_429");
const postResponses503 = new Counter("post_responses_503");
const postOtherResponses = new Counter("post_responses_other");
const postTimeouts = new Counter("post_timeouts");
const postTransportErrors = new Counter("post_transport_errors");
const invalidSuccessResponses = new Counter("invalid_success_responses");
const postSuccess = new Rate("post_success");
const postLatency = new Trend("post_latency", true);

const querySuccess = new Rate("query_success");
const queryTimeouts = new Counter("query_timeouts");
const queryLatency = new Trend("query_latency", true);
const aggregateSuccess = new Rate("aggregate_success");
const aggregateTimeouts = new Counter("aggregate_timeouts");
const aggregateLatency = new Trend("aggregate_latency", true);

const ingestionScenarios = {};

for (const stage of ingestionStages) {
  const preAllocatedVUs = proportionalVUs(
    PEAK_PRE_ALLOCATED_VUS,
    stage.targetRequestsPerSecond,
  );
  const maxVUs = Math.max(
    preAllocatedVUs,
    proportionalVUs(PEAK_MAX_VUS, stage.targetRequestsPerSecond),
  );

  ingestionScenarios[`ingestion_stage_${stage.index}`] = {
    executor: "constant-arrival-rate",
    exec: "ingest",
    rate: stage.targetRequestsPerSecond,
    timeUnit: "1s",
    duration: `${stage.seconds}s`,
    startTime: `${stage.startSeconds}s`,
    preAllocatedVUs,
    maxVUs,
    gracefulStop: "30s",
    tags: {
      workload: "staged_ingestion",
      profile: PROFILE,
      stage: String(stage.index),
      target_lps: String(stage.targetLogsPerSecond),
    },
  };
}

export const options = {
  discardResponseBodies: false,
  summaryTrendStats: [
    "avg",
    "min",
    "med",
    "max",
    "p(90)",
    "p(95)",
    "p(99)",
  ],
  scenarios: {
    ...ingestionScenarios,
    querying: {
      executor: "constant-arrival-rate",
      exec: "queryLogs",
      rate: 1,
      timeUnit: "1s",
      duration: `${TOTAL_PROFILE_SECONDS}s`,
      preAllocatedVUs: READ_PRE_ALLOCATED_VUS,
      maxVUs: READ_MAX_VUS,
      gracefulStop: "10s",
      tags: {
        workload: "query",
        profile: PROFILE,
      },
    },
    aggregation: {
      executor: "constant-arrival-rate",
      exec: "aggregate",
      rate: 1,
      timeUnit: "1s",
      duration: `${TOTAL_PROFILE_SECONDS}s`,
      preAllocatedVUs: READ_PRE_ALLOCATED_VUS,
      maxVUs: READ_MAX_VUS,
      gracefulStop: "10s",
      tags: {
        workload: "aggregation",
        profile: PROFILE,
      },
    },
  },
};

const JSON_HEADERS = {
  "Content-Type": "application/json",
};
const LEVELS = ["debug", "info", "warn", "error"];

function createRunId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function makeBatch(servicePrefix, generatedAtMs) {
  const logs = new Array(BATCH_SIZE);

  for (let index = 0; index < BATCH_SIZE; index += 1) {
    logs[index] = {
      timestamp: new Date(generatedAtMs - (index % 600) * 1000).toISOString(),
      level: LEVELS[index % LEVELS.length],
      service: `${servicePrefix}-${index % SERVICE_COUNT}`,
      message: `staged ingestion log ${index % 100}`,
      attributes: {
        region: `region-${index % 4}`,
        worker: index % 16,
        sampled: index % 2 === 0,
      },
    };
  }

  return JSON.stringify({ logs });
}

function safeJson(response) {
  try {
    return response.json();
  } catch {
    return null;
  }
}

export function setup() {
  const deadline = Date.now() + 60000;

  while (Date.now() < deadline) {
    const response = http.get(`${BASE_URL}/health`, {
      tags: { endpoint: "readiness" },
      timeout: "2s",
    });

    if (response.status === 200) {
      const generatedAtMs = Date.now();
      const currentMinute = Math.floor(generatedAtMs / 60000) * 60000;
      const servicePrefix = `staged-${createRunId()}-ingest`;

      return {
        servicePrefix,
        batchPayload: makeBatch(servicePrefix, generatedAtMs),
        since: new Date(currentMinute - 15 * 60 * 1000).toISOString(),
        until: new Date(
          currentMinute +
            Math.ceil((TOTAL_PROFILE_SECONDS + 120) / 60) * 60 * 1000,
        ).toISOString(),
      };
    }

    sleep(1);
  }

  throw new Error("service did not become healthy within 60 seconds");
}

export function ingest(data) {
  let response;

  try {
    response = http.post(`${BASE_URL}/logs`, data.batchPayload, {
      headers: JSON_HEADERS,
      tags: { endpoint: "ingest" },
      timeout: REQUEST_TIMEOUT,
    });
  } catch (_error) {
    completedIngestionRequests.add(1);
    postTimeouts.add(1);
    postTransportErrors.add(1);
    postSuccess.add(false);

    check(null, {
      "POST /logs durably accepted the complete batch": () => false,
    });
    return;
  }

  completedIngestionRequests.add(1);
  postTimeouts.add(response.status === 0 ? 1 : 0);

  if (Number.isFinite(response.timings.duration)) {
    postLatency.add(response.timings.duration);
  }

  if (response.status === 200) {
    postResponses200.add(1);
  } else if (response.status === 429) {
    postResponses429.add(1);
  } else if (response.status === 503) {
    postResponses503.add(1);
  } else if (response.status !== 0) {
    postOtherResponses.add(1);
  }

  const body = safeJson(response);
  const accepted = body?.accepted;
  const rejected = body?.rejected;
  const validCounts =
    Number.isInteger(accepted) &&
    accepted >= 0 &&
    Array.isArray(rejected) &&
    accepted + rejected.length === BATCH_SIZE;
  const completeDurableSuccess =
    response.status === 200 &&
    validCounts &&
    accepted === BATCH_SIZE &&
    rejected.length === 0;

  if (response.status === 200 && validCounts) {
    acceptedLogs.add(accepted);
    rejectedLogs.add(rejected.length);
  }

  invalidSuccessResponses.add(
    response.status === 200 && !completeDurableSuccess ? 1 : 0,
  );
  postSuccess.add(completeDurableSuccess);

  check(response, {
    "POST /logs durably accepted the complete batch": () =>
      completeDurableSuccess,
  });
}

export function queryLogs(data) {
  const parameters = [
    `service=${encodeURIComponent(`${data.servicePrefix}-0`)}`,
    `since=${encodeURIComponent(data.since)}`,
    `until=${encodeURIComponent(data.until)}`,
    "level=debug",
    "limit=100",
  ];
  const response = http.get(`${BASE_URL}/logs?${parameters.join("&")}`, {
    tags: { endpoint: "query" },
    timeout: REQUEST_TIMEOUT,
  });
  const body = safeJson(response);
  const success =
    response.status === 200 &&
    Array.isArray(body?.logs) &&
    (body?.next_cursor === null || typeof body?.next_cursor === "string");

  queryTimeouts.add(response.status === 0 ? 1 : 0);
  queryLatency.add(response.timings.duration);
  querySuccess.add(success);

  check(response, {
    "GET /logs returns a valid page": () => success,
  });
}

export function aggregate(data) {
  const parameters = [
    `since=${encodeURIComponent(data.since)}`,
    `until=${encodeURIComponent(data.until)}`,
    "bucket=1m",
    "group_by=service",
    `service=${encodeURIComponent(`${data.servicePrefix}-0`)}`,
  ];
  const response = http.get(
    `${BASE_URL}/logs/aggregate?${parameters.join("&")}`,
    {
      tags: { endpoint: "aggregate" },
      timeout: REQUEST_TIMEOUT,
    },
  );
  const body = safeJson(response);
  const success = response.status === 200 && Array.isArray(body?.buckets);

  aggregateTimeouts.add(response.status === 0 ? 1 : 0);
  aggregateLatency.add(response.timings.duration);
  aggregateSuccess.add(success);

  check(response, {
    "GET /logs/aggregate returns buckets": () => success,
  });
}

function metricValue(data, metricName, valueName) {
  return data.metrics?.[metricName]?.values?.[valueName] ?? 0;
}

function responseRate(count, total) {
  return total > 0 ? count / total : 0;
}

function ingestionDroppedIterations(data) {
  return ingestionStages.reduce(
    (total, stage) =>
      total +
      metricValue(
        data,
        `dropped_iterations{scenario:ingestion_stage_${stage.index}}`,
        "count",
      ),
    0,
  );
}

function buildReport(data) {
  const completedRequests = metricValue(
    data,
    "completed_ingestion_requests",
    "count",
  );
  const accepted = metricValue(data, "accepted_logs", "count");
  const responses = {
    200: metricValue(data, "post_responses_200", "count"),
    429: metricValue(data, "post_responses_429", "count"),
    503: metricValue(data, "post_responses_503", "count"),
    other: metricValue(data, "post_responses_other", "count"),
  };
  const droppedIngestion = ingestionDroppedIterations(data);

  return {
    profile: PROFILE,
    baseTargetLogsPerSecond: BASE_TARGET_LPS,
    batchSize: BATCH_SIZE,
    peakPreAllocatedVUs: PEAK_PRE_ALLOCATED_VUS,
    peakMaxVUs: PEAK_MAX_VUS,
    scheduledDurationSeconds: TOTAL_PROFILE_SECONDS,
    stages: ingestionStages.map((stage) => ({
      multiplier: stage.multiplier,
      startTime: `${stage.startSeconds}s`,
      duration: `${stage.seconds}s`,
      targetLogsPerSecond: stage.targetLogsPerSecond,
      targetRequestsPerSecond: stage.targetRequestsPerSecond,
      preAllocatedVUs: proportionalVUs(
        PEAK_PRE_ALLOCATED_VUS,
        stage.targetRequestsPerSecond,
      ),
      maxVUs: Math.max(
        proportionalVUs(
          PEAK_PRE_ALLOCATED_VUS,
          stage.targetRequestsPerSecond,
        ),
        proportionalVUs(PEAK_MAX_VUS, stage.targetRequestsPerSecond),
      ),
    })),
    expectedScheduledRequests: EXPECTED_SCHEDULED_REQUESTS,
    expectedScheduledLogs: EXPECTED_SCHEDULED_LOGS,
    completedRequests,
    completedRequestsPerSecond: completedRequests / TOTAL_PROFILE_SECONDS,
    acceptedLogs: accepted,
    acceptedLogsPerSecond: accepted / TOTAL_PROFILE_SECONDS,
    rejectedLogs: metricValue(data, "rejected_logs", "count"),
    postSuccessRate: metricValue(data, "post_success", "rate"),
    responses: {
      ...responses,
      rates: {
        200: responseRate(responses[200], completedRequests),
        429: responseRate(responses[429], completedRequests),
        503: responseRate(responses[503], completedRequests),
        other: responseRate(responses.other, completedRequests),
      },
    },
    timeouts: metricValue(data, "post_timeouts", "count"),
    transportErrors: metricValue(data, "post_transport_errors", "count"),
    invalidSuccessResponses: metricValue(
      data,
      "invalid_success_responses",
      "count",
    ),
    droppedIngestionIterations: droppedIngestion,
    droppedLogsEquivalent: droppedIngestion * BATCH_SIZE,
    postLatencyMs: {
      average: metricValue(data, "post_latency", "avg"),
      median: metricValue(data, "post_latency", "med"),
      p90: metricValue(data, "post_latency", "p(90)"),
      p95: metricValue(data, "post_latency", "p(95)"),
      p99: metricValue(data, "post_latency", "p(99)"),
      maximum: metricValue(data, "post_latency", "max"),
    },
    query: {
      successRate: metricValue(data, "query_success", "rate"),
      timeouts: metricValue(data, "query_timeouts", "count"),
      p95Ms: metricValue(data, "query_latency", "p(95)"),
      droppedIterations: metricValue(
        data,
        "dropped_iterations{scenario:querying}",
        "count",
      ),
    },
    aggregate: {
      successRate: metricValue(data, "aggregate_success", "rate"),
      timeouts: metricValue(data, "aggregate_timeouts", "count"),
      p95Ms: metricValue(data, "aggregate_latency", "p(95)"),
      droppedIterations: metricValue(
        data,
        "dropped_iterations{scenario:aggregation}",
        "count",
      ),
    },
  };
}

function formatNumber(value, digits = 0) {
  const number = Number(value);

  return Number.isFinite(number) ? number.toFixed(digits) : "n/a";
}

function formatPercent(value) {
  return `${formatNumber(Number(value) * 100, 2)}%`;
}

function renderSummary(report) {
  return [
    "",
    `Staged ingestion summary (${report.profile})`,
    `  Batch size:                  ${report.batchSize}`,
    `  Base target:                 ${formatNumber(report.baseTargetLogsPerSecond)} logs/s`,
    `  Scheduled duration:          ${report.scheduledDurationSeconds}s`,
    `  Completed POST throughput:   ${formatNumber(report.completedRequestsPerSecond, 2)} req/s`,
    `  Accepted throughput:         ${formatNumber(report.acceptedLogsPerSecond, 2)} logs/s`,
    `  Accepted logs:               ${formatNumber(report.acceptedLogs)}`,
    `  POST success:                ${formatPercent(report.postSuccessRate)}`,
    `  HTTP 200:                    ${formatNumber(report.responses[200])} (${formatPercent(report.responses.rates[200])})`,
    `  HTTP 429:                    ${formatNumber(report.responses[429])} (${formatPercent(report.responses.rates[429])})`,
    `  HTTP 503:                    ${formatNumber(report.responses[503])} (${formatPercent(report.responses.rates[503])})`,
    `  Other HTTP responses:        ${formatNumber(report.responses.other)} (${formatPercent(report.responses.rates.other)})`,
    `  Timeouts/status 0:           ${formatNumber(report.timeouts)}`,
    `  Transport errors:            ${formatNumber(report.transportErrors)}`,
    `  Dropped ingestion iters:     ${formatNumber(report.droppedIngestionIterations)}`,
    `  Dropped logs equivalent:     ${formatNumber(report.droppedLogsEquivalent)}`,
    `  POST latency p50:            ${formatNumber(report.postLatencyMs.median, 2)} ms`,
    `  POST latency p90:            ${formatNumber(report.postLatencyMs.p90, 2)} ms`,
    `  POST latency p95:            ${formatNumber(report.postLatencyMs.p95, 2)} ms`,
    `  POST latency p99:            ${formatNumber(report.postLatencyMs.p99, 2)} ms`,
    `  GET success:                 ${formatPercent(report.query.successRate)}`,
    `  GET timeouts:                ${formatNumber(report.query.timeouts)}`,
    `  GET latency p95:             ${formatNumber(report.query.p95Ms, 2)} ms`,
    `  Dropped GET iterations:      ${formatNumber(report.query.droppedIterations)}`,
    `  Aggregate success:           ${formatPercent(report.aggregate.successRate)}`,
    `  Aggregate timeouts:          ${formatNumber(report.aggregate.timeouts)}`,
    `  Aggregate latency p95:       ${formatNumber(report.aggregate.p95Ms, 2)} ms`,
    `  Dropped aggregate iters:     ${formatNumber(report.aggregate.droppedIterations)}`,
    "",
  ].join("\n");
}

export function handleSummary(data) {
  const report = buildReport(data);

  return {
    stdout: renderSummary(report),
    [SUMMARY_PATH]: `${JSON.stringify(report, null, 2)}\n`,
  };
}
