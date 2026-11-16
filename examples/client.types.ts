export type WirePage = {
  messages: { cursor: string; createdAt: number; expiresAt: number; ciphertext: string }[];
  nextCursor: string;
  hasMore: boolean;
  truncated: boolean;
};
