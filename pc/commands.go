package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"math"
	"sync"
	"time"
)

// Comandos do celular ({ c: ... }) e o estado mandado de volta ({ t: ... }).

type playerState struct {
	Title    string   `json:"title"`
	Poster   string   `json:"poster"`
	Time     float64  `json:"time"`
	Duration float64  `json:"duration"`
	Paused   *bool    `json:"paused"`
	Volume   *float64 `json:"volume"`
	Fs       bool     `json:"fs"`
}

func readPlayer() *playerState {
	var p *playerState
	if callStremio(3*time.Second, "player", &p) != nil {
		return nil
	}
	return p
}

var pushMu sync.Mutex

func pushState() {
	if len(openPeers()) == 0 {
		return
	}
	pushMu.Lock()
	defer pushMu.Unlock()
	msg := map[string]any{"t": "state", "ver": version, "stremio": nil, "player": nil, "accounts": accounts()}
	if s := current(); s != nil {
		msg["stremio"] = map[string]any{"profile": s.profile, "email": s.email}
		if p := readPlayer(); p != nil {
			msg["player"] = p
		}
	}
	sendAll(msg)
}

// A cada segundo, com celular conectado: estado do player. A cada 5 s: Continuar Assistindo, que vai
// sozinho para os celulares se mudou (item novo, progresso)
func stateLoop() {
	var lastCW [32]byte
	n := 0
	for range time.Tick(time.Second) {
		if len(openPeers()) == 0 {
			lastCW = [32]byte{}
			continue
		}
		pushState()
		n++
		if n%5 == 0 && current() != nil {
			checkLang()
			var items json.RawMessage
			if callStremio(5*time.Second, "list", &items, "cw") == nil {
				h := sha256.Sum256(items)
				if h != lastCW {
					if lastCW != ([32]byte{}) {
						sendAll(map[string]any{"t": "list", "which": "cw", "items": items, "auto": true})
					}
					lastCW = h
				}
			}
		}
	}
}

// Idioma: o celular pede as chaves de texto do Stremio que usa; o PC devolve as traduções no idioma
// da interface do Stremio aberto e manda de novo sozinho quando esse idioma muda
var (
	i18nMu   sync.Mutex
	i18nKeys = map[string]bool{}
	lastLang string
)

func i18nDict() (json.RawMessage, error) {
	i18nMu.Lock()
	keys := make([]string, 0, len(i18nKeys))
	for k := range i18nKeys {
		keys = append(keys, k)
	}
	i18nMu.Unlock()
	var out json.RawMessage
	err := callStremio(8*time.Second, "i18n", &out, keys)
	return out, err
}

func sendI18n(to *peer) {
	d, err := i18nDict()
	if err != nil || d == nil {
		return
	}
	var x struct {
		Lang string `json:"lang"`
	}
	json.Unmarshal(d, &x)
	i18nMu.Lock()
	lastLang = x.Lang
	i18nMu.Unlock()
	msg := map[string]any{"t": "i18n", "data": d}
	if to != nil {
		to.send(msg)
	} else {
		sendAll(msg)
	}
}

// Confere o idioma do Stremio (chamado a cada 5 s com celular conectado)
func checkLang() {
	var lang string
	if callStremio(3*time.Second, "lang", &lang) != nil {
		return
	}
	i18nMu.Lock()
	changed := lang != "" && lang != lastLang
	i18nMu.Unlock()
	if changed {
		sendI18n(nil)
	}
}

func str(c map[string]any, k string) string {
	s, _ := c[k].(string)
	return s
}

func num(c map[string]any, k string) float64 {
	f, _ := c[k].(float64)
	return f
}

func errText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func handle(p *peer, c map[string]any) {
	switch str(c, "c") {
	case "ping":
		p.send(map[string]any{"t": "pong"})
	case "hello":
		if n := str(c, "name"); n != "" {
			if r := []rune(n); len(r) > 40 {
				n = string(r[:40])
			}
			p.name = n
		}
		updateTray()
		pushState()
	case "i18n":
		if ks, ok := c["keys"].([]any); ok {
			i18nMu.Lock()
			for _, k := range ks {
				if s, ok := k.(string); ok && len(s) < 80 && len(i18nKeys) < 500 {
					i18nKeys[s] = true
				}
			}
			i18nMu.Unlock()
		}
		sendI18n(p)
	case "list":
		which := str(c, "which")
		if which != "cw" && which != "lib" {
			return
		}
		var items json.RawMessage
		err := callStremio(15*time.Second, "list", &items, which)
		if items == nil {
			items = json.RawMessage("[]")
		}
		p.send(map[string]any{"t": "list", "which": which, "items": items, "error": errText(err)})
	case "accounts":
		p.send(map[string]any{"t": "accounts", "list": accountsForPhone()})
	case "accSwitch":
		p.send(map[string]any{"t": "toast", "key": "accSwitching"})
		email, err := switchAccount(str(c, "id"))
		switch {
		case err != nil && err.Error() == "invalid":
			p.send(map[string]any{"t": "toast", "key": "accInvalid", "vars": map[string]string{"name": ""}})
		case err != nil:
			p.send(map[string]any{"t": "toast", "key": "accSwitchFailed", "vars": map[string]string{"error": err.Error()}})
		default:
			p.send(map[string]any{"t": "toast", "key": "accSwitched", "vars": map[string]string{"name": email}})
		}
		sendAll(map[string]any{"t": "accounts", "list": accountsForPhone()})
		pushState()
	case "accForget":
		forgetAccount(str(c, "id"))
		p.send(map[string]any{"t": "accounts", "list": accountsForPhone()})
	case "accAdd":
		if err := addAccount(); err != nil {
			p.send(map[string]any{"t": "toast", "key": "accSwitchFailed", "vars": map[string]string{"error": err.Error()}})
		} else {
			p.send(map[string]any{"t": "toast", "key": "accAddHint"})
		}
	case "hdr":
		p.send(map[string]any{"t": "hdr", "data": getHdr(false)})
	case "hdrSet":
		on, _ := c["on"].(bool)
		if err := setHdr(on); err != nil {
			p.send(map[string]any{"t": "toast", "key": "hdrFailed", "vars": map[string]string{"error": err.Error()}})
		}
		time.Sleep(600 * time.Millisecond)
		sendAll(map[string]any{"t": "hdr", "data": getHdr(true)})
	case "xplayer":
		sendExtPlayer(p)
	case "xplayerSet":
		if err := callStremio(5*time.Second, "extPlayerSet", nil, c["id"]); err != nil {
			p.send(map[string]any{"t": "toast", "key": "xplayerFailed", "vars": map[string]string{"error": err.Error()}})
		}
		sendAllExtPlayer()
	case "popts":
		sendPlayerOptions(p)
	case "pset":
		if err := callStremio(5*time.Second, "playerSet", nil, str(c, "what"), c["value"]); err != nil {
			p.send(map[string]any{"t": "toast", "key": "playFailed", "vars": map[string]string{"error": err.Error()}})
		}
		time.Sleep(350 * time.Millisecond)
		sendPlayerOptions(p)
		pushState()
	case "board":
		var sections json.RawMessage
		err := callStremio(20*time.Second, "board", &sections)
		if sections == nil {
			sections = json.RawMessage("[]")
		}
		p.send(map[string]any{"t": "board", "sections": sections, "error": errText(err)})
	case "catalog":
		var res json.RawMessage
		err := callStremio(20*time.Second, "catalog", &res, str(c, "key"), int(num(c, "skip")))
		p.send(map[string]any{"t": "catalog", "key": str(c, "key"), "skip": int(num(c, "skip")), "data": res, "error": errText(err)})
	case "search":
		q := str(c, "q")
		if r := []rune(q); len(r) > 100 {
			q = string(r[:100])
		}
		var items json.RawMessage
		err := callStremio(20*time.Second, "search", &items, q)
		if items == nil {
			items = json.RawMessage("[]")
		}
		p.send(map[string]any{"t": "list", "which": "search", "q": str(c, "q"), "items": items, "error": errText(err)})
	case "meta":
		var meta json.RawMessage
		err := callStremio(20*time.Second, "meta", &meta, str(c, "type"), str(c, "id"))
		p.send(map[string]any{"t": "meta", "type": str(c, "type"), "id": str(c, "id"), "meta": meta, "error": errText(err)})
	case "streams":
		streams(p, str(c, "type"), str(c, "id"), str(c, "videoId"))
	case "play":
		if err := callStremio(10*time.Second, "play", nil, str(c, "sid")); err != nil {
			p.send(map[string]any{"t": "toast", "key": "playFailed", "vars": map[string]string{"error": err.Error()}})
			return
		}
		time.Sleep(1500 * time.Millisecond)
		pushState()
	case "toggle":
		playerCtl(p, "toggle", 0)
	case "skip":
		playerCtl(p, "skip", num(c, "by"))
	case "seek":
		playerCtl(p, "seek", num(c, "time"))
	case "volume":
		playerCtl(p, "volume", math.Max(0, math.Min(200, num(c, "level"))))
	case "fs":
		want, _ := c["on"].(bool)
		if pl := readPlayer(); pl != nil && pl.Fs != want {
			playerKey(p, "f", "KeyF", 70)
		}
	case "open":
		key, name := openProfile(str(c, "p"))
		p.send(map[string]any{"t": "toast", "key": key, "vars": map[string]string{"name": name}})
	}
}

// Opções do player (legendas, áudio, velocidade...) para a aba Controle do celular
func sendPlayerOptions(p *peer) {
	var o json.RawMessage
	callStremio(5*time.Second, "playerOptions", &o)
	if o == nil {
		o = json.RawMessage("null")
	}
	p.send(map[string]any{"t": "popts", "data": o})
}

// Player externo das Configurações do Stremio (lista e escolhido) para a aba Controle do celular
func readExtPlayer() json.RawMessage {
	var o json.RawMessage
	callStremio(5*time.Second, "extPlayer", &o)
	if o == nil {
		o = json.RawMessage("null")
	}
	return o
}

func sendExtPlayer(p *peer) { p.send(map[string]any{"t": "xplayer", "data": readExtPlayer()}) }

func sendAllExtPlayer() { sendAll(map[string]any{"t": "xplayer", "data": readExtPlayer()}) }

var inputMu sync.Mutex // teclas e cliques de mais de um celular não se misturam

func playerKey(p *peer, key, code string, vk int) {
	inputMu.Lock()
	defer inputMu.Unlock()
	s := current()
	if s == nil {
		p.send(map[string]any{"t": "toast", "key": "stremioClosed"})
		return
	}
	if readPlayer() == nil {
		p.send(map[string]any{"t": "toast", "key": "nothingPlaying"})
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	s.c.key(ctx, key, code, vk)
	time.Sleep(300 * time.Millisecond)
	pushState()
}

// Comandos do player pelas funções da barra de controle do Stremio (sem mouse simulado, que deixava
// o cursor e os controles presos na tela)
func playerCtl(p *peer, what string, value float64) {
	inputMu.Lock()
	defer inputMu.Unlock()
	if current() == nil {
		p.send(map[string]any{"t": "toast", "key": "stremioClosed"})
		return
	}
	if err := callStremio(3*time.Second, "ctl", nil, what, value); err != nil {
		p.send(map[string]any{"t": "toast", "key": "nothingPlaying"})
		return
	}
	time.Sleep(250 * time.Millisecond)
	pushState()
}

// Fontes: pergunta a cada addon ao mesmo tempo e manda ao celular conforme chegam
func streams(p *peer, typ, id, videoId string) {
	var addons []struct {
		Idx  int    `json:"idx"`
		Name string `json:"name"`
	}
	if err := callStremio(10*time.Second, "streamAddons", &addons, typ, videoId); err != nil {
		p.send(map[string]any{"t": "streams", "videoId": videoId, "pending": 0, "error": err.Error()})
		return
	}
	if len(addons) == 0 {
		p.send(map[string]any{"t": "streams", "videoId": videoId, "pending": 0})
		return
	}
	var mu sync.Mutex
	pending := len(addons)
	var wg sync.WaitGroup
	for _, a := range addons {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var items json.RawMessage
			callStremio(30*time.Second, "addonStreams", &items, a.Idx, typ, id, videoId)
			if items == nil {
				items = json.RawMessage("[]")
			}
			mu.Lock()
			pending--
			left := pending
			mu.Unlock()
			p.send(map[string]any{"t": "streams", "videoId": videoId, "addon": a.Name, "key": a.Idx, "items": items, "pending": left})
		}()
	}
	wg.Wait()
}
