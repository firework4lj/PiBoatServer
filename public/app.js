const elements = {
  boatName: document.querySelector("#boatName"),
  statusPill: document.querySelector("#statusPill"),
  lastSeen: document.querySelector("#lastSeen"),
  position: document.querySelector("#position"),
  speed: document.querySelector("#speed"),
  cellular: document.querySelector("#cellular"),
  signal: document.querySelector("#signal"),
  uptime: document.querySelector("#uptime"),
  devices: document.querySelector("#devices"),
};

const map = L.map("map", { zoomControl: true }).setView([45.58809, -122.7044], 14);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  tileSize: 256,
  zoomOffset: 0,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);
setTimeout(() => map.invalidateSize(), 0);

const boatIcon = L.divIcon({
  className: "",
  html: '<div class="boat-marker">B</div>',
  iconSize: [34, 34],
  iconAnchor: [17, 17],
});

let marker;
let selectedBoatId;

async function refresh() {
  const boats = await fetchJson("/api/boats");
  if (!boats.boats.length) {
    setEmpty();
    return;
  }

  selectedBoatId ||= boats.boats[0].boat_id;
  const latest = await fetchJson(`/api/boats/${encodeURIComponent(selectedBoatId)}/latest`);
  const records = Object.values(latest.devices);
  const newest = records.sort((a, b) => new Date(b.received_at) - new Date(a.received_at))[0];

  if (!newest) {
    setEmpty();
    return;
  }

  renderDashboard(newest, records);
}

async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}`);
  }
  return response.json();
}

function renderDashboard(record, records) {
  const sim7600 = record.sensors?.sim7600 || {};
  const gnss = sim7600.gnss || {};
  const system = record.sensors?.system || {};
  const position = getPosition(record);

  elements.boatName.textContent = record.boat_id;
  setStatus(record.status);
  elements.lastSeen.textContent = formatDate(record.received_at || record.sent_at);
  elements.position.textContent = position ? `${position.latitude.toFixed(6)}, ${position.longitude.toFixed(6)}` : "--";
  elements.speed.textContent = formatKnots(gnss.speed_knots);
  elements.cellular.textContent = [sim7600.operator?.name, sim7600.network?.system_mode].filter(Boolean).join(" - ") || "--";
  elements.signal.textContent = formatSignal(sim7600.signal?.rssi_dbm);
  elements.uptime.textContent = formatDuration(system.uptime_seconds);
  renderDevices(records);

  if (position) {
    if (!marker) {
      marker = L.marker([position.latitude, position.longitude], { icon: boatIcon }).addTo(map);
      map.setView([position.latitude, position.longitude], 15);
    } else {
      marker.setLatLng([position.latitude, position.longitude]);
    }
  }
}

function renderDevices(records) {
  elements.devices.replaceChildren(
    ...records.map((record) => {
      const row = document.createElement("div");
      const title = document.createElement("strong");
      const detail = document.createElement("span");

      row.className = "device-row";
      title.textContent = record.device_id;
      detail.textContent = `${record.status} - ${formatDate(record.received_at || record.sent_at)}`;

      row.append(title, detail);
      return row;
    }),
  );
}

function setStatus(status) {
  elements.statusPill.textContent = status || "unknown";
  elements.statusPill.className = `status-pill ${status || ""}`;
}

function setEmpty() {
  elements.boatName.textContent = "No boats";
  setStatus("Waiting");
}

function getPosition(record) {
  const gnss = record.sensors?.sim7600?.gnss;
  if (gnss?.fix && Number.isFinite(gnss.latitude) && Number.isFinite(gnss.longitude)) {
    return { latitude: gnss.latitude, longitude: gnss.longitude };
  }
  return null;
}

function formatDate(value) {
  if (!value) {
    return "--";
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}

function formatKnots(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)} kt` : "--";
}

function formatSignal(value) {
  if (!Number.isFinite(value)) {
    return "--";
  }
  const label = value >= -75 ? "Excellent" : value >= -90 ? "Good" : value >= -105 ? "Usable" : "Weak";
  return `${value} dBm - ${label}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) {
    return "--";
  }
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  return `${minutes}m`;
}

refresh().catch(console.error);
setInterval(() => refresh().catch(console.error), 15000);
