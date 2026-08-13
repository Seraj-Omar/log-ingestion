export type ReleaseIngestionSlot = () => void;

export class IngestionAdmission {
    private inFlight = 0;

    public constructor(private readonly maximumInFlight: number) {
        if (!Number.isInteger(maximumInFlight) || maximumInFlight <= 0) {
            throw new Error("maximum in-flight ingestions must be a positive integer");
        }
    }

    public tryAcquire(): ReleaseIngestionSlot | null {
        if (this.inFlight >= this.maximumInFlight) {
            return null;
        }

        this.inFlight += 1;
        let released = false;

        return () => {
            if (released) {
                return;
            }

            released = true;
            this.inFlight -= 1;
        };
    }
}
