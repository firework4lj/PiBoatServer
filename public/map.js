const TRACK_HISTORY_LIMIT = 25000;
const TRACK_MIN_DISTANCE_METERS = 25;
const TRACK_MAX_POINTS = 1200;
const TRACK_COLORS = ["#0f5f78", "#117b4f", "#a15c00", "#6b5bd6", "#b42318", "#1665a7"];

const elements = {
  boatName: document.querySelector("#trackBoatName"),
  meta: document.querySelector("#trackMeta"),
  distance: document.querySelector("#trackDistance"),
  averageSpeed: document.querySelector("#trackAverageSpeed"),
  maxSpeed: document.querySelector("#trackMaxSpeed"),
  movingTime: document.querySelector("#trackMovingTime"),
  startTime: document.querySelector("#trackStartTime"),
  endTime: document.querySelector("#trackEndTime"),
  list: document.querySelector("#trackList"),
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

let boatId;
let latestMarker;
let tracks = [];
let selectedTrackId;

loadTrackMap().catch((error) => {
  console.error(error);
  elements.meta.textContent = "Unable to load track history";
});

async function loadTrackMap() {
  const boats = await fetchJson("/api/boats");
  boatId = boats.boats[0]?.boat_id;
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

  tracks = buildDailyTracks(rawPoints);
  selectedTrackId = tracks[0]?.id;

  renderLatestMarker(newest);
  renderTrackLayers();
  renderTrackList();
  selectTrack(selectedTrackId);
  elements.meta.textContent = formatTrackMeta(rawPoints, tracks);
}

async function fetchJson(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}`);
  }
  return response.json();
}

function renderLatestMarker(latestRecord) {
  const latestPosition = getPosition(latestRecord);
  if (!latestPosition) {
    return;
  }

  latestMarker = L.marker([latestPosition.latitude, latestPosition.longitude], { icon: boatIcon }).addTo(map);
}

function renderTrackLayers() {
  tracks.forEach((track) => {
    const latLngs = track.points.map((point) => [point.latitude, point.longitude]);
    if (latLngs.length < 2) {
      return;
    }

    track.layer = L.polyline(latLngs, {
      color: track.color,
      opacity: 0.85,
      weight: 3,
    }).addTo(map);

    track.layer.on("click", () => selectTrack(track.id));
  });

  const bounds = visibleTrackBounds();
  if (bounds) {
    map.fitBounds(bounds, { maxZoom: 15, padding: [28, 28] });
  } else if (latestMarker) {
    map.setView(latestMarker.getLatLng(), 15);
  }
}

function renderTrackList() {
  elements.list.replaceChildren(
    ...tracks.map((track) => {
      const row = document.createElement("div");
      const header = document.createElement("div");
      const title = document.createElement("div");
      const color = document.createElement("span");
      const name = document.createElement("strong");
      const summary = document.createElement("small");
      const actions = document.createElement("div");
      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      const deleteButton = document.createElement("button");

      row.className = "track-row";
      row.dataset.trackId = track.id;
      header.className = "track-row-header";
      title.className = "track-row-title";
      color.className = "track-color";
      color.style.background = track.color;
      name.textContent = track.label;
      summary.textContent = `${formatTrackTime(track.stats.startTimestamp)} - ${formatTrackTime(track.stats.endTimestamp)}`;
      actions.className = "track-row-actions";
      checkbox.type = "checkbox";
      checkbox.checked = track.visible;
      label.append(checkbox, " Visible");
      deleteButton.type = "button";
      deleteButton.textContent = "Delete";

      title.append(color, name);
      header.append(title, summary);
      actions.append(label, deleteButton);
      row.append(header, actions);

      row.addEventListener("click", () => selectTrack(track.id));
      checkbox.addEventListener("click", (event) => event.stopPropagation());
      checkbox.addEventListener("change", () => setTrackVisible(track.id, checkbox.checked));
      deleteButton.addEventListener("click", (event) => {
        event.stopPropagation();
        deleteTrack(track.id).catch((error) => {
          console.error(error);
          elements.meta.textContent = "Unable to delete track";
        });
      });

      return row;
    }),
  );
}

function selectTrack(trackId) {
  const track = tracks.find((item) => item.id === trackId) || tracks[0];
  if (!track) {
    renderTrackStats(emptyStats());
    return;
  }

  selectedTrackId = track.id;
  renderTrackStats(track.stats);
  elements.list.querySelectorAll(".track-row").forEach((row) => {
    row.classList.toggle("active", row.dataset.trackId === track.id);
  });

  if (track.layer) {
    map.fitBounds(track.layer.getBounds(), { maxZoom: 15, padding: [28, 28] });
  }
}

function setTrackVisible(trackId, visible) {
  const track = tracks.find((item) => item.id === trackId);
  if (!track) {
    return;
  }

  track.visible = visible;
  if (track.layer) {
    if (visible) {
      track.layer.addTo(map);
    } else {
      track.layer.remove();
    }
  }
}

async function deleteTrack(trackId) {
  const track = tracks.find((item) => item.id === trackId);
  if (!track || !boatId) {
    return;
  }

  const confirmed = window.confirm(`Delete track data for ${track.label}?`);
  if (!confirmed) {
    return;
  }

  let token = sessionStorage.getItem("piboat_api_token") || "";
  if (!token) {
    token = window.prompt("API token required to delete track data") || "";
    if (token) {
      sessionStorage.setItem("piboat_api_token", token);
    }
  }
  if (!token) {
    return;
  }

  await fetchJson(
    `/api/boats/${encodeURIComponent(boatId)}/history?start=${encodeURIComponent(track.startIso)}&end=${encodeURIComponent(track.endIso)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    },
  );

  if (track.layer) {
    track.layer.remove();
  }
  tracks = tracks.filter((item) => item.id !== track.id);
  selectedTrackId = tracks[0]?.id;
  renderTrackList();
  selectTrack(selectedTrackId);
  elements.meta.textContent = `Deleted ${track.label}`;
}

function buildDailyTracks(rawPoints) {
  const groups = new Map();
  rawPoints.forEach((point) => {
    const key = localDayKey(point.timestamp);
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(point);
  });

  return [...groups.entries()]
    .sort(([left], [right]) => right.localeCompare(left))
    .map(([key, points], index) => {
      const reducedPoints = reduceTrackPoints(points);
      const [year, month, day] = key.split("-").map(Number);
      const start = new Date(year, month - 1, day);
      const end = new Date(year, month - 1, day + 1);
      return {
        id: key,
        label: formatDayLabel(start),
        color: TRACK_COLORS[index % TRACK_COLORS.length],
        points: reducedPoints,
        rawPointCount: points.length,
        visible: true,
        startIso: start.toISOString(),
        endIso: end.toISOString(),
        stats: calculateTrackStats(reducedPoints),
      };
    });
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
    endTimestamp: points.at(-1)?.timestamp ?? null,
    elapsedMs,
    movingTimeMs,
    startTimestamp: points[0]?.timestamp ?? null,
    averageMovingSpeedKnots,
    maxSpeedKnots,
  };
}

function emptyStats() {
  return {
    distanceMeters: null,
    endTimestamp: null,
    elapsedMs: null,
    movingTimeMs: null,
    startTimestamp: null,
    averageMovingSpeedKnots: null,
    maxSpeedKnots: null,
  };
}

function renderTrackStats(stats) {
  elements.distance.textContent = formatDistance(stats.distanceMeters);
  elements.averageSpeed.textContent = formatSpeed(stats.averageMovingSpeedKnots);
  elements.maxSpeed.textContent = formatSpeed(stats.maxSpeedKnots);
  elements.movingTime.textContent = formatDurationMs(stats.movingTimeMs);
  elements.startTime.textContent = formatTrackTime(stats.startTimestamp);
  elements.endTime.textContent = formatTrackTime(stats.endTimestamp);
}

function visibleTrackBounds() {
  const visibleLayers = tracks.filter((track) => track.visible && track.layer).map((track) => track.layer);
  if (!visibleLayers.length) {
    return null;
  }

  return visibleLayers.reduce((bounds, layer) => bounds.extend(layer.getBounds()), visibleLayers[0].getBounds());
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

function metersToMiles(value) {
  return value / 1609.344;
}

function metersPerSecondToKnots(value) {
  return value * 1.943844;
}

function formatTrackMeta(rawPoints, dailyTracks) {
  if (!rawPoints.length) {
    return "No location history yet";
  }

  const first = new Date(rawPoints[0].timestamp);
  const last = new Date(rawPoints.at(-1).timestamp);
  return `${dailyTracks.length} daily tracks from ${formatDate(first)} to ${formatDate(last)}`;
}

function localDayKey(timestamp) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDayLabel(value) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(value);
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

function formatTrackTime(timestamp) {
  if (!Number.isFinite(timestamp)) {
    return "--";
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function formatDistance(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return "--";
  }

  const nauticalMiles = metersToNauticalMiles(value);
  const miles = metersToMiles(value);
  if (nauticalMiles >= 0.1) {
    return `${nauticalMiles.toFixed(2)} nm / ${miles.toFixed(2)} mi`;
  }
  return `${Math.round(value)} m / ${miles.toFixed(2)} mi`;
}

function formatSpeed(value) {
  if (!Number.isFinite(value)) {
    return "--";
  }
  return `${value.toFixed(1)} kt / ${knotsToMph(value).toFixed(1)} mph`;
}

function knotsToMph(value) {
  return value * 1.150779;
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
