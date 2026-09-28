import { describe, expect, it } from "vitest";
import { isPrivateAddress, isPrivateHost, normalizeHost } from "./net";

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1",
    "127.255.255.254",
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "0.0.0.0",
    "0.1.2.3",
    "100.64.0.1",
    "100.127.255.255",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "[::1]",
    "fc00::1",
    "fdff:ffff::1",
    "fe80::1",
    "fe80::1%eth0",
    "febf::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "[::ffff:7f00:1]",
    "::ffff:10.0.0.1",
    "::ffff:192.168.0.1",
    "0:0:0:0:0:ffff:a9fe:a9fe",
    "::127.0.0.1",
    "64:ff9b::7f00:1",
    "2002:7f00:1::",
    "192.0.2.1",
    "198.51.100.7",
    "203.0.113.200",
    "192.88.99.1",
    "::ffff:0:808:808",
    "::ffff:0:1.2.3.4",
    "64:ff9b:1::808:808",
    "2001::1",
    "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    "100::1",
    "100::ffff:ffff:ffff:ffff",
    "2001:db8::1",
    "[2001:db8::1]",
    "3fff::1",
    "3fff:fff:ffff::1",
    "5f00::1",
    "5f00:ffff::1",
    "2001:10::1",
    "2001:1f:ffff::1",
    "2001:20::1",
    "2001:2f:ffff::1",
  ])("%s is private", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "93.184.216.34",
    "172.15.255.255",
    "172.32.0.1",
    "100.63.255.255",
    "100.128.0.1",
    "169.253.0.1",
    "11.0.0.1",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
    "::ffff:8.8.8.8",
    "::ffff:808:808",
    "64:ff9b::808:808",
    "2002:808:808::",
    "192.0.3.1",
    "198.51.101.1",
    "203.0.114.1",
    "2001:470::1",
    "2001:db9::1",
    "100:0:0:1::1",
    "3fff:1000::1",
    "3ffe::1",
    "5f01::1",
    "2001:f::1",
    "2001:30::1",
  ])("%s is public", (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });

  it.each([
    "",
    "localhost",
    "example.com",
    "2130706433",
    "0x7f.1",
    "127.1",
    "0177.0.0.1",
    "256.0.0.1",
    "1:2:3:4:5:6:7:8:9",
    "1::2::3",
    "gggg::1",
  ])("%s is not an IP address and fails closed", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });
});

describe("normalizeHost", () => {
  it.each([
    ["127.1", "127.0.0.1"],
    ["2130706433", "127.0.0.1"],
    ["0x7f.0.0.1", "127.0.0.1"],
    ["[0:0:0:0:0:0:0:1]", "::1"],
    ["0:0:0:0:0:0:0:1", "::1"],
    ["[::FFFF:127.0.0.1]", "::ffff:7f00:1"],
    ["Example.COM.", "example.com"],
    ["bücher.example", "xn--bcher-kva.example"],
    ["", ""],
  ])("%s becomes %s", (host, want) => {
    expect(normalizeHost(host)).toBe(want);
  });
});

describe("isPrivateHost", () => {
  it.each([
    "localhost",
    "api.localhost",
    "localhost.",
    "127.1",
    "2130706433",
    "0x7f.0.0.1",
    "0177.0.0.1",
    "[::ffff:7f00:1]",
    "[0:0:0:0:0:0:0:1]",
    "198.18.0.1",
    "198.19.255.255",
    "224.0.0.1",
    "239.255.255.255",
    "240.0.0.1",
    "192.0.0.8",
    "64:ff9b::a00:1",
    "[64:ff9b::7f00:1]",
    "2002:c0a8:101::",
    "[2002:7f00:1::]",
  ])("%s is private", (host) => {
    expect(isPrivateHost(host)).toBe(true);
  });

  it.each([
    "api.github.com",
    "fdic.gov",
    "fe80.example",
    "fc00.example",
    "example.com.",
    "8.8.8.8",
    "198.20.0.1",
    "[2606:4700:4700::1111]",
    "64:ff9b::808:808",
  ])("%s is public", (host) => {
    expect(isPrivateHost(host)).toBe(false);
  });
});
