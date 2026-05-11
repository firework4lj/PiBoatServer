const TRACK_HISTORY_LIMIT = 25000;
const TRACK_MIN_DISTANCE_METERS = 25;
const TRACK_MAX_POINTS = 1200;

const elements = {
  boatName: document.querySelector("#trackBoatName"),
  meta: document.querySelector("#trackMeta"),
  distance: document.querySelector("#trackDistance"),
  averageSpeed: document.querySelector("#trackAverageSpeed"),
  maxSpeed: document.querySelector("#trackMaxSpeed"),
  movingTime: document.querySelector("#trackMovingTime"),
};

const map = L.map("trackMap", { zoomControl: true }).setView([45.58809, -122.7044], 13);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  tileSize: 256,
  zoomOffset: 0,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

const boatIcon = L.divIcon({
  className: "",
  html: '<div class="boat-marker">B</div>',
  iconSize: [34, 34],
  iconAnchor: [17, 17],
});

loadTrackMap().catch((error) => {
  console.error(error);
  elements.meta.textContent = "Unable to load track history";
});

async function loadTrackMap() {
  const boats = await fetchJson("/api/boats");
  const boatId = boats.boats[0]?.boat_id;
  if (!boatId) {
    elements.boatName.textContent = "No boats";
    elements.meta.textContent = "Waiting for telemetry";
    return;
  }

  elements.boatName.textContent = boatId;
  const latest = await fetchJson(`/api/boats/${encodeURIComponent(boatId)}/latest`);
  const history = await fetchJson(`/api/boats/${encodeURIComponent(boatId)}/history?limit=${TRACK_HISTORY_LIMIT}`);
  const records = Object.values(latest.devices || {});
  const newest = records.sort((a, b) => new Date(b.received_at) - new Date(a.received_at))[0];
  const rawPoints = history.heartbeats
    .map(trackPointFromRecord)
    .filter(Boolean)
    .sort((a, b) => a.timestamp - b.timestamp);
  const trackPoints = reduceTrackPoints(rawPoints);
  const stats = calculateTrackStats(trackPoints);

  renderTrack(trackPoints, newest);
  elements.meta.textContent = formatTrackMeta(rawPoints, trackPoints);
  renderTrackStats(stats);
}

async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}`);
  }
  return response.json();
}

function renderTrack(trackPoints, latestRecord) {
  const latestPosition = getPosition(latestRecord);
  if (latestPosition) {
    L.marker([latestPosition.latitude, latestPosition.longitude], { icon: boatIcon }).addTo(map);
  }

  if (trackPoints.length > 1) {
    const latLngs = trackPoints.map((point) => [point.latitude, point.longitude]);
    const track = L.polyline(latLngs, {
      color: "#0f5f78",
      opacity: 0.85,
      weight: 3,
    }).addTo(map);
    map.fitBounds(track.getBounds(), { maxZoom: 15, padding: [28, 28] });
    return;
  }

  if (latestPosition) {
    map.setView([latestPosition.latitude, latestPosition.longitude], 15);
  }
}

function trackPointFromRecord(record) {
  const position = getPosition(record);
  const timestamp = new Date(record?.received_at || record?.sent_at).getTime();
  if (!position || !Number.isFinite(timestamp)) {
    return null;
  }

  return {
    ...position,
    timestamp,
    speedKnots: record.sensors?.sim7600?.gnss?.speed_knots ?? record.sensors?.gps?.speed_knots,
  };
}

function reduceTrackPoints(points) {
  if (points.length <= 2) {
    return points;
  }

  const reduced = [points[0]];
  points.slice(1, -1).forEach((point) => {
    const previous = reduced.at(-1);
    const movedMeters = distanceMeters(previous, point);
    const underway = Number.isFinite(point.speedKnots) && point.speedKnots >= 1;
    if (movedMeters >= TRACK_MIN_DISTANCE_METERS || underway) {
      reduced.push(point);
    }
  });

  const last = points.at(-1);
  if (distanceMeters(reduced.at(-1), last) > 0) {
    reduced.push(last);
  }

  if (reduced.length <= TRACK_MAX_POINTS) {
    return reduced;
  }

  const stride = Math.ceil(reduced.length / TRACK_MAX_POINTS);
  return reduced.filter((_, index) => index === 0 || index === reduced.length - 1 || index % stride === 0);
}

function calculateTrackStats(points) {
  let distanceMetersTotal = 0;
  let movingTimeMs = 0;
  let elapsedMs = 0;
  let maxSpeedKnots = null;

  if (points.length >= 2) {
    elapsedMs = points.at(-1).timestamp - points[0].timestamp;
  }

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const distance = distanceMeters(previous, current);
    const intervalMs = current.timestamp - previous.timestamp;
    const derivedSpeedKnots = intervalMs > 0 ? metersPerSecondToKnots(distance / (intervalMs / 1000)) : null;
    const speedKnots = Number.isFinite(current.speedKnots) ? current.speedKnots : derivedSpeedKnots;

    if (distance >= TRACK_MIN_DISTANCE_METERS) {
      distanceMetersTotal += distance;
    }

    if (intervalMs > 0 && (distance >= TRACK_MIN_DISTANCE_METERS || speedKnots >= 1)) {
      movingTimeMs += intervalMs;
    }

    if (Number.isFinite(speedKnots)) {
      maxSpeedKnots = Math.max(maxSpeedKnots ?? 0, speedKnots);
    }
  }

  const movingHours = movingTimeMs / (60 * 60 * 1000);
  const averageMovingSpeedKnots = movingHours > 0 ? metersToNauticalMiles(distanceMetersTotal) / movingHours : null;

  return {
    distanceMeters: distanceMetersTotal,
    elapsedMs,
    movingTimeMs,
    averageMovingSpeedKnots,
    maxSpeedKnots,
  };
}

function renderTrackStats(stats) {
  elements.distance.textContent = formatDistance(stats.distanceMeters);
  elements.averageSpeed.textContent = formatKnots(stats.averageMovingSpeedKnots);
  elements.maxSpeed.textContent = formatKnots(stats.maxSpeedKnots);
  elements.movingTime.textContent = formatDurationMs(stats.movingTimeMs);
}

function getPosition(record) {
  const gnss = record?.sensors?.sim7600?.gnss;
  if (gnss?.fix && Number.isFinite(gnss.latitude) && Number.isFinite(gnss.longitude)) {
    return { latitude: gnss.latitude, longitude: gnss.longitude };
  }

  const gps = record?.sensors?.gps;
  if (Number.isFinite(gps?.latitude) && Number.isFinite(gps?.longitude)) {
    return { latitude: gps.latitude, longitude: gps.longitude };
  }

  return null;
}

function distanceMeters(a, b) {
  const earthRadiusMeters = 6371000;
  const lat1 = degreesToRadians(a.latitude);
  const lat2 = degreesToRadians(b.latitude);
  const deltaLat = degreesToRadians(b.latitude - a.latitude);
  const deltaLon = degreesToRadians(b.longitude - a.longitude);
  const haversine = Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function degreesToRadians(value) {
  return value * (Math.PI / 180);
}

function metersToNauticalMiles(value) {
  return value / 1852;
}

function metersPerSecondToKnots(value) {
  return value * 1.943844;
}

function formatTrackMeta(rawPoints, trackPoints) {
  if (!rawPoints.length) {
    return "No location history yet";
  }

  const first = new Date(rawPoints[0].timestamp);
  const last = new Date(rawPoints.at(-1).timestamp);
  return `${trackPoints.length} track points from ${formatDate(first)} to ${formatDate(last)}`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

function formatDistance(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return "--";
  }

  const nauticalMiles = metersToNauticalMiles(value);
  if (nauticalMiles >= 0.1) {
    return `${nauticalMiles.toFixed(2)} nm`;
  }
  return `${Math.round(value)} m`;
}

function formatKnots(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)} kt` : "--";
}

function formatDurationMs(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return "--";
  }

  const minutes = Math.round(value / 60000);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours > 0) {
    return `${hours}h ${remainder}m`;
  }
  return `${minutes}m`;
}
