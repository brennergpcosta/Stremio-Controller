# Changelog

## 1.2.0 - 2026-11-06

- Board no celular igual ao do Stremio: as mesmas seções, na mesma ordem, em carrosséis, com "Ver tudo" (lista completa, carrega mais ao rolar).
- Opções do player no celular: legendas (desligar, idioma, variante, atraso, tamanho e posição), áudio, velocidade, escala da imagem e próximo episódio.
- Episódios como no Stremio: miniatura com progresso, data e as marcas ASSISTIDO e EM BREVE.
- Filtro das fontes por addon.
- Busca enquanto digita, sem botão.
- Celular no mesmo idioma do Stremio, com as traduções do próprio Stremio.
- No lugar de "Perfil A/B", o e-mail da conta.
- Trocar de conta do Stremio pelo celular: as contas usadas ficam salvas no PC, criptografadas; "Adicionar conta" abre a tela de entrar do Stremio.
- QR code numa janela própria do Windows ("Mostrar QR code"); a página no navegador continua em "Mostrar QR code (Web)".
- Botão de QR code dentro do Stremio, na barra de cima, enquanto o programa roda.
- "Ler QR code" pela câmera do celular quando a página não acha o PC (leitor no GitHub Pages).

## 1.1.0 - 2026-11-06

- O controle agora funciona só na rede de casa, sem nenhum serviço de fora: o programa do PC serve a página do celular e recebe os comandos direto. Sai o ntfy.sh (e o limite diário de mensagens) e o WebRTC.
- A página do celular vem de dentro do programa, então está sempre na mesma versão dele e recarrega sozinha quando ele se atualiza.
- Pareamento: o QR code leva o endereço do PC na rede. Leia de novo depois de atualizar (o QR antigo não serve mais). A chave não passa pela rede (desafio HMAC-SHA256).
- Avisos na página: QR code trocado no PC, e PC não encontrado (desligado, outro Wi-Fi ou endereço mudou).
- Conserto: logo depois de abrir o Stremio, o programa às vezes não conseguia se ligar a ele até reiniciar.
- CLAUDE.md: regra de não usar serviços de terceiros.

## 1.0.1 - 2026-11-05

- QR code: a página agora abre por um endereço local (127.0.0.1) em vez de um arquivo, que às vezes dava "ERR_FILE_NOT_FOUND" no navegador.

## 1.0.0 - 2026-11-05

- Programa do PC (`StremioController.exe`): fica perto do relógio, acha o Stremio aberto (perfil A ou B) e se reconecta quando ele é reaberto. Menu com Mostrar QR code, Trocar QR code, Iniciar com o Windows e Sair.
- Página nova do celular: pareamento pelo QR code, reconexão automática, perfil aberto no topo (ou "Stremio fechado", com botões para abrir o perfil A ou B). Abas Continuar, Biblioteca, Buscar e Controle.
- Escolha temporada, episódio e fonte (dos addons instalados) no celular e o Stremio do PC toca no player dele. Navegar no celular não muda a tela do PC.
- Controle: tocar/pausar, ±10 s, barra de tempo, volume e tela cheia, com título e tempo ao vivo. O Continuar assistindo se atualiza sozinho.
- Conexão direta celular-PC (WebRTC); o pareamento passa pelo ntfy.sh criptografado com a chave do QR code. Os links das fontes ficam no PC.
- Atualização automática: o programa baixa a versão nova da release do GitHub, confere o .sha256 e reinicia sozinho. A página do celular sempre abre a versão mais nova.
- O .exe é compilado no GitHub Actions e anexado a cada release.
- CLAUDE.md: regra de privacidade e sem caminho local.

## 0.1.0 - 2026-11-05

- Repositório preparado para o controle do Stremio 5: sai o protótipo antigo com mpv, fica a página do celular em `docs/`.
- `pc/porta-ligar.reg` e `pc/porta-desligar.reg`: ligam e desligam a porta de controle do WebView2 nos dois Stremio (perfil A na 9222, perfil B na 9223), pelo registro do usuário.
- `pc/teste-stremio.mjs`: teste de viabilidade pela porta de controle. Lê perfil, addons, Continuar Assistindo, biblioteca e fontes sem mudar a tela; abre um episódio no player do próprio Stremio; pausa, continua, avança 10 s, volume e tela cheia.
