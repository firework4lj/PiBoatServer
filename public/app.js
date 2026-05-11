const elements = {
  boatName: document.querySelector("#boatName"),
  statusPill: document.querySelector("#statusPill"),
  lastSeen: document.querySelector("#lastSeen"),
  position: document.querySelector("#position"),
  speed: document.querySelector("#speed"),
  cellular: document.querySelector("#cellular"),
  signal: document.querySelector("#signal"),
  battery: document.querySelector("#battery"),
  uptime: document.querySelector("#uptime"),
  devices: document.querySelector("#devices"),
  voltageChart: document.querySelector("#voltageChart"),
  voltageSummary: document.querySelector("#voltageSummary"),
  voltageRanges: document.querySelector("#voltageRanges"),
  snapshot: document.querySelector("#snapshot"),
  snapshotTime: document.querySelector("#snapshotTime"),
  liveCameraButton: document.querySelector("#liveCameraButton"),
};

const VOLTAGE_RANGES = {
  5: { label: "5m", historyLimit: 20 },
  30: { label: "30m", historyLimit: 90 },
  60: { label: "1h", historyLimit: 180 },
  180: { label: "3h", historyLimit: 420 },
  360: { label: "6h", historyLimit: 840 },
  720: { label: "12h", historyLimit: 1500 },
  1440: { label: "1d", historyLimit: 3000 },
};

const ESTIMATED_BATTERY_CAPACITY_AMP_HOURS = 100;
const MIN_DISCHARGE_WINDOW_MS = 2 * 60 * 1000;

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
let voltageRangeMinutes = 180;
let liveCameraActive = false;
let dashboardRefreshTimer;
let liveSnapshotTimer;

elements.voltageRanges.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-range-minutes]");
  if (!button) {
    return;
  }

  voltageRangeMinutes = Number(button.dataset.rangeMinutes);
  setActiveVoltageRange();
  refresh().catch(console.error);
});

elements.liveCameraButton.addEventListener("click", async () => {
  if (!selectedBoatId) {
    return;
  }

  const action = liveCameraActive ? "stop" : "start";
  const status = await postJson(`/api/boats/${encodeURIComponent(selectedBoatId)}/live/${action}`);
  updateLiveButton(status.active);
  await refreshSnapshotOnly();
});

async function refresh() {
  const boats = await fetchJson("/api/boats");
  if (!boats.boats.length) {
    setEmpty();
    return;
  }

  selectedBoatId ||= boats.boats[0].boat_id;
  const latest = await fetchJson(`/api/boats/${encodeURIComponent(selectedBoatId)}/latest`);
  const historyLimit = VOLTAGE_RANGES[voltageRangeMinutes]?.historyLimit || 420;
  const history = await fetchJson(`/api/boats/${encodeURIComponent(selectedBoatId)}/history?limit=${historyLimit}`);
  const snapshot = await fetchJson(`/api/boats/${encodeURIComponent(selectedBoatId)}/snapshot/latest`);
  const liveStatus = await fetchJson(`/api/boats/${encodeURIComponent(selectedBoatId)}/live`);
  const records = Object.values(latest.devices);
  const newest = records.sort((a, b) => new Date(b.received_at) - new Date(a.received_at))[0];

  if (!newest) {
    setEmpty();
    return;
  }

  updateLiveButton(liveStatus.active);
  renderDashboard(newest, records, snapshot.snapshot, history.heartbeats);
}

async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}`);
  }
  return response.json();
}

async function postJson(path) {
  const response = await fetch(path, { method: "POST" });
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}`);
  }
  return response.json();
}

function renderDashboard(record, records, snapshot, history) {
  const sim7600 = record.sensors?.sim7600 || {};
  const gnss = sim7600.gnss || {};
  const system = record.sensors?.system || {};
  const battery = record.sensors?.arduino_voltage || {};
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
  const dischargeWatts = renderVoltageChart(history);
  elements.battery.textContent = formatBattery(battery, dischargeWatts);
  renderSnapshot(snapshot);

  if (position) {
    if (!marker) {
      marker = L.marker([position.latitude, position.longitude], { icon: boatIcon }).addTo(map);
      map.setView([position.latitude, position.longitude], 15);
    } else {
      marker.setLatLng([position.latitude, position.longitude]);
    }
  }
}

function renderVoltageChart(history) {
  const allPoints = history
    .map((record) => {
      const battery = record.sensors?.arduino_voltage;
      if (!Number.isFinite(battery?.voltage)) {
        return null;
      }
      return {
        timestamp: new Date(record.received_at || record.sent_at).getTime(),
        voltage: battery.voltage,
        charging: battery.charging === true,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timestamp - b.timestamp);
  const newestTimestamp = allPoints.at(-1)?.timestamp || Date.now();
  const rangeStart = newestTimestamp - (voltageRangeMinutes * 60 * 1000);
  const points = allPoints.filter((point) => point.timestamp >= rangeStart && point.timestamp <= newestTimestamp);

  const canvas = elements.voltageChart;
  const ctx = canvas.getContext("2d");
  const scale = window.devicePixelRatio || 1;
  const bounds = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(bounds.width * scale));
  canvas.height = Math.max(1, Math.floor(bounds.height * scale));
  ctx.setTransform(scale, 0, 0, scale, 0, 0);

  const dischargeWatts = estimateDischargeWatts(points);
  drawVoltageChart(ctx, bounds.width, bounds.height, points, rangeStart, newestTimestamp, dischargeWatts);
  return dischargeWatts;
}

function drawVoltageChart(ctx, width, height, points, rangeStart, rangeEnd, dischargeWatts) {
  ctx.clearRect(0, 0, width, height);
  const padding = { top: 16, right: 14, bottom: 28, left: 42 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  ctx.fillStyle = "#fbfcfc";
  ctx.fillRect(0, 0, width, height);

  if (points.length < 2) {
    const rangeLabel = VOLTAGE_RANGES[voltageRangeMinutes]?.label || `${voltageRangeMinutes}m`;
    elements.voltageSummary.textContent = points.length === 1 ? `${points[0].voltage.toFixed(2)} V` : `No data in ${rangeLabel}`;
    drawChartText(ctx, "Waiting for voltage history", width / 2, height / 2, "#65717a", "center");
    return;
  }

  const voltages = points.map((point) => point.voltage);
  const minVoltage = Math.min(...voltages);
  const maxVoltage = Math.max(...voltages);
  const yMin = Math.max(0, Math.floor((minVoltage - 0.2) * 10) / 10);
  const yMax = Math.ceil((maxVoltage + 0.2) * 10) / 10;
  const lastTime = points[points.length - 1].timestamp;
  const current = points[points.length - 1];
  const delta = current.voltage - points[0].voltage;
  const deltaLabel = `${delta >= 0 ? "+" : ""}${delta.toFixed(2)} V`;
  const drawLabel = Number.isFinite(dischargeWatts) ? ` - est ${dischargeWatts.toFixed(0)} W draw` : "";

  elements.voltageSummary.textContent = `${current.voltage.toFixed(2)} V at ${formatChartTime(lastTime)} (${deltaLabel})${drawLabel}`;

  drawGrid(ctx, padding, chartWidth, chartHeight, yMin, yMax);

  ctx.beginPath();
  points.forEach((point, index) => {
    const x = padding.left + ((point.timestamp - rangeStart) / Math.max(1, rangeEnd - rangeStart)) * chartWidth;
    const y = padding.top + (1 - ((point.voltage - yMin) / Math.max(0.1, yMax - yMin))) * chartHeight;
    if (index === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.strokeStyle = "#0f5f78";
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = "#117b4f";
  points.filter((point) => point.charging).forEach((point) => {
    const x = padding.left + ((point.timestamp - rangeStart) / Math.max(1, rangeEnd - rangeStart)) * chartWidth;
    const y = padding.top + (1 - ((point.voltage - yMin) / Math.max(0.1, yMax - yMin))) * chartHeight;
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  });

  drawChartText(ctx, `${yMax.toFixed(1)}V`, 8, padding.top + 4, "#65717a", "left");
  drawChartText(ctx, `${yMin.toFixed(1)}V`, 8, padding.top + chartHeight, "#65717a", "left");
  drawChartText(ctx, formatChartTime(rangeStart), padding.left, height - 8, "#65717a", "left");
  drawChartText(ctx, formatChartTime(rangeEnd), width - padding.right, height - 8, "#65717a", "right");
}

function estimateDischargeWatts(points) {
  if (points.length < 2 || points.at(-1).charging) {
    return null;
  }

  const lastChargingIndex = points.findLastIndex((point) => point.charging);
  const dischargePoints = points.slice(lastChargingIndex + 1);
  if (dischargePoints.length < 2) {
    return null;
  }

  const first = dischargePoints[0];
  const current = dischargePoints.at(-1);
  const elapsedMs = current.timestamp - first.timestamp;
  if (elapsedMs < MIN_DISCHARGE_WINDOW_MS) {
    return null;
  }

  const startSoc = estimateLeadAcidSocPercent(first.voltage);
  const endSoc = estimateLeadAcidSocPercent(current.voltage);
  const socDrop = startSoc - endSoc;
  if (socDrop <= 0) {
    return 0;
  }

  const averageVoltage = (first.voltage + current.voltage) / 2;
  const wattHours = (socDrop / 100) * ESTIMATED_BATTERY_CAPACITY_AMP_HOURS * averageVoltage;
  const elapsedHours = elapsedMs / (60 * 60 * 1000);
  return wattHours / elapsedHours;
}

function estimateLeadAcidSocPercent(voltage) {
  const curve = [
    [11.31, 10],
    [11.58, 20],
    [11.75, 30],
    [11.90, 40],
    [12.06, 50],
    [12.20, 60],
    [12.32, 70],
    [12.42, 80],
    [12.50, 90],
    [12.70, 100],
  ];

  if (voltage <= curve[0][0]) {
    return 0;
  }

  for (let index = 1; index < curve.length; index += 1) {
    const [upperVoltage, upperSoc] = curve[index];
    const [lowerVoltage, lowerSoc] = curve[index - 1];
    if (voltage <= upperVoltage) {
      const ratio = (voltage - lowerVoltage) / (upperVoltage - lowerVoltage);
      return lowerSoc + ratio * (upperSoc - lowerSoc);
    }
  }

  return 100;
}

function setActiveVoltageRange() {
  elements.voltageRanges.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.rangeMinutes) === voltageRangeMinutes);
  });
}

function drawGrid(ctx, padding, chartWidth, chartHeight, yMin, yMax) {
  ctx.strokeStyle = "#dce3e7";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let index = 0; index <= 3; index += 1) {
    const y = padding.top + (index / 3) * chartHeight;
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + chartWidth, y);
  }
  ctx.stroke();

  const chargeY = padding.top + (1 - ((13.2 - yMin) / Math.max(0.1, yMax - yMin))) * chartHeight;
  if (chargeY >= padding.top && chargeY <= padding.top + chartHeight) {
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(padding.left, chargeY);
    ctx.lineTo(padding.left + chartWidth, chargeY);
    ctx.strokeStyle = "#a15c00";
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawChartText(ctx, text, x, y, color, align) {
  ctx.fillStyle = color;
  ctx.font = "12px system-ui, sans-serif";
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y);
}

function formatChartTime(timestamp) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function renderSnapshot(snapshot) {
  if (!snapshot?.image_url) {
    elements.snapshot.style.display = "none";
    elements.snapshotTime.textContent = "--";
    return;
  }

  elements.snapshot.style.display = "block";
  elements.snapshot.src = `${snapshot.image_url}?t=${encodeURIComponent(snapshot.received_at)}`;
  elements.snapshotTime.textContent = formatDate(snapshot.received_at);
}

function updateLiveButton(active) {
  liveCameraActive = active === true;
  elements.liveCameraButton.classList.toggle("active", liveCameraActive);
  elements.liveCameraButton.textContent = liveCameraActive ? "Stop Live" : "View Live";
  scheduleLiveSnapshotRefresh();
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

function formatBattery(battery, dischargeWatts) {
  if (!Number.isFinite(battery.voltage)) {
    return "--";
  }
  const parts = [`${battery.voltage.toFixed(2)} V`];
  if (Number.isFinite(battery.soc_estimate_percent)) {
    parts.push(`${battery.soc_estimate_percent}% est`);
  }
  if (battery.charging) {
    parts.push("charging");
  } else if (Number.isFinite(dischargeWatts)) {
    parts.push(`est draw ${dischargeWatts.toFixed(0)} W`);
  }
  return parts.join(" - ");
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
setActiveVoltageRange();
scheduleDashboardRefresh();

function scheduleDashboardRefresh() {
  clearTimeout(dashboardRefreshTimer);
  dashboardRefreshTimer = setTimeout(() => {
    refresh()
      .catch(console.error)
      .finally(scheduleDashboardRefresh);
  }, 15000);
}

function scheduleLiveSnapshotRefresh() {
  clearTimeout(liveSnapshotTimer);
  if (!liveCameraActive) {
    return;
  }

  liveSnapshotTimer = setTimeout(() => {
    refreshSnapshotOnly()
      .catch(console.error)
      .finally(scheduleLiveSnapshotRefresh);
  }, 2500);
}

async function refreshSnapshotOnly() {
  if (!selectedBoatId) {
    return;
  }
  const snapshot = await fetchJson(`/api/boats/${encodeURIComponent(selectedBoatId)}/snapshot/latest`);
  renderSnapshot(snapshot.snapshot);
}
