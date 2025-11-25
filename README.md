# Solana Market Maker Bot

A production-ready, CLI-based market maker bot for Solana meme coins with advanced safety features, MEV protection, and automated wallet management.

## 🎯 Features

### Core Functionality
- ✅ **HD Wallet Management**: Generate and manage 10,000+ wallets from a single seed
- ✅ **Auto-Funding**: Automatically fund trading wallets when balances are low
- ✅ **Auto-Withdrawal**: Automatically collect profits back to master wallet
- ✅ **Jupiter V6 Integration**: Market orders and limit orders via Jupiter
- ✅ **Multi-Source Pricing**: Aggregate prices from Jupiter, Pyth, Birdeye, and DexScreener

### Safety Features
- ✅ **MEV Protection**: Priority fee optimization and sandwich attack detection
- ✅ **Rug-Pull Detection**: Monitor LP tokens, supply changes, and holder concentration
- ✅ **Circuit Breaker**: Automatic trading halt on extreme price movements or losses
- ✅ **Position Limits**: Enforce maximum position sizes and daily loss limits
- ✅ **Transaction Simulation**: Pre-flight simulation before sending transactions

### Advanced Features
- ✅ **Dynamic Spread**: Adjust spread based on volatility and inventory
- ✅ **Inventory Balancing**: Automatically rebalance base/quote inventory
- ✅ **Multi-RPC Failover**: Automatic failover between multiple RPC endpoints
- ✅ **Persistent State**: SQLite database for order and state tracking
- ✅ **Structured Logging**: Comprehensive logging with Winston

### Strategy Modules (Optional)
- ✅ **Liquidity Mirroring**: Mirror order book depth from major DEXs
- ✅ **Spread Controller**: Dynamic spread optimization with adaptive learning
- ✅ **Volatility Filter**: Automatic risk adjustment based on market volatility
- ✅ **Wall Manager**: Bid/ask wall placement for market influence

### Enhanced Price Feed (v2.0+)
- ✅ **5-Tier Fallback Hierarchy**: Multi-source → Single source → Recent cache → Stale cache → Detailed error
- ✅ **Automatic Health Monitoring**: Real-time source health tracking with auto-recovery
- ✅ **Reliability Tracking**: Per-source success metrics and dynamic prioritization
- ✅ **Smart Retry Logic**: Exponential backoff with jitter and error-aware handling
- ✅ **Enhanced Price Sources**: Endpoint fallbacks for Jupiter, Pyth, Birdeye, and Dexscreener
- ✅ **Comprehensive Metrics**: Cache hit rate, tier usage, price consistency tracking
- ✅ **100% Backward Compatible**: Drop-in replacement for existing PriceAggregator

## 🚀 Quick Start

### Simple 2-Step Process

```bash
# Step 1: Build
npm run build

# Step 2: Run
npm start
```

**That's it!** See [START.md](START.md) for detailed instructions.

### First Time Setup

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env
nano .env

# Build and run
npm run build
npm start
```

### Prerequisites
- Node.js >= 18.0.0
- npm or yarn
- Solana wallet with SOL for funding

### Minimum Configuration

Edit `.env` with your settings:

```env
# Network (use devnet for testing)
RPC_URLS=https://api.devnet.solana.com

# Master Wallet
MASTER_WALLET_PRIVATE_KEY=your_private_key_here
WALLET_ENCRYPTION_KEY=your_32_character_encryption_key

# Wallet Generation
NUMBER_OF_WALLETS=10
WALLETS_FILE_PATH=./wallets/encrypted-wallets.json

# Trading Pair
BASE_MINT=So11111111111111111111111111111111111111112  # SOL
QUOTE_MINT=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v  # USDC

# Trading Parameters
BASE_TRADE_SIZE_QUOTE=10  # $10 per order
SPREAD_BPS=100  # 1% spread
MAX_POSITION_QUOTE=1000  # $1000 max position

# Safety Features (all enabled by default)
MEV_PROTECTION_ENABLED=true
RUG_PULL_DETECTION_ENABLED=true
CIRCUIT_BREAKER_ENABLED=true
AUTO_FUND_ENABLED=true
AUTO_WITHDRAW_ENABLED=true
```

## 📖 Documentation

- **[QUICK_START.md](QUICK_START.md)** - Fast setup guide
- **[TESTING_GUIDE.md](TESTING_GUIDE.md)** - Comprehensive testing procedures
- **[STRATEGY_MODULES.md](STRATEGY_MODULES.md)** - Advanced strategy modules guide
- **[PRICE_FEED_ENHANCEMENT_MIGRATION.md](docs/PRICE_FEED_ENHANCEMENT_MIGRATION.md)** - Enhanced price feed v2.0 migration guide
- **[FINAL_IMPLEMENTATION_SUMMARY.md](FINAL_IMPLEMENTATION_SUMMARY.md)** - Complete feature list
- **[CURRENT_STATUS_ASSESSMENT.md](CURRENT_STATUS_ASSESSMENT.md)** - Detailed status review

## 🔧 Configuration

### Trading Parameters

```env
ORDER_REFRESH_TIME_SECONDS=15    # How often to refresh orders
SPREAD_BPS=100                   # 100 basis points = 1%
INVENTORY_SKEW_BPS=50            # Inventory skew tolerance
BASE_TRADE_SIZE_QUOTE=10         # Order size in quote token
MAX_POSITION_QUOTE=1000          # Maximum position size
MIN_PROFIT_BPS=5                 # Minimum profit per trade
```

### Auto-Funding

```env
AUTO_FUND_ENABLED=true
AUTO_FUND_THRESHOLD_SOL=0.05     # Fund when balance < 0.05 SOL
FUNDING_AMOUNT_SOL=0.2           # Fund 0.2 SOL each time
```

### Auto-Withdrawal

```env
AUTO_WITHDRAW_ENABLED=true
AUTO_WITHDRAW_THRESHOLD_SOL=0.5  # Withdraw when balance > 0.5 SOL
MIN_BALANCE_TO_KEEP_SOL=0.05     # Keep minimum 0.05 SOL
```

### Safety Thresholds

```env
# Circuit Breaker
CIRCUIT_BREAKER_ENABLED=true
CIRCUIT_BREAKER_PRICE_DEVIATION_PERCENT=50
CIRCUIT_BREAKER_VOLATILITY_PERCENT=100
CIRCUIT_BREAKER_LOSS_PERCENT=10

# MEV Protection
MEV_PROTECTION_ENABLED=true
BASE_PRIORITY_FEE=10000
MAX_PRIORITY_FEE=100000
ENABLE_SANDWICH_DETECTION=true

# Rug-Pull Detection
RUG_PULL_DETECTION_ENABLED=true
SUPPLY_CHANGE_THRESHOLD_PERCENT=20
HOLDER_CONCENTRATION_THRESHOLD_PERCENT=50
```

## 🎯 How It Works

### 1. Wallet Management
- Generates HD wallets from master seed using BIP44 derivation
- Encrypts wallets with AES-256-GCM encryption
- Stores encrypted wallets in JSON file
- Automatically funds wallets when balances are low

### 2. Market Making
- Fetches prices from multiple sources (Jupiter, Pyth, Birdeye)
- Calculates bid/ask prices with dynamic spread
- Places limit orders on both sides of the market
- Cancels and refreshes orders based on price movement
- Tracks inventory and rebalances when needed

### 3. Safety Features
- **MEV Protection**: Detects sandwich attacks before placing orders
- **Circuit Breaker**: Halts trading on extreme conditions
- **Rug-Pull Detection**: Monitors token for suspicious activity
- **Position Limits**: Enforces maximum position sizes
- **Loss Guards**: Stops trading if losses exceed threshold

### 4. Auto-Management
- **Auto-Funding**: Distributes SOL/tokens to wallets automatically
- **Auto-Withdrawal**: Collects profits back to master wallet
- **Inventory Balancing**: Rebalances base/quote inventory
- **Graceful Shutdown**: Cancels orders and withdraws funds on exit

## 📊 Performance

### Scalability
- Supports 10,000+ wallets
- ~2-3 seconds per order placement
- ~10 wallets per batch operation
- Efficient memory usage (~100-200 MB)

### Resource Usage
- **Memory**: 100-200 MB
- **CPU**: 5-10% idle, 20-30% active
- **Network**: 1-5 MB/hour
- **Disk**: ~10 MB (logs + database)

## 🧪 Testing

### Test on Devnet First!

```bash
# 1. Configure for devnet
RPC_URLS=https://api.devnet.solana.com

# 2. Fund master wallet with devnet SOL
# Visit: https://faucet.solana.com/

# 3. Start with small amounts
NUMBER_OF_WALLETS=5
BASE_TRADE_SIZE_QUOTE=1

# 4. Run the bot
npm start

# 5. Monitor logs
tail -f logs/bot.log
```

See [TESTING_GUIDE.md](TESTING_GUIDE.md) for comprehensive testing procedures.

## 🔒 Security

### Best Practices
- ✅ Never commit `.env` file
- ✅ Backup master wallet private key securely
- ✅ Use strong encryption key (32 characters)
- ✅ Test on devnet before mainnet
- ✅ Start with small amounts
- ✅ Monitor closely for first 24 hours

### Encryption
- Wallets encrypted with AES-256-GCM
- Encryption key required to decrypt wallets
- Master seed never stored in plain text
- All sensitive data encrypted at rest

## 📈 Monitoring

### Logs
```bash
# Watch logs in real-time
tail -f logs/bot.log

# Search for errors
grep ERROR logs/bot.log

# Search for specific wallet
grep "wallet_address" logs/bot.log
```

### Database
```bash
# Install sqlite3
npm install -g sqlite3

# Inspect database
sqlite3 db/market-maker.sqlite

# View orders
SELECT * FROM orders LIMIT 10;
```

## 🛑 Stopping the Bot

### Graceful Shutdown
```bash
# Press Ctrl+C
# Bot will:
# 1. Stop market making
# 2. Cancel all orders
# 3. Withdraw funds to master wallet
# 4. Close connections
# 5. Exit cleanly
```

### Emergency Stop
```bash
# If bot is unresponsive
kill -9 <process_id>

# Then manually withdraw funds
# (see TESTING_GUIDE.md for procedures)
```

## 🐛 Troubleshooting

### Common Issues

**Issue**: "Insufficient funds"
```bash
# Solution: Fund master wallet with more SOL
# Get address from logs and use faucet
```

**Issue**: "Failed to get quote"
```bash
# Solution: Check RPC endpoint is working
# Try different RPC provider in .env
```

**Issue**: "Circuit breaker activated"
```bash
# Solution: This is normal during high volatility
# Wait for cooldown period or adjust thresholds
```

**Issue**: "Wallet generation failed"
```bash
# Solution: Check MASTER_WALLET_SEED is set
# Verify WALLET_ENCRYPTION_KEY is 32 characters
```

See [TESTING_GUIDE.md](TESTING_GUIDE.md) for more troubleshooting tips.

## 📦 Project Structure

```
solana-market-maker/
├── src/
│   ├── core/
│   │   ├── MarketMaker.ts          # Main market making logic
│   │   └── types.ts                # Type definitions
│   ├── exchange/
│   │   ├── JupiterSwap.ts          # Jupiter V6 swap integration
│   │   └── JupiterLimitOrders.ts   # Jupiter limit orders
│   ├── pricing/
│   │   ├── PriceAggregator.ts      # Multi-source price aggregation
│   │   ├── JupiterPriceFeed.ts     # Jupiter price feed
│   │   ├── PythPriceFeed.ts        # Pyth oracle integration
│   │   └── BirdeyePriceFeed.ts     # Birdeye API integration
│   ├── safety/
│   │   ├── MEVProtection.ts        # MEV protection module
│   │   ├── CircuitBreaker.ts       # Circuit breaker
│   │   └── RugPullDetector.ts      # Rug-pull detection
│   ├── utils/
│   │   ├── WalletGenerator.ts      # HD wallet generation
│   │   ├── EncryptionManager.ts    # Wallet encryption
│   │   ├── FundingManager.ts       # Auto-funding logic
│   │   ├── WithdrawalManager.ts    # Auto-withdrawal logic
│   │   ├── WalletManager.ts        # Unified wallet management
│   │   ├── AppConfig.ts            # Configuration management
│   │   ├── RPCManager.ts           # Multi-RPC management
│   │   ├── StateManager.ts         # State persistence
│   │   └── Logger.ts               # Structured logging
│   └── index.ts                    # Main entry point
├── config/                         # Configuration files
├── logs/                           # Log files
├── db/                             # SQLite database
├── wallets/                        # Encrypted wallets
├── .env.example                    # Environment template
├── package.json                    # Dependencies
├── tsconfig.json                   # TypeScript config
└── README.md                       # This file
```

## 🤝 Contributing

Contributions are welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## 📄 License

MIT License - see LICENSE file for details

## ⚠️ Disclaimer

This software is provided "as is" without warranty of any kind. Use at your own risk. Trading cryptocurrencies involves substantial risk of loss. Always test thoroughly on devnet before using real funds.

## 🙏 Acknowledgments

- Jupiter Aggregator for swap and limit order APIs
- Pyth Network for oracle price feeds
- Birdeye for market data
- Solana Foundation for the blockchain

## 📞 Support

For issues, questions, or contributions:
- Open an issue on GitHub
- Check existing documentation
- Review TESTING_GUIDE.md for common problems

---

**Version**: 2.0.0  
**Status**: Production Ready ✅  
**Last Updated**: November 20, 2025

**Happy Trading! 🚀**
