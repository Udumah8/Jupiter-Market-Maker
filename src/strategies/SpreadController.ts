/**
 * Spread Controller
 * Dynamically adjusts spread based on volatility, inventory, and market conditions
 */

import { Logger } from '../utils/Logger.js';

export interface SpreadConfig {
  minSpread: number; // Minimum spread (e.g., 0.005 = 0.5%)
  maxSpread: number; // Maximum spread (e.g., 0.05 = 5%)
  baseSpread: number; // Base spread (e.g., 0.01 = 1%)
  volatilityMultiplier: number; // How much volatility affects spread
  inventoryMultiplier: number; // How much inventory skew affects spread
  minProfitBps: number; // Minimum profit in basis points
  adaptiveEnabled: boolean; // Enable adaptive spread adjustment
}

export interface SpreadCalculation {
  bidSpread: number;
  askSpread: number;
  totalSpread: number;
  adjustments: {
    volatility: number;
    inventory: number;
    minProfit: number;
  };
}

export interface MarketConditions {
  volatility: number; // Current volatility (0-1)
  inventoryRatio: number; // Current inventory ratio (0-1, 0.5 = balanced)
  recentFills: number; // Number of recent fills
  competitionSpread: number; // Competitor spread if available
}

export class SpreadController {
  private logger: Logger;
  private config: SpreadConfig;
  private spreadHistory: number[] = [];
  private fillHistory: { timestamp: number; spread: number }[] = [];

  constructor(config: SpreadConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Calculate optimal spread based on market conditions
   */
  calculateOptimalSpread(
    midPrice: number,
    conditions: MarketConditions
  ): SpreadCalculation {
    let baseSpread = this.config.baseSpread;

    // Adjust for volatility
    const volatilityAdjustment = this.calculateVolatilityAdjustment(
      conditions.volatility
    );
    baseSpread += volatilityAdjustment;

    // Adjust for inventory
    const inventoryAdjustment = this.calculateInventoryAdjustment(
      conditions.inventoryRatio
    );

    // Ensure minimum profit
    const minProfitAdjustment = this.ensureMinimumProfit(midPrice);

    // Apply adjustments
    let totalSpread = baseSpread + minProfitAdjustment;

    // Clamp to min/max
    totalSpread = Math.max(
      this.config.minSpread,
      Math.min(totalSpread, this.config.maxSpread)
    );

    // Calculate asymmetric spread based on inventory
    const { bidSpread, askSpread } = this.calculateAsymmetricSpread(
      totalSpread,
      inventoryAdjustment,
      conditions.inventoryRatio
    );

    // Store in history
    this.spreadHistory.push(totalSpread);
    if (this.spreadHistory.length > 100) {
      this.spreadHistory.shift();
    }

    const result: SpreadCalculation = {
      bidSpread,
      askSpread,
      totalSpread,
      adjustments: {
        volatility: volatilityAdjustment,
        inventory: inventoryAdjustment,
        minProfit: minProfitAdjustment,
      },
    };

    this.logger.debug('Calculated optimal spread', {
      totalSpread: (totalSpread * 100).toFixed(3) + '%',
      bidSpread: (bidSpread * 100).toFixed(3) + '%',
      askSpread: (askSpread * 100).toFixed(3) + '%',
      volatility: (conditions.volatility * 100).toFixed(2) + '%',
      inventoryRatio: conditions.inventoryRatio.toFixed(3),
    });

    return result;
  }

  /**
   * Calculate volatility adjustment
   */
  private calculateVolatilityAdjustment(volatility: number): number {
    // Higher volatility = wider spread
    // Use exponential scaling for high volatility
    const adjustment =
      volatility * this.config.volatilityMultiplier * this.config.baseSpread;

    return Math.min(adjustment, this.config.maxSpread - this.config.baseSpread);
  }

  /**
   * Calculate inventory adjustment
   */
  private calculateInventoryAdjustment(inventoryRatio: number): number {
    // inventoryRatio: 0 = all quote, 1 = all base, 0.5 = balanced
    const targetRatio = 0.5;
    const deviation = Math.abs(inventoryRatio - targetRatio);

    // Larger deviation = larger adjustment
    const adjustment =
      deviation * this.config.inventoryMultiplier * this.config.baseSpread;

    return adjustment;
  }

  /**
   * Calculate asymmetric spread based on inventory
   */
  private calculateAsymmetricSpread(
    totalSpread: number,
    inventoryAdjustment: number,
    inventoryRatio: number
  ): { bidSpread: number; askSpread: number } {
    const targetRatio = 0.5;

    if (inventoryRatio > targetRatio) {
      // Too much base, widen ask spread to encourage selling
      return {
        bidSpread: totalSpread / 2 - inventoryAdjustment / 2,
        askSpread: totalSpread / 2 + inventoryAdjustment / 2,
      };
    } else if (inventoryRatio < targetRatio) {
      // Too much quote, widen bid spread to encourage buying
      return {
        bidSpread: totalSpread / 2 + inventoryAdjustment / 2,
        askSpread: totalSpread / 2 - inventoryAdjustment / 2,
      };
    } else {
      // Balanced, symmetric spread
      return {
        bidSpread: totalSpread / 2,
        askSpread: totalSpread / 2,
      };
    }
  }

  /**
   * Ensure minimum profit after fees
   */
  private ensureMinimumProfit(_midPrice: number): number {
    // Calculate minimum spread needed for profit
    // Assuming 0.3% trading fees (0.15% each side)
    const tradingFees = 0.003;
    const minSpreadForProfit = tradingFees + this.config.minProfitBps / 10000;

    // If current spread is below minimum, add adjustment
    if (this.config.baseSpread < minSpreadForProfit) {
      return minSpreadForProfit - this.config.baseSpread;
    }

    return 0;
  }

  /**
   * Adjust spread based on recent fill rate
   */
  adjustSpreadByFillRate(
    currentSpread: number,
    recentFills: number,
    targetFillRate: number
  ): number {
    if (!this.config.adaptiveEnabled) {
      return currentSpread;
    }

    // If fills are too frequent, widen spread
    if (recentFills > targetFillRate * 1.5) {
      return Math.min(currentSpread * 1.1, this.config.maxSpread);
    }

    // If fills are too infrequent, tighten spread
    if (recentFills < targetFillRate * 0.5) {
      return Math.max(currentSpread * 0.9, this.config.minSpread);
    }

    return currentSpread;
  }

  /**
   * Adjust spread based on competition
   */
  adjustSpreadByCompetition(
    currentSpread: number,
    competitionSpread: number
  ): number {
    if (!this.config.adaptiveEnabled || competitionSpread === 0) {
      return currentSpread;
    }

    // Try to be slightly tighter than competition
    const targetSpread = competitionSpread * 0.95;

    // But not below minimum
    return Math.max(targetSpread, this.config.minSpread);
  }

  /**
   * Record a fill for adaptive learning
   */
  recordFill(spread: number): void {
    this.fillHistory.push({
      timestamp: Date.now(),
      spread,
    });

    // Keep only last 100 fills
    if (this.fillHistory.length > 100) {
      this.fillHistory.shift();
    }

    this.logger.debug('Recorded fill', {
      spread: (spread * 100).toFixed(3) + '%',
      totalFills: this.fillHistory.length,
    });
  }

  /**
   * Get recent fill rate
   */
  getRecentFillRate(windowMs: number = 300000): number {
    // Default 5 minute window
    const cutoff = Date.now() - windowMs;
    const recentFills = this.fillHistory.filter((f) => f.timestamp > cutoff);

    return recentFills.length;
  }

  /**
   * Get average spread of recent fills
   */
  getAverageFillSpread(windowMs: number = 300000): number {
    const cutoff = Date.now() - windowMs;
    const recentFills = this.fillHistory.filter((f) => f.timestamp > cutoff);

    if (recentFills.length === 0) return this.config.baseSpread;

    const sum = recentFills.reduce((acc, f) => acc + f.spread, 0);
    return sum / recentFills.length;
  }

  /**
   * Get spread statistics
   */
  getSpreadStats(): {
    current: number;
    min: number;
    max: number;
    average: number;
    recentFills: number;
  } {
    if (this.spreadHistory.length === 0) {
      return {
        current: this.config.baseSpread,
        min: this.config.minSpread,
        max: this.config.maxSpread,
        average: this.config.baseSpread,
        recentFills: 0,
      };
    }

    const current = this.spreadHistory[this.spreadHistory.length - 1];
    const min = Math.min(...this.spreadHistory);
    const max = Math.max(...this.spreadHistory);
    const average =
      this.spreadHistory.reduce((sum, s) => sum + s, 0) / this.spreadHistory.length;
    const recentFills = this.getRecentFillRate();

    return { current, min, max, average, recentFills };
  }

  /**
   * Calculate dynamic spread based on order book imbalance
   */
  calculateSpreadFromImbalance(
    bidLiquidity: number,
    askLiquidity: number
  ): number {
    const totalLiquidity = bidLiquidity + askLiquidity;
    if (totalLiquidity === 0) return this.config.baseSpread;

    const ratio = bidLiquidity / totalLiquidity;

    // If order book is imbalanced, widen spread
    const imbalance = Math.abs(ratio - 0.5);
    const imbalanceAdjustment = imbalance * this.config.baseSpread * 2;

    return Math.min(
      this.config.baseSpread + imbalanceAdjustment,
      this.config.maxSpread
    );
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<SpreadConfig>): void {
    this.config = { ...this.config, ...config };
    this.logger.info('Spread controller config updated', config);
  }

  /**
   * Get current configuration
   */
  getConfig(): SpreadConfig {
    return { ...this.config };
  }

  /**
   * Reset history (useful for testing or after major market changes)
   */
  resetHistory(): void {
    this.spreadHistory = [];
    this.fillHistory = [];
    this.logger.info('Spread controller history reset');
  }
}
