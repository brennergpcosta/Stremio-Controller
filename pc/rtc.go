package main

import (
	"encoding/json"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
)

// Celulares conectados por WebRTC (canal de dados). O celular faz a oferta; o PC responde.
type peer struct {
	id   string
	name string
	pc   *webrtc.PeerConnection
	dc   *webrtc.DataChannel
	mu   sync.Mutex
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
	p.mu.Lock()
	dc := p.dc
	p.mu.Unlock()
	if dc != nil && dc.ReadyState() == webrtc.DataChannelStateOpen {
		dc.SendText(string(b))
	}
}

func openPeers() []*peer {
	peersMu.Lock()
	defer peersMu.Unlock()
	var out []*peer
	for _, p := range peers {
		p.mu.Lock()
		ok := p.dc != nil && p.dc.ReadyState() == webrtc.DataChannelStateOpen
		p.mu.Unlock()
		if ok {
			out = append(out, p)
		}
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
		p.pc.Close()
		updateTray()
	}
}

func dropAllPeers() {
	peersMu.Lock()
	ids := make([]string, 0, len(peers))
	for id := range peers {
		ids = append(ids, id)
	}
	peersMu.Unlock()
	for _, id := range ids {
		dropPeer(id)
	}
}

var rtcConfig = webrtc.Configuration{
	ICEServers: []webrtc.ICEServer{{URLs: []string{"stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"}}},
}

func onOffer(s *secret, from string, sig signal) {
	dropPeer(from)
	pc, err := webrtc.NewPeerConnection(rtcConfig)
	if err != nil {
		logf("webrtc: %v", err)
		return
	}
	name := sig.Name
	if len([]rune(name)) > 40 {
		name = string([]rune(name)[:40])
	}
	if name == "" {
		name = "Celular"
	}
	p := &peer{id: from, name: name, pc: pc}
	peersMu.Lock()
	peers[from] = p
	peersMu.Unlock()

	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		p.mu.Lock()
		p.dc = dc
		p.mu.Unlock()
		dc.OnOpen(func() {
			logf("celular conectado: %s", p.name)
			updateTray()
			go pushState()
		})
		// Comandos do player um por vez, na ordem em que chegam (teclas e cliques não podem se
		// misturar); listas, dados e fontes em paralelo
		ctl := make(chan map[string]any, 64)
		done := make(chan struct{})
		dc.OnClose(func() {
			close(done)
			peersMu.Lock()
			same := peers[from] == p
			peersMu.Unlock()
			if same {
				dropPeer(from)
			}
		})
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
		dc.OnMessage(func(m webrtc.DataChannelMessage) {
			var c map[string]any
			if json.Unmarshal(m.Data, &c) != nil {
				return
			}
			switch c["c"] {
			case "toggle", "skip", "seek", "volume", "fs", "play", "open":
				select {
				case ctl <- c:
				default:
				}
			default:
				go handle(p, c)
			}
		})
	})
	pc.OnConnectionStateChange(func(st webrtc.PeerConnectionState) {
		if st == webrtc.PeerConnectionStateFailed || st == webrtc.PeerConnectionStateClosed {
			peersMu.Lock()
			same := peers[from] == p
			peersMu.Unlock()
			if same {
				dropPeer(from)
			}
		}
	})
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: sig.SDP}); err != nil {
		logf("webrtc: oferta: %v", err)
		dropPeer(from)
		return
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		dropPeer(from)
		return
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(answer); err != nil {
		dropPeer(from)
		return
	}
	select {
	case <-gathered:
	case <-time.After(3 * time.Second):
	}
	if err := publish(s, signal{Type: "answer", To: from, O: sig.O, SDP: pc.LocalDescription().SDP, Name: "PC"}); err != nil {
		logf("ntfy: resposta: %v", err)
	}
}
