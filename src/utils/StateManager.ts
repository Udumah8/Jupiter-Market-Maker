
import sqlite3 from 'sqlite3';
import { IAppConfig } from './AppConfig.js';
import { logger } from './Logger.js';
import { Order } from '../core/types.js';

// This is a more robust state manager using a local SQLite database
// to ensure transactional and reliable state persistence.

export class StateManager {
  private db!: sqlite3.Database;

  constructor(private config: IAppConfig) { }

  public async initialize(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(this.config.DB_PATH, async (err: Error | null) => {
        if (err) {
          logger.error('Failed to connect to SQLite database.', err);
          return reject(err);
        }
        logger.info('Connected to SQLite database.');
        await this.initSchema();
        resolve();
      });
    });
  }

  private async initSchema(): Promise<void> {
    const schemaQueries = [
      `CREATE TABLE IF NOT EXISTS active_orders (
        orderId TEXT PRIMARY KEY,
        wallet TEXT NOT NULL,
        baseMint TEXT NOT NULL,
        quoteMint TEXT NOT NULL,
        side TEXT NOT NULL,
        price REAL NOT NULL,
        size REAL NOT NULL,
        createdAt INTEGER NOT NULL
      );`,
      `CREATE TABLE IF NOT EXISTS trade_history (
        tradeId INTEGER PRIMARY KEY AUTOINCREMENT,
        orderId TEXT,
        wallet TEXT NOT NULL,
        baseMint TEXT NOT NULL,
        quoteMint TEXT NOT NULL,
        side TEXT NOT NULL,
        price REAL NOT NULL,
        size REAL NOT NULL,
        timestamp INTEGER NOT NULL
      );`,
      `CREATE TABLE IF NOT EXISTS inventory (
          wallet TEXT NOT NULL,
          mint TEXT NOT NULL,
          amount REAL NOT NULL,
          PRIMARY KEY (wallet, mint)
      );`,
      `CREATE TABLE IF NOT EXISTS kv_store (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
      );`
    ];

    for (const query of schemaQueries) {
      await this.runQuery(query);
    }
    logger.info('Database schema initialized.');
  }

  // --- State Mutation Methods ---

  public async saveActiveOrder(order: Order): Promise<void> {
    const query = `
      INSERT OR REPLACE INTO active_orders (orderId, wallet, baseMint, quoteMint, side, price, size, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?);
    `;
    await this.runQuery(query, [
      order.orderId,
      order.wallet,
      order.baseMint,
      order.quoteMint,
      order.side,
      order.price,
      order.size,
      order.createdAt
    ]);
  }

  public async removeActiveOrder(orderId: string): Promise<void> {
    await this.runQuery('DELETE FROM active_orders WHERE orderId = ?;', [orderId]);
  }

  public async loadActiveOrders(): Promise<Order[]> {
    const rows = await this.allQuery('SELECT * FROM active_orders;');
    return rows as Order[];
  }

  public async updateInventory(wallet: string, mint: string, change: number): Promise<void> {
    const query = `
        INSERT INTO inventory (wallet, mint, amount) VALUES (?, ?, ?)
        ON CONFLICT(wallet, mint) DO UPDATE SET amount = amount + ?;
      `;
    await this.runQuery(query, [wallet, mint, change, change]);
  }

  public async getInventory(wallet: string, mint: string): Promise<number> {
    const row = await this.getQuery('SELECT amount FROM inventory WHERE wallet = ? AND mint = ?;', [wallet, mint]);
    return row ? row.amount : 0;
  }

  public async setKey(key: string, value: any): Promise<void> {
    const stringValue = JSON.stringify(value);
    const query = `INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?);`;
    await this.runQuery(query, [key, stringValue]);
  }

  public async getKey<T>(key: string): Promise<T | null> {
    const row = await this.getQuery('SELECT value FROM kv_store WHERE key = ?;', [key]);
    if (!row) return null;
    try {
      return JSON.parse(row.value) as T;
    } catch (e) {
      logger.error(`Failed to parse value for key ${key}`, { error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  }

  public async close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.close((err: Error | null) => {
        if (err) return reject(err);
        logger.info('Database connection closed.');
        resolve();
      });
    });
  }


  // --- Database Utility Methods ---

  private runQuery(query: string, params: any[] = []): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run(query, params, (err: Error | null) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  private getQuery(query: string, params: any[] = []): Promise<any> {
    return new Promise((resolve, reject) => {
      this.db.get(query, params, (err: Error | null, row: any) => {
        if (err) return reject(err);
        resolve(row);
      });
    });
  }

  private allQuery(query: string, params: any[] = []): Promise<any[]> {
    return new Promise((resolve, reject) => {
      this.db.all(query, params, (err: Error | null, rows: any[]) => {
        if (err) return reject(err);
        resolve(rows);
      });
    });
  }
}
