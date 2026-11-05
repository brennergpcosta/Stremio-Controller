# Changelog

## 0.1.0 - 2026-11-05

- Repositório preparado para o controle do Stremio 5: sai o protótipo antigo com mpv, fica a página do celular em `docs/`.
- `pc/porta-ligar.reg` e `pc/porta-desligar.reg`: ligam e desligam a porta de controle do WebView2 nos dois Stremio (perfil A na 9222, perfil B na 9223), pelo registro do usuário.
- `pc/teste-stremio.mjs`: teste de viabilidade pela porta de controle. Lê perfil, addons, Continuar Assistindo, biblioteca e fontes sem mudar a tela; abre um episódio no player do próprio Stremio; pausa, continua, avança 10 s, volume e tela cheia.
