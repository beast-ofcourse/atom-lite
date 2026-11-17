import { test } from "node:test";
import assert from "node:assert/strict";
import { findLanAddress, isPrivateIpv4 } from "../../dist/web/lan.js";

function entry(address, internal = false) {
  return {
    address,
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:00:00:00:00:00",
    internal,
    cidr: `${address}/24`,
  };
}

test("private IPv4 ranges are recognized", () => {
  assert.equal(isPrivateIpv4("192.168.1.20"), true);
  assert.equal(isPrivateIpv4("10.0.0.4"), true);
  assert.equal(isPrivateIpv4("172.16.0.2"), true);
  assert.equal(isPrivateIpv4("172.31.255.1"), true);
  assert.equal(isPrivateIpv4("172.32.0.1"), false);
  assert.equal(isPrivateIpv4("8.8.8.8"), false);
  assert.equal(isPrivateIpv4("not-an-ip"), false);
});

test("the most likely home or office address wins", () => {
  const address = findLanAddress({
    wlan0: [entry("10.1.2.3")],
    eth0: [entry("192.168.1.44")],
    lo: [entry("127.0.0.1", true)],
  });
  assert.equal(address, "192.168.1.44");
});

test("internal and public addresses are ignored", () => {
  const address = findLanAddress({
    lo: [entry("127.0.0.1", true)],
    eth0: [entry("8.8.8.8")],
  });
  assert.equal(address, undefined);
});

test("link-local addresses are a last resort", () => {
  const address = findLanAddress({
    eth0: [entry("169.254.10.2")],
    wlan0: [entry("172.20.0.5")],
  });
  assert.equal(address, "172.20.0.5");
});
