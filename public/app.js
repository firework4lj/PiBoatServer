const elements = {
  boatName: document.querySelector("#boatName"),
  statusPill: document.querySelector("#statusPill"),
  lastSeen: document.querySelector("#lastSeen"),
  position: document.querySelector("#position"),
  speed: document.querySelector("#speed"),
  cellular: document.querySelector("#cellular"),
  signal: document.querySelector("#signal"),
  audioActivity: document.querySelector("#audioActivity"),
  battery: document.querySelector("#battery"),
  uptime: document.querySelector("#uptime"),
  devices: document.querySelector("#devices"),
  voltageChart: document.querySelector("#voltageChart"),
  voltageTooltip: document.querySelector("#voltageTooltip"),
  voltageSummary: document.querySelector("#voltageSummary"),
  voltageRanges: document.querySelector("#voltageRanges"),
  batteryState: document.querySelector("#batteryState"),
  batteryTrend: document.querySelector("#batteryTrend"),
  batteryChargeTime: document.querySelector("#batteryChargeTime"),
  batteryBestCharge: document.querySelector("#batteryBestCharge"),
  snapshot: document.querySelector("#snapshot"),
  snapshotTime: document.querySelector("#snapshotTime"),
  refreshSnapshotButton: document.querySelector("#refreshSnapshotButton"),
  liveCameraButton: document.querySelector("#liveCameraButton"),
  audioEvents: document.querySelector("#audioEvents"),
  audioEventsSummary: document.querySelector("#audioEventsSummary"),
};

const VOLTAGE_RANGES = {
  5: { label: "5m", historyLimit: 20 },
  30: { label: "30m", historyLimit: 90 },
  60: { label: "1h", historyLimit: 180 },
  180: { label: "3h", historyLimit: 420 },
  360: { label: "6h", historyLimit: 840 },
  720: { label: "12h", historyLimit: 1500 },
  1440: { label: "1d", historyLimit: 3000 },
  4320: { label: "3d", historyLimit: 9000 },
  10080: { label: "7d", historyLimit: 21000 },
};

const ESTIMATED_BATTERY_CAPACITY_AMP_HOURS = 100;
const MIN_DISCHARGE_WINDOW_MS = 10 * 60 * 1000;
const MIN_VOLTAGE_GAP_MS = 2 * 60 * 1000;
const MIN_WATT_BUCKET_MS = 2 * 60 * 1000;
const MAX_WATT_BUCKET_MS = 30 * 60 * 1000;
const MAX_CHART_POINTS = 1200;
const AUDIO_EVENT_LIMIT = 25;
const LISTENED_AUDIO_EVENTS_KEY = "piboat.listenedAudioEvents";

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
let voltageChartState = null;
let latestAudioEvents = [];
let pendingAudioEvents = null;
const listenedAudioEvents = loadListenedAudioEvents();

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

elements.refreshSnapshotButton.addEventListener("click", async () => {
  if (!selectedBoatId) {
    return;
  }

  elements.refreshSnapshotButton.disabled = true;
  elements.refreshSnapshotButton.textContent = "Requested";
  await postJson(`/api/boats/${encodeURIComponent(selectedBoatId)}/snapshot/request`);
  setTimeout(() => {
    refreshSnapshotOnly().catch(console.error);
  }, 5000);
  setTimeout(() => {
    elements.refreshSnapshotButton.disabled = false;
    elements.refreshSnapshotButton.textContent = "Refresh Photo";
  }, 15000);
});

elements.voltageChart.addEventListener("pointermove", showVoltageTooltip);
elements.voltageChart.addEventListener("pointerdown", showVoltageTooltip);
elements.voltageChart.addEventListener("pointerleave", hideVoltageTooltip);
elements.voltageChart.addEventListener("pointercancel", hideVoltageTooltip);

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
  const audioEvents = await fetchJson(`/api/boats/${encodeURIComponent(selectedBoatId)}/audio-events?limit=${AUDIO_EVENT_LIMIT}`);
  const liveStatus = await fetchJson(`/api/boats/${encodeURIComponent(selectedBoatId)}/live`);
  const records = Object.values(latest.devices);
  const newest = records.sort((a, b) => new Date(b.received_at) - new Date(a.received_at))[0];

  if (!newest) {
    setEmpty();
    return;
  }

  updateLiveButton(liveStatus.active);
  renderDashboard(newest, records, snapshot.snapshot, history.heartbeats, audioEvents.events);
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

function renderDashboard(record, records, snapshot, history, audioEvents) {
  const sim7600 = record.sensors?.sim7600 || {};
  const gnss = sim7600.gnss || {};
  const system = record.sensors?.system || {};
  const battery = record.sensors?.arduino_voltage || {};
  const audioActivity = record.sensors?.audio_activity || {};
  const position = getPosition(record);

  elements.boatName.textContent = record.boat_id;
  setStatus(record.status);
  elements.lastSeen.textContent = formatDate(record.received_at || record.sent_at);
  elements.position.textContent = position ? `${position.latitude.toFixed(6)}, ${position.longitude.toFixed(6)}` : "--";
  elements.speed.textContent = formatKnots(gnss.speed_knots);
  elements.cellular.textContent = [sim7600.operator?.name, sim7600.network?.system_mode].filter(Boolean).join(" - ") || "--";
  elements.signal.textContent = formatSignal(sim7600.signal?.rssi_dbm);
  elements.audioActivity.textContent = formatAudioActivity(audioActivity);
  elements.uptime.textContent = formatDuration(system.uptime_seconds);
  renderDevices(records);
  const batteryInsights = renderVoltageChart(history);
  renderBatteryInsights(batteryInsights);
  elements.battery.textContent = formatBattery(battery, batteryInsights.dischargeWatts);
  renderSnapshot(snapshot);
  renderAudioEvents(audioEvents);

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
  const allSamples = history
    .map((record) => {
      const battery = record.sensors?.arduino_voltage;
      const timestamp = new Date(record.received_at || record.sent_at).getTime();
      if (!Number.isFinite(timestamp)) {
        return null;
      }
      return {
        timestamp,
        voltage: Number.isFinite(battery?.voltage) ? battery.voltage : null,
        charging: battery?.charging === true,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timestamp - b.timestamp);
  const newestTimestamp = allSamples.at(-1)?.timestamp || Date.now();
  const rangeStart = newestTimestamp - (voltageRangeMinutes * 60 * 1000);
  const samples = allSamples.filter((sample) => sample.timestamp >= rangeStart && sample.timestamp <= newestTimestamp);
  const points = voltagePointsWithGaps(samples);

  const canvas = elements.voltageChart;
  const ctx = canvas.getContext("2d");
  const scale = window.devicePixelRatio || 1;
  const bounds = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(bounds.width * scale));
  canvas.height = Math.max(1, Math.floor(bounds.height * scale));
  ctx.setTransform(scale, 0, 0, scale, 0, 0);

  const batteryInsights = deriveBatteryInsights(samples, points);
  const dischargeWatts = batteryInsights.dischargeWatts;
  drawVoltageChart(ctx, bounds.width, bounds.height, points, rangeStart, newestTimestamp, dischargeWatts);
  return batteryInsights;
}

function downsampleChartPoints(points) {
  if (points.length <= MAX_CHART_POINTS) {
    return points;
  }

  const stride = Math.ceil(points.length / MAX_CHART_POINTS);
  return points.filter((point, index) => (
    index === 0 ||
    index === points.length - 1 ||
    point.gapBefore ||
    points[index + 1]?.gapBefore ||
    index % stride === 0
  ));
}

function voltagePointsWithGaps(samples) {
  const gapThreshold = voltageGapThreshold(samples);
  const points = [];
  let lastVoltagePoint = null;
  let missingSinceLastVoltage = false;

  samples.forEach((sample) => {
    if (!Number.isFinite(sample.voltage)) {
      missingSinceLastVoltage = true;
      return;
    }

    const gapBefore = Boolean(
      lastVoltagePoint && (
        missingSinceLastVoltage ||
        sample.timestamp - lastVoltagePoint.timestamp > gapThreshold
      ),
    );

    const point = { ...sample, gapBefore };
    points.push(point);
    lastVoltagePoint = point;
    missingSinceLastVoltage = false;
  });

  return points;
}

function voltageGapThreshold(samples) {
  const intervals = [];
  for (let index = 1; index < samples.length; index += 1) {
    const interval = samples[index].timestamp - samples[index - 1].timestamp;
    if (interval > 0) {
      intervals.push(interval);
    }
  }

  if (!intervals.length) {
    return MIN_VOLTAGE_GAP_MS;
  }

  intervals.sort((a, b) => a - b);
  const median = intervals[Math.floor(intervals.length / 2)];
  return Math.max(MIN_VOLTAGE_GAP_MS, median * 3);
}

function drawVoltageChart(ctx, width, height, points, rangeStart, rangeEnd, dischargeWatts) {
  ctx.clearRect(0, 0, width, height);
  const padding = { top: 16, right: 14, bottom: 28, left: 42 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  voltageChartState = null;
  hideVoltageTooltip();

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
  const drawPoints = downsampleChartPoints(points);
  voltageChartState = {
    chartHeight,
    chartWidth,
    height,
    padding,
    points,
    rangeEnd,
    rangeStart,
    width,
    yMax,
    yMin,
  };

  elements.voltageSummary.textContent = `${current.voltage.toFixed(2)} V at ${formatChartTime(lastTime, { includeDate: true })} (${deltaLabel})${drawLabel}`;

  drawGrid(ctx, padding, chartWidth, chartHeight, yMin, yMax);

  ctx.beginPath();
  drawPoints.forEach((point, index) => {
    const x = padding.left + ((point.timestamp - rangeStart) / Math.max(1, rangeEnd - rangeStart)) * chartWidth;
    const y = padding.top + (1 - ((point.voltage - yMin) / Math.max(0.1, yMax - yMin))) * chartHeight;
    if (index === 0 || point.gapBefore) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.strokeStyle = "#0f5f78";
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = "#117b4f";
  drawPoints.filter((point) => point.charging).forEach((point) => {
    const x = padding.left + ((point.timestamp - rangeStart) / Math.max(1, rangeEnd - rangeStart)) * chartWidth;
    const y = padding.top + (1 - ((point.voltage - yMin) / Math.max(0.1, yMax - yMin))) * chartHeight;
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  });

  drawChartText(ctx, `${yMax.toFixed(1)}V`, 8, padding.top + 4, "#65717a", "left");
  drawChartText(ctx, `${yMin.toFixed(1)}V`, 8, padding.top + chartHeight, "#65717a", "left");
  drawChartText(ctx, formatChartAxisTime(rangeStart), padding.left, height - 8, "#65717a", "left");
  drawChartText(ctx, formatChartAxisTime(rangeEnd), width - padding.right, height - 8, "#65717a", "right");
}

function showVoltageTooltip(event) {
  if (!voltageChartState) {
    hideVoltageTooltip();
    return;
  }

  event.preventDefault();
  const rect = elements.voltageChart.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const targetTimestamp = voltageChartState.rangeStart +
    ((x - voltageChartState.padding.left) / Math.max(1, voltageChartState.chartWidth)) *
    (voltageChartState.rangeEnd - voltageChartState.rangeStart);
  const nearest = nearestVoltagePoint(targetTimestamp, voltageChartState.points);
  if (!nearest) {
    hideVoltageTooltip();
    return;
  }

  const markerX = voltageChartState.padding.left +
    ((nearest.timestamp - voltageChartState.rangeStart) / Math.max(1, voltageChartState.rangeEnd - voltageChartState.rangeStart)) *
    voltageChartState.chartWidth;
  const markerY = voltageChartState.padding.top +
    (1 - ((nearest.voltage - voltageChartState.yMin) / Math.max(0.1, voltageChartState.yMax - voltageChartState.yMin))) *
    voltageChartState.chartHeight;
  const left = Math.min(Math.max(markerX, 70), voltageChartState.width - 70);
  const top = Math.max(36, markerY - 8);

  elements.voltageTooltip.hidden = false;
  elements.voltageTooltip.style.left = `${left}px`;
  elements.voltageTooltip.style.top = `${top}px`;
  elements.voltageTooltip.innerHTML = `${nearest.voltage.toFixed(2)} V<br>${formatTooltipTime(nearest.timestamp)}`;
}

function hideVoltageTooltip() {
  elements.voltageTooltip.hidden = true;
}

function nearestVoltagePoint(timestamp, points) {
  return points.reduce((nearest, point) => {
    if (!nearest) {
      return point;
    }
    return Math.abs(point.timestamp - timestamp) < Math.abs(nearest.timestamp - timestamp) ? point : nearest;
  }, null);
}

function deriveBatteryInsights(samples, points) {
  const current = points.at(-1) || null;
  return {
    currentState: classifyBatteryState(current),
    voltageTrendPerHour: estimateVoltageTrendPerHour(points),
    chargeTimeMs: estimateChargeTimeMs(samples),
    bestChargeSession: bestChargeSession(points),
    dischargeWatts: estimateDischargeWatts(points),
  };
}

function classifyBatteryState(point) {
  if (!point) {
    return "No voltage data";
  }

  if (point.charging) {
    if (point.voltage >= 14.2) {
      return "Charging - bulk";
    }
    if (point.voltage >= 13.5) {
      return "Charging - absorb/float";
    }
    return "Charging";
  }

  if (point.voltage >= 12.7) {
    return "Resting - full";
  }
  if (point.voltage >= 12.2) {
    return "Discharging";
  }
  return "Low";
}

function estimateVoltageTrendPerHour(points) {
  if (points.length < 2) {
    return null;
  }

  const continuousSegment = latestContinuousSegment(points);
  const trendPoints = continuousSegment.length >= 2 ? continuousSegment : points;
  const elapsedMs = trendPoints.at(-1).timestamp - trendPoints[0].timestamp;
  if (elapsedMs < MIN_DISCHARGE_WINDOW_MS) {
    return null;
  }

  const smoothedPoints = smoothDischargePoints(trendPoints);
  if (smoothedPoints.length < 2) {
    return null;
  }

  return linearRegressionSlopePerHour(smoothedPoints, "voltage");
}

function latestContinuousSegment(points) {
  let segment = [];
  points.forEach((point) => {
    if (point.gapBefore) {
      segment = [];
    }
    segment.push(point);
  });
  return segment;
}

function estimateChargeTimeMs(samples) {
  let totalMs = 0;
  const gapThreshold = voltageGapThreshold(samples);

  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    const interval = current.timestamp - previous.timestamp;
    if (
      interval > 0 &&
      interval <= gapThreshold &&
      previous.charging &&
      current.charging &&
      Number.isFinite(previous.voltage) &&
      Number.isFinite(current.voltage)
    ) {
      totalMs += interval;
    }
  }

  return totalMs;
}

function bestChargeSession(points) {
  let best = null;
  let currentSession = [];

  const flush = () => {
    if (currentSession.length < 2) {
      currentSession = [];
      return;
    }

    const first = currentSession[0];
    const last = currentSession.at(-1);
    const durationMs = last.timestamp - first.timestamp;
    const voltageGain = last.voltage - first.voltage;
    if (durationMs >= MIN_DISCHARGE_WINDOW_MS && voltageGain > 0) {
      const session = { start: first.timestamp, end: last.timestamp, durationMs, voltageGain };
      if (!best || session.voltageGain > best.voltageGain) {
        best = session;
      }
    }

    currentSession = [];
  };

  points.forEach((point) => {
    if (point.gapBefore || !point.charging) {
      flush();
    }

    if (point.charging) {
      currentSession.push(point);
    }
  });
  flush();

  return best;
}

function renderBatteryInsights(insights) {
  elements.batteryState.textContent = insights.currentState;
  elements.batteryTrend.textContent = formatVoltageTrend(insights.voltageTrendPerHour);
  elements.batteryChargeTime.textContent = formatDurationMs(insights.chargeTimeMs);
  elements.batteryBestCharge.textContent = formatChargeSession(insights.bestChargeSession);
}

function estimateDischargeWatts(points) {
  if (points.length < 2 || points.at(-1).charging) {
    return null;
  }

  const dischargePoints = latestContinuousDischargeSegment(points);
  if (dischargePoints.length < 2) {
    return null;
  }

  const first = dischargePoints[0];
  const current = dischargePoints.at(-1);
  const elapsedMs = current.timestamp - first.timestamp;
  if (elapsedMs < MIN_DISCHARGE_WINDOW_MS) {
    return null;
  }

  const smoothedPoints = smoothDischargePoints(dischargePoints);
  if (smoothedPoints.length < 2) {
    return null;
  }

  const socPoints = smoothedPoints.map((point) => ({
    timestamp: point.timestamp,
    soc: estimateLeadAcidSocPercent(point.voltage),
    voltage: point.voltage,
  }));
  const socSlopePerHour = linearRegressionSlopePerHour(socPoints, "soc");
  if (!Number.isFinite(socSlopePerHour) || socSlopePerHour >= 0) {
    return 0;
  }

  const averageVoltage = average(socPoints.map((point) => point.voltage));
  const ampHoursPerHour = (-socSlopePerHour / 100) * ESTIMATED_BATTERY_CAPACITY_AMP_HOURS;
  return ampHoursPerHour * averageVoltage;
}

function latestContinuousDischargeSegment(points) {
  let segment = [];
  points.forEach((point) => {
    if (point.charging) {
      segment = [];
      return;
    }

    if (point.gapBefore) {
      segment = [];
    }

    segment.push(point);
  });
  return segment;
}

function smoothDischargePoints(points) {
  const elapsedMs = points.at(-1).timestamp - points[0].timestamp;
  const bucketMs = Math.min(MAX_WATT_BUCKET_MS, Math.max(MIN_WATT_BUCKET_MS, elapsedMs / 24));
  const buckets = new Map();

  points.forEach((point) => {
    const bucket = Math.floor((point.timestamp - points[0].timestamp) / bucketMs);
    buckets.set(bucket, [...(buckets.get(bucket) || []), point]);
  });

  return [...buckets.values()].map((bucketPoints) => {
    const middle = bucketPoints[Math.floor(bucketPoints.length / 2)];
    return {
      timestamp: middle.timestamp,
      voltage: median(bucketPoints.map((point) => point.voltage)),
    };
  });
}

function linearRegressionSlopePerHour(points, key) {
  const start = points[0].timestamp;
  const xs = points.map((point) => (point.timestamp - start) / (60 * 60 * 1000));
  const ys = points.map((point) => point[key]);
  const xMean = average(xs);
  const yMean = average(ys);
  let numerator = 0;
  let denominator = 0;

  xs.forEach((x, index) => {
    numerator += (x - xMean) * (ys[index] - yMean);
    denominator += (x - xMean) ** 2;
  });

  return denominator === 0 ? null : numerator / denominator;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function average(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
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

function formatChartAxisTime(timestamp) {
  return formatChartTime(timestamp, { includeDate: voltageRangeMinutes >= 720 });
}

function formatChartTime(timestamp, { includeDate = false } = {}) {
  const options = {
    hour: "numeric",
    minute: "2-digit",
  };
  if (includeDate) {
    options.month = "short";
    options.day = "numeric";
  }
  return new Intl.DateTimeFormat(undefined, options).format(new Date(timestamp));
}

function formatTooltipTime(timestamp) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
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

function renderAudioEvents(events = []) {
  if (audioPlaybackActive()) {
    pendingAudioEvents = events;
    const unlistenedCount = countUnlistenedEvents(events);
    elements.audioEventsSummary.textContent = `${events.length} recent${unlistenedCount ? ` - ${unlistenedCount} new` : ""}`;
    return;
  }

  latestAudioEvents = events;
  pendingAudioEvents = null;
  const unlistenedCount = countUnlistenedEvents(events);
  elements.audioEventsSummary.textContent = events.length ? `${events.length} recent${unlistenedCount ? ` - ${unlistenedCount} new` : ""}` : "--";
  if (!events.length) {
    elements.audioEvents.replaceChildren(emptyText("No audio events"));
    return;
  }

  elements.audioEvents.replaceChildren(
    ...events.map((event) => {
      const row = document.createElement("div");
      const meta = document.createElement("div");
      const title = document.createElement("strong");
      const detail = document.createElement("span");
      const badge = document.createElement("span");
      const audio = document.createElement("audio");
      const eventId = audioEventId(event);
      const listened = listenedAudioEvents.has(eventId);

      row.className = `audio-event-row ${listened ? "listened" : "unlistened"}`;
      meta.className = "audio-event-meta";
      title.textContent = `${titleCase(String(event.trigger || "audio event").replaceAll("_", " "))} - ${formatDate(event.received_at)}`;
      detail.textContent = formatAudioEventDetail(event);
      badge.className = "audio-event-badge";
      badge.textContent = listened ? "Listened" : "New";
      audio.controls = true;
      audio.preload = "none";
      audio.src = event.audio_url;
      audio.addEventListener("play", () => {
        markAudioEventListened(eventId);
        row.classList.remove("unlistened");
        row.classList.add("listened");
        badge.textContent = "Listened";
        elements.audioEventsSummary.textContent = `${latestAudioEvents.length} recent${countUnlistenedEvents(latestAudioEvents) ? ` - ${countUnlistenedEvents(latestAudioEvents)} new` : ""}`;
      });
      audio.addEventListener("ended", renderPendingAudioEvents);
      audio.addEventListener("pause", renderPendingAudioEvents);

      meta.append(title, detail, badge);
      row.append(meta, audio);
      return row;
    }),
  );
}

function audioPlaybackActive() {
  return [...elements.audioEvents.querySelectorAll("audio")].some((audio) => !audio.paused && !audio.ended);
}

function renderPendingAudioEvents() {
  if (audioPlaybackActive() || !pendingAudioEvents) {
    return;
  }
  renderAudioEvents(pendingAudioEvents);
}

function audioEventId(event) {
  return event.audio_url || `${event.device_id || ""}:${event.received_at || ""}:${event.trigger || ""}`;
}

function countUnlistenedEvents(events) {
  return events.filter((event) => !listenedAudioEvents.has(audioEventId(event))).length;
}

function markAudioEventListened(eventId) {
  listenedAudioEvents.add(eventId);
  try {
    localStorage.setItem(LISTENED_AUDIO_EVENTS_KEY, JSON.stringify([...listenedAudioEvents].slice(-500)));
  } catch (error) {
    console.warn("could not save listened audio events", error);
  }
}

function loadListenedAudioEvents() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LISTENED_AUDIO_EVENTS_KEY) || "[]");
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function emptyText(text) {
  const element = document.createElement("span");
  element.className = "empty-text";
  element.textContent = text;
  return element;
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
  const gps = record.sensors?.gps;
  if (Number.isFinite(gps?.latitude) && Number.isFinite(gps?.longitude)) {
    return { latitude: gps.latitude, longitude: gps.longitude };
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

function formatAudioActivity(audioActivity) {
  if (!audioActivity || audioActivity.status === "unknown") {
    return "--";
  }

  const parts = [];
  if (audioActivity.state) {
    parts.push(titleCase(String(audioActivity.state).replaceAll("_", " ")));
  } else if (audioActivity.status) {
    parts.push(titleCase(audioActivity.status));
  }
  if (Number.isFinite(audioActivity.impact_count_1m)) {
    parts.push(`${audioActivity.impact_count_1m} impacts/min`);
  }
  if (Number.isFinite(audioActivity.rms_db)) {
    parts.push(`${audioActivity.rms_db.toFixed(1)} dB avg`);
  }
  if (Number.isFinite(audioActivity.peak_db)) {
    parts.push(`${audioActivity.peak_db.toFixed(1)} dB peak`);
  }

  return parts.join(" - ") || "--";
}

function formatAudioEventDetail(event) {
  const parts = [];
  if (Number.isFinite(event.duration_seconds)) {
    parts.push(`${event.duration_seconds.toFixed(1)} sec`);
  }
  if (Number.isFinite(event.rms_db)) {
    parts.push(`${event.rms_db.toFixed(1)} dB avg`);
  }
  if (Number.isFinite(event.peak_db)) {
    parts.push(`${event.peak_db.toFixed(1)} dB peak`);
  }
  return parts.join(" - ") || "--";
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

function titleCase(value) {
  return value.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatVoltageTrend(value) {
  if (!Number.isFinite(value)) {
    return "--";
  }
  if (Math.abs(value) < 0.01) {
    return "flat";
  }
  const direction = value > 0 ? "rising" : "falling";
  return `${direction} ${Math.abs(value).toFixed(2)} V/hr`;
}

function formatDurationMs(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    return "--";
  }

  const minutes = Math.round(milliseconds / 60000);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours > 0) {
    return `${hours}h ${remainder}m`;
  }
  return `${minutes}m`;
}

function formatChargeSession(session) {
  if (!session) {
    return "--";
  }
  return `+${session.voltageGain.toFixed(2)} V over ${formatDurationMs(session.durationMs)}`;
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
