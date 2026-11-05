# Stremio Controller

Controle remoto do Stremio pelo celular.

O Stremio 5 aberto no PC (`stremio-shell-ng`, que usa WebView2) é comandado pela porta de controle do WebView2 (Chrome DevTools Protocol). Um programa no PC fica em segundo plano, encontra o Stremio aberto e executa os comandos que chegam do celular: escolher o que assistir, dar play, pausar, avançar, volume e tela cheia, tudo no player do próprio Stremio.

- `docs/`: página do celular (PWA no GitHub Pages).
- `pc/`: programa do Windows que conversa com o Stremio aberto.

Ainda em fase de teste de viabilidade.
