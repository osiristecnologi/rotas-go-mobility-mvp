let driver = null;
let driverWs = null;
let passengerId = "PASSENGER-DEMO";
let currentOffer = null;

const $ = (id) => document.getElementById(id);

function api(path, options = {}) {
  return fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  }).then(async r => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  });
}

function gps() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Geolocalização não disponível"));
    navigator.geolocation.getCurrentPosition(
      p => resolve({
        lat: p.coords.latitude,
        lng: p.coords.longitude,
        accuracy: p.coords.accuracy
      }),
      e => reject(new Error(e.message)),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 10000 }
    );
  });
}

async function connectDriverWs() {
  if (!driver) return;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  driverWs = new WebSocket(`${proto}://${location.host}/?role=driver&id=${encodeURIComponent(driver.id)}`);
  driverWs.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.type === "RIDE_OFFER") {
      currentOffer = msg.payload.ride;
      renderOffer(msg.payload);
    }
    if (["DRIVER_UPDATED", "RIDE_UPDATED", "RIDE_ACCEPTED", "RIDE_NO_DRIVER"].includes(msg.type)) {
      refresh();
    }
  };
}

function renderOffer(payload) {
  const ride = payload.ride;
  $("offer").hidden = false;
  $("offer").innerHTML = `
    <h3>🚕 Nova corrida</h3>
    <p><b>Origem:</b> ${ride.pickup.label}</p>
    <p><b>Destino:</b> ${ride.destination.label}</p>
    <p><b>Distância:</b> ${Number(payload.pickupDistanceKm).toFixed(2)} km</p>
    <button onclick="acceptRide('${ride.id}')">✅ ACEITAR</button>
    <button onclick="rejectRide('${ride.id}')">❌ RECUSAR</button>
  `;
}

window.acceptRide = async (rideId) => {
  await api(`/api/rides/${rideId}/accept`, {
    method: "POST",
    body: JSON.stringify({ driverId: driver.id })
  });
  $("offer").hidden = true;
  currentOffer = null;
  refresh();
};

window.rejectRide = async (rideId) => {
  await api(`/api/rides/${rideId}/reject`, {
    method: "POST",
    body: JSON.stringify({ driverId: driver.id })
  });
  $("offer").hidden = true;
  currentOffer = null;
  refresh();
};

$("registerDriver").onclick = async () => {
  driver = await api("/api/drivers/register", {
    method: "POST",
    body: JSON.stringify({ name: $("driverName").value })
  });
  $("driverPanel").hidden = false;
  $("driverId").textContent = driver.id;
  await connectDriverWs();
  refresh();
};

$("startShift").onclick = async () => {
  let position = null;
  try { position = await gps(); } catch (e) { alert("GPS: " + e.message); }
  driver = await api(`/api/drivers/${driver.id}/shift/start`, {
    method: "POST",
    body: JSON.stringify(position || {})
  });
  refresh();
};

$("sendMapsLink").onclick = async () => {
  const link = $("mapsLink").value.trim();
  if (!link) return alert("Cole o link do Google Maps.");
  try {
    driver = await api(`/api/drivers/${driver.id}/location-link`, {
      method: "POST",
      body: JSON.stringify({ link })
    });
    alert("Link recebido pelo backend.");
    refresh();
  } catch (e) {
    alert("Maps: " + e.message);
  }
};

$("sendLocation").onclick = async () => {
  try {
    const position = await gps();
    driver = await api(`/api/drivers/${driver.id}/location`, {
      method: "POST",
      body: JSON.stringify(position)
    });
    refresh();
  } catch (e) {
    alert("GPS: " + e.message);
  }
};

$("stopShift").onclick = async () => {
  driver = await api(`/api/drivers/${driver.id}/shift/stop`, { method: "POST" });
  refresh();
};

$("usePassengerGps").onclick = async () => {
  try {
    const p = await gps();
    $("pickupLat").value = p.lat;
    $("pickupLng").value = p.lng;
  } catch (e) {
    alert("GPS: " + e.message);
  }
};

$("requestRide").onclick = async () => {
  const ride = await api("/api/rides", {
    method: "POST",
    body: JSON.stringify({
      passengerId,
      pickupLat: Number($("pickupLat").value),
      pickupLng: Number($("pickupLng").value),
      pickupLabel: $("pickupLabel").value,
      destinationLabel: $("destinationLabel").value,
      // Para testar a regra "finalizou no destino", usamos coordenadas
      // de destino iguais à origem neste MVP. Edite se quiser testar outro ponto.
      destinationLat: Number($("pickupLat").value),
      destinationLng: Number($("pickupLng").value),
      searchRadiusKm: 10
    })
  });
  $("rideStatus").textContent = `Corrida ${ride.id}: ${ride.status}`;
  refresh();
};

async function refresh() {
  const [drivers, rides] = await Promise.all([
    api("/api/drivers"),
    api("/api/rides")
  ]);

  $("drivers").innerHTML = drivers.map(d => `
    <div class="item">
      <b>${d.name}</b> <code>${d.id}</code>
      <span class="pill">${d.status}</span>
      <br>
      posição: ${d.lat == null ? "—" : `${Number(d.lat).toFixed(5)}, ${Number(d.lng).toFixed(5)}`}
      | fonte: ${d.locationSource || "—"}
      | expira: ${d.locationExpiresAt ? new Date(d.locationExpiresAt).toLocaleTimeString() : "—"}
    </div>
  `).join("") || "<p>Nenhum motorista.</p>";

  $("rides").innerHTML = rides.slice().reverse().map(r => `
    <div class="item">
      <b>${r.id}</b> — ${r.status}
      | motorista: ${r.currentDriverId || "—"}
      | ${r.pickup.label} → ${r.destination.label}
    </div>
  `).join("") || "<p>Nenhuma corrida.</p>";

  if (driver) {
    const fresh = drivers.find(d => d.id === driver.id);
    if (fresh) $("driverStatus").textContent = fresh.status;
  }
}

refresh();
setInterval(refresh, 5000);
