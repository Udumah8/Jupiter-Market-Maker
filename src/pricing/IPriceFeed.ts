
export interface PriceFeedData {
  price: number;
  source: string;
}

export interface IPriceFeed {
  getPrice(baseMint: string, quoteMint: string): Promise<PriceFeedData | null>;
}
