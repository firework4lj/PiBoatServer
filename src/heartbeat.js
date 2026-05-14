export function validateHeartbeat(payload) {
  const errors = [];

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return ["payload must be an object"];
  }

  if (typeof payload.t === "string") {
    return validateCompactHeartbeat(payload);
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
  if (typeof payload?.t === "string") {
    return normalizeCompactHeartbeat(payload, receivedAt);
  }

  return {
    ...payload,
    boat_id: payload.boat_id.trim(),
    device_id: payload.device_id.trim(),
    received_at: receivedAt.toISOString(),
  };
}

export function validateCompactHeartbeat(payload) {
  const fields = parseCsvLine(payload.t);
  const errors = [];

  if (fields[0] !== "1") {
    errors.push("compact telemetry version must be 1");
  }

  if (!fields[1]) {
    errors.push("boat_id is required");
  }

  if (!fields[2]) {
    errors.push("device_id is required");
  }

  if (!fields[3] || Number.isNaN(Number(fields[3]))) {
    errors.push("sequence must be a number");
  }

  if (!fields[4] || Number.isNaN(Date.parse(fields[4]))) {
    errors.push("sent_at must be an ISO timestamp");
  }

  return errors;
}

export function normalizeCompactHeartbeat(payload, receivedAt = new Date()) {
  const fields = parseCsvLine(payload.t);
  const [
    version,
    boatId,
    deviceId,
    sequence,
    sentAt,
    status,
    systemStatus,
    uptimeSeconds,
    modemStatus,
    consecutiveFailures,
    rssiDbm,
    registered,
    operatorName,
    systemMode,
    gnssFix,
    latitude,
    longitude,
    speedKnots,
    courseDegrees,
    altitudeMeters,
    voltageStatus,
    voltage,
    charging,
    socEstimatePercent,
    audioStatus,
    audioState,
    audioRmsDb,
    audioPeakDb,
    audioImpactCount,
    audioPeakOverRmsDb,
  ] = fields;

  return {
    boat_id: boatId.trim(),
    device_id: deviceId.trim(),
    sequence: Number(sequence),
    sent_at: sentAt,
    status: status || "unknown",
    wire_format: "compact_csv",
    wire_version: Number(version),
    sensors: {
      system: {
        status: systemStatus || "unknown",
        uptime_seconds: numberOrNull(uptimeSeconds),
      },
      sim7600: {
        status: modemStatus || "unknown",
        consecutive_failures: numberOrNull(consecutiveFailures),
        signal: {
          rssi_dbm: numberOrNull(rssiDbm),
        },
        registration: {
          registered: registered === "1",
        },
        operator: {
          name: operatorName || null,
        },
        network: {
          system_mode: systemMode || null,
        },
        gnss: {
          fix: gnssFix === "1",
          latitude: numberOrNull(latitude),
          longitude: numberOrNull(longitude),
          speed_knots: numberOrNull(speedKnots),
          course_degrees: numberOrNull(courseDegrees),
          altitude_meters: numberOrNull(altitudeMeters),
        },
      },
      arduino_voltage: {
        status: voltageStatus || "unknown",
        voltage: numberOrNull(voltage),
        charging: charging === "1",
        soc_estimate_percent: numberOrNull(socEstimatePercent),
      },
      audio_activity: {
        status: audioStatus || "unknown",
        state: audioState || null,
        rms_db: numberOrNull(audioRmsDb),
        peak_db: numberOrNull(audioPeakDb),
        impact_count_1m: numberOrNull(audioImpactCount),
        peak_over_rms_db: numberOrNull(audioPeakOverRmsDb),
      },
    },
    received_at: receivedAt.toISOString(),
  };
}

export function parseCsvLine(line) {
  const fields = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      field += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      fields.push(field);
      field = "";
      continue;
    }

    field += char;
  }

  fields.push(field);
  return fields;
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const number = Number(value);
  return Number.isNaN(number) ? null : number;
}
