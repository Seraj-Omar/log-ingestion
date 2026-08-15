import type { ValidLog } from "../schemas/log.js";

interface IngestionJob {
    logs: readonly ValidLog[];
    retainedBytes: number;
    resolve: () => void;
    reject: (reason: unknown) => void;
}

export interface IngestionBatcherOptions {
    maxInFlightRequests: number;
    maxInFlightLogs: number;
    maxInFlightBytes: number;
    batchSize: number;
    batchDelayMs: number;
}

type PersistLogs = (logs: ValidLog[]) => Promise<void>;

const MAX_ADAPTIVE_BATCH_SIZE = 10_000;

function requirePositiveInteger(
    name: string,
    value: number
): void {
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer`);
    }
}

export class IngestionBatcher {
    private readonly queue: Array<IngestionJob | undefined> = [];

    private queueHead = 0;
    private queuedLogs = 0;

    private inFlightRequests = 0;
    private inFlightLogs = 0;
    private inFlightBytes = 0;

    private writing = false;
    private accepting = true;
    private flushDue = false;

    private flushTimer: NodeJS.Timeout | undefined;

    private closePromise: Promise<void> | undefined;
    private finishClose: (() => void) | undefined;

    public constructor(
        private readonly persistLogs: PersistLogs,
        private readonly options: IngestionBatcherOptions
    ) {
        requirePositiveInteger(
            "max in-flight requests",
            options.maxInFlightRequests
        );

        requirePositiveInteger(
            "max in-flight logs",
            options.maxInFlightLogs
        );

        requirePositiveInteger(
            "max in-flight bytes",
            options.maxInFlightBytes
        );

        requirePositiveInteger(
            "ingestion batch size",
            options.batchSize
        );

        if (
            !Number.isInteger(options.batchDelayMs) ||
            options.batchDelayMs < 0
        ) {
            throw new Error(
                "ingestion batch delay must be a non-negative integer"
            );
        }
    }

    public tryIngest(
        logs: readonly ValidLog[],
        retainedBytes: number
    ): Promise<void> | null {
        if (logs.length === 0) {
            throw new Error(
                "an ingestion job must contain at least one log"
            );
        }

        requirePositiveInteger(
            "retained ingestion bytes",
            retainedBytes
        );

        if (
            !this.accepting ||
            this.inFlightRequests + 1 >
                this.options.maxInFlightRequests ||
            this.inFlightLogs + logs.length >
                this.options.maxInFlightLogs ||
            this.inFlightBytes + retainedBytes >
                this.options.maxInFlightBytes
        ) {
            return null;
        }

        let resolveJob: () => void = () => undefined;
        let rejectJob: (reason: unknown) => void = () => undefined;

        const completion = new Promise<void>((resolve, reject) => {
            resolveJob = resolve;
            rejectJob = reject;
        });

        this.queue.push({
            logs,
            retainedBytes,
            resolve: resolveJob,
            reject: rejectJob
        });

        this.queuedLogs += logs.length;

        this.inFlightRequests += 1;
        this.inFlightLogs += logs.length;
        this.inFlightBytes += retainedBytes;

        if (
            this.options.batchDelayMs === 0 ||
            this.queuedLogs >= this.options.batchSize
        ) {
            if (this.writing) {
                this.clearFlushTimer();
                this.flushDue = true;
            }
            else {
                this.startNextBatch();
            }
        }
        else {
            this.armFlushTimer();
        }

        return completion;
    }

    public close(): Promise<void> {
        if (this.closePromise !== undefined) {
            return this.closePromise;
        }

        this.accepting = false;
        this.clearFlushTimer();

        this.closePromise = new Promise<void>((resolve) => {
            this.finishClose = resolve;
        });

        if (!this.writing && this.hasQueuedJobs()) {
            this.startNextBatch();
        }

        this.resolveCloseIfDrained();

        return this.closePromise;
    }

    private hasQueuedJobs(): boolean {
        return this.queueHead < this.queue.length;
    }

    private getTargetBatchSize(): number {
        const baseBatchSize = this.options.batchSize;

        if (baseBatchSize >= MAX_ADAPTIVE_BATCH_SIZE) {
            return baseBatchSize;
        }

        if (this.queuedLogs >= baseBatchSize * 4) {
            return Math.min(
                baseBatchSize * 4,
                MAX_ADAPTIVE_BATCH_SIZE
            );
        }

        if (this.queuedLogs >= baseBatchSize * 2) {
            return Math.min(
                baseBatchSize * 2,
                MAX_ADAPTIVE_BATCH_SIZE
            );
        }

        return baseBatchSize;
    }

    private armFlushTimer(): void {
        if (this.flushTimer !== undefined) {
            return;
        }

        this.flushTimer = setTimeout(() => {
            this.flushTimer = undefined;

            if (this.writing) {
                this.flushDue = true;
            }
            else {
                this.startNextBatch();
            }
        }, this.options.batchDelayMs);
    }

    private clearFlushTimer(): void {
        if (this.flushTimer === undefined) {
            return;
        }

        clearTimeout(this.flushTimer);
        this.flushTimer = undefined;
    }

    private takeNextBatch(): IngestionJob[] {
        const jobs: IngestionJob[] = [];

        let batchLogs = 0;

        const targetBatchSize =
            this.getTargetBatchSize();

        while (this.hasQueuedJobs()) {
            const job = this.queue[this.queueHead];

            if (job === undefined) {
                this.queueHead += 1;
                continue;
            }

            if (
                jobs.length > 0 &&
                batchLogs + job.logs.length >
                    targetBatchSize
            ) {
                break;
            }

            jobs.push(job);

            batchLogs += job.logs.length;

            this.queue[this.queueHead] = undefined;
            this.queueHead += 1;

            this.queuedLogs -= job.logs.length;

            if (batchLogs >= targetBatchSize) {
                break;
            }
        }

        if (
            this.queueHead >= 1_024 &&
            this.queueHead * 2 >= this.queue.length
        ) {
            this.queue.splice(0, this.queueHead);
            this.queueHead = 0;
        }

        return jobs;
    }

    private startNextBatch(): void {
        if (
            this.writing ||
            !this.hasQueuedJobs()
        ) {
            this.resolveCloseIfDrained();
            return;
        }

        this.clearFlushTimer();

        const jobs = this.takeNextBatch();

        if (!this.hasQueuedJobs()) {
            this.flushDue = false;
        }

        const logs = jobs.flatMap(
            (job) => job.logs
        );

        this.writing = true;

        void Promise.resolve()
            .then(() => this.persistLogs(logs))
            .then(
                () => {
                    this.finishBatch(jobs);

                    for (const job of jobs) {
                        job.resolve();
                    }
                },
                (error: unknown) => {
                    this.finishBatch(jobs);

                    for (const job of jobs) {
                        job.reject(error);
                    }
                }
            );
    }

    private finishBatch(
        jobs: readonly IngestionJob[]
    ): void {
        for (const job of jobs) {
            this.inFlightRequests -= 1;
            this.inFlightLogs -= job.logs.length;
            this.inFlightBytes -= job.retainedBytes;
        }

        this.writing = false;

        if (!this.hasQueuedJobs()) {
            this.resolveCloseIfDrained();
        }
        else if (
            !this.accepting ||
            this.flushDue ||
            this.queuedLogs >=
                this.options.batchSize ||
            this.options.batchDelayMs === 0
        ) {
            this.startNextBatch();
        }
        else {
            this.armFlushTimer();
        }
    }

    private resolveCloseIfDrained(): void {
        if (
            !this.accepting &&
            !this.writing &&
            !this.hasQueuedJobs() &&
            this.finishClose !== undefined
        ) {
            const resolve = this.finishClose;

            this.finishClose = undefined;

            resolve();
        }
    }
}