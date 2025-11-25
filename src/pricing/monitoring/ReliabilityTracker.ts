/**
 * ReliabilityTracker class for tracking price feed source reliability metrics
 * Implements reliability scoring and source prioritization
 */

import { Logger } from '../../utils/Logger.js';
import { 
  SourceMetrics, 
  ReliabilityConfig, 
  PrioritizedSource, 
  ReliabilityReport,
  // PricePoint - unused interface
} from './ReliabilityTypes.js';

export class ReliabilityTracker {
  private sources: Map<string, SourceMetrics> = new Map();
  private logger: Logger;
  private config: ReliabilityConfig;
  // private dataDirectory = 'data'; // Unused - using default data directory

  constructor(logger: Logger, config: Partial<ReliabilityConfig> = {}) {
    this.logger = logger;
    this.config = {
      maxHistoryPoints: 1000,
      historyWindowMs: 24 * 60 * 60 * 1000, // 24 hours
      performanceWeight: 0.4,
      stabilityWeight: 0.3,
      recentWeight: 0.3,
      persistIntervalMs: 5 * 60 * 1000, // 5 minutes
      ...config,
    };
    
    this.logger.info('ReliabilityTracker initialized', {
      maxHistoryPoints: this.config.maxHistoryPoints,
      historyWindowMs: this.config.historyWindowMs,
      persistIntervalMs: this.config.persistIntervalMs,
    });
  }

  /**
   * Record a request result with timing information
   */
  recordRequest(
    source: string, 
    success: boolean, 
    responseTime: number, 
    price?: number
  ): void {
    const metrics = this.getOrCreateMetrics(source);
    
    // Update request statistics
    metrics.totalRequests++;
    metrics.lastRequestTime = Date.now();
    
    if (success) {
      metrics.successfulRequests++;
      metrics.lastSuccessTime = Date.now();
      
      // Update response time statistics (exponential moving average)
      const alpha = 0.1; // Smoothing factor
      metrics.averageResponseTime = 
        metrics.averageResponseTime === 0 
          ? responseTime 
          : (alpha * responseTime + (1 - alpha) * metrics.averageResponseTime);
      
    } else {
      metrics.failedRequests++;
      metrics.lastFailureTime = Date.now();
    }
    
    // Add price to history if provided
    if (price !== undefined) {
      this.addPriceToHistory(metrics, price);
    }
    
    // Recalculate reliability score
    metrics.reliabilityScore = this.calculateReliabilityScore(metrics);
    
    // Update metrics
    this.sources.set(source, metrics);
  }

  /**
   * Get reliability score for a specific source
   */
  getReliabilityScore(source: string): number {
    const metrics = this.sources.get(source);
    return metrics ? metrics.reliabilityScore : 1.0; // Default to perfect score for unknown sources
  }

  /**
   * Get prioritized list of sources for optimal fetching order
   */
  getPrioritizedSources(isHealthyMap: Map<string, boolean> = new Map()): PrioritizedSource[] {
    const sources: PrioritizedSource[] = [];
    
    for (const [source, metrics] of this.sources.entries()) {
      const isHealthy = isHealthyMap.get(source) ?? true;
      
      sources.push({
        source,
        priority: this.calculatePriority(metrics, isHealthy),
        reliabilityScore: metrics.reliabilityScore,
        isHealthy,
      });
    }
    
    // Sort by priority (higher is better)
    return sources.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Generate comprehensive reliability report
   */
  getReliabilityReport(): ReliabilityReport {
    const allSources = Array.from(this.sources.values());
    const isHealthyMap = new Map<string, boolean>();
    
    // Build health map for prioritization
    for (const [source, metrics] of this.sources.entries()) {
      isHealthyMap.set(source, metrics.reliabilityScore > 0.5);
    }
    
    const prioritizedSources = this.getPrioritizedSources(isHealthyMap);
    
    // Calculate overall metrics
    const totalRequests = allSources.reduce((sum, m) => sum + m.totalRequests, 0);
    const avgResponseTime = allSources.length > 0 
      ? allSources.reduce((sum, m) => sum + m.averageResponseTime, 0) / allSources.length 
      : 0;
    const overallReliability = allSources.length > 0
      ? allSources.reduce((sum, m) => sum + m.reliabilityScore, 0) / allSources.length
      : 1.0;
    
    return {
      overallReliability,
      sources: allSources,
      prioritizedSources,
      totalRequests,
      averageResponseTime: avgResponseTime,
      timestamp: Date.now(),
    };
  }

  /**
   * Reset all metrics (useful for testing)
   */
  resetAll(): void {
    this.sources.clear();
    this.logger.info('ReliabilityTracker reset all sources');
  }

  /**
   * Private helper to get or create source metrics
   */
  private getOrCreateMetrics(source: string): SourceMetrics {
    let metrics = this.sources.get(source);
    
    if (!metrics) {
      metrics = {
        source,
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        averageResponseTime: 0,
        lastRequestTime: Date.now(),
        reliabilityScore: 1.0,
        priceHistory: [],
        uptime: 0,
        downtime: 0,
      };
    }
    
    return metrics;
  }

  /**
   * Add price to history with window management
   */
  private addPriceToHistory(metrics: SourceMetrics, price: number): void {
    const now = Date.now();
    metrics.priceHistory.push({
      price,
      timestamp: now,
      source: metrics.source,
    });
    
    // Remove old entries
    const cutoffTime = now - this.config.historyWindowMs;
    metrics.priceHistory = metrics.priceHistory.filter(point => point.timestamp >= cutoffTime);
    
    // Limit total history size
    if (metrics.priceHistory.length > this.config.maxHistoryPoints) {
      metrics.priceHistory = metrics.priceHistory.slice(-this.config.maxHistoryPoints);
    }
  }

  /**
   * Calculate reliability score using weighted formula
   */
  private calculateReliabilityScore(metrics: SourceMetrics): number {
    if (metrics.totalRequests === 0) return 1.0;
    
    // Success rate component
    const successRate = metrics.successfulRequests / metrics.totalRequests;
    
    // Performance component (inverse of response time, normalized)
    const maxGoodResponseTime = 1000; // 1 second threshold
    const performanceScore = Math.max(0, 1 - (metrics.averageResponseTime / maxGoodResponseTime));
    
    // Recency component (based on last request time)
    const timeSinceLastRequest = Date.now() - metrics.lastRequestTime;
    const recencyScore = Math.max(0, 1 - (timeSinceLastRequest / (24 * 60 * 60 * 1000))); // 24h window
    
    // Weighted combination
    const reliabilityScore = 
      (successRate * this.config.stabilityWeight) +
      (performanceScore * this.config.performanceWeight) +
      (recencyScore * this.config.recentWeight);
    
    return Math.max(0, Math.min(1, reliabilityScore));
  }

  /**
   * Calculate priority score for source ordering
   */
  private calculatePriority(metrics: SourceMetrics, isHealthy: boolean): number {
    // Base priority from reliability score
    let priority = metrics.reliabilityScore * 1000;
    
    // Adjust for health status
    if (!isHealthy) {
      priority *= 0.1; // Heavily penalize unhealthy sources
    }
    
    // Boost recently active sources
    const timeSinceLastRequest = Date.now() - metrics.lastRequestTime;
    if (timeSinceLastRequest < 5 * 60 * 1000) { // 5 minutes
      priority *= 1.2;
    }
    
    return priority;
  }
}
