/**
 * Reliability tracking interfaces and types for price feed metrics
 */

export interface SourceMetrics {
  source: string;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageResponseTime: number;
  lastRequestTime: number;
  lastSuccessTime?: number;
  lastFailureTime?: number;
  reliabilityScore: number;
  priceHistory: PricePoint[];
  uptime: number;
  downtime: number;
}

export interface PricePoint {
  price: number;
  timestamp: number;
  source: string;
}

export interface ReliabilityConfig {
  maxHistoryPoints: number;
  historyWindowMs: number; // 24 hours
  performanceWeight: number;
  stabilityWeight: number;
  recentWeight: number;
  persistIntervalMs: number;
}

export interface PrioritizedSource {
  source: string;
  priority: number;
  reliabilityScore: number;
  isHealthy: boolean;
}

export interface ReliabilityReport {
  overallReliability: number;
  sources: SourceMetrics[];
  prioritizedSources: PrioritizedSource[];
  totalRequests: number;
  averageResponseTime: number;
  timestamp: number;
}
