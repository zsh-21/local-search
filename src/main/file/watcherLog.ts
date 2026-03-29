let watcherLogBrokenPipeDetected = false;
let watcherLogStreamGuardInstalled = false;

function isBrokenPipeError(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : "";
  const normalizedCode = typeof code === "string" ? code : "";
  return normalizedCode === "EPIPE" || normalizedCode === "ERR_STREAM_DESTROYED";
}

function ensureWatcherLogStreamGuard() {
  if (watcherLogStreamGuardInstalled) return;
  watcherLogStreamGuardInstalled = true;
  const markBrokenPipe = (error: unknown) => {
    if (!isBrokenPipeError(error)) return;
    watcherLogBrokenPipeDetected = true;
  };
  process.stdout?.on("error", markBrokenPipe);
  process.stderr?.on("error", markBrokenPipe);
}

export function safeWatcherLog(...args: unknown[]) {
  ensureWatcherLogStreamGuard();
  if (watcherLogBrokenPipeDetected) return;

  const stdout = process.stdout;
  if (!stdout || stdout.destroyed || stdout.writableEnded || !stdout.writable) {
    watcherLogBrokenPipeDetected = true;
    return;
  }

  try {
    console.log(...args);
  } catch (error) {
    if (isBrokenPipeError(error)) {
      watcherLogBrokenPipeDetected = true;
    }
  }
}
