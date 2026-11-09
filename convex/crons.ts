import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Safety net for the outbox: re-dispatch any delivery whose retry should
// already have run (e.g. interrupted by a deploy). Normal retries are scheduled
// directly by outbox.markFailedAttempt.
crons.interval("outbox sweep", { minutes: 10 }, internal.outbox.sweep, {});

export default crons;
