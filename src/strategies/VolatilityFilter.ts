/**
 * Volatility Filter
 * Monitors market volatility and adjusts trading behavior accordingly
 */

import { Logger } from '../utils/Logger.js';

export interface VolatilityConfig {
  enabled: boolean;
  windowSize: number; // Number of price points to analyze
  pauseThresholdPercent: number; // Pause trading if volatility exceeds this
  reduceThresholdPercent: number; // Reduce position size if volatility exceeds this
  resumeThresholdPercent: number; // Resume normal trading when volatility drops below this
  positionSizeReduction: number; // Reduce position size by this factor (e.g., 0.5 = 50%)
  updateInterval: number; // How often to calculate volatility (ms)
}

export interface VolatilityMetrics {
  current: number; // Current volatility (annualized)
  average: number; // Average volatility over window
  max: number; // Maximum volatility in window
  min: number; // Minimum volatility in window
  trend: 'increasing' | 'decreasing' | 'stable';
  level: 'low' | 'medium' | 'high' | 'extreme';
}

export interface VolatilityAction {
  shouldPause: boolean;
  shouldReduce: boolean;
  positionSizeFactor: number; // Multiply position size by this
  spreadMultiplier: number; // Multiply spread by this
  reason: string;
}

export class VolatilityFilter {
  private logger: Logger;
  private config: VolatilityConfig;
  private priceHistory: number[] = [];
  private volatilityHistory: number[] = [];
  private lastUpdate: number = 0;
  private currentVolatility: number = 0;
  private isPaused: boolean = false;

  constructor(config: VolatilityConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Update price and calculate volatility
   */
  updatePrice(price: number): void {
    this.priceHistory.push(price);

    // Keep only the window size
    if (this.priceHistory.length > this.config.windowSize) {
      this.priceHistory.shift();
    }

    // Calculate volatility if we have enough data
    if (this.priceHistory.length >= 5) {
      const now = Date.now();
      if (now - this.lastUpdate >= this.config.updateInterval) {
        this.currentVolatility = this.calculateVolatility();
        this.volatilityHistory.push(this.currentVolatility);

        if (this.volatilityHistory.length > 100) {
          this.volatilityHistory.shift();
        }

        this.lastUpdate = now;

        this.logger.debug('Volatility updated', {
          volatility: (this.currentVolatility * 100).toFixed(2) + '%',
          pricePoints: this.priceHistory.length,
        });
      }
    }
  }

  /**
   * Calculate current volatility (annualized standard deviation of returns)
   */
  calculateVolatility(): number {
    if (this.priceHistory.length < 2) return 0;

    // Calculate returns
    const returns: number[] = [];
    for (let i = 1; i < this.priceHistory.length; i++) {
      const ret = Math.log(this.priceHistory[i] / this.priceHistory[i - 1]);
      returns.push(ret);
    }

    if (returns.length === 0) return 0;

    // Calculate mean
    const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;

    // Calculate variance
    const variance =
      returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;

    // Calculate standard deviation (volatility)
    const stdDev = Math.sqrt(variance);

    // Annualize (assuming 252 trading days, 24 hours)
    const annualized = stdDev * Math.sqrt(252 * 24);

    return annualized;
  }

  /**
   * Get volatility metrics
   */
  getMetrics(): VolatilityMetrics {
    if (this.volatilityHistory.length === 0) {
      return {
        current: 0,
        average: 0,
        max: 0,
        min: 0,
        trend: 'stable',
        level: 'low',
      };
    }

    const current = this.currentVolatility;
    const average =
      this.volatilityHistory.reduce((sum, v) => sum + v, 0) /
      this.volatilityHistory.length;
    const max = Math.max(...this.volatilityHistory);
    const min = Math.min(...this.volatilityHistory);

    // Determine trend
    let trend: 'increasing' | 'decreasing' | 'stable' = 'stable';
    if (this.volatilityHistory.length >= 5) {
      const recent = this.volatilityHistory.slice(-5);
      const older = this.volatilityHistory.slice(-10, -5);
      if (older.length > 0) {
        const recentAvg = recent.reduce((sum, v) => sum + v, 0) / recent.length;
        const olderAvg = older.reduce((sum, v) => sum + v, 0) / older.length;

        if (recentAvg > olderAvg * 1.2) trend = 'increasing';
        else if (recentAvg < olderAvg * 0.8) trend = 'decreasing';
      }
    }

    // Determine level
    let level: 'low' | 'medium' | 'high' | 'extreme' = 'low';
    const volPercent = current * 100;
    if (volPercent > this.config.pauseThresholdPercent) level = 'extreme';
    else if (volPercent > this.config.reduceThresholdPercent) level = 'high';
    else if (volPercent > this.config.reduceThresholdPercent * 0.5) level = 'medium';

    return { current, average, max, min, trend, level };
  }

  /**
   * Determine what action to take based on volatility
   */
  getAction(): VolatilityAction {
    if (!this.config.enabled) {
      return {
        shouldPause: false,
        shouldReduce: false,
        positionSizeFactor: 1.0,
        spreadMultiplier: 1.0,
        reason: 'Volatility filter disabled',
      };
    }

    const metrics = this.getMetrics();
    const volPercent = metrics.current * 100;

    // Check if should pause
    if (volPercent > this.config.pauseThresholdPercent) {
      this.isPaused = true;
      return {
        shouldPause: true,
        shouldReduce: true,
        positionSizeFactor: 0,
        spreadMultiplier: 2.0,
        reason: `Extreme volatility: ${volPercent.toFixed(2)}%`,
      };
    }

    // Check if should resume
    if (this.isPaused && volPercent < this.config.resumeThresholdPercent) {
      this.isPaused = false;
      this.logger.info('Resuming trading after volatility decrease', {
        volatility: volPercent.toFixed(2) + '%',
      });
    }

    // Check if should reduce
    if (volPercent > this.config.reduceThresholdPercent) {
      const reductionFactor = this.calculateReductionFactor(volPercent);
      return {
        shouldPause: false,
        shouldReduce: true,
        positionSizeFactor: reductionFactor,
        spreadMultiplier: 1 + (volPercent / 100) * 0.5,
        reason: `High volatility: ${volPercent.toFixed(2)}%`,
      };
    }

    // Normal operation
    return {
      shouldPause: false,
      shouldReduce: false,
      positionSizeFactor: 1.0,
      spreadMultiplier: 1.0,
      reason: 'Normal volatility',
    };
  }

  /**
   * Calculate position size reduction factor based on volatility
   */
  private calculateReductionFactor(volPercent: number): number {
    // Linear reduction between reduce and pause thresholds
    const range =
      this.config.pauseThresholdPercent - this.config.reduceThresholdPercent;
    const excess = volPercent - this.config.reduceThresholdPercent;
    const ratio = Math.min(excess / range, 1);

    // Reduce from 1.0 to configured minimum
    return 1.0 - ratio * (1.0 - this.config.positionSizeReduction);
  }

  /**
   * Check if trading should be paused
   */
  shouldPauseTrading(): boolean {
    if (!this.config.enabled) return false;

    const action = this.getAction();
    return action.shouldPause;
  }

  /**
   * Get adjusted position size based on volatility
   */
  getAdjustedPositionSize(baseSize: number): number {
    const action = this.getAction();
    return baseSize * action.positionSizeFactor;
  }

  /**
   * Get adjusted spread based on volatility
   */
  getAdjustedSpread(baseSpread: number): number {
    const action = this.getAction();
    return baseSpread * action.spreadMultiplier;
  }

  /**
   * Calculate volatility-adjusted order size
   */
  calculateVolatilityAdjustedSize(
    baseSize: number,
    volatility: number
  ): number {
    if (!this.config.enabled) return baseSize;

    // Reduce size as volatility increases
    const volPercent = volatility * 100;

    if (volPercent > this.config.pauseThresholdPercent) {
      return 0; // No trading
    }

    if (volPercent > this.config.reduceThresholdPercent) {
      const reductionFactor = this.calculateReductionFactor(volPercent);
      return baseSize * reductionFactor;
    }

    return baseSize;
  }

  /**
   * Predict if volatility will increase
   */
  predictVolatilityIncrease(): boolean {
    const metrics = this.getMetrics();

    // If trend is increasing and already at medium level
    if (metrics.trend === 'increasing' && metrics.level !== 'low') {
      return true;
    }

    // If current volatility is near pause threshold
    const volPercent = metrics.current * 100;
    if (volPercent > this.config.pauseThresholdPercent * 0.8) {
      return true;
    }

    return false;
  }

  /**
   * Get volatility forecast
   */
  getForecast(): {
    prediction: 'increasing' | 'decreasing' | 'stable';
    confidence: number;
    expectedVolatility: number;
  } {
    const metrics = this.getMetrics();

    // Simple forecast based on trend
    let prediction = metrics.trend;
    let confidence = 0.5;

    // Increase confidence if trend is consistent
    if (this.volatilityHistory.length >= 10) {
      const recent = this.volatilityHistory.slice(-5);
      const older = this.volatilityHistory.slice(-10, -5);

      const recentAvg = recent.reduce((sum, v) => sum + v, 0) / recent.length;
      const olderAvg = older.reduce((sum, v) => sum + v, 0) / older.length;

      const change = Math.abs(recentAvg - olderAvg) / olderAvg;
      confidence = Math.min(0.5 + change, 0.9);
    }

    // Predict next volatility
    let expectedVolatility = metrics.current;
    if (prediction === 'increasing') {
      expectedVolatility *= 1.1;
    } else if (prediction === 'decreasing') {
      expectedVolatility *= 0.9;
    }

    return { prediction, confidence, expectedVolatility };
  }

  /**
   * Get current volatility
   */
  getCurrentVolatility(): number {
    return this.currentVolatility;
  }

  /**
   * Check if volatility is stable
   */
  isVolatilityStable(): boolean {
    const metrics = this.getMetrics();
    return metrics.trend === 'stable' && metrics.level === 'low';
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<VolatilityConfig>): void {
    this.config = { ...this.config, ...config };
    this.logger.info('Volatility filter config updated', config);
  }

  /**
   * Get current configuration
   */
  getConfig(): VolatilityConfig {
    return { ...this.config };
  }

  /**
   * Reset history
   */
  resetHistory(): void {
    this.priceHistory = [];
    this.volatilityHistory = [];
    this.currentVolatility = 0;
    this.isPaused = false;
    this.logger.info('Volatility filter history reset');
  }

  /**
   * Get status summary
   */
  getStatus(): {
    enabled: boolean;
    paused: boolean;
    metrics: VolatilityMetrics;
    action: VolatilityAction;
  } {
    return {
      enabled: this.config.enabled,
      paused: this.isPaused,
      metrics: this.getMetrics(),
      action: this.getAction(),
    };
  }
}
