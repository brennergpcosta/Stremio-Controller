package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

//go:embed page.js
var pageJSRaw string

var pageJS string

// Perfis: só um Stremio abre por vez. A porta diz qual (pc/porta-ligar.reg)
var profilePorts = []struct {
	name string
	port int
}{{"A", 9222}, {"B", 9223}}

type stremioConn struct {
	profile string
	email   string
	c       *cdp
}

var (
	stMu sync.Mutex
	cur  *stremioConn
)

func current() *stremioConn {
	stMu.Lock()
	defer stMu.Unlock()
	if cur != nil && !cur.c.alive() {
		cur = nil
	}
	return cur
}

var errClosed = errors.New("o Stremio está fechado no PC")

// Chama window.__strc.<fn>(args...) na página (injetando o page.js se precisar)
func (s *stremioConn) run(ctx context.Context, fn string, out any, args ...any) error {
	if args == nil {
		args = []any{}
	}
	a, _ := json.Marshal(args)
	expr := pageJS + "\n;window.__strc." + fn + "(..." + string(a) + ")"
	return s.c.eval(ctx, expr, out)
}

func callStremio(timeout time.Duration, fn string, out any, args ...any) error {
	s := current()
	if s == nil {
		return errClosed
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	return s.run(ctx, fn, out, args...)
}

// Procura o Stremio aberto a cada 2 s e se liga a ele (e de novo quando for reaberto)
func watchStremio() {
	pageJS = strings.ReplaceAll(pageJSRaw, "__VERSION__", version)
	lastErr := ""
	note := func(e string) {
		if e != lastErr {
			lastErr = e
			logf("Stremio: %s", e)
		}
	}
	for {
		if current() == nil {
			for _, p := range profilePorts {
				ws, err := findPage(p.port)
				if err != nil {
					continue
				}
				c, err := dialCDP(ws)
				if err != nil {
					note("conexão com a porta falhou: " + err.Error())
					continue
				}
				s := &stremioConn{profile: p.name, c: c}
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				var pr struct {
					Email string `json:"email"`
				}
				if err := s.run(ctx, "profile", &pr); err != nil {
					// A página ainda está carregando (window.core não existe): tenta de novo depois
					note("página ainda não pronta: " + err.Error())
					cancel()
					c.close()
					continue
				}
				cancel()
				s.email = pr.Email
				stMu.Lock()
				cur = s
				stMu.Unlock()
				logf("Stremio conectado: perfil %s", p.name)
				updateTray()
				go pushState()
				go func() {
					<-c.closed
					logf("Stremio desconectado: perfil %s", p.name)
					updateTray()
					pushState()
				}()
				break
			}
		}
		time.Sleep(2 * time.Second)
	}
}

// Abre um perfil do Stremio (pedido do celular)
func openProfile(p string) string {
	if s := current(); s != nil {
		if s.profile == p {
			return "O perfil " + p + " já está aberto"
		}
		return "Feche o perfil " + s.profile + " no PC antes (só um Stremio abre por vez)"
	}
	exe := profileExe(p)
	if exe == "" {
		return "Caminho do perfil " + p + " não configurado no PC (config.json)"
	}
	if _, err := os.Stat(exe); err != nil {
		return "Não achei o Stremio do perfil " + p + " no PC"
	}
	cmd := exec.Command(exe)
	cmd.Dir = dirOf(exe)
	if err := cmd.Start(); err != nil {
		return "Não deu para abrir: " + err.Error()
	}
	go cmd.Wait()
	return "Abrindo o perfil " + p + " no PC…"
}

func dirOf(p string) string {
	i := strings.LastIndexAny(p, `\/`)
	if i < 0 {
		return "."
	}
	return p[:i]
}
