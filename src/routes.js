import { readBody, readJson, requireBearerToken, sendJson } from "./http.js";
import { normalizeHeartbeat, validateHeartbeat } from "./heartbeat.js";
import { sendStatic } from "./static.js";

const liveCameraSessions = new Map();
const snapshotRequests = new Map();
const LIVE_CAMERA_DURATION_MS = 5 * 60 * 1000;
const LIVE_CAMERA_INTERVAL_SECONDS = 2;

export function createRouter({ config, store }) {
  return async function route(req, res) {
    const url = new URL(req.url, "http://localhost");

    try {
      if (req.method === "GET" && await sendStatic(res, url.pathname)) {
        return;
      }

      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { status: "ok" });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/heartbeat") {
        await handleHeartbeat(req, res, { config, store });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/snapshot") {
        await handleSnapshot(req, res, { config, store });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/audio-event") {
        await handleAudioEvent(req, res, { config, store });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/audio-event-snapshot") {
        await handleAudioEventSnapshot(req, res, { config, store });
        return;
      }

      const liveStartMatch = url.pathname.match(/^\/api\/boats\/([^/]+)\/live\/start$/);
      if (req.method === "POST" && liveStartMatch) {
        const boatId = decodeURIComponent(liveStartMatch[1]);
        sendJson(res, 202, startLiveCamera(boatId));
        return;
      }

      const liveStopMatch = url.pathname.match(/^\/api\/boats\/([^/]+)\/live\/stop$/);
      if (req.method === "POST" && liveStopMatch) {
        const boatId = decodeURIComponent(liveStopMatch[1]);
        liveCameraSessions.delete(boatId);
        sendJson(res, 202, { active: false });
        return;
      }

      const snapshotRequestMatch = url.pathname.match(/^\/api\/boats\/([^/]+)\/snapshot\/request$/);
      if (req.method === "POST" && snapshotRequestMatch) {
        const boatId = decodeURIComponent(snapshotRequestMatch[1]);
        sendJson(res, 202, requestSnapshot(boatId));
        return;
      }

      const liveStatusMatch = url.pathname.match(/^\/api\/boats\/([^/]+)\/live$/);
      if (req.method === "GET" && liveStatusMatch) {
        const boatId = decodeURIComponent(liveStatusMatch[1]);
        sendJson(res, 200, liveCameraStatus(boatId));
        return;
      }

      const latestMatch = url.pathname.match(/^\/api\/boats\/([^/]+)\/latest$/);
      if (req.method === "GET" && latestMatch) {
        const boatId = decodeURIComponent(latestMatch[1]);
        sendJson(res, 200, { boat_id: boatId, devices: await store.latestForBoat(boatId) });
        return;
      }

      const historyMatch = url.pathname.match(/^\/api\/boats\/([^/]+)\/history$/);
      if (req.method === "GET" && historyMatch) {
        const boatId = decodeURIComponent(historyMatch[1]);
        const limit = url.searchParams.get("limit") || 100;
        sendJson(res, 200, { boat_id: boatId, heartbeats: await store.historyForBoat(boatId, limit) });
        return;
      }
      if (req.method === "DELETE" && historyMatch) {
        await handleDeleteHistory(req, res, { config, store, url, boatId: decodeURIComponent(historyMatch[1]) });
        return;
      }

      const snapshotLatestMatch = url.pathname.match(/^\/api\/boats\/([^/]+)\/snapshot\/latest$/);
      if (req.method === "GET" && snapshotLatestMatch) {
        const boatId = decodeURIComponent(snapshotLatestMatch[1]);
        sendJson(res, 200, { boat_id: boatId, snapshot: await store.latestSnapshotForBoat(boatId) });
        return;
      }

      const audioEventsMatch = url.pathname.match(/^\/api\/boats\/([^/]+)\/audio-events$/);
      if (req.method === "GET" && audioEventsMatch) {
        const boatId = decodeURIComponent(audioEventsMatch[1]);
        const limit = url.searchParams.get("limit") || 10;
        sendJson(res, 200, { boat_id: boatId, events: await store.recentAudioEventsForBoat(boatId, limit) });
        return;
      }

      const audioFileMatch = url.pathname.match(/^\/api\/boats\/([^/]+)\/devices\/([^/]+)\/audio\/([^/]+)\.wav$/);
      if (req.method === "GET" && audioFileMatch) {
        const boatId = decodeURIComponent(audioFileMatch[1]);
        const deviceId = decodeURIComponent(audioFileMatch[2]);
        const eventId = decodeURIComponent(audioFileMatch[3]);
        const audio = await store.audioEventFile(boatId, deviceId, eventId);
        if (!audio) {
          sendJson(res, 404, { error: "audio event not found" });
          return;
        }
        res.writeHead(200, {
          "Content-Type": "audio/wav",
          "Content-Length": audio.length,
          "Cache-Control": "no-cache",
        });
        res.end(audio);
        return;
      }

      const audioImageMatch = url.pathname.match(/^\/api\/boats\/([^/]+)\/devices\/([^/]+)\/audio\/([^/]+)\.jpg$/);
      if (req.method === "GET" && audioImageMatch) {
        const boatId = decodeURIComponent(audioImageMatch[1]);
        const deviceId = decodeURIComponent(audioImageMatch[2]);
        const eventId = decodeURIComponent(audioImageMatch[3]);
        const image = await store.audioEventImage(boatId, deviceId, eventId);
        if (!image) {
          sendJson(res, 404, { error: "audio event image not found" });
          return;
        }
        res.writeHead(200, {
          "Content-Type": "image/jpeg",
          "Content-Length": image.length,
          "Cache-Control": "no-cache",
        });
        res.end(image);
        return;
      }

      const snapshotImageMatch = url.pathname.match(/^\/api\/boats\/([^/]+)\/devices\/([^/]+)\/snapshot\.jpg$/);
      if (req.method === "GET" && snapshotImageMatch) {
        const boatId = decodeURIComponent(snapshotImageMatch[1]);
        const deviceId = decodeURIComponent(snapshotImageMatch[2]);
        const image = await store.snapshotImage(boatId, deviceId);
        if (!image) {
          sendJson(res, 404, { error: "snapshot not found" });
          return;
        }
        res.writeHead(200, {
          "Content-Type": "image/jpeg",
          "Content-Length": image.length,
          "Cache-Control": "no-cache",
        });
        res.end(image);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/boats") {
        sendJson(res, 200, { boats: await store.listBoats() });
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (error) {
      console.error(error);
      sendJson(res, 500, { error: "internal server error" });
    }
  };
}

async function handleDeleteHistory(req, res, { config, store, url, boatId }) {
  if (!requireBearerToken(req, config.apiToken)) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!start || !end || Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
    sendJson(res, 400, { error: "start and end ISO timestamps are required" });
    return;
  }

  const result = await store.deleteHistoryRangeForBoat(boatId, start, end);
  sendJson(res, 200, { status: "deleted", boat_id: boatId, ...result });
}

async function handleSnapshot(req, res, { config, store }) {
  if (!requireBearerToken(req, config.apiToken)) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  if (!req.headers["content-type"]?.startsWith("image/jpeg")) {
    sendJson(res, 415, { error: "snapshot must be image/jpeg" });
    return;
  }

  const boatId = req.headers["x-boat-id"];
  const deviceId = req.headers["x-device-id"];
  const sentAt = req.headers["x-sent-at"];
  if (!boatId || !deviceId || !sentAt || Number.isNaN(Date.parse(sentAt))) {
    sendJson(res, 400, { error: "snapshot metadata headers are required" });
    return;
  }

  let image;
  try {
    image = await readBody(req, { maxBodyBytes: config.maxSnapshotBytes });
  } catch (error) {
    sendJson(res, error.statusCode || 400, { error: error.message || "invalid snapshot body" });
    return;
  }

  const metadata = await store.saveSnapshot({
    boatId,
    deviceId,
    sentAt,
    receivedAt: new Date().toISOString(),
    image,
  });
  snapshotRequests.delete(boatId);

  console.log(
    JSON.stringify({
      event: "snapshot.received",
      boat_id: boatId,
      device_id: deviceId,
      bytes: image.length,
      received_at: metadata.received_at,
    }),
  );

  sendJson(res, 202, { status: "accepted", snapshot: metadata });
}

async function handleAudioEvent(req, res, { config, store }) {
  if (!requireBearerToken(req, config.apiToken)) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  if (!req.headers["content-type"]?.startsWith("audio/wav")) {
    sendJson(res, 415, { error: "audio event must be audio/wav" });
    return;
  }

  const boatId = req.headers["x-boat-id"];
  const deviceId = req.headers["x-device-id"];
  const sentAt = req.headers["x-sent-at"];
  const trigger = req.headers["x-trigger"] || "audio_event";
  if (!boatId || !deviceId || !sentAt || Number.isNaN(Date.parse(sentAt))) {
    sendJson(res, 400, { error: "audio event metadata headers are required" });
    return;
  }

  let audio;
  try {
    audio = await readBody(req, { maxBodyBytes: config.maxAudioEventBytes });
  } catch (error) {
    sendJson(res, error.statusCode || 400, { error: error.message || "invalid audio event body" });
    return;
  }

  const metadata = await store.saveAudioEvent({
    boatId,
    deviceId,
    sentAt,
    receivedAt: new Date().toISOString(),
    trigger,
    rmsDb: req.headers["x-rms-db"],
    peakDb: req.headers["x-peak-db"],
    peakOverRmsDb: req.headers["x-peak-over-rms-db"],
    durationSeconds: req.headers["x-duration-seconds"],
    audio,
  });

  console.log(
    JSON.stringify({
      event: "audio.received",
      boat_id: boatId,
      device_id: deviceId,
      trigger,
      bytes: audio.length,
      received_at: metadata.received_at,
    }),
  );

  sendJson(res, 202, { status: "accepted", audio_event: metadata });
}

async function handleAudioEventSnapshot(req, res, { config, store }) {
  if (!requireBearerToken(req, config.apiToken)) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  if (!req.headers["content-type"]?.startsWith("image/jpeg")) {
    sendJson(res, 415, { error: "audio event snapshot must be image/jpeg" });
    return;
  }

  const boatId = req.headers["x-boat-id"];
  const deviceId = req.headers["x-device-id"];
  const eventId = req.headers["x-event-id"];
  const sentAt = req.headers["x-sent-at"];
  if (!boatId || !deviceId || !eventId || !sentAt || Number.isNaN(Date.parse(sentAt))) {
    sendJson(res, 400, { error: "audio event snapshot metadata headers are required" });
    return;
  }

  let image;
  try {
    image = await readBody(req, { maxBodyBytes: config.maxSnapshotBytes });
  } catch (error) {
    sendJson(res, error.statusCode || 400, { error: error.message || "invalid audio event snapshot body" });
    return;
  }

  const metadata = await store.saveAudioEventSnapshot({
    boatId,
    deviceId,
    eventId,
    sentAt,
    receivedAt: new Date().toISOString(),
    image,
  });

  console.log(
    JSON.stringify({
      event: "audio.snapshot.received",
      boat_id: boatId,
      device_id: deviceId,
      event_id: eventId,
      bytes: image.length,
      received_at: metadata.image_received_at,
    }),
  );

  sendJson(res, 202, { status: "accepted", audio_event: metadata });
}

async function handleHeartbeat(req, res, { config, store }) {
  if (!requireBearerToken(req, config.apiToken)) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  let payload;
  try {
    payload = await readJson(req, { maxBodyBytes: config.maxBodyBytes });
  } catch (error) {
    sendJson(res, error.statusCode || 400, { error: error.message || "invalid json" });
    return;
  }

  const errors = validateHeartbeat(payload);
  if (errors.length > 0) {
    sendJson(res, 400, { error: "invalid heartbeat payload", details: errors });
    return;
  }

  const heartbeat = normalizeHeartbeat(payload);
  await store.save(heartbeat);
  const liveCamera = liveCameraStatus(heartbeat.boat_id);
  const snapshotRequest = snapshotRequestStatus(heartbeat.boat_id);

  console.log(
    JSON.stringify({
      event: "heartbeat.received",
      boat_id: heartbeat.boat_id,
      device_id: heartbeat.device_id,
      sequence: heartbeat.sequence,
      status: heartbeat.status,
      received_at: heartbeat.received_at,
    }),
  );

  sendJson(res, 202, {
    status: "accepted",
    commands: {
      camera_live: {
        active: liveCamera.active,
        interval_seconds: liveCamera.interval_seconds,
        until: liveCamera.until,
      },
      camera_snapshot: snapshotRequest,
    },
  });
}

function requestSnapshot(boatId) {
  const request = {
    requested: true,
    request_id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    requested_at: new Date().toISOString(),
  };
  snapshotRequests.set(boatId, request);
  return request;
}

function snapshotRequestStatus(boatId) {
  return snapshotRequests.get(boatId) || {
    requested: false,
    request_id: null,
    requested_at: null,
  };
}

function startLiveCamera(boatId) {
  const untilMs = Date.now() + LIVE_CAMERA_DURATION_MS;
  liveCameraSessions.set(boatId, untilMs);
  return liveCameraStatus(boatId);
}

function liveCameraStatus(boatId) {
  const untilMs = liveCameraSessions.get(boatId);
  if (!untilMs || untilMs <= Date.now()) {
    liveCameraSessions.delete(boatId);
    return {
      active: false,
      interval_seconds: null,
      until: null,
    };
  }

  return {
    active: true,
    interval_seconds: LIVE_CAMERA_INTERVAL_SECONDS,
    until: new Date(untilMs).toISOString(),
  };
}
