package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// Cliente mínimo do Chrome DevTools Protocol, ligado à página web.stremio.com do WebView2.
type cdp struct {
	ws      *websocket.Conn
	wmu     sync.Mutex
	seq     atomic.Int64
	pmu     sync.Mutex
	pending map[int64]chan cdpReply
	closed  chan struct{}
	once    sync.Once
}

type cdpReply struct {
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Message string `json:"message"`
	} `json:"error"`
}

// Acha a página do Stremio na porta (só ela, não o service worker)
func findPage(port int) (string, error) {
	c := http.Client{Timeout: 1500 * time.Millisecond}
	resp, err := c.Get(fmt.Sprintf("http://127.0.0.1:%d/json", port))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var list []struct {
		Type string `json:"type"`
		URL  string `json:"url"`
		WS   string `json:"webSocketDebuggerUrl"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&list); err != nil {
		return "", err
	}
	for _, t := range list {
		if t.Type == "page" && strings.HasPrefix(t.URL, "https://web.stremio.com") {
			return t.WS, nil
		}
	}
	return "", errors.New("página do Stremio não encontrada")
}

func dialCDP(wsURL string) (*cdp, error) {
	d := websocket.Dialer{HandshakeTimeout: 3 * time.Second}
	ws, _, err := d.Dial(wsURL, nil)
	if err != nil {
		return nil, err
	}
	ws.SetReadLimit(64 << 20)
	c := &cdp{ws: ws, pending: map[int64]chan cdpReply{}, closed: make(chan struct{})}
	go c.readLoop()
	return c, nil
}

func (c *cdp) readLoop() {
	defer c.close()
	for {
		_, data, err := c.ws.ReadMessage()
		if err != nil {
			return
		}
		var m struct {
			ID int64 `json:"id"`
			cdpReply
		}
		if json.Unmarshal(data, &m) != nil || m.ID == 0 {
			continue
		}
		c.pmu.Lock()
		ch := c.pending[m.ID]
		delete(c.pending, m.ID)
		c.pmu.Unlock()
		if ch != nil {
			ch <- m.cdpReply
		}
	}
}

func (c *cdp) close() {
	c.once.Do(func() {
		close(c.closed)
		c.ws.Close()
	})
}

func (c *cdp) alive() bool {
	select {
	case <-c.closed:
		return false
	default:
		return true
	}
}

func (c *cdp) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	id := c.seq.Add(1)
	ch := make(chan cdpReply, 1)
	c.pmu.Lock()
	c.pending[id] = ch
	c.pmu.Unlock()
	defer func() {
		c.pmu.Lock()
		delete(c.pending, id)
		c.pmu.Unlock()
	}()
	msg, _ := json.Marshal(map[string]any{"id": id, "method": method, "params": params})
	c.wmu.Lock()
	err := c.ws.WriteMessage(websocket.TextMessage, msg)
	c.wmu.Unlock()
	if err != nil {
		c.close()
		return nil, err
	}
	select {
	case r := <-ch:
		if r.Error != nil {
			return nil, errors.New(r.Error.Message)
		}
		return r.Result, nil
	case <-c.closed:
		return nil, errors.New("Stremio desconectado")
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// Roda uma expressão na página (com await) e devolve o valor em JSON
func (c *cdp) eval(ctx context.Context, expr string, out any) error {
	raw, err := c.call(ctx, "Runtime.evaluate", map[string]any{
		"expression": expr, "awaitPromise": true, "returnByValue": true,
	})
	if err != nil {
		return err
	}
	var r struct {
		Result struct {
			Value json.RawMessage `json:"value"`
		} `json:"result"`
		Exception *struct {
			Text      string `json:"text"`
			Exception struct {
				Description string `json:"description"`
			} `json:"exception"`
		} `json:"exceptionDetails"`
	}
	if err := json.Unmarshal(raw, &r); err != nil {
		return err
	}
	if r.Exception != nil {
		msg := r.Exception.Exception.Description
		if msg == "" {
			msg = r.Exception.Text
		}
		if i := strings.Index(msg, "\n"); i > 0 {
			msg = msg[:i]
		}
		return errors.New(strings.TrimPrefix(msg, "Error: "))
	}
	if out == nil || len(r.Result.Value) == 0 {
		return nil
	}
	return json.Unmarshal(r.Result.Value, out)
}

// Tecla de verdade (keyDown + keyUp), como se fosse no teclado do PC
func (c *cdp) key(ctx context.Context, key, code string, vk int) error {
	base := map[string]any{"key": key, "code": code, "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk}
	down := map[string]any{"type": "keyDown"}
	for k, v := range base {
		down[k] = v
	}
	if len(key) == 1 {
		down["text"] = key
	}
	if _, err := c.call(ctx, "Input.dispatchKeyEvent", down); err != nil {
		return err
	}
	up := map[string]any{"type": "keyUp"}
	for k, v := range base {
		up[k] = v
	}
	_, err := c.call(ctx, "Input.dispatchKeyEvent", up)
	return err
}
