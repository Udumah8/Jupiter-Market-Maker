/**
 * Jupiter Swap Integration for Immediate Market Orders
 * Uses Jupiter V6 API with RFQ and wholesale support for best-priced instant swaps
 * Includes Token2022 support and advanced priority fee management
 */

import { Connection, PublicKey, Keypair, VersionedTransaction } from '@solana/web3.js';
import BN from 'bn.js';
import { Logger } from '../utils/Logger.js';
import { BNMath } from '../utils/BNMath.js';
import { RateLimiter } from '../utils/RateLimiter.js';
import pRetry from 'p-retry';
import fetch from 'node-fetch';

export interface PlacedOrder {
  orderKey: PublicKey;
  signature: string;
  inputMint: PublicKey;
  outputMint: PublicKey;
  inAmount: BN;
  outAmount: BN;
  price: number;
  timestamp: number;
  type?: 'limit' | 'market';
}

export interface JupiterQuoteData {
  inAmount: string;
  outAmount: string;
  priceImpactPct?: string;
  otherAmountThreshold?: string;
  swapMode?: string;
  slippageBps?: number;
  [key: string]: any; // Allow additional properties
}

export interface SwapParams {
  inputMint: PublicKey;
  outputMint: PublicKey;
  amount: BN;
  slippageBps?: number; // e.g., 50 = 0.5%
  onlyDirectRoutes?: boolean;
  asLegacyTransaction?: boolean;
  useToken2022?: boolean;
  rfq?: boolean;
}

export interface RFQQuote {
  inAmount: BN;
  outAmount: BN;
  priceImpactPct: number;
  fee: BN;
  route: any;
}

export interface SwapResult {
  signature: string;
  inAmount: BN;
  outAmount: BN;
  fee: BN;
  executionTime: number;
}

export class JupiterSwap {
  private connection: Connection;
  private logger: Logger;
  private baseUrl = 'https://quote-api.jup.ag/v6';
  private rateLimiter: RateLimiter;

  constructor(
    connection: Connection,
    logger: Logger
  ) {
    this.connection = connection;
    this.logger = logger;
    // Jupiter free tier: ~10 requests per second, be conservative
    this.rateLimiter = new RateLimiter({
      maxRequests: 5,
      windowMs: 1000,
      minDelayMs: 200, // Minimum 200ms between requests
    });
  }

  /**
   * Execute immediate buy market order
   */
  async buyMarketOrder(
    wallet: Keypair,
    baseMint: PublicKey,
    quoteMint: PublicKey,
    quoteAmount: BN,
    maxSlippagePercent: number = 1.0,
    useRFQ: boolean = true,
    useToken2022: boolean = false
  ): Promise<SwapResult> {
    const startTime = Date.now();

    try {

      const params: SwapParams = {
        inputMint: quoteMint,
        outputMint: baseMint,
        amount: quoteAmount,
        slippageBps: Math.floor(maxSlippagePercent * 100),
        onlyDirectRoutes: false,
        asLegacyTransaction: false,
        useToken2022,
        rfq: useRFQ,
      };

      const result = await this.executeSwap(wallet, params);
      result.executionTime = Date.now() - startTime;

      this.logger.info('Buy market order executed', {
        signature: result.signature,
        baseMint: baseMint.toString(),
        quoteSpent: quoteAmount.toString(),
        baseReceived: result.outAmount.toString(),
        price: BNMath.calculatePrice(quoteAmount, result.outAmount, 6, 9).toFixed(6),
        slippage: `${maxSlippagePercent}%`,
        executionTime: result.executionTime + 'ms',
      });

      return result;

    } catch (error) {
      this.logger.error('Buy market order failed', {
        baseMint: baseMint.toString(),
        quoteAmount: quoteAmount.toString(),
        error: error instanceof Error ? error.message : 'Unknown error',
        executionTime: Date.now() - startTime,
      });
      throw error;
    }
  }

  /**
   * Execute immediate sell market order
   */
  async sellMarketOrder(
    wallet: Keypair,
    baseMint: PublicKey,
    quoteMint: PublicKey,
    baseAmount: BN,
    maxSlippagePercent: number = 1.0,
    useRFQ: boolean = true,
    useToken2022: boolean = false
  ): Promise<SwapResult> {
    const startTime = Date.now();

    try {

      const params: SwapParams = {
        inputMint: baseMint,
        outputMint: quoteMint,
        amount: baseAmount,
        slippageBps: Math.floor(maxSlippagePercent * 100),
        onlyDirectRoutes: false,
        asLegacyTransaction: false,
        useToken2022,
        rfq: useRFQ,
      };

      const result = await this.executeSwap(wallet, params);
      result.executionTime = Date.now() - startTime;

      this.logger.info('Sell market order executed', {
        signature: result.signature,
        baseMint: baseMint.toString(),
        baseSold: baseAmount.toString(),
        quoteReceived: result.outAmount.toString(),
        price: BNMath.calculatePrice(baseAmount, result.outAmount, 9, 6).toFixed(6),
        slippage: `${maxSlippagePercent}%`,
        executionTime: result.executionTime + 'ms',
      });

      return result;

    } catch (error) {
      this.logger.error('Sell market order failed', {
        baseMint: baseMint.toString(),
        baseAmount: baseAmount.toString(),
        error: error instanceof Error ? error.message : 'Unknown error',
        executionTime: Date.now() - startTime,
      });
      throw error;
    }
  }

  /**
   * Execute RFQ swap for large orders
   */
  async rfqSwap(
    wallet: Keypair,
    inputMint: PublicKey,
    outputMint: PublicKey,
    amount: BN,
    maxSlippagePercent: number = 0.5,
    useToken2022: boolean = false
  ): Promise<SwapResult> {
    const startTime = Date.now();

    try {
      const rfqQuote = await this.getRFQQuote(inputMint, outputMint, amount, Math.floor(maxSlippagePercent * 100));
      if (!rfqQuote) {
        throw new Error('No RFQ quote available');
      }

      const swapParams: SwapParams = {
        inputMint,
        outputMint,
        amount,
        slippageBps: Math.floor(maxSlippagePercent * 100),
        asLegacyTransaction: false,
        useToken2022,
        rfq: true
      };

      const result = await this.executeRFQSwap(wallet, rfqQuote, swapParams);
      result.executionTime = Date.now() - startTime;

      this.logger.info('RFQ swap executed', {
        signature: result.signature,
        inputMint: inputMint.toString(),
        outputMint: outputMint.toString(),
        inputAmount: amount.toString(),
        outputAmount: result.outAmount.toString(),
        price: BNMath.calculatePrice(amount, result.outAmount, 9, 9).toFixed(6),
        executionTime: result.executionTime + 'ms',
      });

      return result;

    } catch (error) {
      this.logger.error('RFQ swap failed', {
        inputMint: inputMint.toString(),
        outputMint: outputMint.toString(),
        amount: amount.toString(),
        error: error instanceof Error ? error.message : 'Unknown error',
        executionTime: Date.now() - startTime,
      });
      throw error;
    }
  }

  /**
   * Get RFQ quote for large orders (uses same endpoint as regular quotes in V6)
   */
  async getRFQQuote(
    inputMint: PublicKey,
    outputMint: PublicKey,
    amount: BN,
    slippageBps: number = 50
  ): Promise<RFQQuote | null> {
    try {
      // Jupiter V6 uses same quote endpoint for RFQ with rate limiting
      const response = await this.rateLimiter.execute(async () => {
        return fetch(
          `${this.baseUrl}/quote?inputMint=${inputMint.toString()}&outputMint=${outputMint.toString()}&amount=${amount.toString()}&slippageBps=${slippageBps}`
        );
      });

      if (!response.ok) {
        if (response.status === 429) {
          this.logger.warn('Jupiter rate limit hit in RFQ quote');
          await new Promise(resolve => setTimeout(resolve, 5000));
          return null;
        }
        throw new Error(`RFQ Quote API returned ${response.status}`);
      }

      const quoteData: JupiterQuoteData = await response.json() as JupiterQuoteData;

      if (!quoteData.outAmount) {
        this.logger.warn('No route found for RFQ', {
          inputMint: inputMint.toString(),
          outputMint: outputMint.toString(),
          amount: amount.toString(),
        });
        return null;
      }

      return {
        inAmount: new BN(quoteData.inAmount),
        outAmount: new BN(quoteData.outAmount),
        priceImpactPct: parseFloat(quoteData.priceImpactPct || '0'),
        fee: new BN(quoteData.otherAmountThreshold || '0'),
        route: quoteData,
      };

    } catch (error) {
      this.logger.debug('RFQ quote failed', {
        inputMint: inputMint.toString(),
        outputMint: outputMint.toString(),
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return null;
    }
  }

  /**
   * Execute swap with retry logic and priority fees
   */
  private async executeSwap(wallet: Keypair, params: SwapParams): Promise<SwapResult> {
    const result = await pRetry(
      async () => {
        // Use RFQ for large orders or regular swap
        if (params.rfq) {
          const rfqQuote = await this.getRFQQuote(params.inputMint, params.outputMint, params.amount, params.slippageBps || 50);
          if (rfqQuote) {
            return await this.executeRFQSwap(wallet, rfqQuote, params);
          }
        }

        // Regular swap
        const quote = await this.getQuote(params);
        if (!quote) {
          throw new Error('Failed to get swap quote');
        }

        const swapData = await this.getSwapInstructions(quote, wallet.publicKey);
        const versionedTx = await this.buildSwapTransaction(swapData, wallet);

        // Send versioned transaction
        const signature = await this.connection.sendTransaction(versionedTx, {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
          maxRetries: 3,
        });

        await this.connection.confirmTransaction(signature, 'confirmed');

        return {
          signature,
          inAmount: new BN(quote.inAmount),
          outAmount: new BN(quote.outAmount),
          fee: new BN(quote.otherAmountThreshold || '0'),
          executionTime: 0,
        };
      },
      {
        retries: 3,
        minTimeout: 2000,
        onFailedAttempt: (error) => {
          this.logger.warn('Swap attempt failed', {
            attempt: error.attemptNumber,
            retriesLeft: error.retriesLeft,
            inputMint: params.inputMint.toString(),
            outputMint: params.outputMint.toString(),
            error: error.message,
          });
        },
      }
    );

    return result;
  }

  /**
   * Execute RFQ swap
   */
  private async executeRFQSwap(wallet: Keypair, rfqQuote: RFQQuote, _params: SwapParams): Promise<SwapResult> {
    const swapInstructions = await this.getRFQSwapInstructions(rfqQuote, wallet.publicKey);
    const versionedTx = await this.buildRFQTransaction(swapInstructions, wallet);

    // Send versioned transaction
    const signature = await this.connection.sendTransaction(versionedTx, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 3,
    });

    await this.connection.confirmTransaction(signature, 'confirmed');

    return {
      signature,
      inAmount: rfqQuote.inAmount,
      outAmount: rfqQuote.outAmount,
      fee: rfqQuote.fee,
      executionTime: 0,
    };
  }

  /**
   * Get swap quote from Jupiter V6
   */
  private async getQuote(params: SwapParams): Promise<any> {
    const queryParams = new URLSearchParams({
      inputMint: params.inputMint.toString(),
      outputMint: params.outputMint.toString(),
      amount: params.amount.toString(),
      slippageBps: (params.slippageBps || 50).toString(),
      onlyDirectRoutes: (params.onlyDirectRoutes || false).toString(),
    });

    const response = await this.rateLimiter.execute(async () => {
      return fetch(`${this.baseUrl}/quote?${queryParams}`);
    });

    if (!response.ok) {
      if (response.status === 429) {
        this.logger.warn('Jupiter rate limit hit in quote');
        await new Promise(resolve => setTimeout(resolve, 5000));
        throw new Error('Rate limit exceeded, please retry');
      }
      const errorText = await response.text();
      throw new Error(`Quote API error: ${response.status} - ${errorText}`);
    }

    const quoteData = await response.json() as { outAmount?: string; inAmount?: string };

    // Jupiter V6 returns the quote directly, not in routePlan
    if (!quoteData || !quoteData.outAmount) {
      throw new Error('No valid quote received');
    }

    return quoteData;
  }

  /**
   * Get swap instructions from Jupiter V6
   */
  private async getSwapInstructions(quote: any, userPublicKey: PublicKey): Promise<any> {
    const response = await this.rateLimiter.execute(async () => {
      return fetch(`${this.baseUrl}/swap`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: userPublicKey.toString(),
          wrapAndUnwrapSol: true,
          useSharedAccounts: true,
          feeAccount: undefined,
          computeUnitPriceMicroLamports: 'auto',
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: 'auto',
        }),
      });
    });

    if (!response.ok) {
      if (response.status === 429) {
        this.logger.warn('Jupiter rate limit hit in swap instructions');
        await new Promise(resolve => setTimeout(resolve, 5000));
        throw new Error('Rate limit exceeded, please retry');
      }
      const errorText = await response.text();
      throw new Error(`Swap API error: ${response.status} - ${errorText}`);
    }

    const swapData = await response.json();
    return swapData;
  }

  /**
   * Get RFQ swap instructions (uses same endpoint as regular swaps in V6)
   */
  private async getRFQSwapInstructions(rfqQuote: RFQQuote, userPublicKey: PublicKey): Promise<any> {
    const response = await this.rateLimiter.execute(async () => {
      return fetch(`${this.baseUrl}/swap`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          quoteResponse: rfqQuote.route,
          userPublicKey: userPublicKey.toString(),
          wrapAndUnwrapSol: true,
          useSharedAccounts: true,
          feeAccount: undefined,
          computeUnitPriceMicroLamports: 'auto',
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: 'auto',
        }),
      });
    });

    if (!response.ok) {
      if (response.status === 429) {
        this.logger.warn('Jupiter rate limit hit in RFQ swap instructions');
        await new Promise(resolve => setTimeout(resolve, 5000));
        throw new Error('Rate limit exceeded, please retry');
      }
      const errorText = await response.text();
      throw new Error(`RFQ Swap API error: ${response.status} - ${errorText}`);
    }

    return await response.json();
  }

  /**
   * Build swap transaction with compute budget and priority fees
   * Jupiter V6 returns VersionedTransaction
   */
  private async buildSwapTransaction(swapData: any, wallet: Keypair): Promise<VersionedTransaction> {
    const { swapTransaction } = swapData;

    // Jupiter V6 returns base64 encoded VersionedTransaction
    const txBuf = Buffer.from(swapTransaction, 'base64');
    const versionedTx = VersionedTransaction.deserialize(txBuf);

    // Sign the transaction
    versionedTx.sign([wallet]);

    return versionedTx;
  }

  /**
   * Build RFQ transaction (same as regular swap in V6)
   */
  private async buildRFQTransaction(swapData: any, wallet: Keypair): Promise<VersionedTransaction> {
    return await this.buildSwapTransaction(swapData, wallet);
  }

  /**
   * Get supported output amount for input amount (estimation)
   */
  async getEstimatedOutput(
    inputMint: PublicKey,
    outputMint: PublicKey,
    inputAmount: BN,
    slippageBps: number = 50,
    useToken2022: boolean = false
  ): Promise<BN | null> {
    try {
      const params: SwapParams = {
        inputMint,
        outputMint,
        amount: inputAmount,
        slippageBps,
        useToken2022,
      };

      const quote = await this.getQuote(params);
      return new BN(quote.outAmount);
    } catch (error) {
      this.logger.debug('Failed to get output estimate', {
        inputMint: inputMint.toString(),
        outputMint: outputMint.toString(),
        inputAmount: inputAmount.toString(),
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return null;
    }
  }

  /**
   * Check if token pair is supported for swapping
   */
  async isSupportedPair(inputMint: PublicKey, outputMint: PublicKey, useToken2022: boolean = false): Promise<boolean> {
    try {
      const params: SwapParams = {
        inputMint,
        outputMint,
        amount: new BN(1000000), // Small test amount
        slippageBps: 50,
        useToken2022,
      };

      const quote = await this.getQuote(params);
      return !!quote && !!quote.outAmount;
    } catch {
      return false;
    }
  }
}
