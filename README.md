# Rotas GO — Location Resolver V2

Esta versão muda o teste anterior.

Agora o backend usa **Playwright (Chromium)** para abrir o link do Google Maps como um navegador real, esperar o carregamento e procurar coordenadas no conteúdo renderizado.

Fluxo:

Google Maps shared link
→ Playwright no backend
→ redirect
→ página renderizada
→ URL/HTML/texto
→ tentativa de latitude/longitude
→ cache temporário
→ frontend.

## Instalação

Node.js 20+ recomendado.

```bash
npm install
npx playwright install chromium
npm start
```

Abra:

```text
http://localhost:3000
```

O link do teste já vem preenchido.

## O que mudou

A versão anterior fazia somente `fetch()`.

Agora:

```text
fetch()
  ❌ pode não executar o JavaScript do Maps

Playwright / Chromium
  ✅ executa a página como navegador
```

Isso aumenta bastante a chance de encontrar dados que só aparecem depois do carregamento da página.

## Se aparecer "coordenadas não encontradas"

Não significa necessariamente que o link não possui localização.

O painel de diagnóstico mostrará:

- URL final;
- título da página;
- tamanho do HTML;
- parte do texto que o navegador conseguiu enxergar.

Isso permite o próximo passo de engenharia.

## Importante

Isto é um laboratório/prova de conceito.

Não estamos afirmando que o Google Maps oferece uma API pública para extrair a localização compartilhada por esses links. O Google pode mudar a página, exigir autenticação, bloquear automação ou não disponibilizar coordenadas ao navegador automatizado.

Para produção, devemos usar uma fonte de localização oficialmente suportada ou o GPS do próprio PWA/app.

## Objetivo final

Se o experimento funcionar:

```text
Motorista
  ↓
compartilha localização
  ↓
link
  ↓
Rotas GO
  ↓
resolver
  ↓
lat/lng
  ↓
Redis GEO
  ↓
WebSocket
  ↓
mapa
  ↓
matching de corrida
```
