package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// O programa serve a página do celular na rede de casa e recebe os comandos por WebSocket, direto,
// sem nenhum serviço de fora. Só aceita conexões da rede local (IPs privados).
const port = 47800

//go:embed web
var webFS embed.FS

// ---------------------------------------------------------------------------------------------
// Celulares conectados
// ---------------------------------------------------------------------------------------------
type peer struct {
	id   string
	name string
	conn *websocket.Conn
	wmu  sync.Mutex
}

var (
	peersMu sync.Mutex
	peers   = map[string]*peer{}
)

func (p *peer) send(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	p.wmu.Lock()
	defer p.wmu.Unlock()
	p.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if p.conn.WriteMessage(websocket.TextMessage, b) != nil {
		go dropPeer(p.id)
	}
}

func openPeers() []*peer {
	peersMu.Lock()
	defer peersMu.Unlock()
	out := make([]*peer, 0, len(peers))
	for _, p := range peers {
		out = append(out, p)
	}
	return out
}

func sendAll(v any) {
	for _, p := range openPeers() {
		p.send(v)
	}
}

func dropPeer(id string) {
	peersMu.Lock()
	p := peers[id]
	delete(peers, id)
	peersMu.Unlock()
	if p != nil {
		p.conn.Close()
		updateTray()
	}
}

func dropAllPeers() {
	for _, p := range openPeers() {
		dropPeer(p.id)
	}
}

// ---------------------------------------------------------------------------------------------
// Rede
// ---------------------------------------------------------------------------------------------

// Só a rede de casa: loopback, IPs privados e link-local
func localAddr(remote string) bool {
	host, _, err := net.SplitHostPort(remote)
	if err != nil {
		return false
	}
	a, err := netip.ParseAddr(host)
	if err != nil {
		return false
	}
	a = a.Unmap()
	return a.IsLoopback() || a.IsPrivate() || a.IsLinkLocalUnicast()
}

func loopback(remote string) bool {
	host, _, _ := net.SplitHostPort(remote)
	a, err := netip.ParseAddr(host)
	return err == nil && a.Unmap().IsLoopback()
}

// IP do PC na rede de casa: o da interface que sai para a internet (nenhum pacote é enviado),
// senão o primeiro IPv4 privado de uma interface ligada
func lanIP() string {
	if c, err := net.Dial("udp4", "192.0.2.1:9"); err == nil {
		ip := c.LocalAddr().(*net.UDPAddr).IP
		c.Close()
		if a, ok := netip.AddrFromSlice(ip); ok && a.Unmap().IsPrivate() {
			return a.Unmap().String()
		}
	}
	ifs, _ := net.Interfaces()
	for _, it := range ifs {
		if it.Flags&net.FlagUp == 0 || it.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := it.Addrs()
		for _, ad := range addrs {
			if n, ok := ad.(*net.IPNet); ok {
				if a, ok := netip.AddrFromSlice(n.IP); ok && a.Unmap().Is4() && a.Unmap().IsPrivate() {
					return a.Unmap().String()
				}
			}
		}
	}
	return ""
}

func pairLink() string {
	ip := lanIP()
	if ip == "" {
		return ""
	}
	return fmt.Sprintf("http://%s:%d/#k=%s", ip, port, getConfig().Key)
}

// ---------------------------------------------------------------------------------------------
// Servidor
// ---------------------------------------------------------------------------------------------
var (
	serverErr string // erro ao abrir a porta (aparece no menu)
	upgrader  = websocket.Upgrader{
		ReadBufferSize: 4096, WriteBufferSize: 64 * 1024,
		// O celular abre a página por este mesmo endereço: a origem tem que ser a deste servidor
		CheckOrigin: func(r *http.Request) bool {
			o := r.Header.Get("Origin")
			return o == "" || strings.TrimPrefix(strings.TrimPrefix(o, "http://"), "https://") == r.Host
		},
	}
)

func startServer() {
	sub, _ := fs.Sub(webFS, "web")
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", serveWS)
	mux.HandleFunc("/qr", serveQR)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if p == "" {
			p = "index.html"
		}
		b, err := fs.ReadFile(sub, p)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		if p == "app.js" || p == "index.html" {
			b = []byte(strings.ReplaceAll(string(b), "__VERSION__", version))
		}
		ct := mime.TypeByExtension(path.Ext(p))
		if path.Ext(p) == ".webmanifest" {
			ct = "application/manifest+json"
		}
		w.Header().Set("Content-Type", ct)
		w.Header().Set("Cache-Control", "no-store") // a página é sempre a da versão do programa
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Write(b)
	})
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !localAddr(r.RemoteAddr) {
			http.Error(w, "só na rede de casa", http.StatusForbidden)
			return
		}
		mux.ServeHTTP(w, r)
	})
	go func() {
		for {
			addr := fmt.Sprintf(":%d", port)
			if os.Getenv("STRC_LISTEN") == "127.0.0.1" { // testes: sem o aviso do firewall
				addr = fmt.Sprintf("127.0.0.1:%d", port)
			}
			ln, err := net.Listen("tcp", addr)
			if err != nil {
				serverErr = fmt.Sprintf("porta %d ocupada", port)
				logf("servidor: %v", err)
				updateTray()
				time.Sleep(10 * time.Second)
				continue
			}
			serverErr = ""
			updateTray()
			logf("servidor na porta %d", port)
			srv := &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second}
			err = srv.Serve(ln)
			logf("servidor parou: %v", err)
			time.Sleep(2 * time.Second)
		}
	}()
}

// Autenticação: o servidor manda um desafio aleatório; o celular responde com
// HMAC-SHA256(chave do QR, desafio). A chave nunca passa pela rede depois do QR.
func serveWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	conn.SetReadLimit(64 * 1024)
	nonceB := make([]byte, 16)
	rand.Read(nonceB)
	nonce := hex.EncodeToString(nonceB)
	conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	conn.WriteJSON(map[string]any{"t": "challenge", "nonce": nonce})
	conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	var auth struct {
		C    string `json:"c"`
		Mac  string `json:"mac"`
		Name string `json:"name"`
	}
	if conn.ReadJSON(&auth) != nil || auth.C != "auth" {
		conn.Close()
		return
	}
	m := hmac.New(sha256.New, []byte(getConfig().Key))
	m.Write([]byte(nonce))
	want := hex.EncodeToString(m.Sum(nil))
	if !hmac.Equal([]byte(want), []byte(strings.ToLower(auth.Mac))) {
		time.Sleep(time.Second) // freia tentativas
		conn.WriteJSON(map[string]any{"t": "denied"})
		conn.Close()
		logf("celular recusado (QR antigo ou chave errada) de %s", r.RemoteAddr)
		return
	}
	name := auth.Name
	if r := []rune(name); len(r) > 40 {
		name = string(r[:40])
	}
	if name == "" {
		name = "Celular"
	}
	idB := make([]byte, 6)
	rand.Read(idB)
	p := &peer{id: hex.EncodeToString(idB), name: name, conn: conn}
	peersMu.Lock()
	peers[p.id] = p
	peersMu.Unlock()
	logf("celular conectado: %s", p.name)
	p.send(map[string]any{"t": "ok"})
	updateTray()
	go pushState()

	// Comandos do player um por vez, na ordem em que chegam (teclas e cliques não podem se
	// misturar); listas, dados e fontes em paralelo
	ctl := make(chan map[string]any, 64)
	done := make(chan struct{})
	defer close(done)
	go func() {
		for {
			select {
			case c := <-ctl:
				handle(p, c)
			case <-done:
				return
			}
		}
	}()
	for {
		// O celular manda "ping" a cada poucos segundos: sem nada por 40 s, a conexão morreu
		conn.SetReadDeadline(time.Now().Add(40 * time.Second))
		_, data, err := conn.ReadMessage()
		if err != nil {
			break
		}
		var c map[string]any
		if json.Unmarshal(data, &c) != nil {
			continue
		}
		switch c["c"] {
		case "toggle", "skip", "seek", "volume", "fs", "play", "open", "pset", "accSwitch", "accAdd", "accForget":
			select {
			case ctl <- c:
			default:
			}
		default:
			go handle(p, c)
		}
	}
	dropPeer(p.id)
}

// Página do QR code: só no próprio PC (127.0.0.1)
func serveQR(w http.ResponseWriter, r *http.Request) {
	if !loopback(r.RemoteAddr) {
		http.NotFound(w, r)
		return
	}
	page, err := qrPage()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Write([]byte(page))
}
