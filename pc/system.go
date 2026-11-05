package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"html"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"

	"github.com/skip2/go-qrcode"
	"golang.org/x/sys/windows/registry"
)

// ---------------------------------------------------------------------------------------------
// QR code: página local com o link da página do celular + a chave depois do "#" (não sai do celular)
// ---------------------------------------------------------------------------------------------
// A página é servida por um servidor local (127.0.0.1, porta aleatória, caminho secreto), gerada na
// hora com a chave atual: sem arquivo no disco que o navegador possa não achar.
var (
	qrOnce sync.Once
	qrURL  string
)

func startQRServer() error {
	var err error
	qrOnce.Do(func() {
		var ln net.Listener
		ln, err = net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return
		}
		tok := make([]byte, 16)
		rand.Read(tok)
		path := "/qr-" + hex.EncodeToString(tok)
		qrURL = "http://" + ln.Addr().String() + path
		mux := http.NewServeMux()
		mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
			page, e := qrPage()
			if e != nil {
				http.Error(w, e.Error(), 500)
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Referrer-Policy", "no-referrer")
			w.Write([]byte(page))
		})
		go http.Serve(ln, mux)
	})
	if err != nil {
		return err
	}
	if qrURL == "" {
		return errors.New("servidor do QR code não iniciou")
	}
	return nil
}

func showQR() {
	os.Remove(filepath.Join(dataDir(), "pareamento.html")) // versões antigas gravavam em arquivo
	if err := startQRServer(); err != nil {
		logf("qr: %v", err)
		return
	}
	openFile(qrURL)
}

func qrPage() (string, error) {
	link := pageURL + "#k=" + getConfig().Key
	png, err := qrcode.Encode(link, qrcode.Medium, 512)
	if err != nil {
		return "", err
	}
	page := fmt.Sprintf(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Stremio Controller: parear o celular</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0c0b14;color:#f1f1f4;font:16px/1.5 "Segoe UI",system-ui,sans-serif;text-align:center}
.box{max-width:520px;padding:24px}img{width:360px;height:360px;border-radius:16px;background:#fff;padding:12px}
h1{font-size:22px;margin:0 0 8px}p{color:#a9a8b8}small{color:#74738a}</style></head><body><div class="box">
<h1>Parear o celular</h1><p>Abra a câmera do celular e leia o código. A página do controle abre já pareada com este PC.</p>
<img src="data:image/png;base64,%s" alt="QR code">
<p><small>Este código é a chave do seu controle: não mostre para outras pessoas. Para invalidar, use "Trocar QR code" no ícone perto do relógio.<br>Pode fechar esta página depois de ler.</small></p>
<p><small>Stremio Controller %s</small></p></div></body></html>`, base64.StdEncoding.EncodeToString(png), html.EscapeString(version))
	return page, nil
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
