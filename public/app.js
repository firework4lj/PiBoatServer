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
  snapshot: document.querySelector("#snapshot"),
  snapshotTime: document.querySelector("#snapshotTime"),
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
  const history = await fetchJson(`/api/boats/${encodeURIComponent(selectedBoatId)}/history?limit=720`);
  const snapshot = await fetchJson(`/api/boats/${encodeURIComponent(selectedBoatId)}/snapshot/latest`);
  const records = Object.values(latest.devices);
  const newest = records.sort((a, b) => new Date(b.received_at) - new Date(a.received_at))[0];

  if (!newest) {
    setEmpty();
    return;
  }

  renderDashboard(newest, records, snapshot.snapshot, history.heartbeats);
}

async function fetchJson(path) {
  const response = await fetch(path);
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
  elements.battery.textContent = formatBattery(battery);
  elements.uptime.textContent = formatDuration(system.uptime_seconds);
  renderDevices(records);
  renderVoltageChart(history);
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
  const points = history
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

  const canvas = elements.voltageChart;
  const ctx = canvas.getContext("2d");
  const scale = window.devicePixelRatio || 1;
  const bounds = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(bounds.width * scale));
  canvas.height = Math.max(1, Math.floor(bounds.height * scale));
  ctx.setTransform(scale, 0, 0, scale, 0, 0);

  drawVoltageChart(ctx, bounds.width, bounds.height, points);
}

function drawVoltageChart(ctx, width, height, points) {
  ctx.clearRect(0, 0, width, height);
  const padding = { top: 16, right: 14, bottom: 28, left: 42 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  ctx.fillStyle = "#fbfcfc";
  ctx.fillRect(0, 0, width, height);

  if (points.length < 2) {
    elements.voltageSummary.textContent = points.length === 1 ? `${points[0].voltage.toFixed(2)} V` : "No voltage history";
    drawChartText(ctx, "Waiting for voltage history", width / 2, height / 2, "#65717a", "center");
    return;
  }

  const voltages = points.map((point) => point.voltage);
  const minVoltage = Math.min(...voltages);
  const maxVoltage = Math.max(...voltages);
  const yMin = Math.max(0, Math.floor((minVoltage - 0.2) * 10) / 10);
  const yMax = Math.ceil((maxVoltage + 0.2) * 10) / 10;
  const firstTime = points[0].timestamp;
  const lastTime = points[points.length - 1].timestamp;
  const current = points[points.length - 1];

  elements.voltageSummary.textContent = `${current.voltage.toFixed(2)} V now`;

  drawGrid(ctx, padding, chartWidth, chartHeight, yMin, yMax);

  ctx.beginPath();
  points.forEach((point, index) => {
    const x = padding.left + ((point.timestamp - firstTime) / Math.max(1, lastTime - firstTime)) * chartWidth;
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
    const x = padding.left + ((point.timestamp - firstTime) / Math.max(1, lastTime - firstTime)) * chartWidth;
    const y = padding.top + (1 - ((point.voltage - yMin) / Math.max(0.1, yMax - yMin))) * chartHeight;
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  });

  drawChartText(ctx, `${yMax.toFixed(1)}V`, 8, padding.top + 4, "#65717a", "left");
  drawChartText(ctx, `${yMin.toFixed(1)}V`, 8, padding.top + chartHeight, "#65717a", "left");
  drawChartText(ctx, formatChartTime(firstTime), padding.left, height - 8, "#65717a", "left");
  drawChartText(ctx, formatChartTime(lastTime), width - padding.right, height - 8, "#65717a", "right");
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

function formatBattery(battery) {
  if (!Number.isFinite(battery.voltage)) {
    return "--";
  }
  const parts = [`${battery.voltage.toFixed(2)} V`];
  if (Number.isFinite(battery.soc_estimate_percent)) {
    parts.push(`${battery.soc_estimate_percent}% est`);
  }
  if (battery.charging) {
    parts.push("charging");
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
setInterval(() => refresh().catch(console.error), 15000);
