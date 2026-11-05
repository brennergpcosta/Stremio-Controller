package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

// Configuração local, fora do repositório: %APPDATA%\Stremio-Controller\config.json
type Config struct {
	Key      string `json:"key"`      // chave do pareamento (vai no QR code)
	ProfileA string `json:"perfilA"` // caminho do stremio-shell-ng.exe do perfil A (vazio: instalação padrão)
	ProfileB string `json:"perfilB"` // caminho do .exe do perfil B (porta 9223)
}

var (
	cfgMu sync.Mutex
	cfg   Config
)

func dataDir() string {
	d := filepath.Join(os.Getenv("APPDATA"), "Stremio-Controller")
	if t := os.Getenv("STRC_DATA"); t != "" { // pasta de teste (desenvolvimento)
		d = t
	}
	os.MkdirAll(d, 0o700)
	return d
}

func cfgPath() string { return filepath.Join(dataDir(), "config.json") }

func loadConfig() {
	cfgMu.Lock()
	defer cfgMu.Unlock()
	if b, err := os.ReadFile(cfgPath()); err == nil {
		json.Unmarshal(b, &cfg)
	}
	if cfg.Key == "" {
		cfg.Key = newKey()
		saveConfigLocked()
	}
}

func saveConfigLocked() {
	b, _ := json.MarshalIndent(cfg, "", "  ")
	tmp := cfgPath() + ".tmp"
	if os.WriteFile(tmp, b, 0o600) == nil {
		os.Rename(tmp, cfgPath())
	}
}

func getConfig() Config {
	cfgMu.Lock()
	defer cfgMu.Unlock()
	return cfg
}

func setKey(k string) {
	cfgMu.Lock()
	cfg.Key = k
	saveConfigLocked()
	cfgMu.Unlock()
}

func newKey() string {
	b := make([]byte, 32)
	rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func profileExe(p string) string {
	c := getConfig()
	switch p {
	case "A":
		if c.ProfileA != "" {
			return c.ProfileA
		}
		return filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "Stremio", "stremio-shell-ng.exe")
	case "B":
		return c.ProfileB
	}
	return ""
}
