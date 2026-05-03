import test from "node:test";
import assert from "node:assert/strict";

import { normalizeHeartbeat, parseCsvLine, validateHeartbeat } from "../src/heartbeat.js";
import { requireBearerToken } from "../src/http.js";

test("validateHeartbeat accepts PiBoatCore payloads", () => {
  const errors = validateHeartbeat({
    boat_id: "my-boat",
    device_id: "raspberry-pi-bridge",
    sequence: 1,
    sent_at: "2026-04-28T12:00:00Z",
    status: "ok",
    sensors: {
      gps: { status: "ok" },
    },
  });

  assert.deepEqual(errors, []);
});

test("validateHeartbeat reports missing required fields", () => {
  const errors = validateHeartbeat({});

  assert(errors.includes("boat_id is required"));
  assert(errors.includes("device_id is required"));
  assert(errors.includes("sent_at must be an ISO timestamp"));
  assert(errors.includes("sensors must be an object"));
});

test("normalizeHeartbeat trims ids and adds received_at", () => {
  const heartbeat = normalizeHeartbeat(
    {
      boat_id: " my-boat ",
      device_id: " pi ",
      sent_at: "2026-04-28T12:00:00Z",
      sensors: {},
    },
    new Date("2026-04-28T12:01:00Z"),
  );

  assert.equal(heartbeat.boat_id, "my-boat");
  assert.equal(heartbeat.device_id, "pi");
  assert.equal(heartbeat.received_at, "2026-04-28T12:01:00.000Z");
});

test("validateHeartbeat accepts compact telemetry payloads", () => {
  const errors = validateHeartbeat({
    t: "1,lukas-glasply,pi-bridge-1,6,2026-05-03T04:42:57Z,ok,ok,150.8,ok,0,-85,1,Dark Star,LTE,1,45.5880914,-122.7043979,0,,22.8",
  });

  assert.deepEqual(errors, []);
});

test("normalizeHeartbeat expands compact telemetry payloads", () => {
  const heartbeat = normalizeHeartbeat(
    {
      t: "1,lukas-glasply,pi-bridge-1,6,2026-05-03T04:42:57Z,ok,ok,150.8,ok,0,-85,1,Dark Star,LTE,1,45.5880914,-122.7043979,0,,22.8",
    },
    new Date("2026-05-03T04:43:00Z"),
  );

  assert.equal(heartbeat.boat_id, "lukas-glasply");
  assert.equal(heartbeat.device_id, "pi-bridge-1");
  assert.equal(heartbeat.sequence, 6);
  assert.equal(heartbeat.wire_format, "compact_csv");
  assert.equal(heartbeat.sensors.sim7600.signal.rssi_dbm, -85);
  assert.equal(heartbeat.sensors.sim7600.registration.registered, true);
  assert.equal(heartbeat.sensors.sim7600.gnss.latitude, 45.5880914);
  assert.equal(heartbeat.sensors.sim7600.gnss.course_degrees, null);
});

test("parseCsvLine handles quoted commas", () => {
  assert.deepEqual(parseCsvLine('1,"boat, one",pi'), ["1", "boat, one", "pi"]);
});

test("requireBearerToken enforces configured API token", () => {
  assert.equal(requireBearerToken({ headers: {} }, ""), true);
  assert.equal(requireBearerToken({ headers: {} }, "secret"), false);
  assert.equal(requireBearerToken({ headers: { authorization: "Bearer secret" } }, "secret"), true);
  assert.equal(requireBearerToken({ headers: { authorization: "Bearer wrong" } }, "secret"), false);
});
