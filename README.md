# Rotas GO — Location Resolver V4

Esta versão foi criada para diagnosticar o erro:

`Unexpected end of JSON input`

## O que mudou

- `/health` para verificar se o backend está vivo.
- `/api/version` para confirmar a versão.
- timeout rígido para o Playwright.
- `try/catch/finally` no navegador.
- o backend sempre tenta devolver JSON, inclusive em erros.
- o frontend lê primeiro como texto e só depois tenta `JSON.parse()`.
- não existe mais acesso inseguro a `data.location.source`.
- cache em memória com expiração para testar o conceito de TTL.
- Chromium com flags para ambientes de container/Render.

## Instalação

```bash
npm install
npx playwright install chromium
npm start
```

## Render

Build Command:

```bash
npm install && npx playwright install chromium
```

Start Command:

```bash
npm start
```

## Endpoints

```text
GET  /health
GET  /api/version
POST /api/location/resolve
GET  /api/location/:driverId
```

## Importante

Esta é uma prova de conceito. O objetivo é descobrir se o link de compartilhamento do Google Maps pode ser resolvido no backend e se as coordenadas ficam acessíveis ao navegador automatizado. Para produção, o modelo preferível continua sendo localização obtida diretamente pelo app/PWA com consentimento do motorista, não depender de scraping de páginas do Google Maps.
