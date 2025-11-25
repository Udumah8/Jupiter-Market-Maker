/**
 * Wall Manager
 * Manages bid and ask walls to create artificial support/resistance levels
 */

import { PublicKey } from '@solana/web3.js';
import { Logger } from '../utils/Logger.js';

export interface WallConfig {
  enabled: boolean;
  bidWallEnabled: boolean;
  askWallEnabled: boolean;
  wallDepthPercent: number; // Distance from mid price (e.g., 2 = 2%)
  wallSizeMultiplier: number; // Size relative to normal orders (e.g., 3 = 3x)
  refreshInterval: number; // How often to refresh walls (ms)
  maxWalls: number; // Maximum number of walls per side
  minWallSize: number; // Minimum wall size
  maxWallSize: number; // Maximum wall size
  adaptiveEnabled: boolean; // Adjust wall size based on market
}

export interface Wall {
  orderKey: PublicKey;
  price: number;
  size: number;
  side: 'bid' | 'ask';
  level: number;
  timestamp: number;
  filled: boolean;
}

export interface WallPlacement {
  price: number;
  size: number;
  side: 'bid' | 'ask';
  level: number;
}

export class WallManager {
  private logger: Logger;
  private config: WallConfig;
  private activeWalls: Map<string, Wall[]> = new Map(); // wallet -> walls
  private lastRefresh: Map<string, number> = new Map();
  private fillHistory: { timestamp: number; side: 'bid' | 'ask' }[] = [];

  constructor(config: WallConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Calculate wall placements based on mid price
   */
  calculateWallPlacements(
    midPrice: number,
    baseOrderSize: number
  ): WallPlacement[] {
    if (!this.config.enabled) return [];

    const placements: WallPlacement[] = [];

    // Calculate bid walls
    if (this.config.bidWallEnabled) {
      for (let i = 0; i < this.config.maxWalls; i++) {
        const level = i + 1;
        const depthPercent = this.config.wallDepthPercent * level;
        const price = midPrice * (1 - depthPercent / 100);
        const size = this.calculateWallSize(baseOrderSize, level);

        placements.push({
          price,
          size,
          side: 'bid',
          level,
        });
      }
    }

    // Calculate ask walls
    if (this.config.askWallEnabled) {
      for (let i = 0; i < this.config.maxWalls; i++) {
        const level = i + 1;
        const depthPercent = this.config.wallDepthPercent * level;
        const price = midPrice * (1 + depthPercent / 100);
        const size = this.calculateWallSize(baseOrderSize, level);

        placements.push({
          price,
          size,
          side: 'ask',
          level,
        });
      }
    }

    return placements;
  }

  /**
   * Calculate wall size based on level
   */
  private calculateWallSize(baseSize: number, level: number): number {
    // Larger walls at deeper levels
    let size = baseSize * this.config.wallSizeMultiplier * (1 + level * 0.2);

    // Clamp to limits
    size = Math.max(this.config.minWallSize, Math.min(size, this.config.maxWallSize));

    return size;
  }

  /**
   * Check if walls need refreshing
   */
  shouldRefreshWalls(walletKey: string): boolean {
    if (!this.config.enabled) return false;

    const lastRefresh = this.lastRefresh.get(walletKey) || 0;
    const timeSinceRefresh = Date.now() - lastRefresh;

    return timeSinceRefresh >= this.config.refreshInterval;
  }

  /**
   * Register a placed wall
   */
  registerWall(walletKey: string, wall: Wall): void {
    const walls = this.activeWalls.get(walletKey) || [];
    walls.push(wall);
    this.activeWalls.set(walletKey, walls);

    this.logger.debug('Wall registered', {
      wallet: walletKey,
      side: wall.side,
      price: wall.price.toFixed(6),
      size: wall.size.toFixed(6),
      level: wall.level,
    });
  }

  /**
   * Remove a wall
   */
  removeWall(walletKey: string, orderKey: PublicKey): void {
    const walls = this.activeWalls.get(walletKey) || [];
    const filtered = walls.filter(
      (w) => w.orderKey.toString() !== orderKey.toString()
    );
    this.activeWalls.set(walletKey, filtered);

    this.logger.debug('Wall removed', {
      wallet: walletKey,
      orderKey: orderKey.toString(),
    });
  }

  /**
   * Get active walls for a wallet
   */
  getActiveWalls(walletKey: string): Wall[] {
    return this.activeWalls.get(walletKey) || [];
  }

  /**
   * Handle wall fill
   */
  handleWallFill(walletKey: string, wall: Wall): void {
    // Mark as filled
    wall.filled = true;

    // Record fill
    this.fillHistory.push({
      timestamp: Date.now(),
      side: wall.side,
    });

    // Keep only last 100 fills
    if (this.fillHistory.length > 100) {
      this.fillHistory.shift();
    }

    this.logger.info('Wall filled', {
      wallet: walletKey,
      side: wall.side,
      price: wall.price.toFixed(6),
      size: wall.size.toFixed(6),
      level: wall.level,
    });

    // Remove from active walls
    this.removeWall(walletKey, wall.orderKey);

    // Adjust strategy if needed
    if (this.config.adaptiveEnabled) {
      this.adjustWallStrategy(wall.side);
    }
  }

  /**
   * Adjust wall strategy based on fills
   */
  private adjustWallStrategy(side: 'bid' | 'ask'): void {
    // Count recent fills on this side
    const recentFills = this.fillHistory.filter(
      (f) => f.side === side && Date.now() - f.timestamp < 300000 // 5 minutes
    );

    // If walls are filling too quickly, move them deeper
    if (recentFills.length > 5) {
      this.config.wallDepthPercent *= 1.1;
      this.logger.info('Walls filling too quickly, increasing depth', {
        side,
        newDepth: this.config.wallDepthPercent.toFixed(2) + '%',
      });
    }

    // If walls aren't filling, move them closer
    if (recentFills.length === 0 && this.fillHistory.length > 20) {
      this.config.wallDepthPercent *= 0.9;
      this.logger.info('Walls not filling, decreasing depth', {
        side,
        newDepth: this.config.wallDepthPercent.toFixed(2) + '%',
      });
    }
  }

  /**
   * Check if price is approaching a wall
   */
  isApproachingWall(
    walletKey: string,
    currentPrice: number,
    side: 'bid' | 'ask'
  ): { approaching: boolean; wall: Wall | null; distance: number } {
    const walls = this.getActiveWalls(walletKey).filter((w) => w.side === side);

    if (walls.length === 0) {
      return { approaching: false, wall: null, distance: 0 };
    }

    // Find closest wall
    let closestWall: Wall | null = null;
    let minDistance = Infinity;

    for (const wall of walls) {
      const distance = Math.abs(currentPrice - wall.price) / currentPrice;
      if (distance < minDistance) {
        minDistance = distance;
        closestWall = wall;
      }
    }

    // Consider "approaching" if within 0.5% of wall
    const approaching = minDistance < 0.005;

    return {
      approaching,
      wall: closestWall,
      distance: minDistance,
    };
  }

  /**
   * Get wall statistics
   */
  getWallStats(walletKey: string): {
    totalWalls: number;
    bidWalls: number;
    askWalls: number;
    totalSize: number;
    recentFills: number;
  } {
    const walls = this.getActiveWalls(walletKey);
    const bidWalls = walls.filter((w) => w.side === 'bid').length;
    const askWalls = walls.filter((w) => w.side === 'ask').length;
    const totalSize = walls.reduce((sum, w) => sum + w.size, 0);

    const recentFills = this.fillHistory.filter(
      (f) => Date.now() - f.timestamp < 300000 // 5 minutes
    ).length;

    return {
      totalWalls: walls.length,
      bidWalls,
      askWalls,
      totalSize,
      recentFills,
    };
  }

  /**
   * Calculate optimal wall depth based on volatility
   */
  calculateOptimalDepth(volatility: number): number {
    // Higher volatility = deeper walls
    const baseDepth = this.config.wallDepthPercent;
    const volatilityAdjustment = volatility * 100 * 0.5; // 50% of volatility

    return Math.max(baseDepth, baseDepth + volatilityAdjustment);
  }

  /**
   * Calculate optimal wall size based on liquidity
   */
  calculateOptimalSize(
    baseSize: number,
    availableLiquidity: number
  ): number {
    // Don't make walls larger than 10% of available liquidity
    const maxSize = availableLiquidity * 0.1;
    const targetSize = baseSize * this.config.wallSizeMultiplier;

    return Math.min(targetSize, maxSize);
  }

  /**
   * Check if should place walls
   */
  shouldPlaceWalls(
    walletKey: string,
    volatility: number,
    inventoryRatio: number
  ): boolean {
    if (!this.config.enabled) return false;

    // Don't place walls during high volatility
    if (volatility > 0.5) {
      this.logger.debug('Skipping walls due to high volatility', {
        volatility: (volatility * 100).toFixed(2) + '%',
      });
      return false;
    }

    // Don't place walls if inventory is too skewed
    if (Math.abs(inventoryRatio - 0.5) > 0.3) {
      this.logger.debug('Skipping walls due to inventory imbalance', {
        inventoryRatio: inventoryRatio.toFixed(3),
      });
      return false;
    }

    // Check if refresh is needed
    return this.shouldRefreshWalls(walletKey);
  }

  /**
   * Mark walls as refreshed
   */
  markRefreshed(walletKey: string): void {
    this.lastRefresh.set(walletKey, Date.now());
  }

  /**
   * Clear all walls for a wallet
   */
  clearWalls(walletKey: string): void {
    this.activeWalls.delete(walletKey);
    this.logger.debug('Cleared all walls', { wallet: walletKey });
  }

  /**
   * Get wall placement recommendations
   */
  getRecommendations(
    _midPrice: number,
    volatility: number,
    inventoryRatio: number
  ): {
    shouldPlace: boolean;
    recommendedDepth: number;
    recommendedSize: number;
    reason: string;
  } {
    if (!this.config.enabled) {
      return {
        shouldPlace: false,
        recommendedDepth: 0,
        recommendedSize: 0,
        reason: 'Walls disabled',
      };
    }

    // Check volatility
    if (volatility > 0.5) {
      return {
        shouldPlace: false,
        recommendedDepth: 0,
        recommendedSize: 0,
        reason: 'Volatility too high',
      };
    }

    // Check inventory
    if (Math.abs(inventoryRatio - 0.5) > 0.3) {
      return {
        shouldPlace: false,
        recommendedDepth: 0,
        recommendedSize: 0,
        reason: 'Inventory too imbalanced',
      };
    }

    // Calculate recommendations
    const recommendedDepth = this.calculateOptimalDepth(volatility);
    const recommendedSize = this.config.wallSizeMultiplier;

    return {
      shouldPlace: true,
      recommendedDepth,
      recommendedSize,
      reason: 'Conditions favorable for walls',
    };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<WallConfig>): void {
    this.config = { ...this.config, ...config };
    this.logger.info('Wall manager config updated', config);
  }

  /**
   * Get current configuration
   */
  getConfig(): WallConfig {
    return { ...this.config };
  }

  /**
   * Reset history
   */
  resetHistory(): void {
    this.fillHistory = [];
    this.logger.info('Wall manager history reset');
  }

  /**
   * Get status summary
   */
  getStatus(): {
    enabled: boolean;
    totalWalls: number;
    recentFills: number;
    config: WallConfig;
  } {
    let totalWalls = 0;
    this.activeWalls.forEach((walls) => {
      totalWalls += walls.length;
    });

    const recentFills = this.fillHistory.filter(
      (f) => Date.now() - f.timestamp < 300000
    ).length;

    return {
      enabled: this.config.enabled,
      totalWalls,
      recentFills,
      config: this.config,
    };
  }
}
