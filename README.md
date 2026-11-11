# custom-google-flow-mcp

Servidor MCP (stdio, TypeScript) que automatiza o **Google Flow** (`flow.google.com`, antigo `labs.google/fx/tools/flow`)
no seu próprio navegador logado, via Chrome DevTools Protocol. Baseado na arquitetura de
[retrolyze52/google-flow-mcp](https://github.com/retrolyze52/google-flow-mcp), reescrito em módulos.

## Instalação

Requisitos: **Node.js 20+** e um navegador Chromium (Chrome, Brave, Edge ou Chromium).

### Opção 1 — Plugin do Claude Code (mais fácil)

Dentro do Claude Code:

```
/plugin marketplace add kasseditor-oss/custom-google-flow-mcp
/plugin install google-flow@kasseditor-oss
```

Na primeira execução o plugin instala as dependências sozinho (~5 s). Depois faça o login uma vez (veja "Primeiro login").

### Opção 2 — Um comando (Claude Code + Claude Desktop)

```
npx -y github:kasseditor-oss/custom-google-flow-mcp install
```

Instala uma cópia permanente em `%LOCALAPPDATA%\custom-google-flow-mcp\app`, registra o servidor `google-flow`
no Claude Code (escopo usuário) e no `claude_desktop_config.json` do Claude Desktop (com backup `.bak`).
Opções: `--output-root D:/Videos`, `--concurrency 2`, `--name meu-flow`, `--only code|desktop`.

### Opção 3 — Clonar

```
git clone https://github.com/kasseditor-oss/custom-google-flow-mcp.git
cd custom-google-flow-mcp
npm install --omit=dev
npm run setup        # mesmo registro automático da opção 2
```

`dist/` já vem compilado no repositório; não precisa de build.

### Primeiro login

```
npx -y github:kasseditor-oss/custom-google-flow-mcp auth
```

(ou `npm run auth` na pasta clonada). Abre o navegador com perfil dedicado; entre na conta Google e clique em
"Crie com o Google Flow". Depois, no Claude, peça `flow_check_session`.

### Pedir para o Claude instalar

Cole no Claude Code: *"Instale o MCP https://github.com/kasseditor-oss/custom-google-flow-mcp rodando
`npx -y github:kasseditor-oss/custom-google-flow-mcp install` e depois rode o comando `auth` dele."*

## Visual no chat (MCP Apps)

As tools de geração abrem um **widget dentro do chat** (padrão oficial MCP Apps, o mesmo usado por conectores
como o Higgsfield): logo animado com "Gerando no Google Flow…", fase e tempo; ao terminar, a imagem / capa do vídeo
grande com modelo · proporção · prompt sobrepostos e botões **Abrir** e **Mostrar na pasta**. Lotes mostram uma grade
com o progresso de cada take.

* Funciona no **Claude Desktop** (servidor local) e em outros hosts com MCP Apps (ex.: VS Code).
* Hosts sem MCP Apps (ex.: Claude Code no terminal) recebem a miniatura como imagem na resposta da tool.
* O ícone oficial do Google Flow é baixado do servidor público do Google (`gstatic.com`) na sua máquina e guardado em cache
  (`%LOCALAPPDATA%\custom-google-flow-mcp\brand`); ele não é distribuído neste repositório. Sem internet, usa um logo genérico.

## Navegador invisível

Depois do `auth`, o MCP usa o perfil logado em **modo headless**: nenhuma janela ou ícone aparece. O navegador abre só
quando há trabalho e fecha sozinho após `FLOW_MCP_IDLE_CLOSE_SECONDS` (padrão 90 s) sem uso, e também quando o MCP
encerra. Um navegador que *você* abriu (ex.: o do `auth`) nunca é fechado pelo MCP. Para ver o que ele faz:
`FLOW_MCP_HEADLESS=0`.

## Tools

| Tool | O que faz |
|---|---|
| `flow_check_session` | Conecta no Chrome (CDP) e diz se o Flow está logado e pronto. |
| `flow_health_check` | Login + sondagem de todos os seletores (mostra qual fallback casou) + screenshot em `logs/error-debug.png` se algo falhar. |
| `flow_generate_video` | Texto → vídeo. `aspect_ratio`, `camera_motion`, `outputs_count`, `model`, nomenclatura. |
| `flow_image_to_video` | `start_frame`, `end_frame`, `reference_images` (ingredientes) → vídeo. |
| `flow_generate_image` | Imagens (Nano Banana / Imagen dentro do Flow). |
| `flow_generate_batch` | Storyboard inteiro em background: concorrência 1–4, retry com backoff exponencial, manifesto. |
| `flow_get_queue_status` | Progresso de lote/job sem bloquear. |
| `flow_cancel` | Cancela job ou lote. |
| `flow_preview`, `flow_open_file` | Usadas só pelo widget do chat (ocultas do modelo). |

As tools de geração aceitam `wait` (padrão `true`, até `wait_timeout_seconds`) — se o vídeo demorar mais, retornam `job_id` e o job continua em background.

## Saída para edição

```
<output_dir>/<project_name>/
  manifest.json                    ← prompt, prompt final enviado, parâmetros, como cada um foi aplicado (ui/prompt), sha256, ffprobe, URL do projeto Flow
  Assets_Flow/
    Scene_01_Take_01.mp4
    Scene_01_Take_02_v1.mp4        ← outputs_count > 1
    Scene_01_Take_02_v2.mp4
    Scene_01_Take_02_alt2.mp4      ← nunca sobrescreve (a menos que overwrite=true)
```

`output_dir` padrão: `C:/Projetos` (`FLOW_MCP_OUTPUT_ROOT`). O Flow não expõe seed na UI; o manifesto grava `seed: null` explicitamente.

## Autenticação (CDP híbrido)

* `npm run auth` — abre (visível, só para o login) um Chrome **real** (não build de automação) com perfil dedicado
  (`%LOCALAPPDATA%\custom-google-flow-mcp\chrome-profile`) e `--remote-debugging-port=9222`. Você faz login uma vez; a sessão fica no perfil, sem 2FA repetido.
* O MCP (`FLOW_MCP_BROWSER_MODE=auto`) anexa a esse Chrome via `connectOverCDP`. Se estiver fechado, relança com o mesmo perfil.
* `cdp` = só anexa (use se você mesmo abre o navegador com `--remote-debugging-port=9222 --user-data-dir=...`). Chrome 136+ não aceita a porta de debug no perfil padrão — por isso o perfil dedicado.
* Navegador detectado automaticamente: Chrome → Chromium → Brave → Edge → Chromium do Playwright. Force com `FLOW_MCP_BROWSER_EXECUTABLE`.

## Robustez

* **`src/selectors.ts`**: cada elemento tem estratégias em ordem (ícone Material → aria-label PT/EN → role → texto → CSS). UI mudou? Edite só esse arquivo.
* Parâmetros sem controle visível na UI (proporção, câmera, frames) caem para **diretiva no prompt**; o manifesto registra `applied_via`.
* Erros classificados: `rate_limited`/`server_error`/`generation_timeout` → retry com backoff (rate limit dobra a espera); `policy_blocked`/`insufficient_credits` → falha direta.
* Créditos já gastos não são gastos de novo: se falhar após o envio (timeout, download), o retry **retoma** o mesmo resultado em vez de reenviar.
* Concorrência > 1: cada worker usa aba e projeto Flow próprios (galerias não se misturam).
* Falhas salvam screenshot em `logs/job-<id>-attempt<n>.png`.

## Comandos

```
custom-google-flow-mcp            # servidor MCP (stdio)
custom-google-flow-mcp install    # registra no Claude Code / Desktop
custom-google-flow-mcp auth       # login inicial
custom-google-flow-mcp chrome     # só sobe o navegador com CDP
```

Na pasta clonada: `npm run setup | auth | chrome | smoke`. Desenvolvimento: `npm install && npm run build` (commite o `dist/`).

Variáveis: veja `.env.example`. Exemplos de config e storyboard em `examples/`.

## Licença

MIT. Partes derivadas de retrolyze52/google-flow-mcp (MIT).
