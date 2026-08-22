const $ = id => document.getElementById(id);
let timer = null;

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(data.message || data.error || `HTTP ${response.status}`);
    error.data = data;
    throw error;
  }

  return data;
}

$("resolve").onclick = async () => {
  $("status").textContent = "🟡 Abrindo Google Maps no navegador do backend...";
  $("diagnostic").textContent = "Aguardando...";

  try {
    const data = await api("/api/location/resolve", {
      method: "POST",
      body: JSON.stringify({
        driverId: $("driverId").value.trim(),
        link: $("mapsLink").value.trim()
      })
    });

    $("status").textContent = "🟢 Localização encontrada!";

    $("result").textContent = JSON.stringify({
      driverId: $("driverId").value.trim(),
      latitude: data.lat,
      longitude: data.lng,
      source: data.location.source,
      updatedAt: new Date(data.location.updatedAt).toLocaleString(),
      expiresAt: new Date(data.location.expiresAt).toLocaleString()
    }, null, 2);

    $("diagnostic").textContent = JSON.stringify({
      finalUrl: data.finalUrl,
      matchedFrom: data.matchedFrom
    }, null, 2);

  } catch (error) {
    $("status").textContent = "🔴 Coordenadas não encontradas neste teste.";

    const data = error.data || {};
    $("result").textContent = JSON.stringify({
      resolved: false,
      error: data.error || error.message,
      reason: data.reason || null
    }, null, 2);

    $("diagnostic").textContent = JSON.stringify({
      finalUrl: data.finalUrl || null,
      title: data.title || null,
      htmlLength: data.htmlLength || null,
      visibleTextSample: data.visibleTextSample || []
    }, null, 2);
  }
};

async function poll() {
  const id = encodeURIComponent($("driverId").value.trim());

  try {
    const data = await api(`/api/location/${id}`);

    $("result").textContent = JSON.stringify(data.location, null, 2);
    $("loop").textContent =
      `🟢 Localização disponível — ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    $("loop").textContent = `🟡 ${e.message}`;
  }
}

$("start").onclick = () => {
  if (timer) return;
  poll();
  timer = setInterval(poll, 5000);
  $("loop").textContent = "🟢 Loop ativo — 5 segundos.";
};

$("stop").onclick = () => {
  clearInterval(timer);
  timer = null;
  $("loop").textContent = "⏹ Parado.";
};
