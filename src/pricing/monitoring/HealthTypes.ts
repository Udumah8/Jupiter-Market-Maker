/**
 * Health monitoring interfaces and types for price feed reliability
 */

export interface SourceHealth {
  source: string;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastSuccessTime?: number;
  lastFailureTime?: number;
  isHealthy: boolean;
  lastCheckedTime: number;
}

export interface HealthConfig {
  failureThreshold: number;
  successRecoveryThreshold: number;
  checkIntervalMs: number;
}

export interface HealthReport {
  overallHealth: 'healthy' | 'degraded' | 'unhealthy';
  sources: SourceHealth[];
  totalSources: number;
  healthySources: number;
  degradedSources: number;
  unhealthySources: number;
  timestamp: number;
}
