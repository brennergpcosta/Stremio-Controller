package main

import (
	"encoding/base64"
	"fmt"
	"html"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/skip2/go-qrcode"
	"golang.org/x/sys/windows/registry"
)

// ---------------------------------------------------------------------------------------------
// QR code: o link da página do celular neste PC (IP da rede de casa) + a chave depois do "#".
// A página do QR é servida pelo próprio programa, só para o PC (http://127.0.0.1:porta/qr).
// ---------------------------------------------------------------------------------------------
func showQR() {
	os.Remove(filepath.Join(dataDir(), "pareamento.html")) // versões antigas gravavam em arquivo
	openFile(fmt.Sprintf("http://127.0.0.1:%d/qr", port))
}

func qrPage() (string, error) {
	link := pairLink()
	style := `<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0c0b14;color:#f1f1f4;font:16px/1.5 "Segoe UI",system-ui,sans-serif;text-align:center}
.box{max-width:560px;padding:24px}img{width:340px;height:340px;border-radius:16px;background:#fff;padding:12px}
h1{font-size:22px;margin:0 0 8px}p{color:#a9a8b8}small{color:#74738a}code{color:#f1f1f4;background:#1d1b28;padding:2px 6px;border-radius:6px}</style>`
	if link == "" {
		return fmt.Sprintf(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Stremio Controller</title>%s</head><body><div class="box">
<h1>PC fora da rede</h1><p>Não achei o endereço deste PC na rede de casa. Confira se o PC está conectado ao Wi-Fi ou ao cabo e tente de novo.</p></div></body></html>`, style), nil
	}
	png, err := qrcode.Encode(link, qrcode.Medium, 512)
	if err != nil {
		return "", err
	}
	addr := strings.SplitN(link, "#", 2)[0]
	page := fmt.Sprintf(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Stremio Controller: parear o celular</title>%s</head><body><div class="box">
<h1>Parear o celular</h1><p>Com o celular no <b>mesmo Wi-Fi</b> deste PC, abra a câmera e leia o código. A página do controle abre já pareada.</p>
<img src="data:image/png;base64,%%s" alt="QR code">
<p><small>Endereço deste PC: <code>%%s</code>. Se o endereço do PC mudar (o roteador às vezes troca), o celular avisa: é só ler o QR code de novo.</small></p>
<p><small>Este código é a chave do seu controle: não mostre para outras pessoas. Para invalidar, use "Trocar QR code" no ícone perto do relógio.<br>Pode fechar esta página depois de ler.</small></p>
<p><small>Stremio Controller %%s</small></p></div></body></html>`, style)
	return fmt.Sprintf(page, base64.StdEncoding.EncodeToString(png), html.EscapeString(addr), html.EscapeString(version)), nil
}

func openFile(p string) {
	exec.Command("rundll32", "url.dll,FileProtocolHandler", p).Start()
}

// ---------------------------------------------------------------------------------------------
// Iniciar com o Windows (HKCU\...\Run)
// ---------------------------------------------------------------------------------------------
const runKey = `Software\Microsoft\Windows\CurrentVersion\Run`
const runName = "StremioController"

func exePath() string {
	p, _ := os.Executable()
	if r, err := filepath.EvalSymlinks(p); err == nil {
		p = r
	}
	return p
}

func autostartOn() bool {
	k, err := registry.OpenKey(registry.CURRENT_USER, runKey, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer k.Close()
	v, _, err := k.GetStringValue(runName)
	return err == nil && strings.Contains(strings.ToLower(v), strings.ToLower(exePath()))
}

func setAutostart(on bool) error {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, runKey, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	if !on {
		err := k.DeleteValue(runName)
		if err == registry.ErrNotExist {
			return nil
		}
		return err
	}
	return k.SetStringValue(runName, `"`+exePath()+`"`)
}

// Botão do QR code dentro do Stremio (barra de cima): renova a cada 5 s com o QR atual. Se o
// programa fechar, o botão some sozinho em até 20 s (ver page.js).
func qrButtonLoop() {
	var lastLink, png64 string
	for range time.Tick(5 * time.Second) {
		if current() == nil {
			continue
		}
		link := pairLink()
		if link == "" {
			continue
		}
		if link != lastLink {
			png, err := qrcode.Encode(link, qrcode.Medium, 512)
			if err != nil {
				continue
			}
			png64, lastLink = base64.StdEncoding.EncodeToString(png), link
		}
		var lang string
		callStremio(3*time.Second, "lang", &lang)
		title, text := "Pair your phone", "Scan with the phone camera, on the same Wi-Fi as this PC. Click anywhere to close."
		if strings.HasPrefix(strings.ToLower(lang), "pt") || strings.HasPrefix(strings.ToLower(lang), "por") {
			title, text = "Parear o celular", "Leia com a câmera do celular, no mesmo Wi-Fi deste PC. Clique em qualquer lugar para fechar."
		}
		callStremio(3*time.Second, "qrButton", nil, png64, title, text)
	}
}
