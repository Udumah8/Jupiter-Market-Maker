
export type OrderSide = 'buy' | 'sell';

export interface Order {
  orderId: string;
  wallet: string;
  baseMint: string;
  quoteMint: string;
  side: OrderSide;
  price: number;
  size: number;
  createdAt: number;
}

export interface PriceData {
  price: number;
  source: string;
}

export interface MarketData {
  midPrice: number;
  bestBid: number;
  bestAsk: number;
}
