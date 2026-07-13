# Ponte Escolar

Aplicativo desktop residente para integrar catracas Control iD ao ActiveSoft SIGA. Recebe identificações e confirmações de giro pela rede local, associa o `user_id` da Control iD ao aluno sincronizado, registra entrada/saída na ActiveSoft e exibe a foto do último acesso.

## Executar em desenvolvimento

```bash
npm install
npm run dev
```

## Gerar o instalador Windows

Execute em um computador Windows x64 ou dispare manualmente o workflow `Gerar instalador Windows` no GitHub Actions:

```powershell
npm ci
npm run dist:win
```

O instalador NSIS será criado em `release/`. Após instalado, o aplicativo inicia com o Windows, permanece na bandeja do sistema e fecha a janela sem interromper o receptor.

## Endpoints locais já aceitos

- `POST /new_user_identified.fcgi`
- `POST /api/notifications/access_logs`
- `POST /api/notifications/catra_event`
- `POST /device_is_alive.fcgi`
- `POST /api/notifications/device_is_alive`
- `GET /health`

O registro de frequência só é disparado depois da confirmação de giro. Eventos de desistência são ignorados.

## Premissa de identificação

Nesta primeira versão, o `user_id` cadastrado na Control iD deve ser igual ao `id` do aluno retornado por `GET /api/v0/lista_alunos/`. Essa regra deve ser confirmada durante a configuração final do equipamento.
