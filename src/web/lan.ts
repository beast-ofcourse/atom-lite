import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

export type InterfaceMap = NodeJS.Dict<NetworkInterfaceInfo[]>;

/** RFC 1918 and link-local IPv4 ranges; loopback is excluded separately. */
export function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return false;
  }
  const [a, b] = parts;
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

/**
 * Pick the most likely LAN address for a phone on the same network.
 * Prefer common home/office ranges, then any other private IPv4.
 */
export function findLanAddress(
  interfaces: InterfaceMap = networkInterfaces(),
): string | undefined {
  const addresses: string[] = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (!isPrivateIpv4(entry.address)) continue;
      addresses.push(entry.address);
    }
  }
  const rank = (address: string): number =>
    address.startsWith("192.168.")
      ? 0
      : address.startsWith("10.")
        ? 1
        : address.startsWith("172.")
          ? 2
          : 3;
  return addresses.sort((left, right) => rank(left) - rank(right))[0];
}
