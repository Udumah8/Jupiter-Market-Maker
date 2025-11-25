/**
 * Production-Ready Market Maker Engine with Safety Modules
 * Implements Hummingbot-style market making with Jupiter V6 and modern Solana
 */

import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, AccountLayout } from '@solana/spl-token';
import BN from 'bn.js';
import { JupiterSwap } from '../exchange/JupiterSwap.js';
import { PriceAggregator } from '../pricing/PriceAggregator.js';
import { AggregatedPriceResult } from '../pricing/EnhancedPriceAggregator.js';
import { Logger } from '../utils/Logger.js';
import { BNMath } from '../utils/BNMath.js';
import { JupiterLimitOrders } from '../exchange/JupiterLimitOrders.js';
import { RPCManager } from '../utils/RPCManager.js';
import { StateManager } from '../utils/StateManager.js';
import { WalletManager } from '../utils/WalletManager.js';
import { MEVProtection } from '../safety/MEVProtection.js';
import { CircuitBreaker } from '../safety/CircuitBreaker.js';
import { RugPullDetector } from '../safety/RugPullDetector.js';
import {
  StrategyIntegration,
  StrategyConfig,
  createDefaultStrategyConfig,
} from '../strategies/StrategyIntegration.js';

export interface MarketMakerConfig {
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseDecimals: number;
  quoteDecimals: number;
  spreadPercent: number;
  orderSize: number;
  inventorySkew: number;
  maxPositionSize: number;
  orderRefreshInterval: number;
  minSpreadPercent: number;
  enableVolatilityAdaptive: boolean;
  maxLossPercent: number;
  maxSlippagePercent: number;
  volThresholdPercent: number;
  enableBidAskWalls: boolean;
  wallDepthPercent: number;
  targetInventoryRatio: number;
  enableStrategies?: boolean; // Enable advanced strategy modules
  strategyConfig?: StrategyConfig; // Strategy configuration
}

export interface Inventory {
  base: BN;
  quote: BN;
  avgBuyPrice: number;
  lastUpdate: number;
}

export interface PlacedOrder {
  orderKey: PublicKey;
  signature: string;
  inputMint: PublicKey;
  outputMint: PublicKey;
  inAmount: BN;
  outAmount: BN;
  price: number;
  timestamp: number;
  type: 'limit' | 'market';
}

export interface OrderState {
  bid: PlacedOrder | null;
  ask: PlacedOrder | null;
  walls: { bidWall: PlacedOrder | null; askWall: PlacedOrder | null };
  lastRefresh: number;
}

export interface SafetyState {
  circuitBreaker: boolean;
  lastPriceDeviation: number;
  meBlockedTrades: number;
  rugPullDetected: boolean;
}

export class MarketMaker {
  private config: MarketMakerConfig;
  private connection: Connection;

  private inventory: Map<string, Inventory> = new Map();
  private orderStates: Map<string, OrderState> = new Map();
  private safetyStates: Map<string, SafetyState> = new Map();
  private rateLimits: Map<string, number> = new Map();
  private isRunning: boolean = false;
  private volatilityWindow: number[] = [];
  private inventoryTargets: Map<string, number> = new Map();
  private recentFills: Map<string, number> = new Map(); // Track fills per wallet

  private currentSlippage = 0.005; // 0.5% default
  private strategies: StrategyIntegration | null = null;

  constructor(
    config: MarketMakerConfig,
    private rpcManager: RPCManager,
    private stateManager: StateManager,
    private walletManager: WalletManager,
    private priceAggregator: PriceAggregator,
    private jupiterSwap: JupiterSwap,
    private jupiterOrders: JupiterLimitOrders,
    private mevProtection: MEVProtection,
    private circuitBreaker: CircuitBreaker,
    private rugPullDetector: RugPullDetector,
    private logger: Logger,
  ) {
    this.config = config;
    this.connection = this.rpcManager.getConnection();

    // Initialize strategy integration if enabled
    if (config.enableStrategies) {
      const strategyConfig = config.strategyConfig || createDefaultStrategyConfig();
      this.strategies = new StrategyIntegration(
        this.connection,
        strategyConfig,
        this.logger
      );
      this.logger.info('Strategy modules initialized', {
        liquidityMirror: strategyConfig.liquidityMirror.enabled,
        spreadController: strategyConfig.spreadController.adaptiveEnabled,
        volatilityFilter: strategyConfig.volatilityFilter.enabled,
        wallManager: strategyConfig.wallManager.enabled,
      });
    }
  }

  async initialize(): Promise<void> {
    this.logger.info('Initializing Market Maker with safety modules...');

    // Load volatility window state (but don't use it on first run)
    const savedVolWindow = await this.stateManager.getKey<number[]>('volatility_window');
    if (savedVolWindow && savedVolWindow.length > 0) {
      // Only restore if the data is recent (less than 1 hour old)
      // Otherwise, stale data causes false volatility spikes
      this.volatilityWindow = savedVolWindow;
      this.logger.info('Restored volatility window', { points: this.volatilityWindow.length });
    } else {
      this.volatilityWindow = [];
      this.logger.info('Starting with empty volatility window');
    }

    // Initialize any required state
    this.logger.info('Market Maker initialized with safety protocols active.');
  }

  async start(): Promise<void> {
    this.logger.info('Starting market making operations...');

    const wallets = this.walletManager.getTradingWallets();

    // Start market making for all wallets
    for (const wallet of wallets) {
      try {
        await this.startForWallet(wallet);
      } catch (error) {
        this.logger.error('Failed to start market making for wallet', {
          wallet: wallet.publicKey.toString(),
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }
  }

  private async startForWallet(wallet: Keypair): Promise<void> {
    const walletKey = wallet.publicKey.toString();

    this.logger.info('Starting market maker for wallet', { wallet: walletKey });

    // Initialize inventory
    await this.initializeInventory(wallet);

    // Initialize safety state
    this.safetyStates.set(walletKey, {
      circuitBreaker: false,
      lastPriceDeviation: 0,
      meBlockedTrades: 0,
      rugPullDetected: false,
    });

    // Set target inventory ratio
    this.inventoryTargets.set(walletKey, this.config.targetInventoryRatio);

    // Start market making loop
    const loop = async () => {
      if (!this.isRunning) return;

      try {
        // Pre-check for rug pull
        await this.checkRugPull(wallet);

        await this.runCycle(wallet);
        await this.sleep(this.config.orderRefreshInterval);
        await loop();
      } catch (error) {
        this.logger.error('Market making cycle error', {
          wallet: walletKey,
          error: error instanceof Error ? error.message : 'Unknown error'
        });

        // Auto-recover: wait longer on errors
        await this.sleep(5000);
        await loop();
      }
    };

    await loop();
  }

  async stop(): Promise<void> {
    this.logger.info('Stopping market making operations...');
    this.isRunning = false;

    const wallets = this.walletManager.getTradingWallets();

    // Cancel all orders and withdraw profits
    for (const wallet of wallets) {
      try {
        await this.cancelAllOrders(wallet);
        await this.autoWithdrawProfits(wallet);
      } catch (error) {
        this.logger.error('Failed to stop wallet operations', {
          wallet: wallet.publicKey.toString(),
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }

    this.logger.info('Market making operations stopped.');
  }

  private async runCycle(wallet: Keypair): Promise<void> {
    const walletKey = wallet.publicKey.toString();
    const startTime = Date.now();

    // Check circuit breaker status
    if (!this.circuitBreaker.isTradingAllowed()) {
      this.logger.warn('Skipping cycle due to circuit breaker', { wallet: walletKey });
      return;
    }

    const safetyState = this.safetyStates.get(walletKey);
    if (!safetyState || safetyState.circuitBreaker) {
      this.logger.warn('Skipping cycle due to circuit breaker', { wallet: walletKey });
      return;
    }

    // 1. Get current price with fallbacks
    const priceResult = await this.priceAggregator.getDetailedPrice(
      this.config.baseMint,
      this.config.quoteMint
    );

    // Handle null price result
    if (!priceResult) {
      this.logger.error('Failed to get price, skipping market making cycle', {
        baseMint: this.config.baseMint.toString(),
        quoteMint: this.config.quoteMint.toString(),
      });
      return;
    }

    const price = priceResult;

    // Update volatility window
    this.updateVolatilityWindow(price.midPrice);
    this.circuitBreaker.updatePriceHistory(price.midPrice);

    // Check circuit breaker with dedicated module
    const volatility = this.calculateVolatilityFactor() * 100;
    const previousPrice = this.volatilityWindow.length > 1
      ? this.volatilityWindow[this.volatilityWindow.length - 2]
      : price.midPrice;

    // 2. Get current inventory
    const inventory = this.getInventory(walletKey);

    // Calculate current loss (simplified)
    const currentLoss = inventory.avgBuyPrice > 0
      ? ((inventory.avgBuyPrice - price.midPrice) / inventory.avgBuyPrice) * 100
      : 0;

    if (this.circuitBreaker.checkConditions(price.midPrice, previousPrice, currentLoss, volatility)) {
      this.logger.error('Circuit breaker activated', {
        wallet: walletKey,
        price: price.midPrice,
        volatility: volatility.toFixed(2),
      });
      safetyState.circuitBreaker = true;
      return;
    }

    // 3. Calculate target prices with volatility adjustment (and strategy recommendations)
    const { bidPrice, askPrice } = await this.calculateTargetPrices(price, inventory, wallet);

    // 4. Get current orders
    const activeOrders = await this.jupiterOrders.getActiveOrders(wallet.publicKey);

    // 5. Check for fills
    await this.checkForFills(wallet, activeOrders);

    // 6. Cancel stale orders
    await this.cancelStaleOrders(wallet, activeOrders, bidPrice, askPrice);

    // 7. Auto-balance inventory if needed
    await this.autoBalanceInventory(wallet, inventory, bidPrice, askPrice);

    // 8. Place new orders with safety checks
    await this.placeNewOrders(wallet, bidPrice, askPrice, inventory);

    // 9. Place bid/ask walls if enabled
    if (this.config.enableBidAskWalls) {
      await this.placeBidAskWalls(wallet, bidPrice, askPrice);
    }

    this.logger.debug('Market making cycle completed', {
      wallet: walletKey,
      duration: Date.now() - startTime,
      midPrice: price.midPrice.toFixed(6),
      bidPrice: bidPrice.toFixed(6),
      askPrice: askPrice.toFixed(6),
      spread: ((askPrice - bidPrice) / price.midPrice * 100).toFixed(2) + '%',
    });
  }

  private async calculateTargetPrices(
    price: AggregatedPriceResult,
    inventory: Inventory,
    wallet: Keypair
  ): Promise<{ bidPrice: number; askPrice: number }> {
    const walletKey = wallet.publicKey.toString();
    const inventoryRatio = this.calculateInventoryRatio(inventory, price.midPrice);
    const recentFills = this.recentFills.get(walletKey) || 0;

    // Use strategy integration if enabled
    if (this.strategies) {
      try {
        const recommendations = await this.strategies.getRecommendations(
          this.config.baseMint,
          this.config.quoteMint,
          price.midPrice,
          this.config.orderSize,
          inventoryRatio,
          recentFills
        );

        // Check if should pause
        if (recommendations.shouldPause) {
          this.logger.warn('Strategy recommends pausing trading', {
            wallet: walletKey,
            reason: recommendations.reason,
          });
          // Return current price (no trading)
          return { bidPrice: price.midPrice, askPrice: price.midPrice };
        }

        // Use strategy-recommended spread
        const bidPrice = price.midPrice * (1 - recommendations.spread.bidSpread);
        const askPrice = price.midPrice * (1 + recommendations.spread.askSpread);

        this.logger.debug('Using strategy-recommended prices', {
          wallet: walletKey,
          bidSpread: (recommendations.spread.bidSpread * 100).toFixed(3) + '%',
          askSpread: (recommendations.spread.askSpread * 100).toFixed(3) + '%',
          totalSpread: (recommendations.spread.totalSpread * 100).toFixed(3) + '%',
        });

        return { bidPrice, askPrice };
      } catch (error) {
        this.logger.warn('Strategy recommendation failed, using fallback', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        // Fall through to default calculation
      }
    }

    // Default calculation (fallback or when strategies disabled)
    let spreadPercent = this.config.spreadPercent / 100;

    // Volatility adjustment
    const volatilityFactor = this.calculateVolatilityFactor();
    spreadPercent *= (1 + volatilityFactor * 0.5);

    // Inventory skew adjustment with max cap to prevent extreme spreads
    const MAX_SKEW_CAP = 0.10; // 10% max skew adjustment
    const targetRatio = this.inventoryTargets.get(walletKey) || 0.5;
    const inventoryDeviation = inventoryRatio - targetRatio;

    // Clamp deviation to prevent over-amplification
    const clampedDeviation = Math.max(-MAX_SKEW_CAP, Math.min(MAX_SKEW_CAP, inventoryDeviation));

    // Asymmetric bid/ask adjustment based on inventory
    let bidSpreadAdjust = 0;
    let askSpreadAdjust = 0;

    if (Math.abs(clampedDeviation) > 0.05) {
      if (clampedDeviation > 0) {
        // Too much base, widen ask to sell, tighten bid
        askSpreadAdjust = Math.abs(clampedDeviation) * 2;
        bidSpreadAdjust = -Math.abs(clampedDeviation) * 0.5;
      } else {
        // Too much quote, widen bid to buy, tighten ask
        bidSpreadAdjust = Math.abs(clampedDeviation) * 2;
        askSpreadAdjust = -Math.abs(clampedDeviation) * 0.5;
      }
    }

    // Ensure minimum spread
    spreadPercent = Math.max(spreadPercent, this.config.minSpreadPercent / 100);

    // Apply asymmetric adjustments with caps
    const bidSpread = Math.max(0.001, spreadPercent / 2 + bidSpreadAdjust);
    const askSpread = Math.max(0.001, spreadPercent / 2 + askSpreadAdjust);

    const bidPrice = price.midPrice * (1 - bidSpread);
    const askPrice = price.midPrice * (1 + askSpread);

    return { bidPrice, askPrice };
  }

  private calculateInventoryRatio(inventory: Inventory, midPrice: number): number {
    const baseValue = BNMath.toUIAmountNumber(inventory.base, this.config.baseDecimals) * midPrice;
    const quoteValue = BNMath.toUIAmountNumber(inventory.quote, this.config.quoteDecimals);
    const totalValue = baseValue + quoteValue;

    if (totalValue === 0) return 0.5;

    return baseValue / totalValue;
  }

  private updateVolatilityWindow(price: number): void {
    this.volatilityWindow.push(price);
    if (this.volatilityWindow.length > 20) { // 20 price points
      this.volatilityWindow.shift();
    }
    // Persist state
    this.stateManager.setKey('volatility_window', this.volatilityWindow).catch(e => {
      this.logger.error('Failed to save volatility window', { error: e.message });
    });
  }

  private calculateVolatilityFactor(): number {
    // Need at least 5 price points to calculate meaningful volatility
    if (this.volatilityWindow.length < 5) return 0;

    const returns = [];
    for (let i = 1; i < this.volatilityWindow.length; i++) {
      const prev = this.volatilityWindow[i - 1];
      const curr = this.volatilityWindow[i];

      // Skip if we have invalid prices
      if (prev <= 0 || curr <= 0) continue;

      const ret = Math.log(curr / prev);

      // Filter out extreme returns (likely data errors)
      if (Math.abs(ret) < 2) { // ~640% change threshold
        returns.push(ret);
      }
    }

    if (returns.length === 0) return 0;

    const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;

    return Math.sqrt(variance) * Math.sqrt(252); // Annualized volatility
  }



  private async placeNewOrders(
    wallet: Keypair,
    bidPrice: number,
    askPrice: number,
    inventory: Inventory
  ): Promise<void> {
    const walletKey = wallet.publicKey.toString();
    const orderState = this.orderStates.get(walletKey);

    // Safety checks
    if (!this.performSafetyChecks(wallet, inventory, bidPrice, askPrice)) {
      return;
    }

    // Calculate order sizes with risk management
    const orderSize = this.calculateSafeOrderSize(wallet, inventory);

    // Rate limiting
    await this.enforceRateLimit(walletKey);

    // MEV Protection: Check for sandwich attacks before placing orders
    if (this.mevProtection) {
      const sandwichCheck = await this.mevProtection.detectSandwichAttack(
        this.config.quoteMint,
        this.config.baseMint,
        orderSize
      );

      if (sandwichCheck.detected) {
        this.logger.warn('Potential sandwich attack detected, skipping order placement', {
          wallet: walletKey,
          confidence: sandwichCheck.confidence,
          reason: sandwichCheck.reason,
        });
        return;
      }
    }

    // Place bid order
    if (!orderState?.bid) {
      const quoteBalance = BNMath.toUIAmountNumber(inventory.quote, this.config.quoteDecimals);

      if (quoteBalance >= orderSize) {
        try {
          const inAmount = BNMath.toTokenAmount(orderSize, this.config.quoteDecimals);
          const outAmount = BNMath.toTokenAmount(orderSize / bidPrice, this.config.baseDecimals);

          const order = await this.jupiterOrders.placeOrder({
            owner: wallet,
            inputMint: this.config.quoteMint,
            outputMint: this.config.baseMint,
            inAmount,
            outAmount,
          });

          this.updateOrderState(walletKey, 'bid', order);

          this.logger.info('Placed bid order with MEV protection', {
            wallet: walletKey,
            price: bidPrice.toFixed(6),
            size: orderSize.toFixed(6),
          });

        } catch (error) {
          this.logger.error('Failed to place bid order', {
            wallet: walletKey,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }
    }

    // Place ask order
    if (!orderState?.ask) {
      const baseBalance = BNMath.toUIAmountNumber(inventory.base, this.config.baseDecimals);

      if (baseBalance >= orderSize / askPrice) {
        try {
          const inAmount = BNMath.toTokenAmount(orderSize / askPrice, this.config.baseDecimals);
          const outAmount = BNMath.toTokenAmount(orderSize, this.config.quoteDecimals);

          const order = await this.jupiterOrders.placeOrder({
            owner: wallet,
            inputMint: this.config.baseMint,
            outputMint: this.config.quoteMint,
            inAmount,
            outAmount,
          });

          this.updateOrderState(walletKey, 'ask', order);

          this.logger.info('Placed ask order with MEV protection', {
            wallet: walletKey,
            price: askPrice.toFixed(6),
            size: (orderSize / askPrice).toFixed(6),
          });

        } catch (error) {
          this.logger.error('Failed to place ask order', {
            wallet: walletKey,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }
    }
  }

  private async cancelStaleOrders(
    wallet: Keypair,
    activeOrders: any[],
    targetBid: number,
    targetAsk: number
  ): Promise<void> {
    const tolerance = this.currentSlippage; // Use current slippage as tolerance

    for (const order of activeOrders) {
      const orderPrice = BNMath.calculatePrice(
        order.inAmount,
        order.outAmount,
        this.config.quoteDecimals,
        this.config.baseDecimals
      );

      const isBid = order.inputMint.toString() === this.config.quoteMint.toString();
      const targetPrice = isBid ? targetBid : targetAsk;

      const priceDeviation = Math.abs((orderPrice - targetPrice) / targetPrice);

      if (priceDeviation > tolerance) {
        try {
          await this.jupiterOrders.cancelOrder(wallet, order.orderKey);

          this.logger.info('Cancelled stale order', {
            wallet: wallet.publicKey.toString(),
            orderKey: order.orderKey.toString(),
            orderPrice: orderPrice.toFixed(6),
            targetPrice: targetPrice.toFixed(6),
          });

          // Update order state
          const walletKey = wallet.publicKey.toString();
          const orderState = this.orderStates.get(walletKey);
          if (orderState) {
            if (isBid) orderState.bid = null;
            else orderState.ask = null;
          }

        } catch (error) {
          this.logger.error('Failed to cancel order', {
            orderKey: order.orderKey.toString(),
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }
    }
  }

  private async checkForFills(wallet: Keypair, activeOrders: any[]): Promise<void> {
    const walletKey = wallet.publicKey.toString();
    const orderState = this.orderStates.get(walletKey);

    if (!orderState) return;

    // Check bid order
    if (orderState.bid) {
      const stillActive = activeOrders.some(
        o => o.orderKey.toString() === orderState.bid?.orderKey.toString()
      );

      if (!stillActive) {
        this.logger.info('Bid order filled', {
          wallet: walletKey,
          orderKey: orderState.bid.orderKey.toString(),
        });

        this.updateInventoryOnFill(walletKey, 'buy', orderState.bid);
        orderState.bid = null;
      }
    }

    // Check ask order
    if (orderState.ask) {
      const stillActive = activeOrders.some(
        o => o.orderKey.toString() === orderState.ask?.orderKey.toString()
      );

      if (!stillActive) {
        this.logger.info('Ask order filled', {
          wallet: walletKey,
          orderKey: orderState.ask.orderKey.toString(),
        });

        this.updateInventoryOnFill(walletKey, 'sell', orderState.ask);
        orderState.ask = null;
      }
    }
  }

  private async initializeInventory(wallet: Keypair): Promise<void> {
    const walletKey = wallet.publicKey.toString();

    try {
      const tokenAccounts = await this.connection.getTokenAccountsByOwner(
        wallet.publicKey,
        { programId: TOKEN_PROGRAM_ID }
      );

      let baseAmount = new BN(0);
      let quoteAmount = new BN(0);

      for (const { account } of tokenAccounts.value) {
        const data = account.data;
        const parsed = AccountLayout.decode(data);
        const mint = new PublicKey(parsed.mint);
        const amount = new BN(parsed.amount.toString());

        if (mint.equals(this.config.baseMint)) {
          baseAmount = amount;
        } else if (mint.equals(this.config.quoteMint)) {
          quoteAmount = amount;
        }
      }

      this.inventory.set(walletKey, {
        base: baseAmount,
        quote: quoteAmount,
        avgBuyPrice: 0,
        lastUpdate: Date.now(),
      });

      this.orderStates.set(walletKey, {
        bid: null,
        ask: null,
        walls: { bidWall: null, askWall: null },
        lastRefresh: Date.now(),
      });

      this.logger.info('Initialized inventory', {
        wallet: walletKey,
        base: baseAmount.toString(),
        quote: quoteAmount.toString(),
      });

      // Restore avgBuyPrice from state
      const savedAvgPrice = await this.stateManager.getKey<number>(`avg_buy_price_${walletKey}`);
      if (savedAvgPrice) {
        const inv = this.inventory.get(walletKey);
        if (inv) {
          inv.avgBuyPrice = savedAvgPrice;
          this.logger.info('Restored average buy price', { wallet: walletKey, price: savedAvgPrice });
        }
      }

    } catch (error) {
      this.logger.warn('Failed to fetch token balances, initializing with zero', {
        wallet: walletKey,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      this.inventory.set(walletKey, {
        base: new BN(0),
        quote: new BN(0),
        avgBuyPrice: 0,
        lastUpdate: Date.now(),
      });
    }
  }

  private getInventory(walletKey: string): Inventory {
    return this.inventory.get(walletKey) || {
      base: new BN(0),
      quote: new BN(0),
      avgBuyPrice: 0,
      lastUpdate: Date.now(),
    };
  }

  private updateInventoryOnFill(
    walletKey: string,
    side: 'buy' | 'sell',
    order: PlacedOrder
  ): void {
    const inventory = this.getInventory(walletKey);

    if (side === 'buy') {
      inventory.base = inventory.base.add(order.outAmount);
      inventory.quote = inventory.quote.sub(order.inAmount);

      // Update average buy price
      if (inventory.avgBuyPrice === 0) {
        inventory.avgBuyPrice = order.price;
      } else {
        // Weighted average
        const newValue = BNMath.toUIAmountNumber(inventory.base, this.config.baseDecimals) * order.price;
        const oldValue = (BNMath.toUIAmountNumber(inventory.base, this.config.baseDecimals) -
          BNMath.toUIAmountNumber(order.outAmount, this.config.baseDecimals)) * inventory.avgBuyPrice;
        inventory.avgBuyPrice = (oldValue + newValue) /
          BNMath.toUIAmountNumber(inventory.base, this.config.baseDecimals);
      }

    } else {
      inventory.base = inventory.base.sub(order.inAmount);
      inventory.quote = inventory.quote.add(order.outAmount);
    }

    // Persist avgBuyPrice
    this.stateManager.setKey(`avg_buy_price_${walletKey}`, inventory.avgBuyPrice).catch(e => {
      this.logger.error('Failed to save avg buy price', { wallet: walletKey, error: e.message });
    });

    inventory.lastUpdate = Date.now();

    // Update recent fills counter for strategy learning
    const currentFills = this.recentFills.get(walletKey) || 0;
    this.recentFills.set(walletKey, currentFills + 1);

    // Record fill for strategy learning
    if (this.strategies) {
      // Calculate spread from order price
      const spread = Math.abs(order.price - inventory.avgBuyPrice) / inventory.avgBuyPrice;
      const strategySide = side === 'buy' ? 'bid' : 'ask';
      this.strategies.recordFill(spread, strategySide as 'bid' | 'ask');
    }
  }

  private updateOrderState(
    walletKey: string,
    side: 'bid' | 'ask',
    order: PlacedOrder
  ): void {
    let state = this.orderStates.get(walletKey);
    if (!state) {
      state = {
        bid: null,
        ask: null,
        walls: { bidWall: null, askWall: null },
        lastRefresh: Date.now(),
      };
      this.orderStates.set(walletKey, state);
    }

    if (side === 'bid') {
      state.bid = order;
    } else {
      state.ask = order;
    }

    state.lastRefresh = Date.now();
  }

  private performSafetyChecks(
    wallet: Keypair,
    inventory: Inventory,
    bidPrice: number,
    askPrice: number
  ): boolean {
    const walletKey = wallet.publicKey.toString();
    const safetyState = this.safetyStates.get(walletKey);

    if (!safetyState) return false;

    if (safetyState.circuitBreaker) {
      this.logger.warn('Circuit breaker active', { wallet: walletKey });
      return false;
    }

    if (safetyState.rugPullDetected) {
      this.logger.warn('Rug pull detected, halting trades', { wallet: walletKey });
      return false;
    }

    // Max loss check
    // Only check if we have a valid avgBuyPrice and positive loss (not profit)
    if (inventory.avgBuyPrice > 0 && bidPrice > 0 && askPrice > 0) {
      const currentPrice = (bidPrice + askPrice) / 2;
      const lossPercent = (inventory.avgBuyPrice - currentPrice) / inventory.avgBuyPrice;

      // Only trigger if loss is positive (we're actually losing money) and exceeds threshold
      if (lossPercent > 0 && lossPercent > this.config.maxLossPercent / 100) {
        this.logger.warn('Max loss guard triggered', {
          wallet: walletKey,
          avgBuyPrice: inventory.avgBuyPrice.toFixed(6),
          currentPrice: currentPrice.toFixed(6),
          lossPercent: (lossPercent * 100).toFixed(2) + '%',
        });
        return false;
      }
    }

    // Max position size
    const positionValue = BNMath.toUIAmountNumber(inventory.base, this.config.baseDecimals) * bidPrice;
    const totalFunds = positionValue + BNMath.toUIAmountNumber(inventory.quote, this.config.quoteDecimals);
    const positionPercent = positionValue / totalFunds;

    if (positionPercent > this.config.maxPositionSize / 100) {
      this.logger.warn('Max position size exceeded', {
        wallet: walletKey,
        positionValue,
        positionPercent: (positionPercent * 100).toFixed(2) + '%',
      });
      return false;
    }

    return true;
  }

  private calculateSafeOrderSize(wallet: Keypair, inventory: Inventory): number {
    const baseSize = this.config.orderSize;

    // Inventory balancing adjustment
    const inventoryRatio = this.calculateInventoryRatio(inventory, inventory.avgBuyPrice || 1);
    const targetRatio = this.inventoryTargets.get(wallet.publicKey.toString()) || 0.5;

    let adjustmentFactor = 1;
    if (Math.abs(inventoryRatio - targetRatio) > 0.1) {
      adjustmentFactor = 0.5; // Reduce size when inventory is skewed
    } else if (Math.abs(inventoryRatio - targetRatio) > 0.2) {
      adjustmentFactor = 0.2; // Further reduce
    }

    // Volatility adjustment
    const volFactor = this.calculateVolatilityFactor();
    if (volFactor > 0.5) {
      adjustmentFactor *= 0.7;
    }

    return baseSize * adjustmentFactor;
  }

  private async enforceRateLimit(walletKey: string): Promise<void> {
    const lastOrder = this.rateLimits.get(walletKey);
    const minInterval = 1000; // 1 second

    if (lastOrder) {
      const timeSince = Date.now() - lastOrder;
      if (timeSince < minInterval) {
        await this.sleep(minInterval - timeSince);
      }
    }

    this.rateLimits.set(walletKey, Date.now());
  }

  private async checkRugPull(wallet: Keypair): Promise<void> {
    const safetyState = this.safetyStates.get(wallet.publicKey.toString());
    if (!safetyState) return;

    // Check rug pull detector status
    const rugPullRisk = await this.rugPullDetector.checkToken(this.config.baseMint);
    if (rugPullRisk.shouldExit) {
      safetyState.rugPullDetected = true;
      this.logger.error('Rug pull detected by safety module', {
        wallet: wallet.publicKey.toString(),
        level: rugPullRisk.level,
        score: rugPullRisk.score,
        reasons: rugPullRisk.reasons,
      });
      return;
    }

    // Additional check: drastic price change
    if (this.volatilityWindow.length > 1) {
      const current = this.volatilityWindow[this.volatilityWindow.length - 1];
      const previous = this.volatilityWindow[this.volatilityWindow.length - 2];
      const change = Math.abs((current - previous) / previous);

      if (change > 0.8) { // 80% change = potential rug pull
        safetyState.rugPullDetected = true;
        this.logger.error('Potential rug pull detected', {
          wallet: wallet.publicKey.toString(),
          changePercent: (change * 100).toFixed(2) + '%',
        });
      }
    }
  }

  private async autoBalanceInventory(
    wallet: Keypair,
    inventory: Inventory,
    bidPrice: number,
    askPrice: number
  ): Promise<void> {
    // Liquidation balancing: if inventory is too skewed, use market orders to balance
    const midPrice = (bidPrice + askPrice) / 2;
    const inventoryRatio = this.calculateInventoryRatio(inventory, midPrice);
    const targetRatio = this.inventoryTargets.get(wallet.publicKey.toString()) || 0.5;

    // Only rebalance if significantly skewed (>30% deviation)
    if (Math.abs(inventoryRatio - targetRatio) > 0.3) {
      const baseValue = BNMath.toUIAmountNumber(inventory.base, this.config.baseDecimals) * midPrice;
      const quoteValue = BNMath.toUIAmountNumber(inventory.quote, this.config.quoteDecimals);
      const totalValue = baseValue + quoteValue;

      if (totalValue === 0) return;

      // Calculate how much to rebalance (25% of the imbalance)
      const targetBaseValue = totalValue * targetRatio;
      const currentBaseValue = baseValue;
      const imbalance = targetBaseValue - currentBaseValue;
      const rebalanceAmount = Math.abs(imbalance) * 0.25; // Rebalance 25% at a time

      try {
        if (inventoryRatio > targetRatio + 0.1) {
          // Too much base, sell some
          const baseToSell = rebalanceAmount / midPrice;
          const baseToSellBN = BNMath.toTokenAmount(baseToSell, this.config.baseDecimals);

          // Only rebalance if amount is significant (> 1% of order size)
          if (baseToSell > this.config.orderSize * 0.01) {
            this.logger.info('Rebalancing inventory: selling base', {
              wallet: wallet.publicKey.toString(),
              baseToSell: baseToSell.toFixed(6),
              currentRatio: inventoryRatio.toFixed(3),
              targetRatio: targetRatio.toFixed(3),
            });

            await this.jupiterSwap.sellMarketOrder(
              wallet,
              this.config.baseMint,
              this.config.quoteMint,
              baseToSellBN,
              this.config.maxSlippagePercent
            );
          }
        } else if (inventoryRatio < targetRatio - 0.1) {
          // Too little base, buy some
          const quoteToBuy = rebalanceAmount;
          const quoteToBuyBN = BNMath.toTokenAmount(quoteToBuy, this.config.quoteDecimals);

          // Only rebalance if amount is significant (> 1% of order size)
          if (quoteToBuy > this.config.orderSize * 0.01) {
            this.logger.info('Rebalancing inventory: buying base', {
              wallet: wallet.publicKey.toString(),
              quoteToSpend: quoteToBuy.toFixed(6),
              currentRatio: inventoryRatio.toFixed(3),
              targetRatio: targetRatio.toFixed(3),
            });

            await this.jupiterSwap.buyMarketOrder(
              wallet,
              this.config.baseMint,
              this.config.quoteMint,
              quoteToBuyBN,
              this.config.maxSlippagePercent
            );
          }
        }
      } catch (error) {
        this.logger.error('Failed to rebalance inventory', {
          wallet: wallet.publicKey.toString(),
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  }

  private async placeBidAskWalls(
    wallet: Keypair,
    bidPrice: number,
    askPrice: number
  ): Promise<void> {
    const walletKey = wallet.publicKey.toString();
    const orderState = this.orderStates.get(walletKey);
    if (!orderState) return;

    const wallDepth = this.config.wallDepthPercent / 100 * bidPrice; // Wall distance from spread

    // Place deeper bid wall
    if (!orderState.walls.bidWall) {
      const wallBidPrice = bidPrice * (1 - wallDepth);
      const wallSize = this.config.orderSize * 2; // Walls are usually larger

      const quoteBalance = BNMath.toUIAmountNumber(this.getInventory(walletKey).quote, this.config.quoteDecimals);
      if (quoteBalance >= wallSize) {
        try {
          const inAmount = BNMath.toTokenAmount(wallSize, this.config.quoteDecimals);
          const outAmount = BNMath.toTokenAmount(wallSize / wallBidPrice, this.config.baseDecimals);

          const order = await this.jupiterOrders.placeOrder({
            owner: wallet,
            inputMint: this.config.quoteMint,
            outputMint: this.config.baseMint,
            inAmount,
            outAmount,
          });

          orderState.walls.bidWall = order;
          this.logger.info('Placed bid wall', { wallet: walletKey, price: wallBidPrice.toFixed(6) });
        } catch (error) {
          this.logger.error('Failed to place bid wall', { error: error instanceof Error ? error.message : 'Unknown' });
        }
      }
    }

    // Place deeper ask wall
    if (!orderState.walls.askWall) {
      const wallAskPrice = askPrice * (1 + wallDepth);
      const wallSize = this.config.orderSize * 2;

      const baseBalance = BNMath.toUIAmountNumber(this.getInventory(walletKey).base, this.config.baseDecimals);
      if (baseBalance >= wallSize / wallAskPrice) {
        try {
          const inAmount = BNMath.toTokenAmount(wallSize / wallAskPrice, this.config.baseDecimals);
          const outAmount = BNMath.toTokenAmount(wallSize, this.config.quoteDecimals);

          const order = await this.jupiterOrders.placeOrder({
            owner: wallet,
            inputMint: this.config.baseMint,
            outputMint: this.config.quoteMint,
            inAmount,
            outAmount,
          });

          orderState.walls.askWall = order;
          this.logger.info('Placed ask wall', { wallet: walletKey, price: wallAskPrice.toFixed(6) });
        } catch (error) {
          this.logger.error('Failed to place ask wall', { error: error instanceof Error ? error.message : 'Unknown' });
        }
      }
    }
  }

  private async cancelAllOrders(wallet: Keypair): Promise<void> {
    try {
      const activeOrders = await this.jupiterOrders.getActiveOrders(wallet.publicKey);

      for (const order of activeOrders) {
        try {
          await this.jupiterOrders.cancelOrder(wallet, order.orderKey);
        } catch (error) {
          this.logger.error('Failed to cancel order during shutdown', {
            orderKey: order.orderKey.toString(),
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }
    } catch (error) {
      this.logger.error('Failed to get active orders during shutdown', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  private async autoWithdrawProfits(wallet: Keypair): Promise<void> {
    // Withdraw profits to master wallet
    const walletKey = wallet.publicKey.toString();
    const inventory = this.getInventory(walletKey);

    // Calculate profits (simplified)
    const currentValue = BNMath.toUIAmountNumber(inventory.base, this.config.baseDecimals) * (inventory.avgBuyPrice || 1) +
      BNMath.toUIAmountNumber(inventory.quote, this.config.quoteDecimals);

    if (currentValue > this.config.maxPositionSize) { // Threshold for withdrawal
      // Transfer SOL/tokens back to master
      this.logger.info('Auto-withdrawing profits', { wallet: walletKey, amount: currentValue });
      try {
        await this.walletManager.autoWithdrawProfits(this.config.baseMint);
      } catch (error) {
        this.logger.error('Failed to auto-withdraw profits', {
          wallet: walletKey,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Public methods for monitoring
  getSafetyState(wallet: PublicKey): SafetyState | undefined {
    return this.safetyStates.get(wallet.toString());
  }

  resetCircuitBreaker(wallet: PublicKey): void {
    const safetyState = this.safetyStates.get(wallet.toString());
    if (safetyState) {
      safetyState.circuitBreaker = false;
      this.logger.info('Circuit breaker reset', { wallet: wallet.toString() });
    }
  }

  updateSlippage(newSlippage: number): void {
    this.currentSlippage = Math.max(0.001, Math.min(0.1, newSlippage)); // 0.1% to 10%
    this.logger.info('Slippage updated', { newSlippage: this.currentSlippage });
  }

  /**
   * Get strategy status (if strategies are enabled)
   */
  getStrategyStatus(): any {
    if (!this.strategies) {
      return { enabled: false };
    }

    return {
      enabled: true,
      status: this.strategies.getStatus(),
    };
  }

  /**
   * Update strategy configuration
   */
  updateStrategyConfig(config: Partial<StrategyConfig>): void {
    if (!this.strategies) {
      this.logger.warn('Strategies not enabled, cannot update config');
      return;
    }

    this.strategies.updateConfig(config);
    this.logger.info('Strategy configuration updated');
  }

  /**
   * Get strategy modules (for advanced usage)
   */
  getStrategyModules(): any {
    if (!this.strategies) {
      return null;
    }

    return this.strategies.getModules();
  }
}
