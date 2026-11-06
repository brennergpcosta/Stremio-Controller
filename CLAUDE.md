# Stremio-Controller

Controle remoto do Stremio pelo celular. O Stremio aberto no PC (versão 5, `stremio-shell-ng`) é comandado pela porta de controle do WebView2 (Chrome DevTools Protocol). O programa do PC serve a página do celular na rede de casa.

- `pc/`: programa do Windows que fica em segundo plano e conversa com o Stremio aberto. A página do celular fica em `pc/web/` (embutida no .exe); `pc/page.js` é o código injetado no Stremio.
- `docs/`: leitor de QR code no GitHub Pages (a câmera do celular só funciona em https).

## Fluxo de commit e push

- O trabalho é feito em sessões Remote Control no PC do Brenner, na pasta local do clone deste repositório (GitHub: `brennergpcosta/Stremio-Controller`).
- Commits, pushes e releases saem pela conta do Brenner, usando o `git` e o `gh` do PC dele, nunca pela conta do Claude.
- Cada thread faz commit e push sozinha assim que termina e verifica um pedido, sem pedir aprovação.
- Um commit por pedido. Nunca junte vários pedidos num commit só.
- Cada thread commita SÓ as próprias mudanças: rode `git status` antes, faça `git add` só nos seus arquivos (`git add -p` nos compartilhados) e nunca misture com o trabalho de outra thread.
- Uma versão por push, não por commit: escolha o número na hora do push (o próximo acima da última tag no `main`), atualize o `CHANGELOG.md` listando todas as mudanças do push, crie a tag e dê push. Não prometa número de versão antes.
- Versões: `MAJOR.MINOR.PATCH` (major = app mudou completamente, minor = features novas, patch = consertos e ajustes pequenos).
- Se uma mudança depende do trabalho de outra thread que ainda não subiu, combine com ela e lance as duas juntas numa versão só.
- Depois do push da tag, crie a release no GitHub com `gh` (notas = entrada do `CHANGELOG.md` daquela versão).

## Privacidade

Este repositório é público. Nada dos perfis do Stremio do Brenner nem dados pessoais entram no repositório, nos commits, no `CHANGELOG.md`, nas releases, issues ou PRs:

- Nada de e-mails, `authKey`, lista de addons, títulos da biblioteca ou do Continuar Assistindo, histórico, IPs, tópicos do ntfy ou chaves de pareamento.
- Nunca commite URLs de addons (`transportUrl`): elas carregam as chaves do debrid (TorBox etc.).
- Caminhos locais (como a pasta de instalação de um perfil ou a pasta do usuário) ficam só num arquivo de configuração local fora do repositório, por exemplo `%APPDATA%\Stremio-Controller\config.json`.
- No código e na documentação use exemplos genéricos (perfil A, porta 9222, IDs de exemplo).
- Antes de cada commit, confira o diff procurando e-mails, chaves, URLs com tokens e títulos.

## Sem serviços de terceiros

- Faça tudo localmente, com ferramentas nossas. O usuário só roda o programa e usa o quanto quiser, sem se preocupar com nada.
- Não use serviços de terceiros (servidores, APIs, retransmissores), a menos que sejam excelentes, gratuitos para sempre e sem limite de uso. Bibliotecas são liberadas.
- O controle funciona na rede de casa (Wi-Fi): o programa do PC serve a página do celular e recebe os comandos direto, sem nada no meio.
