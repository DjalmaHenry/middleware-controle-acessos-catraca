# Ponte ID

Aplicativo desktop residente para integrar catracas Control iD ao ActiveSoft SIGA. Recebe identificações e confirmações de giro pela rede local, associa o `user_id` da Control iD ao aluno sincronizado, registra entrada/saída na ActiveSoft e exibe a foto do último acesso.

## Executar em desenvolvimento

```bash
npm install
npm run dev
```

## Gerar o instalador Windows

### Requisitos

- Windows 10 ou Windows 11 x64;
- Git para Windows;
- Node.js 22 LTS, que já inclui o npm;
- conexão com a internet durante a primeira build.

### Build automatizada

Depois de clonar o repositório, abra o PowerShell ou Terminal do Windows dentro da pasta do projeto e execute:

```powershell
.\build-windows.cmd
```

O script instala exatamente as dependências do `package-lock.json`, executa os testes, remove builds antigas, gera o instalador NSIS x64 e mostra o SHA-256 do arquivo.

Também é possível executar diretamente pelo PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\build-windows.ps1
```

O instalador será criado em:

```text
release\Ponte ID Setup 0.1.7.exe
```

Para executar cada etapa manualmente:

```powershell
npm ci
npm test
npm run clean
npm run dist:win
```

Também é possível disparar manualmente o workflow `Gerar instalador Windows` no GitHub Actions. Após instalado, o aplicativo inicia com o Windows, permanece na bandeja do sistema e fecha a janela sem interromper o receptor.

O instalador atual não possui certificado comercial de assinatura de código. Até que um certificado seja configurado, o Windows SmartScreen pode solicitar confirmação adicional na primeira execução.

### Gerar no macOS

Em um Mac com Node.js 22 LTS, execute na raiz do projeto:

```bash
./build-windows-macos.sh
```

O script instala as dependências, executa os testes e gera o mesmo instalador NSIS x64 em:

```text
release/Ponte ID Setup 0.1.7.exe
```

Em Macs com Apple Silicon, o script verifica e instala o Rosetta 2 automaticamente na primeira execução. Esta build não requer Docker nem Wine. O comando equivalente pelo npm é `npm run build:windows:macos`.

## Persistência e inicialização

Configurações, alunos sincronizados, histórico recente, fila pendente, associações Control iD e logs são mantidos no diretório de dados do Ponte ID dentro de `%APPDATA%`. O token ActiveSoft é criptografado com a proteção de credenciais do usuário do Windows. O aplicativo mantém também uma cópia de recuperação do arquivo local e o instalador não remove esses dados durante atualização ou desinstalação.

O início automático é obrigatório: após o login na mesma conta do Windows usada na configuração, o Ponte ID inicia oculto e permanece na bandeja. Abrir o atalho quando ele já estiver em execução apenas mostra a janela existente. A validação da instalação também detecta quando a entrada foi desabilitada em `Gerenciador de Tarefas > Aplicativos de inicialização`.

Como a criptografia do token e o auto-início pertencem à conta do Windows, a escola deve manter a mesma conta operacional. Para iniciar antes de qualquer login seria necessário separar o receptor em um Serviço do Windows; a aplicação atual inicia imediatamente após o login.

## Endpoints locais já aceitos

- `POST /new_user_identified.fcgi`
- `POST /api/notifications/dao`
- `POST /api/notifications/access_logs`
- `POST /api/notifications/catra_event`
- `POST /device_is_alive.fcgi`
- `POST /api/notifications/device_is_alive`
- `GET /health`

O registro de frequência só é disparado depois da confirmação de giro. Eventos de desistência são ignorados.

## Premissa de identificação

O campo `registration` do usuário Control iD/iDSecure deve conter a matrícula usada pela ActiveSoft. O middleware aprende e persiste a associação entre o `user_id` interno e essa matrícula. Como compatibilidade para instalações antigas, quando não existe associação conhecida ele tenta localizar um aluno cujo `id` ActiveSoft seja igual ao `user_id`, registrando um erro no Console se não encontrar.

O modo desenvolvedor habilita as abas Console e Instalação. O Console diferencia eventos da catraca, respostas para o equipamento, requisições ActiveSoft, respostas da API e erros. Tokens e senhas são mascarados.

## Instalação assistida

Na aba Instalação, `Preparar este computador` aplica somente mudanças locais seguras:

- registra o auto-início após login;
- reinicia o receptor na porta configurada;
- no Windows, solicita elevação para criar uma regra de Firewall idempotente, restrita aos perfis Domínio e Privado e à sub-rede local. A validação consulta a política efetiva e informa quando uma GPO ignora regras locais.

`Validar instalação` verifica receptor, IPv4, Firewall, perfil da rede, DHCP, auto-início, permissões ActiveSoft sem gravar frequência, alunos, fotos, último evento Control iD, vínculos por matrícula e sentidos de giro. Cada falha inclui uma correção específica.

O receptor possui uma verificação local autenticada em `/health`. A validação e um watchdog em segundo plano reiniciam automaticamente o receptor caso a porta deixe de responder. O endereço do servidor iDSecure é configurado separadamente; na instalação atual, o painel central usa `https://192.168.1.2:30443`, enquanto a porta `8787` pertence exclusivamente ao receptor do Ponte ID.

O aplicativo não modifica automaticamente IP, roteador, `online_client` ou destino atual do Monitor. Essas mudanças podem interromper o iDSecure Enterprise e exigem inspeção da instalação existente.
