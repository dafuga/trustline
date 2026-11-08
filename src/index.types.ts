import type { Channel } from './index';

export interface Env {
  CHANNELS: DurableObjectNamespace<Channel>;
}

export type StoredMessage = {
  seq: number;
  ciphertext: string;
  createdAt: number;
  expiresAt: number;
};

export type ChannelState = {
  lastSeq: number;
  droppedThrough: number;
};
