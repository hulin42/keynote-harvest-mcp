export type ProgressUpdate = {
  progress: number;
  total?: number;
  message?: string;
};

export type ProgressReporter = (update: ProgressUpdate) => void;

type NotificationSender = (notification: {
  method: 'notifications/progress';
  params: {
    progressToken: string | number;
    progress: number;
    total?: number;
    message?: string;
  };
}) => Promise<void>;

type HandlerExtraLike = {
  _meta?: { progressToken?: string | number };
  sendNotification?: NotificationSender;
};

const DEFAULT_HEARTBEAT_MS = 10_000;
const MIN_HEARTBEAT_MS = 100;

export function progressHeartbeatMs() {
  const configured = Number(process.env.KEYNOTE_HARVEST_PROGRESS_HEARTBEAT_MS);
  return Number.isFinite(configured) && configured >= MIN_HEARTBEAT_MS ? configured : DEFAULT_HEARTBEAT_MS;
}

// Builds a reporter from an MCP request handler's `extra` when the caller
// asked for progress (a progressToken in request _meta); undefined otherwise.
// Send failures are swallowed: progress is best-effort and must never fail
// the tool call itself.
export function progressReporterFromExtra(extra: HandlerExtraLike | undefined): ProgressReporter | undefined {
  const progressToken = extra?._meta?.progressToken;
  const sendNotification = extra?.sendNotification;
  if (progressToken === undefined || typeof sendNotification !== 'function') return undefined;
  return ({ progress, total, message }) => {
    void sendNotification({
      method: 'notifications/progress',
      params: {
        progressToken,
        progress,
        ...(total !== undefined ? { total } : {}),
        ...(message !== undefined ? { message } : {}),
      },
    }).catch(() => {});
  };
}

// Keeps `progress` monotonically increasing across a mix of real step events
// and time-based heartbeats: steps land on integers, heartbeats advance by a
// small fraction so they never overtake the next step.
export class ProgressTracker {
  private lastProgress = 0;

  constructor(private readonly report?: ProgressReporter) {}

  get enabled() {
    return this.report !== undefined;
  }

  step(step: number, total: number | undefined, message: string) {
    if (!this.report) return;
    if (step <= this.lastProgress) return;
    this.lastProgress = step;
    this.report({ progress: step, ...(total !== undefined ? { total } : {}), message });
  }

  heartbeat(message: string) {
    if (!this.report) return;
    this.lastProgress += 0.001;
    this.report({ progress: this.lastProgress, message });
  }

  // Emits a heartbeat every progressHeartbeatMs() until the returned stop
  // function is called. Safe to call without a reporter (no-op).
  startHeartbeat(message: string) {
    if (!this.report) return () => {};
    const interval = setInterval(() => this.heartbeat(message), progressHeartbeatMs());
    interval.unref();
    return () => clearInterval(interval);
  }
}
