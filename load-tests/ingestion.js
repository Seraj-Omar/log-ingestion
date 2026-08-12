import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const BATCH_SIZE = Number(__ENV.BATCH_SIZE || 500);
const RATE = Number(__ENV.RATE || 30);
const DURATION = __ENV.DURATION || '30s';
const PRE_ALLOCATED_VUS = Number(__ENV.PRE_ALLOCATED_VUS || 20);
const MAX_VUS = Number(__ENV.MAX_VUS || 100);

const services = ['checkout', 'billing', 'catalog', 'identity'];
const levels = ['debug', 'info', 'warn', 'error'];
const messages = [
  'request completed',
  'payment processed',
  'cache lookup finished',
  'background task completed',
];
const regions = ['eu-west', 'us-east', 'ap-south'];

export const acceptedLogs = new Counter('accepted_logs');
export const rejectedLogs = new Counter('rejected_logs');
export const ingestionErrors = new Counter('ingestion_errors');
export const ingestionLatency = new Trend('ingestion_latency', true);

export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  scenarios: {
    ingestion: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: PRE_ALLOCATED_VUS,
      maxVUs: MAX_VUS,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
  },
};

function buildBatch() {
  const timestamp = new Date().toISOString();
  const iterationSeed = (__VU * 1_000_003) + __ITER;
  const logs = new Array(BATCH_SIZE);

  for (let index = 0; index < BATCH_SIZE; index += 1) {
    const seed = iterationSeed + index;

    logs[index] = {
      timestamp,
      level: levels[seed % levels.length],
      service: services[seed % services.length],
      message: messages[seed % messages.length],
      attributes: {
        user_id: String((seed % 100_000) + 1),
        region: regions[seed % regions.length],
        cached: seed % 2 === 0,
        duration_ms: (seed % 250) + 1,
      },
    };
  }

  return JSON.stringify({ logs });
}

export default function () {
  let response;

  try {
    response = http.post(`${BASE_URL}/logs`, buildBatch(), {
      headers: { 'Content-Type': 'application/json' },
      tags: { name: 'POST /logs' },
    });
  } catch (_error) {
    ingestionErrors.add(1);
    return;
  }

  ingestionLatency.add(response.timings.duration);

  const statusAccepted = check(response, {
    'POST /logs returns 200': (result) => result.status === 200,
  });

  if (!statusAccepted) {
    ingestionErrors.add(1);
    return;
  }

  let body;

  try {
    body = response.json();
  } catch (_error) {
    ingestionErrors.add(1);
    return;
  }

  const validBody = check(body, {
    'response contains sensible accepted/rejected counts': (result) =>
      result !== null &&
      typeof result === 'object' &&
      Number.isInteger(result.accepted) &&
      result.accepted >= 0 &&
      Array.isArray(result.rejected) &&
      result.accepted + result.rejected.length === BATCH_SIZE,
  });

  if (!validBody) {
    ingestionErrors.add(1);
    return;
  }

  acceptedLogs.add(body.accepted);
  rejectedLogs.add(body.rejected.length);
}

function metricValue(data, metricName, valueName) {
  return data.metrics[metricName]?.values?.[valueName] ?? 0;
}

function formatNumber(value, digits = 0) {
  return Number(value).toFixed(digits);
}

export function handleSummary(data) {
  const accepted = metricValue(data, 'accepted_logs', 'count');
  const rejected = metricValue(data, 'rejected_logs', 'count');
  const errors = metricValue(data, 'ingestion_errors', 'count');
  const requestCount = metricValue(data, 'http_reqs', 'count');
  const durationSeconds = (data.state?.testRunDurationMs || 0) / 1000;
  const acceptedPerSecond = durationSeconds > 0
    ? accepted / durationSeconds
    : metricValue(data, 'accepted_logs', 'rate');

  const summary = [
    '',
    'Ingestion baseline summary',
    `  Batch size:                     ${BATCH_SIZE}`,
    `  Target request rate:            ${RATE} req/s`,
    `  Theoretical target throughput:  ${RATE * BATCH_SIZE} logs/s`,
    `  Total accepted logs:            ${formatNumber(accepted)}`,
    `  Total rejected logs:            ${formatNumber(rejected)}`,
    `  Ingestion errors:               ${formatNumber(errors)}`,
    `  Actual accepted throughput:     ${formatNumber(acceptedPerSecond, 2)} logs/s`,
    `  HTTP request count:             ${formatNumber(requestCount)}`,
    `  HTTP latency p50:               ${formatNumber(metricValue(data, 'http_req_duration', 'med'), 2)} ms`,
    `  HTTP latency p95:               ${formatNumber(metricValue(data, 'http_req_duration', 'p(95)'), 2)} ms`,
    `  HTTP latency p99:               ${formatNumber(metricValue(data, 'http_req_duration', 'p(99)'), 2)} ms`,
    '',
  ].join('\n');

  return { stdout: summary };
}
