# Rotas GO Location Resolver V3

V3 corrige o erro da V2 (`reading 'source' of undefined`) e adiciona `/api/version`.

Também adiciona flags de Chromium importantes para ambientes como Render.

Instalação:
```bash
npm install
npx playwright install chromium
npm start
```

Teste:
`/api/version`

O frontend agora nunca assume que `data.location` existe.
