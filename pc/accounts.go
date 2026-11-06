package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Contas do Stremio salvas neste PC, para trocar pelo celular. A sessão (localStorage do Stremio:
// chave de login e dados da conta, nunca a senha) fica criptografada com a DPAPI do Windows (só este
// usuário do Windows abre), em %APPDATA%\Stremio-Controller\contas. Nada disso vai para o celular
// nem para o log; o celular só vê e-mail, foto e um id.

type account struct {
	ID      string `json:"id"` // hash do id da conta no Stremio
	Email   string `json:"email"`
	Avatar  string `json:"avatar,omitempty"`
	Invalid bool   `json:"invalid,omitempty"` // a sessão salva não vale mais: entrar de novo no Stremio
	SavedAt int64  `json:"savedAt"`
}

var accMu sync.Mutex

func accDir() string {
	d := filepath.Join(dataDir(), "contas")
	os.MkdirAll(d, 0o700)
	return d
}

func accIndexPath() string { return filepath.Join(accDir(), "contas.json") }

func loadAccounts() []account {
	var list []account
	if b, err := os.ReadFile(accIndexPath()); err == nil {
		json.Unmarshal(b, &list)
	}
	return list
}

func saveAccounts(list []account) {
	sort.Slice(list, func(i, j int) bool { return list[i].Email < list[j].Email })
	b, _ := json.MarshalIndent(list, "", "  ")
	tmp := accIndexPath() + ".tmp"
	if os.WriteFile(tmp, b, 0o600) == nil {
		os.Rename(tmp, accIndexPath())
	}
}

func accID(stremioID string) string {
	h := sha256.Sum256([]byte("strc:" + stremioID))
	return hex.EncodeToString(h[:12])
}

// ---------------------------------------------------------------------------------------------
// DPAPI (CurrentUser)
// ---------------------------------------------------------------------------------------------
func blob(b []byte) *windows.DataBlob {
	if len(b) == 0 {
		return &windows.DataBlob{}
	}
	return &windows.DataBlob{Size: uint32(len(b)), Data: &b[0]}
}

var entropy = []byte("Stremio-Controller contas v1")

func protect(plain []byte) ([]byte, error) {
	var out windows.DataBlob
	if err := windows.CryptProtectData(blob(plain), nil, blob(entropy), 0, nil, 0x1 /* UI_FORBIDDEN */, &out); err != nil {
		return nil, err
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	return append([]byte(nil), unsafe.Slice(out.Data, out.Size)...), nil
}

func unprotect(enc []byte) ([]byte, error) {
	var out windows.DataBlob
	if err := windows.CryptUnprotectData(blob(enc), nil, blob(entropy), 0, nil, 0x1, &out); err != nil {
		return nil, err
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	return append([]byte(nil), unsafe.Slice(out.Data, out.Size)...), nil
}

// ---------------------------------------------------------------------------------------------
// Salvar e trocar
// ---------------------------------------------------------------------------------------------
type session struct {
	ID     string            `json:"id"`
	Email  string            `json:"email"`
	Avatar string            `json:"avatar"`
	Data   map[string]string `json:"data"`
}

// Salva a conta aberta no Stremio agora (se tiver alguma). Devolve o id dela
func saveCurrentSession() (string, error) {
	var s *session
	if err := callStremio(10*time.Second, "session", &s); err != nil {
		return "", err
	}
	if s == nil || s.ID == "" {
		return "", nil // ninguém logado
	}
	plain, _ := json.Marshal(s)
	enc, err := protect(plain)
	if err != nil {
		return "", err
	}
	id := accID(s.ID)
	accMu.Lock()
	defer accMu.Unlock()
	tmp := filepath.Join(accDir(), id+".bin.tmp")
	if err := os.WriteFile(tmp, enc, 0o600); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, filepath.Join(accDir(), id+".bin")); err != nil {
		return "", err
	}
	list := loadAccounts()
	found := false
	for i := range list {
		if list[i].ID == id {
			list[i].Email, list[i].Avatar, list[i].Invalid, list[i].SavedAt = s.Email, s.Avatar, false, time.Now().Unix()
			found = true
		}
	}
	if !found {
		list = append(list, account{ID: id, Email: s.Email, Avatar: s.Avatar, SavedAt: time.Now().Unix()})
		logf("conta nova salva")
	}
	saveAccounts(list)
	return id, nil
}

func markInvalid(id string, bad bool) {
	accMu.Lock()
	defer accMu.Unlock()
	list := loadAccounts()
	for i := range list {
		if list[i].ID == id {
			list[i].Invalid = bad
		}
	}
	saveAccounts(list)
}

// Lista para o celular: e-mail, foto, se é a aberta e se precisa entrar de novo
func accountsForPhone() []map[string]any {
	cur := ""
	if s := current(); s != nil {
		cur = s.email
	}
	accMu.Lock()
	list := loadAccounts()
	accMu.Unlock()
	out := make([]map[string]any, 0, len(list))
	for _, a := range list {
		out = append(out, map[string]any{"id": a.ID, "email": a.Email, "avatar": a.Avatar, "current": a.Email != "" && a.Email == cur, "invalid": a.Invalid})
	}
	return out
}

var switchMu sync.Mutex // uma troca por vez

func switchAccount(id string) (string, error) {
	switchMu.Lock()
	defer switchMu.Unlock()
	s := current()
	if s == nil {
		return "", errClosed
	}
	accMu.Lock()
	var target *account
	for _, a := range loadAccounts() {
		if a.ID == id {
			a := a
			target = &a
		}
	}
	accMu.Unlock()
	if target == nil {
		return "", errors.New("conta não encontrada")
	}
	if target.Email == s.email {
		return target.Email, nil
	}
	enc, err := os.ReadFile(filepath.Join(accDir(), id+".bin"))
	if err != nil {
		return "", errors.New("sessão salva não encontrada")
	}
	plain, err := unprotect(enc)
	if err != nil {
		return "", errors.New("não deu para abrir a sessão salva")
	}
	var sess session
	if err := json.Unmarshal(plain, &sess); err != nil {
		return "", err
	}
	// Guarda a conta atual antes (com o que mudou nela)
	if _, err := saveCurrentSession(); err != nil {
		logf("contas: não salvou a atual antes de trocar: %v", err)
	}
	if err := callStremio(10*time.Second, "restore", nil, sess.Data); err != nil {
		return "", err
	}
	logf("contas: trocando de conta")
	// Confere se a conta entrou mesmo (o Stremio desloga sozinho se a sessão não vale mais)
	time.Sleep(3 * time.Second)
	for i := 0; i < 15; i++ {
		var pr struct {
			Email string `json:"email"`
		}
		if callStremio(3*time.Second, "profile", &pr) == nil {
			if pr.Email == target.Email {
				s.email = pr.Email
				setEmail(s.profile, pr.Email)
				markInvalid(id, false)
				// Espera um pouco o Stremio sincronizar e confere de novo
				go func(sp *stremioConn) {
					time.Sleep(15 * time.Second)
					var p2 struct {
						Email string `json:"email"`
					}
					if callStremio(3*time.Second, "profile", &p2) == nil && p2.Email == "" && sp == current() {
						markInvalid(id, true)
						sendAll(map[string]any{"t": "toast", "key": "accInvalid", "vars": map[string]string{"name": target.Email}})
						sendAll(map[string]any{"t": "accounts", "list": accountsForPhone()})
					}
				}(s)
				return pr.Email, nil
			}
			if pr.Email == "" && i > 4 {
				markInvalid(id, true)
				return "", errors.New("invalid")
			}
		}
		time.Sleep(time.Second)
	}
	return "", errors.New("a conta não entrou a tempo")
}

func forgetAccount(id string) {
	accMu.Lock()
	defer accMu.Unlock()
	list := loadAccounts()
	out := list[:0]
	for _, a := range list {
		if a.ID != id {
			out = append(out, a)
		}
	}
	saveAccounts(out)
	os.Remove(filepath.Join(accDir(), id+".bin"))
	logf("conta esquecida")
}

// Adicionar conta: salva a atual e abre a tela de entrar do Stremio no PC
func addAccount() error {
	if current() == nil {
		return errClosed
	}
	if _, err := saveCurrentSession(); err != nil {
		return err
	}
	return callStremio(5*time.Second, "logoutLocal", nil)
}

// Salva a conta aberta ao conectar e a cada 10 min (a sessão e a biblioteca mudam com o uso)
func accountsLoop() {
	last := ""
	tick := 0
	for range time.Tick(15 * time.Second) {
		s := current()
		if s == nil {
			last = ""
			continue
		}
		tick++
		// O e-mail da conta aberta pode mudar (entrou ou saiu no próprio Stremio)
		var pr struct {
			Email string `json:"email"`
		}
		if callStremio(3*time.Second, "profile", &pr) == nil && pr.Email != s.email {
			s.email = pr.Email
			setEmail(s.profile, pr.Email)
			updateTray()
			go pushState()
		}
		key := s.profile + "|" + s.email
		if key != last || tick%40 == 0 {
			if _, err := saveCurrentSession(); err == nil {
				last = key
			}
		}
	}
}
