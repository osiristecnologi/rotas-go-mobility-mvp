# Rotas GO — Location Resolver V4.1

Versão ajustada após os 3 testes que falharam (resposta vazia, JSON incompleto e acesso a `source` indefinido).

## O que mudou no 4.1

- **Fetch-first**: tenta expandir o short link (`maps.app.goo.gl`) com `fetch` nativo antes de abrir o Chromium. Muitos links de lugar já resolvem só pela URL final.
- Trata redirect `intent://` e extrai `browser_fallback_url`.
- Extrator de coordenadas mais amplo (mais padrões de URL, meta, JSON-ish).
- Playwright só como fallback (pode ser desligado com `PLAYWRIGHT_ENABLED=0`).
- Intercepta algumas respostas de rede do Maps em busca de lat/lng.
- Diagnóstico mais rico no JSON de resposta (`diagnostic.steps`, `expandedUrl`, erros parciais).
- Logs claros no servidor: `[RESOLVE] start | success | not found | error`.
- Frontend mostra versão, status do Playwright e mensagens de diagnóstico melhores.
- Timeout um pouco maior e flags extras no Chromium para ambientes com pouca memória.

## Instalação

```bash
npm install
npx playwright install chromium
npm start
```

## Render / deploy

**Build Command:**
```bash
npm install && npx playwright install chromium
```

**Start Command:**
```bash
npm start
```

Variáveis de ambiente úteis:

| Variável | Default | Descrição |
|----------|---------|-----------|
| `PORT` | 3000 | Porta |
| `RESOLVE_TIMEOUT_MS` | 22000 | Timeout total da resolução |
| `LOCATION_TTL_MS` | 90000 | TTL da localização em memória |
| `PLAYWRIGHT_ENABLED` | 1 | Use `0` para desligar o browser (só fetch) |

## Endpoints

```text
GET  /health
GET  /api/version
POST /api/location/resolve
GET  /api/location/:driverId
```

## Importante

Esta continua sendo uma **prova de conceito**.

- Links de **lugar** (que terminam com `@lat,lng` ou `!3d...!4d...`) costumam funcionar.
- Shares de **localização ao vivo** do Google Maps quase nunca expõem as coordenadas de forma scrapável (privacidade + conteúdo dinâmico). Nesses casos o resolver corretamente devolve `resolved: false`.
- Em produção o caminho recomendado continua sendo: localização obtida **diretamente no dispositivo do motorista** (Geolocation API / PWA / app nativo) com consentimento, enviada para o backend.

Se o backend devolver resposta vazia no deploy, o culpado mais comum ainda é **falta de memória** ao subir o Chromium. Nesse caso teste com `PLAYWRIGHT_ENABLED=0` ou aumente a RAM do serviço.
