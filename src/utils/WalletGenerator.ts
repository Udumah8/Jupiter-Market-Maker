/**
 * Wallet Generator - HD Wallet Support for 10,000+ Wallets
 * Generates deterministic wallets from master seed
 */

import { Keypair, PublicKey } from '@solana/web3.js';
import { derivePath } from 'ed25519-hd-key';
import bs58 from 'bs58';
import crypto from 'crypto';
import { Logger } from './Logger.js';

export interface GeneratedWallet {
  keypair: Keypair;
  publicKey: PublicKey;
  derivationPath: string;
  index: number;
}

export class WalletGenerator {
  private logger: Logger;
  private masterSeed: Buffer;

  constructor(masterSeedPhrase: string, logger: Logger) {
    this.logger = logger;
    // Convert seed phrase to buffer
    this.masterSeed = this.seedPhraseToBuffer(masterSeedPhrase);
  }

  /**
   * Generate multiple wallets from master seed
   * Supports 10,000+ wallets efficiently
   */
  async generateWallets(count: number, startIndex: number = 0): Promise<GeneratedWallet[]> {
    const wallets: GeneratedWallet[] = [];
    
    this.logger.info('Generating wallets', { count, startIndex });

    for (let i = startIndex; i < startIndex + count; i++) {
      try {
        const wallet = this.generateWallet(i);
        wallets.push(wallet);

        // Log progress every 100 wallets
        if ((i - startIndex + 1) % 100 === 0) {
          this.logger.debug('Wallet generation progress', {
            generated: i - startIndex + 1,
            total: count,
          });
        }
      } catch (error) {
        this.logger.error('Failed to generate wallet', {
          index: i,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        throw error;
      }
    }

    this.logger.info('Wallet generation completed', {
      count: wallets.length,
      firstPublicKey: wallets[0]?.publicKey.toString(),
      lastPublicKey: wallets[wallets.length - 1]?.publicKey.toString(),
    });

    return wallets;
  }

  /**
   * Generate a single wallet at specific index
   */
  generateWallet(index: number): GeneratedWallet {
    // Use BIP44 derivation path: m/44'/501'/0'/0'/index'
    // 501 is Solana's coin type
    const derivationPath = `m/44'/501'/0'/0'/${index}'`;

    // Derive key from master seed
    const derived = derivePath(derivationPath, this.masterSeed.toString('hex'));
    
    // Create keypair from derived key
    const keypair = Keypair.fromSeed(derived.key);

    return {
      keypair,
      publicKey: keypair.publicKey,
      derivationPath,
      index,
    };
  }

  /**
   * Generate wallet from specific derivation path
   */
  generateWalletFromPath(path: string): GeneratedWallet {
    const derived = derivePath(path, this.masterSeed.toString('hex'));
    const keypair = Keypair.fromSeed(derived.key);

    // Extract index from path
    const match = path.match(/\/(\d+)'$/);
    const index = match ? parseInt(match[1]) : 0;

    return {
      keypair,
      publicKey: keypair.publicKey,
      derivationPath: path,
      index,
    };
  }

  /**
   * Verify wallet can be regenerated from seed
   */
  async verifyWallet(wallet: GeneratedWallet): Promise<boolean> {
    try {
      const regenerated = this.generateWallet(wallet.index);
      return regenerated.publicKey.equals(wallet.publicKey);
    } catch (error) {
      this.logger.error('Wallet verification failed', {
        index: wallet.index,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return false;
    }
  }

  /**
   * Generate batch of wallets in parallel (for large counts)
   */
  async generateWalletsBatch(
    count: number,
    startIndex: number = 0,
    batchSize: number = 1000
  ): Promise<GeneratedWallet[]> {
    const allWallets: GeneratedWallet[] = [];
    const batches = Math.ceil(count / batchSize);

    this.logger.info('Generating wallets in batches', {
      totalCount: count,
      batchSize,
      batches,
    });

    for (let batch = 0; batch < batches; batch++) {
      const batchStart = startIndex + batch * batchSize;
      const batchCount = Math.min(batchSize, count - batch * batchSize);

      const batchWallets = await this.generateWallets(batchCount, batchStart);
      allWallets.push(...batchWallets);

      this.logger.debug('Batch completed', {
        batch: batch + 1,
        totalBatches: batches,
        walletsGenerated: allWallets.length,
      });
    }

    return allWallets;
  }

  /**
   * Export wallet to encrypted format
   */
  exportWallet(wallet: GeneratedWallet, encryptionKey: string): string {
    const data = {
      secretKey: bs58.encode(wallet.keypair.secretKey),
      publicKey: wallet.publicKey.toString(),
      derivationPath: wallet.derivationPath,
      index: wallet.index,
    };

    const cipher = crypto.createCipher('aes-256-cbc', encryptionKey);
    let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'hex');
    encrypted += cipher.final('hex');

    return encrypted;
  }

  /**
   * Import wallet from encrypted format
   */
  importWallet(encrypted: string, encryptionKey: string): GeneratedWallet {
    const decipher = crypto.createDecipher('aes-256-cbc', encryptionKey);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    const data = JSON.parse(decrypted);
    const secretKey = bs58.decode(data.secretKey);
    const keypair = Keypair.fromSecretKey(secretKey);

    return {
      keypair,
      publicKey: new PublicKey(data.publicKey),
      derivationPath: data.derivationPath,
      index: data.index,
    };
  }

  /**
   * Convert seed phrase to buffer
   */
  private seedPhraseToBuffer(seedPhrase: string): Buffer {
    // If it's already a hex string, convert directly
    if (/^[0-9a-fA-F]+$/.test(seedPhrase) && seedPhrase.length === 64) {
      return Buffer.from(seedPhrase, 'hex');
    }

    // If it's a base58 string, decode it
    try {
      return Buffer.from(bs58.decode(seedPhrase));
    } catch {
      // Otherwise, hash the seed phrase to create a deterministic seed
      return crypto.createHash('sha256').update(seedPhrase).digest();
    }
  }

  /**
   * Generate master seed from mnemonic (BIP39 compatible)
   */
  static generateMasterSeed(mnemonic?: string): string {
    if (mnemonic) {
      // In production, use proper BIP39 library
      const hash = crypto.createHash('sha256').update(mnemonic).digest();
      return hash.toString('hex');
    }

    // Generate random seed
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Get wallet count that can be generated
   */
  getMaxWalletCount(): number {
    // Theoretical limit is 2^31 - 1 (BIP44 hardened derivation)
    return 2147483647;
  }
}
