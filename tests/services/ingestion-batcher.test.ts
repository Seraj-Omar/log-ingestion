import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ValidLog } from '../../src/schemas/log.js';
import {
  IngestionBatcher,
  type IngestionBatcherOptions,
} from '../../src/services/ingestion-batcher.js';

interface DeferredWrite {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

interface AdmissionCase {
  name: string;
  options: Partial<IngestionBatcherOptions>;
  firstLogs: ValidLog[];
  firstBytes: number;
}

function deferredWrite(): DeferredWrite {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

function log(id: string): ValidLog {
  return {
    timestamp: '2026-08-12T10:00:00.000Z',
    level: 'info',
    service: 'ingestion-test',
    message: `log-${id}`,
    attributes: { id },
  };
}

function options(
  overrides: Partial<IngestionBatcherOptions> = {},
): IngestionBatcherOptions {
  return {
    maxInFlightRequests: 10,
    maxInFlightLogs: 100,
    maxInFlightBytes: 10_000,
    batchSize: 10,
    batchDelayMs: 25,
    ...overrides,
  };
}

function accepted(result: Promise<void> | null): Promise<void> {
  expect(result).not.toBeNull();
  if (result === null) {
    throw new Error('expected ingestion to be admitted');
  }

  return result;
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

describe('IngestionBatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces requests and resolves them only after the combined write is durable', async () => {
    const write = deferredWrite();
    const persistLogs = vi.fn((_logs: ValidLog[]) => write.promise);
    const batcher = new IngestionBatcher(persistLogs, options());
    const firstLog = log('first');
    const secondLog = log('second');

    const first = accepted(batcher.tryIngest([firstLog], 100));
    const second = accepted(batcher.tryIngest([secondLog], 100));
    let completed = false;
    void Promise.all([first, second]).then(() => {
      completed = true;
    });

    await vi.advanceTimersByTimeAsync(24);
    expect(persistLogs).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(persistLogs).toHaveBeenCalledTimes(1);
    expect(persistLogs).toHaveBeenCalledWith([firstLog, secondLog]);
    expect(completed).toBe(false);

    write.resolve();
    await Promise.all([first, second]);
    expect(completed).toBe(true);
    await batcher.close();
  });

  it('uses a fixed delay measured from the first queued request', async () => {
    const persistLogs = vi.fn(async (_logs: ValidLog[]): Promise<void> => undefined);
    const batcher = new IngestionBatcher(
      persistLogs,
      options({ batchDelayMs: 25 }),
    );
    const firstLog = log('first');
    const secondLog = log('second');
    const first = accepted(batcher.tryIngest([firstLog], 100));

    await vi.advanceTimersByTimeAsync(20);
    const second = accepted(batcher.tryIngest([secondLog], 100));

    await vi.advanceTimersByTimeAsync(4);
    expect(persistLogs).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([first, second]);
    expect(persistLogs).toHaveBeenCalledTimes(1);
    expect(persistLogs).toHaveBeenCalledWith([firstLog, secondLog]);
    await batcher.close();
  });

  it('starts a write eagerly when queued logs reach the batch threshold', async () => {
    const persistLogs = vi.fn(async (_logs: ValidLog[]): Promise<void> => undefined);
    const batcher = new IngestionBatcher(
      persistLogs,
      options({ batchSize: 3, batchDelayMs: 1_000 }),
    );
    const firstLogs = [log('one'), log('two')];
    const finalLog = log('three');
    const first = accepted(batcher.tryIngest(firstLogs, 200));

    await flushMicrotasks();
    expect(persistLogs).not.toHaveBeenCalled();

    const second = accepted(batcher.tryIngest([finalLog], 100));
    await Promise.all([first, second]);

    expect(persistLogs).toHaveBeenCalledTimes(1);
    expect(persistLogs).toHaveBeenCalledWith([...firstLogs, finalLog]);
    expect(vi.getTimerCount()).toBe(0);
    await batcher.close();
  });

  it('does not split requests when combining them would cross the batch target', async () => {
    const firstWrite = deferredWrite();
    const secondWrite = deferredWrite();
    let writeIndex = 0;
    const writes = [firstWrite, secondWrite];
    const persistLogs = vi.fn((_logs: ValidLog[]) => {
      const write = writes[writeIndex];
      writeIndex += 1;
      if (write === undefined) {
        throw new Error('unexpected write');
      }

      return write.promise;
    });
    const batcher = new IngestionBatcher(
      persistLogs,
      options({ batchSize: 3, batchDelayMs: 1_000 }),
    );
    const firstLogs = [log('one'), log('two')];
    const secondLogs = [log('three'), log('four')];

    const first = accepted(batcher.tryIngest(firstLogs, 200));
    const second = accepted(batcher.tryIngest(secondLogs, 200));
    await flushMicrotasks();

    expect(persistLogs).toHaveBeenCalledTimes(1);
    expect(persistLogs).toHaveBeenNthCalledWith(1, firstLogs);

    firstWrite.resolve();
    await first;
    await vi.advanceTimersByTimeAsync(1_000);

    expect(persistLogs).toHaveBeenCalledTimes(2);
    expect(persistLogs).toHaveBeenNthCalledWith(2, secondLogs);

    secondWrite.resolve();
    await second;
    await batcher.close();
  });

  it('keeps a request larger than the batch target in one write', async () => {
    const persistLogs = vi.fn(async (_logs: ValidLog[]): Promise<void> => undefined);
    const batcher = new IngestionBatcher(
      persistLogs,
      options({ batchSize: 2, batchDelayMs: 1_000 }),
    );
    const requestLogs = [log('one'), log('two'), log('three')];

    await accepted(batcher.tryIngest(requestLogs, 300));

    expect(persistLogs).toHaveBeenCalledTimes(1);
    expect(persistLogs).toHaveBeenCalledWith(requestLogs);
    await batcher.close();
  });

  const admissionCases: AdmissionCase[] = [
    {
      name: 'request',
      options: { maxInFlightRequests: 1 },
      firstLogs: [log('active')],
      firstBytes: 1,
    },
    {
      name: 'log',
      options: { maxInFlightLogs: 2 },
      firstLogs: [log('active-one'), log('active-two')],
      firstBytes: 1,
    },
    {
      name: 'byte',
      options: { maxInFlightBytes: 5 },
      firstLogs: [log('active')],
      firstBytes: 5,
    },
  ];

  it.each(admissionCases)(
    'keeps the active $name reservation until persistence settles',
    async ({ options: optionOverrides, firstLogs, firstBytes }) => {
      const firstWrite = deferredWrite();
      const persistLogs = vi
        .fn((_logs: ValidLog[]) => firstWrite.promise)
        .mockResolvedValue(undefined);
      persistLogs.mockImplementationOnce((_logs: ValidLog[]) => firstWrite.promise);
      const batcher = new IngestionBatcher(
        persistLogs,
        options({
          batchSize: 1,
          batchDelayMs: 0,
          ...optionOverrides,
        }),
      );
      const first = accepted(batcher.tryIngest(firstLogs, firstBytes));
      await flushMicrotasks();

      expect(batcher.tryIngest([log('overload')], 1)).toBeNull();
      expect(persistLogs).toHaveBeenCalledTimes(1);

      firstWrite.resolve();
      await first;
      await flushMicrotasks();

      const recovered = accepted(batcher.tryIngest([log('recovered')], 1));
      await recovered;
      expect(persistLogs).toHaveBeenCalledTimes(2);
      await batcher.close();
    },
  );

  it('releases admission after a failed write and accepts later work', async () => {
    const failure = new Error('database unavailable');
    const persistLogs = vi
      .fn(async (_logs: ValidLog[]): Promise<void> => undefined)
      .mockRejectedValueOnce(failure);
    const batcher = new IngestionBatcher(
      persistLogs,
      options({
        maxInFlightRequests: 1,
        batchSize: 1,
        batchDelayMs: 0,
      }),
    );

    const failed = accepted(batcher.tryIngest([log('failed')], 100));
    await expect(failed).rejects.toBe(failure);
    await flushMicrotasks();

    const recovered = accepted(batcher.tryIngest([log('recovered')], 100));
    await expect(recovered).resolves.toBeUndefined();
    expect(persistLogs).toHaveBeenCalledTimes(2);
    await batcher.close();
  });

  it('continues with queued work after an active write fails', async () => {
    const firstWrite = deferredWrite();
    const persistLogs = vi
      .fn(async (_logs: ValidLog[]): Promise<void> => undefined)
      .mockImplementationOnce((_logs: ValidLog[]) => firstWrite.promise);
    const batcher = new IngestionBatcher(
      persistLogs,
      options({ batchSize: 1, batchDelayMs: 0 }),
    );
    const failure = new Error('first write failed');
    const first = accepted(batcher.tryIngest([log('first')], 100));
    const second = accepted(batcher.tryIngest([log('second')], 100));
    await flushMicrotasks();

    expect(persistLogs).toHaveBeenCalledTimes(1);
    firstWrite.reject(failure);

    await expect(first).rejects.toBe(failure);
    await expect(second).resolves.toBeUndefined();
    expect(persistLogs).toHaveBeenCalledTimes(2);
    await batcher.close();
  });

  it('runs only one persistence write at a time', async () => {
    const writes = [deferredWrite(), deferredWrite(), deferredWrite()];
    let writeIndex = 0;
    const persistLogs = vi.fn((_logs: ValidLog[]) => {
      const write = writes[writeIndex];
      writeIndex += 1;
      if (write === undefined) {
        throw new Error('unexpected write');
      }

      return write.promise;
    });
    const batcher = new IngestionBatcher(
      persistLogs,
      options({ batchSize: 1, batchDelayMs: 0 }),
    );
    const firstLog = log('first');
    const secondLog = log('second');
    const thirdLog = log('third');
    const first = accepted(batcher.tryIngest([firstLog], 100));
    const second = accepted(batcher.tryIngest([secondLog], 100));
    const third = accepted(batcher.tryIngest([thirdLog], 100));

    await flushMicrotasks();
    expect(persistLogs).toHaveBeenCalledTimes(1);
    expect(persistLogs).toHaveBeenNthCalledWith(1, [firstLog]);

    writes[0]?.resolve();
    await first;
    await flushMicrotasks();
    expect(persistLogs).toHaveBeenCalledTimes(2);
    expect(persistLogs).toHaveBeenNthCalledWith(2, [secondLog]);

    writes[1]?.resolve();
    await second;
    await flushMicrotasks();
    expect(persistLogs).toHaveBeenCalledTimes(3);
    expect(persistLogs).toHaveBeenNthCalledWith(3, [thirdLog]);

    writes[2]?.resolve();
    await third;
    await batcher.close();
  });

  it('drains every batch of an overdue backlog without adding another delay', async () => {
    const writes = [
      deferredWrite(),
      deferredWrite(),
      deferredWrite(),
      deferredWrite(),
    ];
    let writeIndex = 0;
    const persistLogs = vi.fn((_logs: ValidLog[]) => {
      const write = writes[writeIndex];
      writeIndex += 1;
      if (write === undefined) {
        throw new Error('unexpected write');
      }

      return write.promise;
    });
    const batcher = new IngestionBatcher(
      persistLogs,
      options({ batchSize: 2, batchDelayMs: 25 }),
    );
    const active = accepted(
      batcher.tryIngest([log('active-one'), log('active-two')], 200),
    );
    await flushMicrotasks();

    const queued = ['one', 'two', 'three', 'four', 'tail'].map((id) =>
      accepted(batcher.tryIngest([log(id)], 100)),
    );
    await vi.advanceTimersByTimeAsync(25);

    writes[0]?.resolve();
    await active;
    await flushMicrotasks();
    expect(persistLogs).toHaveBeenCalledTimes(2);

    writes[1]?.resolve();
    await flushMicrotasks();
    expect(persistLogs).toHaveBeenCalledTimes(3);

    writes[2]?.resolve();
    await flushMicrotasks();
    expect(persistLogs).toHaveBeenCalledTimes(4);

    writes[3]?.resolve();
    await Promise.all(queued);
    await batcher.close();
  });

  it('close flushes delayed work, rejects new work, waits for durability, and is idempotent', async () => {
    const write = deferredWrite();
    const persistLogs = vi.fn((_logs: ValidLog[]) => write.promise);
    const batcher = new IngestionBatcher(
      persistLogs,
      options({ batchSize: 10, batchDelayMs: 1_000 }),
    );
    const queued = accepted(batcher.tryIngest([log('queued')], 100));

    expect(vi.getTimerCount()).toBe(1);
    const firstClose = batcher.close();
    const secondClose = batcher.close();
    let closed = false;
    void firstClose.then(() => {
      closed = true;
    });

    expect(secondClose).toBe(firstClose);
    expect(batcher.tryIngest([log('too-late')], 100)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await flushMicrotasks();
    expect(persistLogs).toHaveBeenCalledTimes(1);
    expect(closed).toBe(false);

    write.resolve();
    await queued;
    await firstClose;
    expect(closed).toBe(true);
    expect(batcher.close()).toBe(firstClose);
  });

  it('close drains every queued batch before resolving', async () => {
    const writes = [deferredWrite(), deferredWrite()];
    let writeIndex = 0;
    const persistLogs = vi.fn((_logs: ValidLog[]) => {
      const write = writes[writeIndex];
      writeIndex += 1;
      if (write === undefined) {
        throw new Error('unexpected write');
      }

      return write.promise;
    });
    const batcher = new IngestionBatcher(
      persistLogs,
      options({ batchSize: 1, batchDelayMs: 0 }),
    );
    const first = accepted(batcher.tryIngest([log('first')], 100));
    const second = accepted(batcher.tryIngest([log('second')], 100));
    const close = batcher.close();
    let closed = false;
    void close.then(() => {
      closed = true;
    });

    await flushMicrotasks();
    expect(persistLogs).toHaveBeenCalledTimes(1);

    writes[0]?.resolve();
    await first;
    await flushMicrotasks();
    expect(persistLogs).toHaveBeenCalledTimes(2);
    expect(closed).toBe(false);

    writes[1]?.resolve();
    await second;
    await close;
    expect(closed).toBe(true);
  });
});
