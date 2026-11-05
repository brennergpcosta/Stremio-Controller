package main

import (
	"bytes"
	"compress/flate"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"strings"
)

// Mesma criptografia da página do celular: JSON → deflate-raw → AES-GCM (iv de 12 bytes na frente)
// → base64url sem "=". O tópico do ntfy sai do SHA-256 da chave.
type secret struct {
	topic string
	aead  cipher.AEAD
}

func b64dec(s string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(strings.TrimRight(s, "="))
}

func newSecret(key string) (*secret, error) {
	raw, err := b64dec(key)
	if err != nil {
		return nil, err
	}
	h := sha256.Sum256(raw)
	block, err := aes.NewCipher(raw)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &secret{topic: "strc-" + hex.EncodeToString(h[:12]), aead: aead}, nil
}

func (s *secret) seal(v any) (string, error) {
	js, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	var buf bytes.Buffer
	w, _ := flate.NewWriter(&buf, flate.DefaultCompression)
	w.Write(js)
	w.Close()
	iv := make([]byte, 12)
	rand.Read(iv)
	out := s.aead.Seal(iv, iv, buf.Bytes(), nil)
	return base64.RawURLEncoding.EncodeToString(out), nil
}

func (s *secret) open(text string, v any) error {
	b, err := b64dec(text)
	if err != nil {
		return err
	}
	if len(b) < 12 {
		return io.ErrUnexpectedEOF
	}
	plain, err := s.aead.Open(nil, b[:12], b[12:], nil)
	if err != nil {
		return err
	}
	js, err := io.ReadAll(flate.NewReader(bytes.NewReader(plain)))
	if err != nil {
		return err
	}
	return json.Unmarshal(js, v)
}
