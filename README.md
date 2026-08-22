# Rotas GO — Mobility MVP

MVP local para testar a ideia:

**motorista → localização → disponibilidade → cliente solicita → Dispatch Engine → oferta ao motorista mais próximo → aceitar/recusar → próximo motorista → finalizar → motorista volta a disponível**

## O que já está implementado

- Cadastro de motorista.
- Início/encerramento de expediente.
- Geolocalização real pelo navegador, quando disponível.
- Atualização manual de posição para teste.
- Expiração automática de localização (90 s por padrão).
- Lista de motoristas disponíveis.
- Busca por distância usando Haversine.
- Dispatch para o motorista mais próximo.
- Timeout de oferta (15 s).
- Recusa → próximo motorista.
- Aceite → motorista fica BUSY.
- Finalização → motorista volta AVAILABLE.
- Destino da corrida pode virar a última localização conhecida (`RIDE_DESTINATION`).
- WebSocket para eventos em tempo real.
- Não usa Google Maps API.
- Não grava cada posição em banco permanente neste MVP.

## Requisitos

- Node.js 20+
- navegador moderno

## Rodar

```bash
npm install
npm start
```

Abra:

```text
http://localhost:3000
```

Para testar GPS real, o navegador normalmente exige contexto seguro. `localhost` é tratado como contexto seguro pelos navegadores modernos. Em produção, use HTTPS.

## Testar o fluxo

1. Cadastre um motorista.
2. Clique em **Iniciar expediente**.
3. Permita o GPS.
4. Em outro navegador/aba, solicite uma corrida usando coordenadas próximas.
5. O motorista recebe a oferta.
6. Clique em **Recusar** e o sistema tenta outro motorista disponível.
7. Clique em **Aceitar**.
8. Depois, no MVP, as rotas de API podem ser usadas para iniciar/finalizar a corrida.
9. Ao finalizar, o destino pode virar a localização conhecida do motorista.

## API principal

- `POST /api/drivers/register`
- `POST /api/drivers/:id/shift/start`
- `POST /api/drivers/:id/location`
- `POST /api/drivers/:id/shift/stop`
- `GET /api/drivers`
- `POST /api/rides`
- `POST /api/rides/:id/accept`
- `POST /api/rides/:id/reject`
- `POST /api/rides/:id/start`
- `POST /api/rides/:id/complete`
- `GET /api/rides`
- `GET /api/health`

## Próxima evolução

Este é um laboratório de arquitetura, não produção. Para produção:

- Redis GEO para posições temporárias.
- PostgreSQL para motoristas, passageiros, corridas, pagamentos e auditoria.
- autenticação/JWT;
- WhatsApp Business Platform para comunicação;
- PWA ou app Android para localização em segundo plano;
- regras de expiração e privacidade;
- antifraude;
- pagamentos;
- painel de despacho;
- múltiplas cidades/áreas;
- cálculo de rota apenas quando necessário.
