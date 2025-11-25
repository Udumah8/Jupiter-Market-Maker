/**

 * WithdrawalManager v2
 * Production-ready auto-withdrawal + profit collection for Solana
 *
 * Features:
 * - Parallelized batch processing with concurrency limit
 * - Optional priority/Jito fee instructions
 * - Auto-create associated token accounts for destination when needed
 * - Safe token sweeping + optional close of source token accounts (rent reclaim to master)
 * - Transaction size auto-split (basic heuristic)
 * - p-retry wrapped sends with detailed logging
 * - Metrics hooks (callback-based) for integration with Prometheus/Datadog
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
  Commitment,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createTransferInstruction,
  createCloseAccountInstruction,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import BN from 'bn.js';
import pRetry from 'p-retry';

export interface WithdrawalConfigV2 {
  autoWithdrawThresholdSol: number;
  minBalanceToKeepSol: number;
  batchSize: number; // number of wallets per batch
  concurrency: number; // parallel wallets within batch
  maxRetries: number;
  closeTokenAccounts: boolean;
  computeUnitLimit?: number; // optional compute unit limit per tx
  computeUnitPriceMicroLamports?: number; // optional priority fee price (micro-lamports per CU)
  maxTxInstructions?: number; // safe cap for instructions per tx (heuristic)
  commitment?: Commitment;
}

export interface WithdrawalResultV2 {
  wallet: PublicKey;
  solWithdrawn: BN;
  tokenWithdrawn: BN;
  signature?: string;
  success: boolean;
  error?: string;
}

export type MetricsHook = (event: string, payload: Record<string, any>) => void;

export class WithdrawalManagerV2 {
  private connection: Connection;
  private logger: { info: Function; warn: Function; error: Function; debug?: Function };
  private config: WithdrawalConfigV2;
  private metrics?: MetricsHook;

  constructor(
    connection: Connection,
    config: WithdrawalConfigV2,
    logger: { info: Function; warn: Function; error: Function; debug?: Function },
    metricsHook?: MetricsHook,
  ) {
    this.connection = connection;
    this.config = {
      commitment: 'confirmed',
      maxTxInstructions: 10,
      ...config,
    };
    this.logger = logger;
    this.metrics = metricsHook;
  }

  /** Auto‑withdraw profits from wallets above threshold */
  async autoWithdrawProfits(
    wallets: Keypair[],
    masterWallet: Keypair,
    tokenMint?: PublicKey,
  ): Promise<WithdrawalResultV2[]> {
    this.logger.info('Starting autoWithdrawProfits', {
      walletCount: wallets.length,
      thresholdSol: this.config.autoWithdrawThresholdSol,
    });
    const ready: Keypair[] = [];
    for (const w of wallets) {
      try {
        const bal = await this.connection.getBalance(w.publicKey, this.config.commitment);
        const balSol = bal / LAMPORTS_PER_SOL;
        if (balSol > this.config.autoWithdrawThresholdSol) ready.push(w);
      } catch (err) {
        this.logger.warn('Failed to check balance for wallet', {
          wallet: w.publicKey.toBase58(),
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.metrics?.('auto_withdraw.scan_completed', { checked: wallets.length, toWithdraw: ready.length });
    return await this.collectInBatches(ready, masterWallet, tokenMint);
  }

  /** Collect all funds (emergency/shutdown) */
  async collectAllFunds(
    wallets: Keypair[],
    masterWallet: Keypair,
    tokenMint?: PublicKey,
  ): Promise<WithdrawalResultV2[]> {
    this.logger.warn('CollectAllFunds invoked', { walletCount: wallets.length });
    return await this.collectInBatches(wallets, masterWallet, tokenMint);
  }

  /** Emergency withdrawal – withdraw everything immediately */
  async emergencyWithdraw(
    wallets: Keypair[],
    masterWallet: Keypair,
    tokenMint?: PublicKey,
  ): Promise<void> {
    this.logger.error('EMERGENCY WITHDRAWAL: disabling min balance to keep');
    const originalMin = this.config.minBalanceToKeepSol;
    this.config.minBalanceToKeepSol = 0;
    try {
      const results = await this.collectInBatches(wallets, masterWallet, tokenMint);
      const failed = results.filter(r => !r.success);
      if (failed.length) {
        this.logger.error('Emergency withdraw had failures', { failedCount: failed.length });
      }
    } finally {
      this.config.minBalanceToKeepSol = originalMin;
    }
    this.logger.info('Emergency withdrawal completed');
  }

  /** Calculate total withdrawable amount */
  async calculateWithdrawableAmount(
    wallets: Keypair[],
    tokenMint?: PublicKey,
  ): Promise<{ sol: BN; token: BN }> {
    let totalSol = new BN(0);
    let totalToken = new BN(0);
    const minLamports = Math.floor(this.config.minBalanceToKeepSol * LAMPORTS_PER_SOL);
    for (const w of wallets) {
      try {
        const bal = await this.connection.getBalance(w.publicKey, this.config.commitment);
        const withdrawable = Math.max(0, bal - minLamports);
        totalSol = totalSol.add(new BN(withdrawable));
        if (tokenMint) {
          try {
            const ata = await getAssociatedTokenAddress(tokenMint, w.publicKey);
            const tokenInfo = await this.connection.getTokenAccountBalance(ata, this.config.commitment);
            totalToken = totalToken.add(new BN(tokenInfo.value.amount));
          } catch { }
        }
      } catch (err) {
        this.logger.warn('calculateWithdrawableAmount: failed for wallet', { wallet: w.publicKey.toBase58() });
      }
    }
    return { sol: totalSol, token: totalToken };
  }

  /** Internal: process wallets in batches */
  private async collectInBatches(
    wallets: Keypair[],
    masterWallet: Keypair,
    tokenMint?: PublicKey,
  ): Promise<WithdrawalResultV2[]> {
    const results: WithdrawalResultV2[] = [];
    for (let i = 0; i < wallets.length; i += this.config.batchSize) {
      const batch = wallets.slice(i, i + this.config.batchSize);
      this.logger.info('Processing batch', { batchNumber: Math.floor(i / this.config.batchSize) + 1, batchSize: batch.length });
      const batchResults = await this.processBatch(batch, masterWallet, tokenMint);
      results.push(...batchResults);
      this.metrics?.('batch.completed', {
        batchIndex: Math.floor(i / this.config.batchSize) + 1,
        processed: batchResults.length,
        successes: batchResults.filter(r => r.success).length,
      });
      await this.sleep(200);
    }
    return results;
  }

  /** Internal: process a batch with concurrency */
  private async processBatch(
    wallets: Keypair[],
    masterWallet: Keypair,
    tokenMint?: PublicKey,
  ): Promise<WithdrawalResultV2[]> {
    const concurrency = Math.max(1, this.config.concurrency || 4);
    const results: WithdrawalResultV2[] = [];
    let idx = 0;
    const worker = async () => {
      while (idx < wallets.length) {
        const w = wallets[idx++];
        try {
          const res = await this.withdrawFromWalletSafe(w, masterWallet, tokenMint);
          results.push(res);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.error('Unexpected error in worker', { wallet: w.publicKey.toBase58(), err: msg });
          results.push({ wallet: w.publicKey, solWithdrawn: new BN(0), tokenWithdrawn: new BN(0), success: false, error: msg });
        }
      }
    };
    const workers = Array.from({ length: concurrency }, () => worker());
    await Promise.all(workers);
    return results;
  }

  /** Wrap single‑wallet withdrawal with retry */
  private async withdrawFromWalletSafe(
    from: Keypair,
    to: Keypair,
    tokenMint?: PublicKey,
  ): Promise<WithdrawalResultV2> {
    try {
      return await pRetry(
        async () => await this.withdrawFromWallet(from, to, tokenMint),
        {
          retries: this.config.maxRetries,
          onFailedAttempt: err => {
            this.logger.warn('withdrawFromWallet retry', {
              wallet: from.publicKey.toBase58(),
              attempt: err.attemptNumber,
              retriesLeft: err.retriesLeft,
              error: err.message,
            });
            this.metrics?.('withdraw.retry', { wallet: from.publicKey.toBase58(), attempt: err.attemptNumber });
          },
        },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error('withdrawFromWalletSafe final failure', { wallet: from.publicKey.toBase58(), err: msg });
      this.metrics?.('withdraw.failed', { wallet: from.publicKey.toBase58(), error: msg });
      return { wallet: from.publicKey, solWithdrawn: new BN(0), tokenWithdrawn: new BN(0), success: false, error: msg };
    }
  }

  /** Core single‑wallet withdrawal */
  private async withdrawFromWallet(
    from: Keypair,
    to: Keypair,
    tokenMint?: PublicKey,
  ): Promise<WithdrawalResultV2> {
    const result: WithdrawalResultV2 = { wallet: from.publicKey, solWithdrawn: new BN(0), tokenWithdrawn: new BN(0), success: false };
    try {
      const balance = await this.connection.getBalance(from.publicKey, this.config.commitment);
      const rentExempt = await this.connection.getMinimumBalanceForRentExemption(0);
      const minBalanceLamports = Math.floor(this.config.minBalanceToKeepSol * LAMPORTS_PER_SOL);
      const minToKeep = Math.max(minBalanceLamports, rentExempt + 5000);
      const amountToWithdraw = Math.max(0, balance - minToKeep);

      const instructions: TransactionInstruction[] = [];

      if (this.config.computeUnitLimit) {
        instructions.push(ComputeBudgetProgram.setComputeUnitLimit({ units: this.config.computeUnitLimit }));
      }
      if (this.config.computeUnitPriceMicroLamports) {
        instructions.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.config.computeUnitPriceMicroLamports }));
      }

      if (amountToWithdraw > 0) {
        instructions.push(
          SystemProgram.transfer({
            fromPubkey: from.publicKey,
            toPubkey: to.publicKey,
            lamports: amountToWithdraw,
          }),
        );
        result.solWithdrawn = new BN(amountToWithdraw);
      }

      if (tokenMint) {
        try {
          const srcAta = await getAssociatedTokenAddress(tokenMint, from.publicKey);
          const tokenInfo = await this.connection.getTokenAccountBalance(srcAta, this.config.commitment);
          const tokenBalance = new BN(tokenInfo.value.amount);
          if (tokenBalance.gt(new BN(0))) {
            const dstAta = await getAssociatedTokenAddress(tokenMint, to.publicKey);
            const dstInfo = await this.connection.getAccountInfo(dstAta, this.config.commitment);
            if (!dstInfo) {
              instructions.push(createAssociatedTokenAccountInstruction(from.publicKey, dstAta, to.publicKey, tokenMint));
            }
            instructions.push(
              createTransferInstruction(srcAta, dstAta, from.publicKey, BigInt(tokenBalance.toString()), [], TOKEN_PROGRAM_ID),
            );
            if (this.config.closeTokenAccounts) {
              instructions.push(createCloseAccountInstruction(srcAta, to.publicKey, from.publicKey, [], TOKEN_PROGRAM_ID));
            }
            result.tokenWithdrawn = tokenBalance;
          }
        } catch (err) {
          this.logger.debug?.('Token sweep error', { wallet: from.publicKey.toBase58(), err: err instanceof Error ? err.message : String(err) });
        }
      }

      if (instructions.length === 0) {
        this.logger.info('Nothing to withdraw from wallet', { wallet: from.publicKey.toBase58() });
        this.metrics?.('withdraw.nothing', { wallet: from.publicKey.toBase58() });
        result.success = true;
        return result;
      }

      const maxInstr = Math.max(1, this.config.maxTxInstructions ?? 8);
      const txs: Transaction[] = [];
      for (let i = 0; i < instructions.length; i += maxInstr) {
        const tx = new Transaction();
        const slice = instructions.slice(i, i + maxInstr);
        slice.forEach(ix => tx.add(ix));
        txs.push(tx);
      }

      let lastSignature = '';
      for (const tx of txs) {
        const signature = await pRetry(
          async () => await sendAndConfirmTransaction(this.connection, tx, [from], { commitment: this.config.commitment, skipPreflight: false }),
          { retries: this.config.maxRetries, onFailedAttempt: err => this.logger.warn('send tx failed', { wallet: from.publicKey.toBase58(), attempt: err.attemptNumber, retriesLeft: err.retriesLeft }) },
        );
        lastSignature = signature;
        this.metrics?.('withdraw.tx_sent', { wallet: from.publicKey.toBase58(), signature });
        await this.sleep(150);
      }

      result.signature = lastSignature;
      result.success = true;
      this.logger.info('Withdraw completed', { wallet: from.publicKey.toBase58(), solWithdrawn: result.solWithdrawn.toString(), tokenWithdrawn: result.tokenWithdrawn.toString(), signature: lastSignature });
      this.metrics?.('withdraw.success', { wallet: from.publicKey.toBase58(), sol: Number(result.solWithdrawn.toString()) / LAMPORTS_PER_SOL, token: result.tokenWithdrawn.toString() });
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error('withdrawFromWallet failed', { wallet: from.publicKey.toBase58(), err: msg });
      this.metrics?.('withdraw.error', { wallet: from.publicKey.toBase58(), error: msg });
      return { wallet: from.publicKey, solWithdrawn: new BN(0), tokenWithdrawn: new BN(0), success: false, error: msg };
    }
  }

  /** Utility sleep */
  private async sleep(ms: number) {
    return new Promise(res => setTimeout(res, ms));
  }
}
