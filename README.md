# Stremio Controller

Controle remoto do Stremio pelo celular.

O Stremio 5 aberto no PC (`stremio-shell-ng`, que usa WebView2) é comandado pela porta de controle do WebView2 (Chrome DevTools Protocol). Um programa no PC fica perto do relógio, acha o Stremio aberto e atende o celular por uma conexão direta (WebRTC). No celular você navega à vontade sem mudar nada na tela do PC; só o "tocar" abre o player do próprio Stremio.

- `docs/`: página do celular (PWA no GitHub Pages): https://brennergpcosta.github.io/Stremio-Controller/
- `pc/`: programa do Windows (Go, um `.exe` só, sem instalador).

## Instalar

1. Dois cliques em `pc/porta-ligar.reg` (liga a porta de controle do Stremio; `porta-desligar.reg` desfaz). Feche e abra o Stremio depois.
2. Baixe o `StremioController.exe` da [última release](https://github.com/brennergpcosta/Stremio-Controller/releases/latest) e ponha numa pasta sua, por exemplo `%LOCALAPPDATA%\Stremio-Controller\`. Ele se atualiza sozinho nessa pasta.
3. Abra o `.exe`. Na primeira vez ele liga o "Iniciar com o Windows" e mostra o QR code.
4. Leia o QR code com a câmera do celular. A página abre já pareada. No Chrome do celular, "Adicionar à tela inicial" instala como app.

O Windows pode avisar que o programa não é conhecido (SmartScreen), porque o `.exe` não tem assinatura digital: "Mais informações" → "Executar assim mesmo".

## Ícone perto do relógio

- **Mostrar QR code**: para parear outro celular.
- **Trocar QR code**: cria uma chave nova; o celular antigo para de funcionar.
- **Iniciar com o Windows**: liga e desliga.
- **Sair**.

## Perfis

Cada instalação do Stremio é um perfil, com a sua porta: perfil A na 9222 (`stremio-shell-ng.exe`) e perfil B na 9223 (`stremio-shell-ng-2.exe`). Só um abre por vez. Para o celular conseguir abrir o perfil B, ponha o caminho do `.exe` dele em `%APPDATA%\Stremio-Controller\config.json`, campo `perfilB`.

## Como funciona

- Pareamento: o QR code leva o link da página com uma chave depois do `#` (não sai do celular). A oferta e a resposta do WebRTC passam pelo ntfy.sh criptografadas com essa chave (AES-GCM); depois tudo vai direto entre o celular e o PC.
- O programa do PC injeta `pc/page.js` na página do Stremio, que lê o estado pelo `window.core` (Continuar Assistindo, biblioteca, perfil, addons), busca dados e fontes nos addons instalados e toca pela rota `#/player/...`. Os links das fontes ficam no PC; o celular só recebe nomes.
- Controles do player: teclas (Espaço, setas, F) e cliques nas barras de tempo e volume, enviados pela porta de controle.
- `pc/teste-stremio.mjs`: o teste de viabilidade (Node 22+).
