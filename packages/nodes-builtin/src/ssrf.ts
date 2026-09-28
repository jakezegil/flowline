/**
 * Address classification for the SSRF guard of `ctx.http.fetch`. Pure: no DNS, no Node built-ins.
 *
 * @module
 */

type Cidr4 = readonly [base: number, prefix: number];

const v4 = (a: number, b: number, c: number, d: number): number =>
  ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;

/** IPv4 ranges that are not publicly routable (RFC 6890 and friends). */
const PRIVATE_V4: readonly Cidr4[] = [
  [v4(0, 0, 0, 0), 8], // "this" network
  [v4(10, 0, 0, 0), 8], // private
  [v4(100, 64, 0, 0), 10], // carrier-grade NAT
  [v4(127, 0, 0, 0), 8], // loopback
  [v4(169, 254, 0, 0), 16], // link-local (cloud metadata)
  [v4(172, 16, 0, 0), 12], // private
  [v4(192, 0, 0, 0), 24], // IETF protocol assignments
  [v4(192, 0, 2, 0), 24], // documentation (TEST-NET-1)
  [v4(192, 88, 99, 0), 24], // deprecated 6to4 relay anycast
  [v4(192, 168, 0, 0), 16], // private
  [v4(198, 18, 0, 0), 15], // benchmarking
  [v4(198, 51, 100, 0), 24], // documentation (TEST-NET-2)
  [v4(203, 0, 113, 0), 24], // documentation (TEST-NET-3)
  [v4(224, 0, 0, 0), 4], // multicast
  [v4(240, 0, 0, 0), 4], // reserved, broadcast
];

function inCidr4(ip: number, [base, prefix]: Cidr4): boolean {
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return (ip & mask) >>> 0 === (base & mask) >>> 0;
}

/** Parses strict dotted-quad IPv4 (`a.b.c.d`, decimal octets) into a 32-bit number. */
function parseV4(s: string): number | undefined {
  const parts = s.split(".");
  if (parts.length !== 4) return undefined;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return undefined;
    const octet = Number(p);
    if (octet > 255) return undefined;
    n = n * 256 + octet;
  }
  return n;
}

/** Parses IPv6 (with `::`, an optional trailing dotted IPv4 and zone ID) into eight 16-bit groups. */
function parseV6(s: string): number[] | undefined {
  let text = s;
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  const tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  if (text.slice(lastColon + 1).includes(".")) {
    const n4 = parseV4(text.slice(lastColon + 1));
    if (n4 === undefined) return undefined;
    tail.push(n4 >>> 16, n4 & 0xffff);
    text = text.slice(0, lastColon + 1);
    if (!text.endsWith("::")) text = text.slice(0, -1);
  }
  const toGroups = (h: string): number[] | undefined => {
    if (h === "") return [];
    const out: number[] = [];
    for (const g of h.split(":")) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return undefined;
      out.push(Number.parseInt(g, 16));
    }
    return out;
  };
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const head = toGroups(halves[0] ?? "");
  if (!head) return undefined;
  if (halves.length === 1) {
    const all = [...head, ...tail];
    return all.length === 8 ? all : undefined;
  }
  const rest = toGroups(halves[1] ?? "");
  if (!rest) return undefined;
  const zeros = 8 - head.length - rest.length - tail.length;
  if (zeros < 1) return undefined;
  return [...head, ...new Array<number>(zeros).fill(0), ...rest, ...tail];
}

function embeddedV4(hi: number, lo: number): number {
  return ((hi << 16) | lo) >>> 0;
}

function isPrivateV6(g: number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  const firstFiveZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  // ::/128 unspecified, ::1 loopback, ::a.b.c.d IPv4-compatible (deprecated).
  if (firstFiveZero && g5 === 0) return g6 === 0 || isPrivateV4(embeddedV4(g6, g7));
  // ::ffff:a.b.c.d IPv4-mapped.
  if (firstFiveZero && g5 === 0xffff) return isPrivateV4(embeddedV4(g6, g7));
  // 64:ff9b::/96 NAT64 with an embedded IPv4.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isPrivateV4(embeddedV4(g6, g7));
  }
  // ::ffff:0:0/96 IPv4-translated (SIIT).
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) return true;
  // 64:ff9b:1::/48 local-use NAT64.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return true;
  // 100::/64 discard-only.
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true;
  // 2001::/32 Teredo, 2001:db8::/32 documentation.
  if (g0 === 0x2001 && (g1 === 0 || g1 === 0xdb8)) return true;
  // 2002::/16 6to4 with an embedded IPv4.
  if (g0 === 0x2002) return isPrivateV4(embeddedV4(g1, g2));
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

function isPrivateV4(n: number): boolean {
  return PRIVATE_V4.some((c) => inCidr4(n, c));
}

/**
 * Whether `ip` is an address `ctx.http.fetch` must not connect to by default: loopback
 * (127/8, ::1), private (10/8, 172.16/12, 192.168/16, fc00::/7), link-local (169.254/16,
 * fe80::/10), "this network" (0/8, ::), carrier-grade NAT (100.64/10), multicast, documentation
 * (192.0.2/24, 198.51.100/24, 203.0.113/24, 2001:db8::/32), Teredo (2001::/32), discard
 * (100::/64), IPv4-translated (::ffff:0:0/96), local-use NAT64 (64:ff9b:1::/48), other reserved
 * ranges, and IPv6 forms embedding such an IPv4 address (`::ffff:127.0.0.1`, NAT64, 6to4).
 *
 * Accepts dotted-quad IPv4 and IPv6 (optionally in brackets, with a zone ID). Fails closed:
 * anything that is not a valid IP address returns `true`.
 *
 * @example
 * ```ts
 * isPrivateAddress("10.1.2.3"); // true
 * isPrivateAddress("[::ffff:7f00:1]"); // true
 * isPrivateAddress("93.184.216.34"); // false
 * ```
 */
export function isPrivateAddress(ip: string): boolean {
  let s = ip.trim();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const n4 = parseV4(s);
  if (n4 !== undefined) return isPrivateV4(n4);
  const g6 = s.includes(":") ? parseV6(s) : undefined;
  if (g6 !== undefined) return isPrivateV6(g6);
  return true;
}
