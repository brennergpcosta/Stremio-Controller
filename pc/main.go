// Stremio Controller: programa do PC. Fica perto do relógio, acha o Stremio 5 aberto (porta CDP do
// WebView2) e atende o celular (página em docs/, GitHub Pages) por WebRTC.
package main

import (
	"context"
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

const pageURL = "https://brennergpcosta.github.io/Stremio-Controller/"

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
// Sinalização: escuta o tópico da chave atual; trocar a chave reinicia a escuta
// ---------------------------------------------------------------------------------------------
var (
	sigMu     sync.Mutex
	sigCancel context.CancelFunc
	relayOK   bool
)

func startSignaling() {
	sigMu.Lock()
	if sigCancel != nil {
		sigCancel()
	}
	ctx, cancel := context.WithCancel(context.Background())
	sigCancel = cancel
	sigMu.Unlock()
	s, err := newSecret(getConfig().Key)
	if err != nil {
		logf("chave inválida: %v", err)
		return
	}
	go listen(ctx, s, func(from string, sig signal) {
		switch sig.Type {
		case "offer":
			if sig.SDP != "" {
				go onOffer(s, from, sig)
			}
		case "bye":
			dropPeer(from)
		}
	}, func(ok bool) {
		sigMu.Lock()
		relayOK = ok
		sigMu.Unlock()
		updateTray()
	})
}

// ---------------------------------------------------------------------------------------------
// Ícone perto do relógio
// ---------------------------------------------------------------------------------------------
var (
	mStatus, mPhones, mQR, mNewQR, mAuto, mQuit *systray.MenuItem
	trayReady                                   = make(chan struct{})
	trayMu                                      sync.Mutex
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
		status = "Stremio aberto: perfil " + s.profile
	}
	mStatus.SetTitle(status)
	ph := openPeers()
	switch len(ph) {
	case 0:
		sigMu.Lock()
		ok := relayOK
		sigMu.Unlock()
		if ok {
			mPhones.SetTitle("Esperando o celular")
		} else {
			mPhones.SetTitle("Sem internet (tentando de novo)")
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
	mQR = systray.AddMenuItem("Mostrar QR code", "Abre o QR code para parear o celular")
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
				showQR()
			case <-mNewQR.ClickedCh:
				setKey(newKey())
				dropAllPeers()
				startSignaling()
				logf("QR code trocado")
				showQR()
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
		setAutostart(true)
	}
	startSignaling()
	go watchStremio()
	go stateLoop()
	go updateLoop()
	if first {
		go func() { <-trayReady; showQR() }()
	}
	systray.Run(onReady, func() { logf("saindo") })
}
