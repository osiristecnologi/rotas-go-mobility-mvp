const $ = id => document.getElementById(id);

function print(value) {
  $("result").textContent = JSON.stringify(value, null, 2);
}

async function resolve() {
  $("status").textContent = "🟡 Resolvendo no backend...";
  $("diagnostic").textContent = "Executando...";

  try {
    const response = await fetch("/api/location/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        driverId: $("driverId").value.trim(),
        link: $("mapsLink").value.trim()
      })
    });

    const data = await response.json();

    // Nunca acessar data.location.source.
    // A V3 retorna tudo no nível superior para evitar o erro da V2.
    if (!response.ok || data.resolved !== true) {
      $("status").textContent =
        "🔴 " + (data.reason || data.error || `HTTP ${response.status}`);

      print(data);

      $("diagnostic").textContent = JSON.stringify({
        httpStatus: response.status,
        finalUrl: data.finalUrl ?? null,
        title: data.title ?? null,
        htmlLength: data.htmlLength ?? null,
        matchedFrom: data.matchedFrom ?? null,
        visibleTextSample: data.visibleTextSample ?? []
      }, null, 2);

      return;
    }

    $("status").textContent = "🟢 Coordenadas encontradas!";

    print({
      driverId: data.driverId,
      latitude: data.lat,
      longitude: data.lng,
      source: data.source,
      updatedAt: new Date(data.updatedAt).toLocaleString(),
      expiresAt: new Date(data.expiresAt).toLocaleString(),
      finalUrl: data.finalUrl
    });

    $("diagnostic").textContent = JSON.stringify({
      httpStatus: response.status,
      matchedFrom: data.matchedFrom,
      finalUrl: data.finalUrl
    }, null, 2);

  } catch (error) {
    $("status").textContent = "🔴 Erro de comunicação com o backend.";
    print({
      resolved: false,
      clientError: error.message
    });
    $("diagnostic").textContent = "O frontend não conseguiu receber uma resposta JSON válida.";
  }
}

async function checkVersion() {
  try {
    const data = await fetch("/api/version").then(r => r.json());
    $("version").textContent = `Backend: V${data.version} — ${data.resolver}`;
  } catch {
    $("version").textContent = "Backend: não respondeu";
  }
}

$("resolve").onclick = resolve;
checkVersion();
