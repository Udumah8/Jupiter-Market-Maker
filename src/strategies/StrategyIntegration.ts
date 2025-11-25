/**
 * Strategy Integration
 * Helper class to integrate all strategy modules with the MarketMaker
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { Logger } from '../utils/Logger.js';
import { LiquidityMirror, MirrorConfig } from './LiquidityMirror.js';
import { SpreadController, SpreadConfig, MarketConditions } from './SpreadController.js';
import { VolatilityFilter, VolatilityConfig } from './VolatilityFilter.js';
import { WallManager, WallConfig } from './WallManager.js';

export interface StrategyConfig {
  liquidityMirror: MirrorConfig;
  spreadController: SpreadConfig;
  volatilityFilter: VolatilityConfig;
  wallManager: WallConfig;
}

export interface StrategyRecommendations {
  spread: {
    bidSpread: number;
    askSpread: number;
    totalSpread: number;
  };
  positionSize: number;
  shouldPause: boolean;
  shouldPlaceWalls: boolean;
  mirrorOrders: any[];
  reason: string;
}

export class StrategyIntegration {
  private liquidityMirror: LiquidityMirror;
  private spreadController: SpreadController;
  private volatilityFilter: VolatilityFilter;
  private wallManager: WallManager;
  private logger: Logger;

  constructor(
    connection: Connection,
    config: StrategyConfig,
    logger: Logger
  ) {
    this.logger = logger;

    // Initialize strategy modules
    this.liquidityMirror = new LiquidityMirror(
      connection,
      config.liquidityMirror,
      logger
    );

    this.spreadController = new SpreadController(
      config.spreadController,
      logger
    );

    this.volatilityFilter = new VolatilityFilter(
      config.volatilityFilter,
      logger
    );

    this.wallManager = new WallManager(config.wallManager, logger);

    this.logger.info('Strategy integration initialized', {
      liquidityMirror: config.liquidityMirror.enabled,
      spreadController: config.spreadController.adaptiveEnabled,
      volatilityFilter: config.volatilityFilter.enabled,
      wallManager: config.wallManager.enabled,
    });
  }

  /**
   * Get comprehensive strategy recommendations
   */
  async getRecommendations(
    baseMint: PublicKey,
    quoteMint: PublicKey,
    midPrice: number,
    baseOrderSize: number,
    inventoryRatio: number,
    recentFills: number
  ): Promise<StrategyRecommendations> {
    // Update volatility with current price
    this.volatilityFilter.updatePrice(midPrice);

    // Get volatility metrics
    const volatilityMetrics = this.volatilityFilter.getMetrics();
    const volatilityAction = this.volatilityFilter.getAction();

    // Check if should pause
    if (volatilityAction.shouldPause) {
      return {
        spread: {
          bidSpread: 0,
          askSpread: 0,
          totalSpread: 0,
        },
        positionSize: 0,
        shouldPause: true,
        shouldPlaceWalls: false,
        mirrorOrders: [],
        reason: volatilityAction.reason,
      };
    }

    // Calculate optimal spread
    // Fetch competition spread from liquidity mirror if available
    let competitionSpread = 0;
    if (this.liquidityMirror.getConfig().enabled) {
      const orderBook = this.liquidityMirror.getOrderBookSnapshot();
      if (orderBook) {
        competitionSpread = orderBook.spread / orderBook.midPrice; // Normalize to percentage
      }
    }

    const marketConditions: MarketConditions = {
      volatility: volatilityMetrics.current,
      inventoryRatio,
      recentFills,
      competitionSpread,
    };

    const spreadCalc = this.spreadController.calculateOptimalSpread(
      midPrice,
      marketConditions
    );

    // Adjust spread for volatility
    const adjustedBidSpread =
      spreadCalc.bidSpread * volatilityAction.spreadMultiplier;
    const adjustedAskSpread =
      spreadCalc.askSpread * volatilityAction.spreadMultiplier;

    // Calculate position size
    let positionSize = baseOrderSize * volatilityAction.positionSizeFactor;

    // Check if should place walls
    const shouldPlaceWalls = this.wallManager.shouldPlaceWalls(
      'default',
      volatilityMetrics.current,
      inventoryRatio
    );

    // Get mirror orders if enabled
    let mirrorOrders: any[] = [];
    if (this.liquidityMirror.getConfig().enabled) {
      const orderBook = await this.liquidityMirror.analyzeOrderBook(
        baseMint,
        quoteMint
      );
      if (orderBook) {
        mirrorOrders = this.liquidityMirror.generateMirrorOrders(orderBook);
      }
    }

    return {
      spread: {
        bidSpread: adjustedBidSpread,
        askSpread: adjustedAskSpread,
        totalSpread: adjustedBidSpread + adjustedAskSpread,
      },
      positionSize,
      shouldPause: false,
      shouldPlaceWalls,
      mirrorOrders,
      reason: 'Normal operation',
    };
  }

  /**
   * Record a fill for adaptive learning
   */
  recordFill(spread: number, _side: 'bid' | 'ask'): void {
    this.spreadController.recordFill(spread);
    // Wall manager will handle its own fill tracking
    // Side parameter reserved for future use
  }

  /**
   * Get all strategy statuses
   */
  getStatus(): {
    liquidityMirror: any;
    spreadController: any;
    volatilityFilter: any;
    wallManager: any;
  } {
    return {
      liquidityMirror: {
        enabled: this.liquidityMirror.getConfig().enabled,
        lastUpdate: this.liquidityMirror.getOrderBookSnapshot()?.timestamp || 0,
      },
      spreadController: this.spreadController.getSpreadStats(),
      volatilityFilter: this.volatilityFilter.getStatus(),
      wallManager: this.wallManager.getStatus(),
    };
  }

  /**
   * Update all strategy configurations
   */
  updateConfig(config: Partial<StrategyConfig>): void {
    if (config.liquidityMirror) {
      this.liquidityMirror.updateConfig(config.liquidityMirror);
    }
    if (config.spreadController) {
      this.spreadController.updateConfig(config.spreadController);
    }
    if (config.volatilityFilter) {
      this.volatilityFilter.updateConfig(config.volatilityFilter);
    }
    if (config.wallManager) {
      this.wallManager.updateConfig(config.wallManager);
    }

    this.logger.info('Strategy configuration updated');
  }

  /**
   * Get individual strategy modules (for advanced usage)
   */
  getModules(): {
    liquidityMirror: LiquidityMirror;
    spreadController: SpreadController;
    volatilityFilter: VolatilityFilter;
    wallManager: WallManager;
  } {
    return {
      liquidityMirror: this.liquidityMirror,
      spreadController: this.spreadController,
      volatilityFilter: this.volatilityFilter,
      wallManager: this.wallManager,
    };
  }

  /**
   * Reset all strategy histories
   */
  resetAll(): void {
    this.spreadController.resetHistory();
    this.volatilityFilter.resetHistory();
    this.wallManager.resetHistory();
    this.logger.info('All strategy histories reset');
  }
}

/**
 * Create default strategy configuration
 */
export function createDefaultStrategyConfig(): StrategyConfig {
  return {
    liquidityMirror: {
      enabled: false, // Disabled by default
      depthLevels: 5,
      sizeMultiplier: 0.1,
      randomizationPercent: 10,
      minOrderSize: 1,
      maxOrderSize: 1000,
      updateInterval: 60000, // 1 minute
    },
    spreadController: {
      minSpread: 0.005, // 0.5%
      maxSpread: 0.05, // 5%
      baseSpread: 0.01, // 1%
      volatilityMultiplier: 1.5,
      inventoryMultiplier: 1.0,
      minProfitBps: 5,
      adaptiveEnabled: true,
    },
    volatilityFilter: {
      enabled: true,
      windowSize: 20,
      pauseThresholdPercent: 100, // 100% annualized
      reduceThresholdPercent: 50, // 50% annualized
      resumeThresholdPercent: 40, // 40% annualized
      positionSizeReduction: 0.5, // Reduce to 50%
      updateInterval: 5000, // 5 seconds
    },
    wallManager: {
      enabled: false, // Disabled by default
      bidWallEnabled: true,
      askWallEnabled: true,
      wallDepthPercent: 2, // 2% from mid
      wallSizeMultiplier: 3, // 3x normal size
      refreshInterval: 300000, // 5 minutes
      maxWalls: 3,
      minWallSize: 10,
      maxWallSize: 10000,
      adaptiveEnabled: true,
    },
  };
}
