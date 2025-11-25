/**
 * Jupiter Limit Order Integration
 * Production-ready implementation with proper error handling and retry logic
 */

import { Connection, PublicKey, Keypair, Transaction, ComputeBudgetProgram } from '@solana/web3.js';
import { LimitOrderProvider } from '@jup-ag/limit-order-sdk';
import BN from 'bn.js';
import { Logger } from '../utils/Logger.js';
import { BNMath } from '../utils/BNMath.js';
import pRetry from 'p-retry';

export interface OrderParams {
  owner: Keypair;
  inputMint: PublicKey;
  outputMint: PublicKey;
  inAmount: BN;
  outAmount: BN;
  expiredAt?: BN;
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

export interface JupiterConfig {
  computeUnitLimit: number;
  computeUnitPrice: number;
  maxRetries: number;
  retryDelay: number;
}

export class JupiterLimitOrders {
  private provider: LimitOrderProvider;
  private connection: Connection;
  private logger: Logger;
  private config: JupiterConfig;

  constructor(
    connection: Connection,
    config: JupiterConfig,
    logger: Logger
  ) {
    this.connection = connection;
    this.config = config;
    this.logger = logger;
    this.provider = new LimitOrderProvider(connection);
  }

  /**
   * Place a limit order with proper compute budget and retry logic
   */
  async placeOrder(params: OrderParams): Promise<PlacedOrder> {
    const startTime = Date.now();
    
    try {
      // Validate inputs
      this.validateOrderParams(params);

      // Create order with retry logic
      const result = await pRetry(
        async () => {
          // Simulate transaction first
          await this.simulateOrder(params);
          
          // Create order transaction
          // Note: 'base' is the token account that will be used as the base for the order
          const result = await this.provider.createOrder({
            owner: params.owner.publicKey,
            inAmount: params.inAmount,
            outAmount: params.outAmount,
            inputMint: params.inputMint,
            outputMint: params.outputMint,
            base: params.owner.publicKey, // Using owner as base for simplicity
            ...(params.expiredAt && { validUntil: params.expiredAt }),
          });
          
          // Extract transaction from result
          const tx = result as unknown as Transaction;
          const orderPubKey = result.orderPubKey;

          // Add compute budget instructions
          const txWithBudget = this.addComputeBudget(tx);

          // Send and confirm
          const signature = await this.connection.sendTransaction(
            txWithBudget,
            [params.owner],
            {
              skipPreflight: false,
              preflightCommitment: 'confirmed',
              maxRetries: 3,
            }
          );

          // Wait for confirmation
          await this.connection.confirmTransaction(signature, 'confirmed');

          return { orderKey: orderPubKey, signature };
        },
        {
          retries: this.config.maxRetries,
          minTimeout: this.config.retryDelay,
          onFailedAttempt: (error) => {
            this.logger.warn('Order placement attempt failed', {
              attempt: error.attemptNumber,
              retriesLeft: error.retriesLeft,
              error: error.message,
            });
          },
        }
      );

      // Calculate price for logging
      const price = BNMath.calculatePrice(
        params.inAmount,
        params.outAmount,
        9, // Assuming SOL decimals
        6  // Assuming token decimals
      );

      const placedOrder: PlacedOrder = {
        orderKey: result.orderKey,
        signature: result.signature,
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        inAmount: params.inAmount,
        outAmount: params.outAmount,
        price,
        timestamp: Date.now(),
        type: 'limit',
      };

      this.logger.info('Order placed successfully', {
        orderKey: result.orderKey.toString(),
        signature: result.signature,
        price: price.toFixed(6),
        duration: Date.now() - startTime,
      });

      return placedOrder;

    } catch (error) {
      this.logger.error('Failed to place order', {
        error: error instanceof Error ? error.message : 'Unknown error',
        duration: Date.now() - startTime,
      });
      throw error;
    }
  }

  /**
   * Cancel an existing order
   */
  async cancelOrder(
    owner: Keypair,
    orderPubKey: PublicKey
  ): Promise<string> {
    const startTime = Date.now();
    
    try {
      const result = await pRetry(
        async () => {
          const result = await this.provider.cancelOrder({
            owner: owner.publicKey,
            orderPubKey,
          });
          
          // Extract transaction from result
          const tx = result as unknown as Transaction;

          // Add compute budget
          const txWithBudget = this.addComputeBudget(tx);

          // Send and confirm
          const signature = await this.connection.sendTransaction(
            txWithBudget,
            [owner],
            {
              skipPreflight: false,
              preflightCommitment: 'confirmed',
            }
          );

          await this.connection.confirmTransaction(signature, 'confirmed');

          return signature;
        },
        {
          retries: this.config.maxRetries,
          minTimeout: this.config.retryDelay,
        }
      );

      this.logger.info('Order cancelled successfully', {
        orderKey: orderPubKey.toString(),
        signature: result,
        duration: Date.now() - startTime,
      });

      return result;

    } catch (error) {
      this.logger.error('Failed to cancel order', {
        orderKey: orderPubKey.toString(),
        error: error instanceof Error ? error.message : 'Unknown error',
        duration: Date.now() - startTime,
      });
      throw error;
    }
  }

  /**
   * Cancel and replace an order safely (serialized to prevent double exposure)
   * Waits for cancel confirmation before placing new order
   */
  async cancelAndReplace(
    owner: Keypair,
    oldOrderKey: PublicKey,
    newOrderParams: OrderParams
  ): Promise<PlacedOrder> {
    const startTime = Date.now();
    
    try {
      this.logger.info('Starting cancel and replace', {
        oldOrder: oldOrderKey.toString(),
      });

      // Step 1: Cancel old order
      const cancelSig = await this.cancelOrder(owner, oldOrderKey);
      
      // Step 2: Wait for cancel confirmation (critical to prevent double exposure)
      await this.connection.confirmTransaction(cancelSig, 'confirmed');
      
      this.logger.debug('Old order cancelled, placing new order', {
        cancelSig,
        duration: Date.now() - startTime,
      });
      
      // Step 3: Place new order only after cancel is confirmed
      const newOrder = await this.placeOrder(newOrderParams);
      
      this.logger.info('Cancel and replace completed', {
        oldOrder: oldOrderKey.toString(),
        newOrder: newOrder.orderKey.toString(),
        totalDuration: Date.now() - startTime,
      });
      
      return newOrder;

    } catch (error) {
      this.logger.error('Cancel and replace failed', {
        oldOrder: oldOrderKey.toString(),
        error: error instanceof Error ? error.message : 'Unknown error',
        duration: Date.now() - startTime,
      });
      throw error;
    }
  }

  /**
   * Get active orders for a wallet
   */
  async getActiveOrders(owner: PublicKey): Promise<any[]> {
    try {
      // Get orders using the correct SDK method - pass owner as array of PublicKeys
      const orders = await this.provider.getOrders([owner] as any);

      this.logger.debug('Retrieved active orders', {
        owner: owner.toString(),
        count: orders.length,
      });

      return orders;

    } catch (error) {
      this.logger.error('Failed to get active orders', {
        owner: owner.toString(),
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Get order history for a wallet
   */
  async getOrderHistory(
    owner: PublicKey,
    limit: number = 10
  ): Promise<any[]> {
    try {
      const history = await this.provider.getOrderHistory({
        wallet: owner.toString(),
        take: limit,
      });

      this.logger.debug('Retrieved order history', {
        owner: owner.toString(),
        count: history.length,
      });

      return history;

    } catch (error) {
      this.logger.error('Failed to get order history', {
        owner: owner.toString(),
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Simulate order before placing
   */
  private async simulateOrder(params: OrderParams): Promise<void> {
    try {
      const result = await this.provider.createOrder({
        owner: params.owner.publicKey,
        inAmount: params.inAmount,
        outAmount: params.outAmount,
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        base: params.owner.publicKey,
        ...(params.expiredAt && { validUntil: params.expiredAt }),
      });
      
      const tx = result as unknown as Transaction;
      const txWithBudget = this.addComputeBudget(tx);

      const simulation = await this.connection.simulateTransaction(
        txWithBudget,
        [params.owner]
      );

      if (simulation.value.err) {
        throw new Error(`Simulation failed: ${JSON.stringify(simulation.value.err)}`);
      }

      this.logger.debug('Order simulation successful', {
        computeUnitsUsed: simulation.value.unitsConsumed,
      });

    } catch (error) {
      this.logger.error('Order simulation failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Add compute budget instructions to transaction
   */
  private addComputeBudget(tx: Transaction): Transaction {
    const modifiedTx = new Transaction();
    
    // Add compute unit limit
    modifiedTx.add(
      ComputeBudgetProgram.setComputeUnitLimit({
        units: this.config.computeUnitLimit,
      })
    );

    // Add compute unit price (priority fee)
    modifiedTx.add(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: this.config.computeUnitPrice,
      })
    );

    // Add original instructions
    modifiedTx.add(...tx.instructions);

    // Copy other transaction properties
    modifiedTx.recentBlockhash = tx.recentBlockhash;
    modifiedTx.feePayer = tx.feePayer;

    return modifiedTx;
  }

  /**
   * Validate order parameters
   */
  private validateOrderParams(params: OrderParams): void {
    if (!params.owner) {
      throw new Error('Owner keypair is required');
    }

    if (!params.inputMint || !params.outputMint) {
      throw new Error('Input and output mints are required');
    }

    if (params.inAmount.isZero() || params.outAmount.isZero()) {
      throw new Error('Amounts must be greater than zero');
    }

    if (params.inAmount.isNeg() || params.outAmount.isNeg()) {
      throw new Error('Amounts cannot be negative');
    }
  }
}
