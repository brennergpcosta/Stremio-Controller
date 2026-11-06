// Stremio Controller: programa do PC. Fica perto do relógio, acha o Stremio 5 aberto (porta CDP do
// WebView2), serve a página do celular na rede de casa e recebe os comandos dele por WebSocket.
package main

import (
	_ "embed"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"fyne.io/systray"
	"golang.org/x/sys/windows"
)

var version = "dev" // trocada no build (-ldflags "-X main.version=1.0.0")

//go:embed assets/icon.ico
var iconICO []byte

// ---------------------------------------------------------------------------------------------
// Log local (%APPDATA%\Stremio-Controller\log.txt), pequeno
// ---------------------------------------------------------------------------------------------
var logMu sync.Mutex

func logf(format string, a ...any) {
	logMu.Lock()
	defer logMu.Unlock()
	p := filepath.Join(dataDir(), "log.txt")
	if st, err := os.Stat(p); err == nil && st.Size() > 512*1024 {
		os.Rename(p, p+".old")
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s %s\n", time.Now().Format("2006-01-02 15:04:05"), fmt.Sprintf(format, a...))
}

// Uma cópia por vez. Depois de uma atualização, a nova espera a velha sair
func singleInstance() bool {
	name, _ := windows.UTF16PtrFromString(`Local\StremioController`)
	for i := 0; i < 40; i++ {
		h, err := windows.CreateMutex(nil, true, name)
		if err == nil {
			_ = h // fica aberto até o programa fechar
			return true
		}
		if h != 0 {
			windows.CloseHandle(h)
		}
		time.Sleep(500 * time.Millisecond)
	}
	return false
}

// ---------------------------------------------------------------------------------------------
// Ícone perto do relógio
// ---------------------------------------------------------------------------------------------
var (
	mStatus, mPhones, mQR, mQRWeb, mNewQR, mAuto, mQuit *systray.MenuItem
	trayReady                                           = make(chan struct{})
	trayMu                                              sync.Mutex
)

func updateTray() {
	select {
	case <-trayReady:
	default:
		return
	}
	trayMu.Lock()
	defer trayMu.Unlock()
	status := "Stremio fechado"
	if s := current(); s != nil {
		status = "Stremio aberto: " + s.email
		if s.email == "" {
			status = "Stremio aberto"
		}
	}
	mStatus.SetTitle(status)
	ph := openPeers()
	switch len(ph) {
	case 0:
		switch {
		case serverErr != "":
			mPhones.SetTitle("Erro: " + serverErr)
		case lanIP() == "":
			mPhones.SetTitle("PC fora da rede de casa")
		default:
			mPhones.SetTitle("Esperando o celular")
		}
	case 1:
		mPhones.SetTitle("Celular conectado: " + ph[0].name)
	default:
		mPhones.SetTitle(fmt.Sprintf("%d celulares conectados", len(ph)))
	}
	systray.SetTooltip("Stremio Controller " + version + "\n" + status)
}

func onReady() {
	systray.SetIcon(iconICO)
	systray.SetTitle("Stremio Controller")
	systray.SetTooltip("Stremio Controller " + version)
	head := systray.AddMenuItem("Stremio Controller "+version, "")
	head.Disable()
	mStatus = systray.AddMenuItem("Stremio fechado", "")
	mStatus.Disable()
	mPhones = systray.AddMenuItem("Esperando o celular", "")
	mPhones.Disable()
	systray.AddSeparator()
	mQR = systray.AddMenuItem("Mostrar QR code", "Abre uma janela com o QR code para parear o celular")
	mQRWeb = systray.AddMenuItem("Mostrar QR code (Web)", "Abre o QR code no navegador")
	mNewQR = systray.AddMenuItem("Trocar QR code", "Cria uma chave nova: o celular antigo para de funcionar")
	mAuto = systray.AddMenuItemCheckbox("Iniciar com o Windows", "", autostartOn())
	systray.AddSeparator()
	mQuit = systray.AddMenuItem("Sair", "")
	close(trayReady)
	updateTray()

	go func() {
		for {
			select {
			case <-mQR.ClickedCh:
				showQRWindow()
			case <-mQRWeb.ClickedCh:
				showQR()
			case <-mNewQR.ClickedCh:
				setKey(newKey())
				dropAllPeers()
				logf("QR code trocado")
				showQRWindow()
			case <-mAuto.ClickedCh:
				on := !mAuto.Checked()
				if err := setAutostart(on); err != nil {
					logf("iniciar com o Windows: %v", err)
				}
				if autostartOn() {
					mAuto.Check()
				} else {
					mAuto.Uncheck()
				}
			case <-mQuit.ClickedCh:
				dropAllPeers()
				systray.Quit()
				return
			}
		}
	}()
}

func main() {
	if !singleInstance() {
		return
	}
	cleanupUpdate()
	loadConfig()
	logf("iniciando %s", version)
	// Primeira vez: liga o "Iniciar com o Windows" e mostra o QR code
	first := false
	if _, err := os.Stat(filepath.Join(dataDir(), "iniciado")); err != nil {
		first = true
		os.WriteFile(filepath.Join(dataDir(), "iniciado"), []byte(version), 0o600)
		if os.Getenv("STRC_DATA") == "" { // na pasta de teste não mexe no "Iniciar com o Windows"
			setAutostart(true)
		}
	}
	startServer()
	go watchStremio()
	go func() { // o IP do PC pode mudar: o menu acompanha
		for range time.Tick(30 * time.Second) {
			updateTray()
		}
	}()
	go stateLoop()
	go qrButtonLoop()
	go updateLoop()
	if first {
		go func() { <-trayReady; showQRWindow() }()
	}
	systray.Run(onReady, func() { logf("saindo") })
}
