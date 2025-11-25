/**
 * Retry management interfaces and types for price feed operations
 */

export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  jitter: boolean;
  cooldownPeriodMs: number;
}

export interface RetryResult<T> {
  success: boolean;
  data?: T;
  error?: Error;
  attempts: number;
  totalTime: number;
  lastAttemptTime: number;
}

export interface SourceStatus {
  source: string;
  lastAttempt?: number;
  isInCooldown: boolean;
  cooldownEndTime?: number;
  consecutiveFailures: number;
}

export interface RetryMetrics {
  totalRetries: number;
  successfulRetries: number;
  failedRetries: number;
  averageAttempts: number;
  totalTimeSaved: number;
  sourceCooldowns: SourceStatus[];
}
