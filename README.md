# Rotas GO — Location Resolver Test

Este projeto testa experimentalmente:

Google Maps shared link
→ backend
→ redirect final
→ tentativa de extração de latitude/longitude
→ armazenamento temporário
→ frontend consulta a posição.

## Rodar

Requer Node.js 20+.

```bash
npm install
npm start
```

Abra:

```text
http://localhost:3000
```

O campo já vem preenchido com o link de teste fornecido.

## Endpoint

```http
POST /api/location/resolve
Content-Type: application/json
```

Exemplo:

```json
{
  "driverId": "DRV-34912",
  "link": "https://maps.app.goo.gl/..."
}
```

Se encontrar coordenadas:

```json
{
  "resolved": true,
  "lat": -16.123,
  "lng": -49.123,
  "location": {
    "source": "GOOGLE_MAPS_SHARED_LINK",
    "expiresAt": 178..."
  }
}
```

## Atenção

Este é um TESTE, não uma integração oficial do Google.

O resolver tenta extrair coordenadas de formatos públicos encontrados na URL final ou no HTML. O Google pode alterar o formato, exigir JavaScript, login ou impedir automação. Portanto, uma resposta `422` não significa que o link não contém uma localização; significa apenas que este protótipo não conseguiu extraí-la.

Não use scraping desse tipo como base de produção sem verificar os termos e uma integração oficialmente suportada.

## Próximo teste

Se este protótipo conseguir extrair as coordenadas do link real, podemos ligar:

Google Maps link
→ resolver
→ Redis GEO
→ WebSocket
→ mapa do Rotas GO
→ Dispatch Engine.

A partir daí testamos vários motoristas simultaneamente.
