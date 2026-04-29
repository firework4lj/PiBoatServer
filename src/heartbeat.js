export function validateHeartbeat(payload) {
  const errors = [];

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return ["payload must be an object"];
  }

  if (typeof payload.boat_id !== "string" || payload.boat_id.trim() === "") {
    errors.push("boat_id is required");
  }

  if (typeof payload.device_id !== "string" || payload.device_id.trim() === "") {
    errors.push("device_id is required");
  }

  if (typeof payload.sent_at !== "string" || Number.isNaN(Date.parse(payload.sent_at))) {
    errors.push("sent_at must be an ISO timestamp");
  }

  if (payload.sequence !== undefined && typeof payload.sequence !== "number") {
    errors.push("sequence must be a number");
  }

  if (!payload.sensors || typeof payload.sensors !== "object" || Array.isArray(payload.sensors)) {
    errors.push("sensors must be an object");
  }

  return errors;
}

export function normalizeHeartbeat(payload, receivedAt = new Date()) {
  return {
    ...payload,
    boat_id: payload.boat_id.trim(),
    device_id: payload.device_id.trim(),
    received_at: receivedAt.toISOString(),
  };
}
