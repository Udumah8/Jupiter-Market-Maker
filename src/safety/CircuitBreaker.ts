/**
 * Circuit Breaker - Trading Halt System
 * Automatically halts trading on extreme market conditions
 */

import { Logger } from '../utils/Logger.js';

export interface CircuitBreakerConfig {
  priceDeviationThresholdPercent: number;
  volatilityThresholdPercent: number;
  lossThresholdPercent: number;
  consecutiveFailuresThreshold: number;
  cooldownPeriodMs: number;
  gradualResumeSteps: number;
  gradualResumeIntervalMs: number;
}

export interface CircuitBreakerStatus {
  isOpen: boolean;
  reason?: string;
  triggeredAt?: number;
  canResumeAt?: number;
  consecutiveFailures: number;
  currentStep: number;
  totalSteps: number;
}

export interface TriggerReason {
  type: 'price_deviation' | 'volatility' | 'loss' | 'failures' | 'manual';
  value: number;
  threshold: number;
  message: string;
}

export class CircuitBreaker {
  private logger: Logger;
  private config: CircuitBreakerConfig;
  private isOpen: boolean = false;
  private triggerReason?: TriggerReason;
  private triggeredAt?: number;
  private consecutiveFailures: number = 0;
  private resumeStep: number = 0;
  private resumeInterval?: NodeJS.Timeout;
  private priceHistory: number[] = [];

  constructor(config: CircuitBreakerConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Check if circuit breaker should trip
   */
  checkConditions(
    currentPrice: number,
    previousPrice: number,
    currentLoss: number,
    volatility: number
  ): boolean {
    // Don't check price deviation if we don't have a valid previous price
    // or if previous price is 0 (initialization)
    if (previousPrice > 0 && currentPrice > 0) {
      // Check price deviation
      const priceDeviation = Math.abs((currentPrice - previousPrice) / previousPrice) * 100;
      if (priceDeviation > this.config.priceDeviationThresholdPercent) {
        this.trip({
          type: 'price_deviation',
          value: priceDeviation,
          threshold: this.config.priceDeviationThresholdPercent,
          message: `Price deviated by ${priceDeviation.toFixed(2)}%`,
        });
        return true;
      }
    }

    // Check volatility
    if (volatility > this.config.volatilityThresholdPercent) {
      this.trip({
        type: 'volatility',
        value: volatility,
        threshold: this.config.volatilityThresholdPercent,
        message: `Volatility at ${volatility.toFixed(2)}%`,
      });
      return true;
    }

    // Check loss threshold
    if (currentLoss > this.config.lossThresholdPercent) {
      this.trip({
        type: 'loss',
        value: currentLoss,
        threshold: this.config.lossThresholdPercent,
        message: `Loss exceeded ${currentLoss.toFixed(2)}%`,
      });
      return true;
    }

    // Check consecutive failures
    if (this.consecutiveFailures >= this.config.consecutiveFailuresThreshold) {
      this.trip({
        type: 'failures',
        value: this.consecutiveFailures,
        threshold: this.config.consecutiveFailuresThreshold,
        message: `${this.consecutiveFailures} consecutive failures`,
      });
      return true;
    }

    return false;
  }

  /**
   * Trip the circuit breaker
   */
  trip(reason: TriggerReason): void {
    if (this.isOpen) {
      return; // Already tripped
    }

    this.isOpen = true;
    this.triggerReason = reason;
    this.triggeredAt = Date.now();

    this.logger.error('CIRCUIT BREAKER TRIPPED', {
      reason: reason.type,
      value: reason.value,
      threshold: reason.threshold,
      message: reason.message,
    });
  }

  /**
   * Manually trip the circuit breaker
   */
  manualTrip(message: string): void {
    this.trip({
      type: 'manual',
      value: 0,
      threshold: 0,
      message,
    });
  }

  /**
   * Reset the circuit breaker
   */
  reset(): void {
    if (!this.isOpen) {
      return;
    }

    // Check cooldown period
    if (this.triggeredAt) {
      const elapsed = Date.now() - this.triggeredAt;
      if (elapsed < this.config.cooldownPeriodMs) {
        const remaining = this.config.cooldownPeriodMs - elapsed;
        this.logger.warn('Cannot reset - cooldown period not elapsed', {
          remainingMs: remaining,
        });
        return;
      }
    }

    this.isOpen = false;
    this.triggerReason = undefined;
    this.triggeredAt = undefined;
    this.consecutiveFailures = 0;
    this.resumeStep = 0;

    if (this.resumeInterval) {
      clearInterval(this.resumeInterval);
      this.resumeInterval = undefined;
    }

    this.logger.info('Circuit breaker reset');
  }

  /**
   * Gradual resume - slowly increase trading activity
   */
  async gradualResume(
    onStepComplete: (step: number, totalSteps: number) => Promise<void>
  ): Promise<void> {
    if (!this.isOpen) {
      this.logger.warn('Circuit breaker not open, cannot resume');
      return;
    }

    // Check cooldown
    if (this.triggeredAt) {
      const elapsed = Date.now() - this.triggeredAt;
      if (elapsed < this.config.cooldownPeriodMs) {
        const remaining = this.config.cooldownPeriodMs - elapsed;
        this.logger.warn('Cannot resume - cooldown period not elapsed', {
          remainingMs: remaining,
        });
        return;
      }
    }

    this.logger.info('Starting gradual resume', {
      steps: this.config.gradualResumeSteps,
      intervalMs: this.config.gradualResumeIntervalMs,
    });

    this.resumeStep = 0;

    return new Promise((resolve) => {
      this.resumeInterval = setInterval(async () => {
        this.resumeStep++;

        this.logger.info('Gradual resume step', {
          step: this.resumeStep,
          total: this.config.gradualResumeSteps,
        });

        try {
          await onStepComplete(this.resumeStep, this.config.gradualResumeSteps);
        } catch (error) {
          this.logger.error('Gradual resume step failed', {
            step: this.resumeStep,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }

        if (this.resumeStep >= this.config.gradualResumeSteps) {
          if (this.resumeInterval) {
            clearInterval(this.resumeInterval);
            this.resumeInterval = undefined;
          }

          this.reset();
          this.logger.info('Gradual resume completed');
          resolve();
        }
      }, this.config.gradualResumeIntervalMs);
    });
  }

  /**
   * Record a trade failure
   */
  recordFailure(): void {
    this.consecutiveFailures++;
    this.logger.debug('Trade failure recorded', {
      consecutiveFailures: this.consecutiveFailures,
      threshold: this.config.consecutiveFailuresThreshold,
    });
  }

  /**
   * Record a trade success
   */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  /**
   * Update price history for volatility calculation
   */
  updatePriceHistory(price: number): void {
    this.priceHistory.push(price);
    if (this.priceHistory.length > 100) {
      this.priceHistory.shift();
    }
  }

  /**
   * Calculate current volatility
   */
  calculateVolatility(): number {
    if (this.priceHistory.length < 2) {
      return 0;
    }

    const returns = [];
    for (let i = 1; i < this.priceHistory.length; i++) {
      const ret = Math.log(this.priceHistory[i] / this.priceHistory[i - 1]);
      returns.push(ret);
    }

    const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    const variance =
      returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;

    return Math.sqrt(variance) * Math.sqrt(252) * 100; // Annualized volatility in percent
  }

  /**
   * Get circuit breaker status
   */
  getStatus(): CircuitBreakerStatus {
    return {
      isOpen: this.isOpen,
      reason: this.triggerReason?.message,
      triggeredAt: this.triggeredAt,
      canResumeAt: this.triggeredAt
        ? this.triggeredAt + this.config.cooldownPeriodMs
        : undefined,
      consecutiveFailures: this.consecutiveFailures,
      currentStep: this.resumeStep,
      totalSteps: this.config.gradualResumeSteps,
    };
  }

  /**
   * Check if trading is allowed
   */
  isTradingAllowed(): boolean {
    return !this.isOpen;
  }

  /**
   * Check if can resume
   */
  canResume(): boolean {
    if (!this.isOpen || !this.triggeredAt) {
      return false;
    }

    const elapsed = Date.now() - this.triggeredAt;
    return elapsed >= this.config.cooldownPeriodMs;
  }

  /**
   * Get time until can resume
   */
  getTimeUntilResume(): number {
    if (!this.isOpen || !this.triggeredAt) {
      return 0;
    }

    const elapsed = Date.now() - this.triggeredAt;
    const remaining = this.config.cooldownPeriodMs - elapsed;

    return Math.max(0, remaining);
  }

  /**
   * Get resume progress (0-1)
   */
  getResumeProgress(): number {
    if (this.config.gradualResumeSteps === 0) {
      return 1;
    }

    return this.resumeStep / this.config.gradualResumeSteps;
  }
}
