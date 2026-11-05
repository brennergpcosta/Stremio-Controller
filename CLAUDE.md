# Stremio-Controller

Controle remoto do Stremio pelo celular. O Stremio aberto no PC (versão 5, `stremio-shell-ng`) é comandado pela porta de controle do WebView2 (Chrome DevTools Protocol). O celular usa uma página (PWA) no GitHub Pages.

- `docs/`: página do celular (publicada pelo GitHub Pages).
- `pc/`: programa do Windows que fica em segundo plano e conversa com o Stremio aberto.

## Fluxo de commit e push

- O trabalho é feito em sessões Remote Control no PC do Brenner, na pasta `C:\Users\brenn\Repo\Stremio-Controller` (GitHub: `brennergpcosta/Stremio-Controller`).
- Commits, pushes e releases saem pela conta do Brenner, usando o `git` e o `gh` do PC dele, nunca pela conta do Claude.
- Cada thread faz commit e push sozinha assim que termina e verifica um pedido, sem pedir aprovação.
- Um commit por pedido. Nunca junte vários pedidos num commit só.
- Cada thread commita SÓ as próprias mudanças: rode `git status` antes, faça `git add` só nos seus arquivos (`git add -p` nos compartilhados) e nunca misture com o trabalho de outra thread.
- Uma versão por push, não por commit: escolha o número na hora do push (o próximo acima da última tag no `main`), atualize o `CHANGELOG.md` listando todas as mudanças do push, crie a tag e dê push. Não prometa número de versão antes.
- Versões: `MAJOR.MINOR.PATCH` (major = app mudou completamente, minor = features novas, patch = consertos e ajustes pequenos).
- Se uma mudança depende do trabalho de outra thread que ainda não subiu, combine com ela e lance as duas juntas numa versão só.
- Depois do push da tag, crie a release no GitHub com `gh` (notas = entrada do `CHANGELOG.md` daquela versão).
