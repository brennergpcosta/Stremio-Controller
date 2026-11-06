# Stremio Controller

Controle remoto do Stremio pelo celular, na rede de casa.

O Stremio 5 aberto no PC (`stremio-shell-ng`, que usa WebView2) é comandado pela porta de controle do WebView2 (Chrome DevTools Protocol). Um programa no PC fica perto do relógio, acha o Stremio aberto e serve a página do controle para o celular no mesmo Wi-Fi. Nada passa por serviços de fora. No celular você navega à vontade sem mudar nada na tela do PC; só o "tocar" abre o player do próprio Stremio.

- `pc/`: programa do Windows (Go, um `.exe` só, sem instalador). A página do celular fica dentro dele (`pc/web/`).
- `docs/`: leitor de QR code no GitHub Pages (https://brennergpcosta.github.io/Stremio-Controller/), para quando o celular não acha o PC: lê o QR pela câmera e abre o controle.

## Instalar

1. Dois cliques em `pc/porta-ligar.reg` (liga a porta de controle do Stremio; `porta-desligar.reg` desfaz). Feche e abra o Stremio depois.
2. Baixe o `StremioController.exe` da [última release](https://github.com/brennergpcosta/Stremio-Controller/releases/latest) e ponha numa pasta sua, por exemplo `%LOCALAPPDATA%\Stremio-Controller\`. Ele se atualiza sozinho nessa pasta.
3. Abra o `.exe`. Na primeira vez ele liga o "Iniciar com o Windows" e mostra o QR code.
4. O Windows pergunta se o programa pode usar a rede: marque só **Redes privadas** e clique em **Permitir**.
5. Com o celular no mesmo Wi-Fi, leia o QR code com a câmera. A página abre já pareada. No Chrome do celular, "Adicionar à tela inicial" cria o atalho.

O Windows pode avisar que o programa não é conhecido (SmartScreen), porque o `.exe` não tem assinatura digital: "Mais informações" → "Executar assim mesmo".

Se o endereço do PC na rede mudar (o roteador às vezes troca), a página avisa: é só ler o QR code de novo. Para isso nunca acontecer, dá para fixar o IP do PC no roteador (reserva de DHCP).

## No celular

- **Board**: as mesmas seções do Board do Stremio (Continuar assistindo, catálogos dos addons), com "Ver tudo".
- **Biblioteca** e **Busca** (enquanto digita).
- Temporadas e episódios como no Stremio (assistido, em breve, progresso), fontes com filtro por addon.
- **Controle**: tocar/pausar, ±10 s, barra de tempo, volume, tela cheia, legendas (idioma, variante, atraso, tamanho, posição), áudio, velocidade, escala e próximo episódio.
- **Contas**: tocar no e-mail do topo troca a conta do Stremio no PC. As sessões ficam salvas só no PC, criptografadas (DPAPI do Windows).
- Mesmo idioma do Stremio (usa as traduções dele).

## Ícone perto do relógio

- **Mostrar QR code**: abre uma janela com o QR para parear um celular (ou de novo, se o endereço do PC mudou). **Mostrar QR code (Web)** abre no navegador. O Stremio também ganha um botão de QR na barra de cima enquanto o programa roda.
- **Trocar QR code**: cria uma chave nova; os celulares antigos param de funcionar.
- **Iniciar com o Windows**: liga e desliga.
- **Sair**.

## Perfis

Cada instalação do Stremio é um perfil, com a sua porta: perfil A na 9222 (`stremio-shell-ng.exe`) e perfil B na 9223 (`stremio-shell-ng-2.exe`). Só um abre por vez. Para o celular conseguir abrir o perfil B, ponha o caminho do `.exe` dele em `%APPDATA%\Stremio-Controller\config.json`, campo `perfilB`.

## Como funciona

- O programa escuta na porta 47800 e só atende a rede de casa (IPs privados). Ele serve a página do celular e um WebSocket para os comandos e o estado ao vivo.
- Pareamento: o QR code leva `http://<IP do PC>:47800/#k=<chave>`. A chave fica guardada no celular e nunca passa pela rede: o PC manda um desafio e o celular responde com HMAC-SHA256. "Trocar QR code" troca a chave.
- O programa injeta `pc/page.js` na página do Stremio, que lê o estado pelo `window.core` (Continuar Assistindo, biblioteca, perfil, addons), busca dados e fontes nos addons instalados e toca pela rota `#/player/...`. Os links das fontes ficam no PC; o celular só recebe nomes.
- Controles do player: teclas (Espaço, setas, F) e cliques nas barras de tempo e volume, enviados pela porta de controle.
- `pc/teste-stremio.mjs`: o teste de viabilidade (Node 22+).
