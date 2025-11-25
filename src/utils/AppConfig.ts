
import dotenv from 'dotenv';
import Joi from 'joi';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { logger } from './Logger.js';

// Define the structure of the application configuration
export interface IAppConfig {
  // Environment
  NODE_ENV: 'development' | 'production' | 'test';
  LOG_LEVEL: 'debug' | 'info' | 'warn' | 'error';
  
  // Network
  RPC_URLS: string[];
  
  // Wallet Configuration
  MASTER_WALLET_PRIVATE_KEY: string;
  MASTER_WALLET_SEED?: string;
  WALLET_ENCRYPTION_KEY: string;
  NUMBER_OF_WALLETS: number;
  WALLETS_FILE_PATH: string;
  USE_EXISTING_WALLETS: boolean;
  
  // Trading Pair
  BASE_MINT: string;
  QUOTE_MINT: string;
  BASE_DECIMALS: number;
  QUOTE_DECIMALS: number;
  
  // Trading Configuration
  ORDER_REFRESH_TIME_SECONDS: number;
  SPREAD_BPS: number;
  INVENTORY_SKEW_BPS: number;
  BASE_TRADE_SIZE_QUOTE: number;
  MAX_POSITION_QUOTE: number;
  MIN_PROFIT_BPS: number;
  PRICE_TOLERANCE_BPS: number;
  
  // Auto-Funding
  AUTO_FUND_ENABLED: boolean;
  AUTO_FUND_THRESHOLD_SOL: number;
  FUNDING_AMOUNT_SOL: number;
  AUTO_FUND_THRESHOLD_TOKEN?: number;
  FUNDING_AMOUNT_TOKEN?: number;
  
  // Auto-Withdrawal
  AUTO_WITHDRAW_ENABLED: boolean;
  AUTO_WITHDRAW_THRESHOLD_SOL: number;
  MIN_BALANCE_TO_KEEP_SOL: number;
  
  // MEV Protection
  MEV_PROTECTION_ENABLED: boolean;
  BASE_PRIORITY_FEE: number;
  MAX_PRIORITY_FEE: number;
  ENABLE_TRANSACTION_SIMULATION: boolean;
  ENABLE_SANDWICH_DETECTION: boolean;
  COMPUTE_UNIT_LIMIT: number;
  
  // Rug-Pull Detection
  RUG_PULL_DETECTION_ENABLED: boolean;
  LP_MONITORING_ENABLED: boolean;
  SUPPLY_CHANGE_THRESHOLD_PERCENT: number;
  HOLDER_CONCENTRATION_THRESHOLD_PERCENT: number;
  RUG_PULL_CHECK_INTERVAL_MS: number;
  AUTO_EXIT_ON_RUG_PULL: boolean;
  
  // Circuit Breaker
  CIRCUIT_BREAKER_ENABLED: boolean;
  CIRCUIT_BREAKER_PRICE_DEVIATION_PERCENT: number;
  CIRCUIT_BREAKER_VOLATILITY_PERCENT: number;
  CIRCUIT_BREAKER_LOSS_PERCENT: number;
  CIRCUIT_BREAKER_CONSECUTIVE_FAILURES: number;
  CIRCUIT_BREAKER_COOLDOWN_MS: number;
  CIRCUIT_BREAKER_GRADUAL_RESUME_STEPS: number;
  
  // Risk Management
  MAX_SLIPPAGE_PERCENT: number;
  MAX_DAILY_LOSS_PERCENT: number;
  MAX_POSITION_SIZE_PERCENT: number;
  
  // Strategy Manager
  ENABLE_STRATEGIES: boolean;
  
  // Paper Trading
  PAPER_TRADING_ENABLED: boolean;
  PAPER_TRADING_INITIAL_BASE: number;
  PAPER_TRADING_INITIAL_QUOTE: number;
  PAPER_TRADING_FILL_PROBABILITY: number;
  PAPER_TRADING_FILL_DELAY_MS: number;
  PAPER_TRADING_SLIPPAGE_PERCENT: number;
  PAPER_TRADING_FEE_PERCENT: number;
  PAPER_TRADING_REALISTIC_FILLS: boolean;
  
  // Database
  DB_PATH: string;
  
  // API Keys
  BIRDEYE_API_KEY?: string;
  PYTH_HERMES_URL?: string;
  
  // Legacy support
  FUNDING_WALLET_PRIVATE_KEY?: string;
  TRADING_WALLET_PRIVATE_KEYS?: string[];
  CIRCUIT_BREAKER_VOLATILITY_BPS?: number;
}

export class AppConfig {
  private config: IAppConfig;

  constructor() {
    dotenv.config();
    this.config = this.loadAndValidate();
  }

  public load(): void {
    this.config = this.loadAndValidate();
    logger.info('Application configuration loaded and validated.');
  }

  public get(): IAppConfig {
    return this.config;
  }

  private loadAndValidate(): IAppConfig {
    const schema = Joi.object<IAppConfig>({
      // Environment
      NODE_ENV: Joi.string().valid('development', 'production', 'test').default('production'),
      LOG_LEVEL: Joi.string().valid('debug', 'info', 'warn', 'error').default('info'),
      
      // Network
      RPC_URLS: Joi.string().required().custom((value: string) => value.split(',').map(url => url.trim())),
      
      // Wallet Configuration
      MASTER_WALLET_PRIVATE_KEY: Joi.string().required(),
      MASTER_WALLET_SEED: Joi.string().optional(),
      WALLET_ENCRYPTION_KEY: Joi.string().length(32).required(),
      NUMBER_OF_WALLETS: Joi.number().min(1).max(100000).default(100),
      WALLETS_FILE_PATH: Joi.string().default('./wallets/encrypted-wallets.json'),
      USE_EXISTING_WALLETS: Joi.boolean().default(false),
      
      // Trading Pair
      BASE_MINT: Joi.string().required(),
      QUOTE_MINT: Joi.string().required(),
      BASE_DECIMALS: Joi.number().min(0).max(18).default(9),
      QUOTE_DECIMALS: Joi.number().min(0).max(18).default(6),
      
      // Trading Configuration
      ORDER_REFRESH_TIME_SECONDS: Joi.number().min(1).default(15),
      SPREAD_BPS: Joi.number().min(0).default(100),
      INVENTORY_SKEW_BPS: Joi.number().min(0).default(50),
      BASE_TRADE_SIZE_QUOTE: Joi.number().positive().default(10),
      MAX_POSITION_QUOTE: Joi.number().positive().default(1000),
      MIN_PROFIT_BPS: Joi.number().min(0).default(5),
      PRICE_TOLERANCE_BPS: Joi.number().min(0).default(20),
      
      // Auto-Funding
      AUTO_FUND_ENABLED: Joi.boolean().default(true),
      AUTO_FUND_THRESHOLD_SOL: Joi.number().min(0).default(0.05),
      FUNDING_AMOUNT_SOL: Joi.number().min(0).default(0.2),
      AUTO_FUND_THRESHOLD_TOKEN: Joi.number().min(0).optional().allow('', null),
      FUNDING_AMOUNT_TOKEN: Joi.number().min(0).optional().allow('', null),
      
      // Auto-Withdrawal
      AUTO_WITHDRAW_ENABLED: Joi.boolean().default(true),
      AUTO_WITHDRAW_THRESHOLD_SOL: Joi.number().min(0).default(0.5),
      MIN_BALANCE_TO_KEEP_SOL: Joi.number().min(0).default(0.05),
      
      // MEV Protection
      MEV_PROTECTION_ENABLED: Joi.boolean().default(true),
      BASE_PRIORITY_FEE: Joi.number().min(0).default(10000),
      MAX_PRIORITY_FEE: Joi.number().min(0).default(100000),
      ENABLE_TRANSACTION_SIMULATION: Joi.boolean().default(true),
      ENABLE_SANDWICH_DETECTION: Joi.boolean().default(true),
      COMPUTE_UNIT_LIMIT: Joi.number().min(0).default(200000),
      
      // Rug-Pull Detection
      RUG_PULL_DETECTION_ENABLED: Joi.boolean().default(true),
      LP_MONITORING_ENABLED: Joi.boolean().default(true),
      SUPPLY_CHANGE_THRESHOLD_PERCENT: Joi.number().min(0).default(20),
      HOLDER_CONCENTRATION_THRESHOLD_PERCENT: Joi.number().min(0).max(100).default(50),
      RUG_PULL_CHECK_INTERVAL_MS: Joi.number().min(1000).default(30000),
      AUTO_EXIT_ON_RUG_PULL: Joi.boolean().default(true),
      
      // Circuit Breaker
      CIRCUIT_BREAKER_ENABLED: Joi.boolean().default(true),
      CIRCUIT_BREAKER_PRICE_DEVIATION_PERCENT: Joi.number().min(0).default(50),
      CIRCUIT_BREAKER_VOLATILITY_PERCENT: Joi.number().min(0).default(100),
      CIRCUIT_BREAKER_LOSS_PERCENT: Joi.number().min(0).default(10),
      CIRCUIT_BREAKER_CONSECUTIVE_FAILURES: Joi.number().min(1).default(5),
      CIRCUIT_BREAKER_COOLDOWN_MS: Joi.number().min(0).default(300000),
      CIRCUIT_BREAKER_GRADUAL_RESUME_STEPS: Joi.number().min(1).default(5),
      
      // Risk Management
      MAX_SLIPPAGE_PERCENT: Joi.number().min(0).max(100).default(1.0),
      MAX_DAILY_LOSS_PERCENT: Joi.number().min(0).default(10),
      MAX_POSITION_SIZE_PERCENT: Joi.number().min(0).max(100).default(50),
      
      // Strategy Manager
      ENABLE_STRATEGIES: Joi.boolean().default(true),
      
      // Paper Trading
      PAPER_TRADING_ENABLED: Joi.boolean().default(false),
      PAPER_TRADING_INITIAL_BASE: Joi.number().min(0).default(1000),
      PAPER_TRADING_INITIAL_QUOTE: Joi.number().min(0).default(10000),
      PAPER_TRADING_FILL_PROBABILITY: Joi.number().min(0).max(1).default(0.8),
      PAPER_TRADING_FILL_DELAY_MS: Joi.number().min(0).default(2000),
      PAPER_TRADING_SLIPPAGE_PERCENT: Joi.number().min(0).max(100).default(0.1),
      PAPER_TRADING_FEE_PERCENT: Joi.number().min(0).max(100).default(0.3),
      PAPER_TRADING_REALISTIC_FILLS: Joi.boolean().default(true),
      
      // Database
      DB_PATH: Joi.string().default('./db/market-maker.sqlite'),
      
      // API Keys
      BIRDEYE_API_KEY: Joi.string().optional(),
      PYTH_HERMES_URL: Joi.string().default('https://hermes.pyth.network'),
      
      // Legacy support
      FUNDING_WALLET_PRIVATE_KEY: Joi.string().optional(),
      TRADING_WALLET_PRIVATE_KEYS: Joi.string().optional(),
      CIRCUIT_BREAKER_VOLATILITY_BPS: Joi.number().optional(),
    }).unknown(true);

    const { error, value } = schema.validate(process.env);

    if (error) {
      logger.error('Configuration validation error:', error);
      throw new Error(`Configuration validation failed: ${error.message}`);
    }
    
    // Legacy support - map old keys to new keys
    if (value.FUNDING_WALLET_PRIVATE_KEY && !value.MASTER_WALLET_PRIVATE_KEY) {
      value.MASTER_WALLET_PRIVATE_KEY = value.FUNDING_WALLET_PRIVATE_KEY;
    }
    
    if (value.CIRCUIT_BREAKER_VOLATILITY_BPS && !value.CIRCUIT_BREAKER_VOLATILITY_PERCENT) {
      value.CIRCUIT_BREAKER_VOLATILITY_PERCENT = value.CIRCUIT_BREAKER_VOLATILITY_BPS / 100;
    }
    
    // Validate master wallet private key
    try {
      Keypair.fromSecretKey(Buffer.from(bs58.decode(value.MASTER_WALLET_PRIVATE_KEY)));
    } catch(e) {
      throw new Error('Master wallet private key is invalid. Please check your .env file.');
    }
    
    // Validate encryption key length
    if (value.WALLET_ENCRYPTION_KEY.length !== 32) {
      throw new Error('WALLET_ENCRYPTION_KEY must be exactly 32 characters');
    }

    return value;
  }
}
