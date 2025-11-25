/**
 * Solana Market Maker Bot - Main Entry Point
 * Production-ready with all safety modules and auto-funding/withdrawal
 */

import { Logger } from './utils/Logger.js';
import { PublicKey } from '@solana/web3.js';
import { MarketMaker } from './core/MarketMaker.js';
import { PaperTradingMarketMaker } from './core/PaperTradingMarketMaker.js';
import { AppConfig } from './utils/AppConfig.js';
import { RPCManager } from './utils/RPCManager.js';
import { StateManager } from './utils/StateManager.js';
import { WalletManager } from './utils/WalletManager.js';
import { JupiterLimitOrders } from './exchange/JupiterLimitOrders.js';
import { JupiterSwap } from './exchange/JupiterSwap.js';
import { PriceAggregator } from './pricing/PriceAggregator.js';
import { MEVProtection } from './safety/MEVProtection.js';
import { RugPullDetector } from './safety/RugPullDetector.js';
import { CircuitBreaker } from './safety/CircuitBreaker.js';
import { PaperTradingConfig } from './utils/PaperTradingEngine.js';

async function main() {
  const logger = new Logger('info');
  logger.info('🚀 Initializing Solana Market Maker Bot...');

  try {
    // 1. Load Configuration
    const config = new AppConfig();
    config.load();
    const cfg = config.get();
    logger.info('✅ Configuration loaded successfully.');

    // 2. Initialize RPC Manager
    const rpcManager = new RPCManager(cfg);
    await rpcManager.initialize();
    logger.info(`✅ RPC Manager initialized with ${rpcManager.getEndpointCount()} endpoints.`);

    const connection = rpcManager.getConnection();

    // 3. Initialize State Manager
    const stateManager = new StateManager(cfg);
    await stateManager.initialize();
    logger.info('✅ State Manager initialized.');

    // 4. Initialize Wallet Manager with all new features
    const walletManager = new WalletManager(
      {
        masterSeed: cfg.MASTER_WALLET_SEED,
        encryptionKey: cfg.WALLET_ENCRYPTION_KEY,
        numberOfWallets: cfg.NUMBER_OF_WALLETS,
        walletsFilePath: cfg.WALLETS_FILE_PATH,
        autoFundThresholdSol: cfg.AUTO_FUND_THRESHOLD_SOL,
        fundingAmountSol: cfg.FUNDING_AMOUNT_SOL,
        autoWithdrawThresholdSol: cfg.AUTO_WITHDRAW_THRESHOLD_SOL,
        minBalanceToKeepSol: cfg.MIN_BALANCE_TO_KEEP_SOL,
      },
      connection,
      logger
    );

    await walletManager.initialize(cfg.MASTER_WALLET_PRIVATE_KEY);
    logger.info(`✅ Wallet Manager initialized with ${walletManager.getWalletCount()} wallets.`);

    // 5. Initialize Safety Modules
    const mevProtection = new MEVProtection(
      connection,
      {
        enablePriorityFees: cfg.MEV_PROTECTION_ENABLED,
        basePriorityFee: cfg.BASE_PRIORITY_FEE,
        maxPriorityFee: cfg.MAX_PRIORITY_FEE,
        enableSimulation: cfg.ENABLE_TRANSACTION_SIMULATION,
        enableSandwichDetection: cfg.ENABLE_SANDWICH_DETECTION,
        maxSlippagePercent: cfg.MAX_SLIPPAGE_PERCENT,
        computeUnitLimit: cfg.COMPUTE_UNIT_LIMIT,
      },
      logger
    );
    logger.info('✅ MEV Protection initialized.');

    const rugPullDetector = new RugPullDetector(
      connection,
      {
        lpMonitoringEnabled: cfg.LP_MONITORING_ENABLED,
        supplyChangeThresholdPercent: cfg.SUPPLY_CHANGE_THRESHOLD_PERCENT,
        holderConcentrationThresholdPercent: cfg.HOLDER_CONCENTRATION_THRESHOLD_PERCENT,
        checkIntervalMs: cfg.RUG_PULL_CHECK_INTERVAL_MS,
        autoExitOnDetection: cfg.AUTO_EXIT_ON_RUG_PULL,
      },
      logger
    );
    logger.info('✅ Rug-Pull Detector initialized.');

    const circuitBreaker = new CircuitBreaker(
      {
        priceDeviationThresholdPercent: cfg.CIRCUIT_BREAKER_PRICE_DEVIATION_PERCENT,
        volatilityThresholdPercent: cfg.CIRCUIT_BREAKER_VOLATILITY_PERCENT,
        lossThresholdPercent: cfg.CIRCUIT_BREAKER_LOSS_PERCENT,
        consecutiveFailuresThreshold: cfg.CIRCUIT_BREAKER_CONSECUTIVE_FAILURES,
        cooldownPeriodMs: cfg.CIRCUIT_BREAKER_COOLDOWN_MS,
        gradualResumeSteps: cfg.CIRCUIT_BREAKER_GRADUAL_RESUME_STEPS,
        gradualResumeIntervalMs: 60000, // 1 minute per step
      },
      logger
    );
    logger.info('✅ Circuit Breaker initialized.');

    // 6. Initialize Price Aggregator
    const priceAggregator = new PriceAggregator(
      {
        cacheDurationMs: cfg.PAPER_TRADING_ENABLED ? 30000 : 5000, // Cache longer in paper trading to reduce API calls
        minSources: cfg.PAPER_TRADING_ENABLED ? 1 : 2, // Only need 1 source in paper trading
        maxPriceDeviationPercent: 10,
        spreadPercent: cfg.SPREAD_BPS / 100,
        enableCircuitBreaker: cfg.CIRCUIT_BREAKER_ENABLED,
        circuitBreakerThresholdPercent: cfg.CIRCUIT_BREAKER_PRICE_DEVIATION_PERCENT,
      },
      logger
    );
    logger.info('✅ Price Aggregator initialized.');

    // 7. Initialize Jupiter Swap
    const jupiterSwap = new JupiterSwap(connection, logger);
    logger.info('✅ Jupiter Swap initialized.');

    // 8. Initialize Jupiter Limit Orders
    const jupiterOrders = new JupiterLimitOrders(
      connection,
      {
        computeUnitLimit: cfg.COMPUTE_UNIT_LIMIT,
        computeUnitPrice: cfg.BASE_PRIORITY_FEE,
        maxRetries: 3,
        retryDelay: 1000,
      },
      logger
    );
    logger.info('✅ Jupiter Limit Orders initialized.');

    // 9. Start Rug-Pull Monitoring
    if (cfg.RUG_PULL_DETECTION_ENABLED) {
      const baseMint = new PublicKey(cfg.BASE_MINT);
      rugPullDetector.startMonitoring(baseMint);
      logger.info('✅ Rug-Pull monitoring started.');
    }

    // 10. Initialize Core Market Maker with Safety Modules and Strategies
    const marketMakerConfig = {
      baseMint: new PublicKey(cfg.BASE_MINT),
      quoteMint: new PublicKey(cfg.QUOTE_MINT),
      baseDecimals: cfg.BASE_DECIMALS,
      quoteDecimals: cfg.QUOTE_DECIMALS,
      spreadPercent: cfg.SPREAD_BPS / 100,
      orderSize: cfg.BASE_TRADE_SIZE_QUOTE,
      inventorySkew: cfg.INVENTORY_SKEW_BPS / 100,
      maxPositionSize: cfg.MAX_POSITION_QUOTE,
      orderRefreshInterval: cfg.ORDER_REFRESH_TIME_SECONDS * 1000,
      minSpreadPercent: cfg.MIN_PROFIT_BPS / 100,
      enableVolatilityAdaptive: true,
      maxLossPercent: cfg.MAX_DAILY_LOSS_PERCENT,
      maxSlippagePercent: cfg.MAX_SLIPPAGE_PERCENT,
      volThresholdPercent: cfg.CIRCUIT_BREAKER_VOLATILITY_PERCENT,
      enableBidAskWalls: false, // Can be enabled later
      wallDepthPercent: 2.0,
      targetInventoryRatio: 0.5,
      enableStrategies: cfg.ENABLE_STRATEGIES, // Enable advanced strategy modules
      // strategyConfig will use defaults from createDefaultStrategyConfig()
    };

    let marketMaker: MarketMaker;

    // Initialize Paper Trading or Real Trading
    if (cfg.PAPER_TRADING_ENABLED) {
      logger.info('🎯 Initializing PAPER TRADING mode...');
      
      const paperConfig: PaperTradingConfig = {
        initialBalances: new Map([
          [cfg.BASE_MINT, { amount: cfg.PAPER_TRADING_INITIAL_BASE, decimals: cfg.BASE_DECIMALS }],
          [cfg.QUOTE_MINT, { amount: cfg.PAPER_TRADING_INITIAL_QUOTE, decimals: cfg.QUOTE_DECIMALS }],
        ]),
        fillProbability: cfg.PAPER_TRADING_FILL_PROBABILITY,
        fillDelayMs: cfg.PAPER_TRADING_FILL_DELAY_MS,
        slippagePercent: cfg.PAPER_TRADING_SLIPPAGE_PERCENT,
        enableRealisticFills: cfg.PAPER_TRADING_REALISTIC_FILLS,
        feePercent: cfg.PAPER_TRADING_FEE_PERCENT,
      };

      marketMaker = new PaperTradingMarketMaker(
        marketMakerConfig,
        rpcManager,
        stateManager,
        walletManager,
        priceAggregator,
        jupiterSwap,
        jupiterOrders,
        mevProtection,
        circuitBreaker,
        rugPullDetector,
        logger,
        paperConfig
      );
    } else {
      logger.info('💰 Initializing REAL TRADING mode...');
      
      marketMaker = new MarketMaker(
        marketMakerConfig,
        rpcManager,
        stateManager,
        walletManager,
        priceAggregator,
        jupiterSwap,
        jupiterOrders,
        mevProtection,
        circuitBreaker,
        rugPullDetector,
        logger
      );
    }

    await marketMaker.initialize();
    logger.info('✅ Market Maker initialized.');

    // 11. Auto-fund wallets before starting (skip in paper trading mode)
    if (cfg.AUTO_FUND_ENABLED && !cfg.PAPER_TRADING_ENABLED) {
      logger.info('💰 Checking wallet balances and auto-funding if needed...');
      const tokenMint = new PublicKey(cfg.BASE_MINT);
      await walletManager.autoFundWallets(tokenMint);
      logger.info('✅ Auto-funding check completed.');
    } else if (cfg.PAPER_TRADING_ENABLED) {
      logger.info('📊 Paper trading mode - skipping real wallet funding');
    }

    // 12. Start the Bot
    logger.info('🎯 Starting market making operations...');
    await marketMaker.start();
    logger.info('✅ Market Maker is now running!');

    // 13. Set up auto-withdrawal interval (skip in paper trading mode)
    if (cfg.AUTO_WITHDRAW_ENABLED && !cfg.PAPER_TRADING_ENABLED) {
      const withdrawalInterval = setInterval(async () => {
        try {
          logger.info('💸 Running auto-withdrawal check...');
          const tokenMint = new PublicKey(cfg.BASE_MINT);
          await walletManager.autoWithdrawProfits(tokenMint);
        } catch (error) {
          logger.error('Auto-withdrawal check failed', {
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }, 300000); // Every 5 minutes

      // Store interval for cleanup
      (global as any).withdrawalInterval = withdrawalInterval;
    }

    // 14. Graceful Shutdown Handler
    const shutdown = async () => {
      logger.info('🛑 Shutting down gracefully...');

      try {
        // Stop market maker
        await marketMaker.stop();
        logger.info('✅ Market maker stopped.');

        // Shutdown price aggregator with metric persistence
        try {
          priceAggregator.shutdown();
          logger.info('✅ Price aggregator shut down and metrics persisted.');
        } catch (error) {
          logger.warn('Warning during price aggregator shutdown', {
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }

        // Stop rug-pull monitoring
        if (cfg.RUG_PULL_DETECTION_ENABLED) {
          rugPullDetector.stopAllMonitoring();
          logger.info('✅ Rug-pull monitoring stopped.');
        }

        // Stop withdrawal interval
        if ((global as any).withdrawalInterval) {
          clearInterval((global as any).withdrawalInterval);
        }

        // Emergency withdrawal if enabled (skip in paper trading mode)
        if (cfg.AUTO_WITHDRAW_ENABLED && !cfg.PAPER_TRADING_ENABLED) {
          logger.info('💸 Performing final withdrawal...');
          const tokenMint = new PublicKey(cfg.BASE_MINT);
          await walletManager.emergencyWithdraw(tokenMint);
          logger.info('✅ Final withdrawal completed.');
        }

        // Close connections
        await rpcManager.stop();
        await stateManager.close();

        logger.info('✅ Shutdown complete. Goodbye!');
        process.exit(0);
      } catch (error) {
        logger.error('Error during shutdown', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        process.exit(1);
      }
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Log startup success
    logger.info('');
    logger.info('═══════════════════════════════════════════════════════');
    logger.info('🎉 Solana Market Maker Bot is fully operational!');
    logger.info('═══════════════════════════════════════════════════════');
    logger.info(`🎮 Trading Mode: ${cfg.PAPER_TRADING_ENABLED ? '📊 PAPER TRADING' : '💰 REAL TRADING'}`);
    logger.info(`📊 Trading Pair: ${cfg.BASE_MINT} / ${cfg.QUOTE_MINT}`);
    logger.info(`👛 Active Wallets: ${walletManager.getWalletCount()}`);
    logger.info(`🛡️  MEV Protection: ${cfg.MEV_PROTECTION_ENABLED ? 'ENABLED' : 'DISABLED'}`);
    logger.info(`🚨 Rug-Pull Detection: ${cfg.RUG_PULL_DETECTION_ENABLED ? 'ENABLED' : 'DISABLED'}`);
    logger.info(`⚡ Circuit Breaker: ${cfg.CIRCUIT_BREAKER_ENABLED ? 'ENABLED' : 'DISABLED'}`);
    logger.info(`🎯 Strategy Manager: ${cfg.ENABLE_STRATEGIES ? 'ENABLED' : 'DISABLED'}`);
    logger.info(`💰 Auto-Funding: ${cfg.AUTO_FUND_ENABLED ? 'ENABLED' : 'DISABLED'}`);
    logger.info(`💸 Auto-Withdrawal: ${cfg.AUTO_WITHDRAW_ENABLED ? 'ENABLED' : 'DISABLED'}`);
    if (cfg.PAPER_TRADING_ENABLED) {
      logger.info('');
      logger.info('⚠️  PAPER TRADING MODE - NO REAL FUNDS USED');
      logger.info(`📈 Initial Base: ${cfg.PAPER_TRADING_INITIAL_BASE}`);
      logger.info(`💵 Initial Quote: ${cfg.PAPER_TRADING_INITIAL_QUOTE}`);
    }
    logger.info('═══════════════════════════════════════════════════════');
    logger.info('');

  } catch (error) {
    logger.error('❌ Fatal error during application startup.', {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  }
}

// Start the bot
main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
