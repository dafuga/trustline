import type { Identity } from '@dafuga/trustline-protocol'
import { CliError, ExitCode } from './errors.js'
import { Home, type Peer } from './home.js'
import { RelayClient } from './relay-client.js'

/** A placeholder until a relay exists. `<account>` is the Cloudflare workers.dev subdomain. */
export const DEFAULT_RELAY_URL = 'wss://trustline-relay.<account>.workers.dev'
export const LOCAL_RELAY_URL = 'ws://127.0.0.1:8787'

export interface Context {
  home: Home
  identity: Identity
  relayUrl: string
  name: string
  now: () => number
}

export interface Flags {
  relay?: string
  name?: string
}

export async function loadContext(env: NodeJS.ProcessEnv, flags: Flags): Promise<Context> {
  const home = await Home.open(env)
  const identity = await home.identity()
  const config = await home.config()
  const relayUrl = flags.relay ?? env.TRUSTLINE_RELAY_URL ?? config.relayUrl ?? DEFAULT_RELAY_URL
  const name = flags.name ?? config.name ?? `device-${identity.deviceId.slice(0, 6)}`
  if (flags.relay !== config.relayUrl && flags.relay) await home.saveConfig({ ...config, relayUrl: flags.relay })
  return { home, identity, relayUrl, name, now: Date.now }
}

function assertRelayConfigured(relayUrl: string): void {
  if (!relayUrl.includes('<account>')) return
  throw new CliError(
    ExitCode.RELAY_UNAVAILABLE,
    'relay_not_configured',
    `No relay is set: ${relayUrl} is a placeholder. ` +
      'Set TRUSTLINE_RELAY_URL or pass --relay <url> with your own relay. ' +
      `For local development, run \`trustline relay dev\` and use ${LOCAL_RELAY_URL}.`,
  )
}

export async function withRelay<T>(context: Context, run: (client: RelayClient) => Promise<T>): Promise<T> {
  assertRelayConfigured(context.relayUrl)
  const client = await RelayClient.connect(context.relayUrl, context.identity)
  try {
    return await run(client)
  } finally {
    client.close()
  }
}

/** Finds a peer by device id or by the name shown in `status`. */
export function findPeer(peers: Peer[], reference: string, role: Peer['role']): Peer {
  const candidates = peers.filter((peer) => peer.role === role)
  const byId = candidates.find((peer) => peer.id === reference)
  if (byId) return byId
  const lower = reference.toLowerCase()
  const byName = candidates.filter((peer) => peer.name.toLowerCase() === lower)
  const active = byName.filter((peer) => peer.status === 'active')
  const matches = active.length > 0 ? active : byName
  if (matches.length === 1 && matches[0]) return matches[0]
  if (matches.length > 1) {
    throw new CliError(ExitCode.CONFLICT, 'ambiguous_name', `More than one ${role} is named "${reference}"; use the id`)
  }
  throw new CliError(ExitCode.NOT_FOUND, `${role}_not_found`, `No ${role} matches "${reference}"`)
}

/** Patches a peer in its latest stored form, so callers can't write back a stale copy. */
export async function updatePeer(home: Home, id: string, patch: Partial<Peer>): Promise<void> {
  const peers = await home.peers()
  await home.savePeers(peers.map((peer) => (peer.id === id ? { ...peer, ...patch } : peer)))
}
