import { lookup } from 'dns/promises'
import net from 'net'

/**
 * SSRF guard for outbound fetches driven by user- or model-supplied URLs.
 *
 * The fetch tool (lib/tools/fetch.ts) retrieves arbitrary URLs a user names in
 * their message. Before this guard there was NO validation: a request for
 * `http://169.254.169.254/…` (cloud metadata) or an internal service was
 * dispatched server-side, and the URL was even forwarded to external scrapers
 * (Firecrawl/Jina). On a cloud host that is credential theft.
 *
 * What this closes, reliably and without any network dependency:
 *   - non-http(s) schemes (file:, gopher:, data:, …)
 *   - literal loopback / private / link-local / reserved IPs (v4, v6, and
 *     v4-mapped-v6), which is where 169.254.169.254 and 127.0.0.1 live
 *   - the `localhost` family and known metadata hostnames
 *
 * Best-effort, DNS-dependent:
 *   - a public hostname that RESOLVES to a private address (basic DNS
 *     rebinding). Checked when DNS resolves; a resolver failure is allowed
 *     through, because the real fetch would then fail anyway and blocking on a
 *     transient DNS hiccup would deny legitimate public sites.
 *
 * NOT covered (documented residual, not silently ignored):
 *   - redirect-based SSRF (a public URL that 302s to a private one) — the
 *     rescue chain follows redirects across several external tiers; fully
 *     closing it means manual redirect handling in each and is a separate change
 *   - DNS rebinding across the check→connect window (TOCTOU), and any resolver
 *     mismatch between this process and the actual fetch egress
 */

export class SsrfBlockedError extends Error {
  constructor(
    public readonly url: string,
    public readonly reason: string
  ) {
    super(`Blocked outbound request to ${url}: ${reason}`)
    this.name = 'SsrfBlockedError'
  }
}

/** How long to wait on the rebinding DNS check before allowing through. */
const DNS_TIMEOUT_MS = 3000

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data' // AWS/GCP legacy metadata alias
])

/** Parse a dotted-quad into a uint32, or null if not a well-formed IPv4. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const b = Number(p)
    if (b > 255) return null
    n = n * 256 + b
  }
  return n >>> 0
}

/** CIDR ranges that must never be reached from a server-side fetch. */
const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local — cloud metadata lives here
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4] // reserved / broadcast
]

function isPrivateV4(ip: string): boolean {
  const addr = ipv4ToInt(ip)
  if (addr === null) return false
  for (const [base, bits] of BLOCKED_V4) {
    const baseInt = ipv4ToInt(base)!
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
    if ((addr & mask) === (baseInt & mask)) return true
  }
  return false
}

/**
 * Expand an IPv6 string to its 16 bytes, or null if unparseable. Handles `::`
 * compression, an embedded dotted-quad tail, and the hex form Node's URL
 * normalises v4-mapped addresses into (`::ffff:7f00:1`). Working on bytes rather
 * than the string is what makes the range checks below immune to which textual
 * form the input arrived in.
 */
function ipv6ToBytes(raw: string): number[] | null {
  let ip = raw.toLowerCase().replace(/^\[|\]$/g, '')
  if (ip.includes('%')) ip = ip.slice(0, ip.indexOf('%')) // strip zone id

  // A trailing dotted-quad (::ffff:1.2.3.4) becomes two hextets.
  const v4Tail = ip.match(/(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (v4Tail) {
    const v4 = ipv4ToInt(v4Tail[1])
    if (v4 === null) return null
    const hi = ((v4 >>> 16) & 0xffff).toString(16)
    const lo = (v4 & 0xffff).toString(16)
    ip = ip.slice(0, v4Tail.index) + `${hi}:${lo}`
  }

  const halves = ip.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const groups: string[] =
    halves.length === 2
      ? [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail]
      : head
  if (groups.length !== 8) return null

  const bytes: number[] = []
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null
    const v = parseInt(g, 16)
    bytes.push((v >> 8) & 0xff, v & 0xff)
  }
  return bytes
}

function isPrivateV6(raw: string): boolean {
  const b = ipv6ToBytes(raw)
  if (!b) return false

  // Unspecified (::) and loopback (::1).
  if (
    b.every((x, i) => (i < 15 ? x === 0 : true)) &&
    (b[15] === 0 || b[15] === 1)
  )
    return true

  // v4-mapped ::ffff:0:0/96 and v4-translated 64:ff9b::/96 — defer to v4 rules
  // on the embedded address.
  const embeddedV4 = `${b[12]}.${b[13]}.${b[14]}.${b[15]}`
  if (b.slice(0, 10).every(x => x === 0) && b[10] === 0xff && b[11] === 0xff)
    return isPrivateV4(embeddedV4)

  // Unique local fc00::/7 and link-local fe80::/10.
  if ((b[0] & 0xfe) === 0xfc) return true
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true

  return false
}

/**
 * Synchronous, network-free checks. Returns a reason if the URL must be
 * blocked outright, or null if it needs (or passes) the DNS check.
 */
export function staticBlockReason(rawUrl: string): string | null {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return 'malformed URL'
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return `scheme ${u.protocol} not allowed`
  }

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')

  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.localhost')) {
    return 'internal hostname'
  }

  const family = net.isIP(host)
  if (family === 4 && isPrivateV4(host)) return 'private or reserved IPv4'
  if (family === 6 && isPrivateV6(host)) return 'private or reserved IPv6'

  return null
}

/**
 * Full check: static rules, then a best-effort DNS resolution to catch a public
 * hostname that resolves to a private address. Throws SsrfBlockedError when the
 * target must not be reached.
 */
export async function assertUrlAllowed(rawUrl: string): Promise<void> {
  const staticReason = staticBlockReason(rawUrl)
  if (staticReason) throw new SsrfBlockedError(rawUrl, staticReason)

  const host = new URL(rawUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '')

  // A literal IP already passed the static check above — nothing to resolve.
  if (net.isIP(host)) return

  let addresses: Array<{ address: string; family: number }>
  try {
    // Bounded: a hanging resolver must not tie the request up. On timeout or
    // failure we allow — the literal-target cases that are the actual threat
    // are already handled synchronously above without any DNS, and a host whose
    // DNS does not answer promptly is not fetchable anyway.
    addresses = await Promise.race([
      lookup(host, { all: true }),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('dns lookup timeout')), DNS_TIMEOUT_MS)
      )
    ])
  } catch {
    return
  }

  for (const { address, family } of addresses) {
    const isPrivate = family === 4 ? isPrivateV4(address) : isPrivateV6(address)
    if (isPrivate) {
      throw new SsrfBlockedError(
        rawUrl,
        'hostname resolves to a private address'
      )
    }
  }
}
