package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"fyne.io/systray"
)

// Atualização automática: ao abrir e a cada 3 horas, olha a última release no GitHub. Se for mais
// nova, baixa o .exe, confere o .sha256, troca o próprio arquivo e reinicia, sem perguntar.
const assetName = "StremioController.exe"

var releasesAPI = func() string {
	if u := os.Getenv("STRC_UPDATE_API"); strings.HasPrefix(u, "http://127.0.0.1:") { // só para testes
		return u
	}
	return "https://api.github.com/repos/brennergpcosta/Stremio-Controller/releases/latest"
}()

func updateLoop() {
	if os.Getenv("STRC_UPDATE_API") != "" {
		time.Sleep(3 * time.Second)
	} else {
		time.Sleep(20 * time.Second)
	}
	for {
		if err := checkUpdate(); err != nil {
			logf("atualização: %v", err)
		}
		time.Sleep(3 * time.Hour)
	}
}

func parseVer(v string) []int {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	var out []int
	for _, p := range strings.Split(v, ".") {
		n, err := strconv.Atoi(p)
		if err != nil {
			return nil
		}
		out = append(out, n)
	}
	return out
}

func newer(a, b string) bool { // a > b
	x, y := parseVer(a), parseVer(b)
	if x == nil || y == nil {
		return false
	}
	for i := 0; i < max(len(x), len(y)); i++ {
		var p, q int
		if i < len(x) {
			p = x[i]
		}
		if i < len(y) {
			q = y[i]
		}
		if p != q {
			return p > q
		}
	}
	return false
}

var httpClient = &http.Client{Timeout: 5 * time.Minute}

func get(url string) ([]byte, error) {
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", "StremioController/"+version)
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("HTTP %d em %s", resp.StatusCode, url)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 200<<20))
}

func checkUpdate() error {
	if version == "dev" {
		return nil
	}
	body, err := get(releasesAPI)
	if err != nil {
		return err
	}
	var rel struct {
		Tag    string `json:"tag_name"`
		Assets []struct {
			Name string `json:"name"`
			URL  string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := json.Unmarshal(body, &rel); err != nil {
		return err
	}
	if !newer(rel.Tag, version) {
		return nil
	}
	var exeURL, shaURL string
	for _, a := range rel.Assets {
		switch a.Name {
		case assetName:
			exeURL = a.URL
		case assetName + ".sha256":
			shaURL = a.URL
		}
	}
	if exeURL == "" || shaURL == "" {
		return fmt.Errorf("release %s sem o .exe ou o .sha256", rel.Tag)
	}
	shaText, err := get(shaURL)
	if err != nil {
		return err
	}
	want := strings.ToLower(strings.Fields(string(shaText) + " x")[0])
	bin, err := get(exeURL)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(bin)
	if hex.EncodeToString(sum[:]) != want {
		return errors.New("o .sha256 não confere: atualização ignorada")
	}
	self := exePath()
	tmp := self + ".new"
	if err := os.WriteFile(tmp, bin, 0o755); err != nil {
		return err
	}
	// O Windows deixa renomear o .exe em uso: o velho vira .old e é apagado na próxima abertura
	old := self + ".old"
	os.Remove(old)
	if err := os.Rename(self, old); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, self); err != nil {
		os.Rename(old, self)
		return err
	}
	logf("atualizado para %s, reiniciando", rel.Tag)
	sendAll(map[string]any{"t": "updated"})
	time.Sleep(500 * time.Millisecond)
	dropAllPeers()
	if err := exec.Command(self).Start(); err != nil {
		return err
	}
	systray.Quit()
	return nil
}

func cleanupUpdate() {
	old := exePath() + ".old"
	for i := 0; i < 10; i++ {
		if err := os.Remove(old); err == nil || os.IsNotExist(err) {
			return
		}
		time.Sleep(500 * time.Millisecond)
	}
}
