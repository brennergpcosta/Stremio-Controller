package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// Sinalização pelo ntfy.sh, igual à da YTPowerFeed: cada mensagem criptografada é cortada em partes
// de até 3000 caracteres ({ f: quem mandou, i: id, p: parte, n: total, d: dados }).
const chunk = 3000

var relayURL = func() string {
	if r := os.Getenv("STRC_RELAY"); strings.HasPrefix(r, "http://127.0.0.1:") { // relay local, só para testes
		return r
	}
	return "https://ntfy.sh"
}()

type envelope struct {
	F string `json:"f"`
	I string `json:"i"`
	P int    `json:"p"`
	N int    `json:"n"`
	D string `json:"d"`
}

type signal struct {
	Type string `json:"type"`
	O    string `json:"o,omitempty"`
	To   string `json:"to,omitempty"`
	SDP  string `json:"sdp,omitempty"`
	Name string `json:"name,omitempty"`
}

var me = fmt.Sprintf("pc-%08x", rand.Uint32())

func randID() string { return fmt.Sprintf("%08x", rand.Uint32()) }

func publish(s *secret, v any) error {
	data, err := s.seal(v)
	if err != nil {
		return err
	}
	id := randID()
	n := (len(data) + chunk - 1) / chunk
	for p := 0; p < n; p++ {
		end := min((p+1)*chunk, len(data))
		body, _ := json.Marshal(envelope{F: me, I: id, P: p, N: n, D: data[p*chunk : end]})
		resp, err := http.Post(relayURL+"/"+s.topic+"?cache=no", "text/plain", strings.NewReader(string(body)))
		if err != nil {
			return err
		}
		resp.Body.Close()
		if resp.StatusCode >= 300 {
			return fmt.Errorf("ntfy: HTTP %d", resp.StatusCode)
		}
	}
	return nil
}

// Escuta o tópico até ctx acabar, reconectando sozinha. Chama onSignal para cada mensagem completa.
func listen(ctx context.Context, s *secret, onSignal func(from string, sig signal), onStatus func(ok bool)) {
	parts := map[string][]string{}
	var mu sync.Mutex
	reassemble := func(e envelope) string {
		if e.N <= 1 {
			return e.D
		}
		mu.Lock()
		defer mu.Unlock()
		got := parts[e.I]
		if got == nil {
			got = make([]string, e.N)
		}
		if e.P >= 0 && e.P < len(got) {
			got[e.P] = e.D
		}
		parts[e.I] = got
		for _, x := range got {
			if x == "" {
				return ""
			}
		}
		delete(parts, e.I)
		if len(parts) > 50 {
			parts = map[string][]string{}
		}
		return strings.Join(got, "")
	}
	backoff := time.Second
	for ctx.Err() == nil {
		err := listenOnce(ctx, s, func(line []byte) {
			var m struct {
				Event   string `json:"event"`
				Message string `json:"message"`
			}
			if json.Unmarshal(line, &m) != nil || m.Event != "message" {
				return
			}
			var e envelope
			if json.Unmarshal([]byte(m.Message), &e) != nil || e.F == me || e.D == "" {
				return
			}
			text := reassemble(e)
			if text == "" {
				return
			}
			var sig signal
			if s.open(text, &sig) != nil {
				return
			}
			onSignal(e.F, sig)
		}, func() { onStatus(true); backoff = time.Second })
		if ctx.Err() != nil {
			return
		}
		onStatus(false)
		logf("ntfy: escuta caiu: %v", err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 60*time.Second)
	}
}

func listenOnce(ctx context.Context, s *secret, onLine func([]byte), onOpen func()) error {
	c, cancel := context.WithCancel(ctx)
	defer cancel()
	req, _ := http.NewRequestWithContext(c, "GET", relayURL+"/"+s.topic+"/json", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	onOpen()
	// O ntfy manda keepalive a cada ~45 s: sem nada por 100 s, a conexão morreu calada
	alive := make(chan struct{}, 1)
	go func() {
		t := time.NewTimer(100 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-c.Done():
				return
			case <-alive:
				t.Reset(100 * time.Second)
			case <-t.C:
				cancel()
				return
			}
		}
	}()
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		select {
		case alive <- struct{}{}:
		default:
		}
		onLine(sc.Bytes())
	}
	if err := sc.Err(); err != nil {
		return err
	}
	return fmt.Errorf("conexão encerrada")
}
