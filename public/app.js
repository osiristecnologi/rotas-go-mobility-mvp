const $ = id => document.getElementById(id);

let timer = null;

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.message || data.error || `HTTP ${response.status}`);
  }

  return data;
}

$("resolve").onclick = async () => {
  $("result").textContent = "Resolvendo link...";

  try {
    const data = await api("/api/location/resolve", {
      method: "POST",
      body: JSON.stringify({
        driverId: $("driverId").value.trim(),
        link: $("mapsLink").value.trim()
      })
    });

    $("result").innerHTML = `
      <b>✅ Localização encontrada</b>
      <br>Latitude: ${data.lat}
      <br>Longitude: ${data.lng}
      <br>Status HTTP: ${data.status}
      <br><small>URL final: ${escapeHtml(data.finalUrl)}</small>
    `;

    renderLocation(data.location);
  } catch (e) {
    $("result").innerHTML =
      `<b>❌ Não foi possível extrair coordenadas</b><br>${escapeHtml(e.message)}`;
  }
};

function renderLocation(data) {
  if (!data) {
    $("location").textContent = "Nenhuma localização.";
    return;
  }

  $("location").textContent = JSON.stringify({
    driverId: $("driverId").value,
    latitude: data.lat,
    longitude: data.lng,
    source: data.source,
    updatedAt: new Date(data.updatedAt).toLocaleString(),
    expiresAt: new Date(data.expiresAt).toLocaleString()
  }, null, 2);
}

async function poll() {
  const id = encodeURIComponent($("driverId").value.trim());

  try {
    const data = await api(`/api/location/${id}`);
    renderLocation(data.location);
    $("loopStatus").textContent =
      `🟢 Última consulta: ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    $("loopStatus").textContent =
      `🟡 ${e.message}`;
  }
}

$("startLoop").onclick = () => {
  if (timer) return;
  poll();
  timer = setInterval(poll, 5000);
  $("loopStatus").textContent = "🟢 Loop ativo — consulta a cada 5 segundos.";
};

$("stopLoop").onclick = () => {
  clearInterval(timer);
  timer = null;
  $("loopStatus").textContent = "⏹ Loop parado.";
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
