import { test } from "node:test";
import assert from "node:assert/strict";
import { accessPolicy, hostnameOf } from "../security.js";

const policy = accessPolicy({ webOrigin: "http://localhost:5173", port: 3001 });

test("hostnameOf", () => {
  assert.equal(hostnameOf("localhost:5173"), "localhost");
  assert.equal(hostnameOf("[::1]:3001"), "[::1]");
  assert.equal(hostnameOf("127.0.0.1"), "127.0.0.1");
});

test("the mirror page, dev proxy, and voice service are allowed", () => {
  // Vite proxy forwards the page's Host + Origin
  assert.equal(policy.check({ host: "localhost:5173", origin: "http://localhost:5173" }), null);
  assert.equal(policy.check({ host: "127.0.0.1:5173", origin: "http://127.0.0.1:5173" }), null);
  // built page served by the server itself
  assert.equal(policy.check({ host: "localhost:3001", origin: "http://localhost:3001" }), null);
  // Python voice service: no Origin
  assert.equal(policy.check({ host: "127.0.0.1:3001" }), null);
  assert.equal(policy.check({ host: "[::1]:3001" }), null);
});

test("other websites are refused", () => {
  assert.equal(
    policy.check({ host: "localhost:3001", origin: "https://evil.example" }),
    "origin_not_allowed",
  );
  // sandboxed iframes / file:// pages send the literal "null"
  assert.equal(policy.check({ host: "localhost:3001", origin: "null" }), "origin_not_allowed");
});

test("DNS rebinding is refused (attacker hostname resolving to loopback)", () => {
  assert.equal(policy.check({ host: "evil.example:3001" }), "host_not_allowed");
  assert.equal(policy.check({ host: "192.168.1.20:3001" }), "host_not_allowed");
});

test("ALLOWED_HOSTS opens specific names only", () => {
  const lan = accessPolicy({
    webOrigin: "http://localhost:5173",
    port: 3001,
    allowedHosts: "mirror.local, 192.168.1.20",
  });
  assert.equal(lan.check({ host: "mirror.local:3001", origin: "http://mirror.local:3001" }), null);
  assert.equal(lan.check({ host: "192.168.1.20:3001" }), null);
  assert.equal(lan.check({ host: "192.168.1.21:3001" }), "host_not_allowed");
});
