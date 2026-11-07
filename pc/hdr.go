package main

import (
	"errors"
	"strings"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// HDR do Windows no monitor onde está a janela do Stremio, pela API de configuração de tela do
// próprio Windows (QueryDisplayConfig / DisplayConfigGetDeviceInfo / DisplayConfigSetDeviceInfo).
// No Windows 11 24H2+ usa GET_ADVANCED_COLOR_INFO_2 e SET_HDR_STATE (HDR separado da "cor
// avançada"); antes disso, GET_ADVANCED_COLOR_INFO e SET_ADVANCED_COLOR_STATE.

var (
	pGetDisplayConfigBufferSizes = user32.NewProc("GetDisplayConfigBufferSizes")
	pQueryDisplayConfig          = user32.NewProc("QueryDisplayConfig")
	pDisplayConfigGetDeviceInfo  = user32.NewProc("DisplayConfigGetDeviceInfo")
	pDisplayConfigSetDeviceInfo  = user32.NewProc("DisplayConfigSetDeviceInfo")
	pMonitorFromWindow           = user32.NewProc("MonitorFromWindow")
	pMonitorFromPoint            = user32.NewProc("MonitorFromPoint")
	pGetMonitorInfoW             = user32.NewProc("GetMonitorInfoW")
	pEnumWindows                 = user32.NewProc("EnumWindows")
	pGetWindowThreadProcessId    = user32.NewProc("GetWindowThreadProcessId")
	pIsWindowVisible             = user32.NewProc("IsWindowVisible")
	pGetWindowRect               = user32.NewProc("GetWindowRect")
)

const (
	qdcOnlyActivePaths      = 0x2
	dcGetSourceName         = 1
	dcGetAdvancedColorInfo  = 9
	dcSetAdvancedColorState = 10
	dcGetAdvancedColorInfo2 = 15
	dcSetHdrState           = 16
	monitorDefaultToNearest = 2
	monitorDefaultToPrimary = 1
	processQueryLimitedInfo = 0x1000
)

type luid struct {
	Low  uint32
	High int32
}

type dcHeader struct {
	Type    uint32
	Size    uint32
	Adapter luid
	ID      uint32
}

// DISPLAYCONFIG_PATH_INFO (72 bytes)
type dcPath struct {
	SrcAdapter  luid
	SrcID       uint32
	SrcMode     uint32
	SrcFlags    uint32
	TgtAdapter  luid
	TgtID       uint32
	TgtMode     uint32
	TgtTech     uint32
	TgtRotation uint32
	TgtScaling  uint32
	TgtRefreshN uint32
	TgtRefreshD uint32
	TgtScanLine uint32
	TgtAvail    int32
	TgtFlags    uint32
	Flags       uint32
}

type dcSourceName struct {
	Header dcHeader
	Name   [32]uint16
}

type dcColorInfo struct {
	Header   dcHeader
	Value    uint32
	Encoding uint32
	Bits     uint32
	Mode     uint32 // só no _2: 0 SDR, 1 WCG, 2 HDR
}

type dcSetState struct {
	Header dcHeader
	Value  uint32
}

type hdrInfo struct {
	Supported bool   `json:"supported"`
	On        bool   `json:"on"`
	Monitor   string `json:"monitor,omitempty"`
}

// Monitor (nome GDI, como \\.\DISPLAY1) onde está a janela do Stremio; sem a janela, o principal
func stremioMonitor() string {
	var best windows.Handle
	var bestArea int64
	cb := windows.NewCallback(func(h windows.Handle, _ uintptr) uintptr {
		if v, _, _ := pIsWindowVisible.Call(uintptr(h)); v == 0 {
			return 1
		}
		var pid uint32
		pGetWindowThreadProcessId.Call(uintptr(h), uintptr(unsafe.Pointer(&pid)))
		if pid == 0 {
			return 1
		}
		ph, err := windows.OpenProcess(processQueryLimitedInfo, false, pid)
		if err != nil {
			return 1
		}
		var buf [512]uint16
		n := uint32(len(buf))
		err = windows.QueryFullProcessImageName(ph, 0, &buf[0], &n)
		windows.CloseHandle(ph)
		if err != nil {
			return 1
		}
		exe := strings.ToLower(windows.UTF16ToString(buf[:n]))
		if !strings.Contains(exe, "stremio-shell-ng") {
			return 1
		}
		var r rect
		pGetWindowRect.Call(uintptr(h), uintptr(unsafe.Pointer(&r)))
		if area := int64(r.right-r.left) * int64(r.bottom-r.top); area > bestArea {
			best, bestArea = h, area
		}
		return 1
	})
	pEnumWindows.Call(cb, 0)
	var mon uintptr
	if best != 0 {
		mon, _, _ = pMonitorFromWindow.Call(uintptr(best), monitorDefaultToNearest)
	} else {
		mon, _, _ = pMonitorFromPoint.Call(0, monitorDefaultToPrimary)
	}
	// MONITORINFOEXW: cbSize, rcMonitor, rcWork, dwFlags, szDevice[32]
	var mi struct {
		Size    uint32
		Monitor rect
		Work    rect
		Flags   uint32
		Device  [32]uint16
	}
	mi.Size = uint32(unsafe.Sizeof(mi))
	if ok, _, _ := pGetMonitorInfoW.Call(mon, uintptr(unsafe.Pointer(&mi))); ok == 0 {
		return ""
	}
	return windows.UTF16ToString(mi.Device[:])
}

// Caminho de tela ativo que mostra esse monitor
func displayPath(device string) (*dcPath, error) {
	var nPaths, nModes uint32
	if r, _, _ := pGetDisplayConfigBufferSizes.Call(qdcOnlyActivePaths, uintptr(unsafe.Pointer(&nPaths)), uintptr(unsafe.Pointer(&nModes))); r != 0 {
		return nil, errors.New("GetDisplayConfigBufferSizes falhou")
	}
	if nPaths == 0 {
		return nil, errors.New("nenhuma tela ativa")
	}
	paths := make([]dcPath, nPaths)
	modes := make([]byte, 64*int(nModes)+64)
	if r, _, _ := pQueryDisplayConfig.Call(qdcOnlyActivePaths, uintptr(unsafe.Pointer(&nPaths)), uintptr(unsafe.Pointer(&paths[0])),
		uintptr(unsafe.Pointer(&nModes)), uintptr(unsafe.Pointer(&modes[0])), 0); r != 0 {
		return nil, errors.New("QueryDisplayConfig falhou")
	}
	var first *dcPath
	for i := 0; i < int(nPaths); i++ {
		p := &paths[i]
		if first == nil {
			first = p
		}
		var sn dcSourceName
		sn.Header = dcHeader{Type: dcGetSourceName, Size: uint32(unsafe.Sizeof(sn)), Adapter: p.SrcAdapter, ID: p.SrcID}
		if r, _, _ := pDisplayConfigGetDeviceInfo.Call(uintptr(unsafe.Pointer(&sn))); r == 0 {
			if strings.EqualFold(windows.UTF16ToString(sn.Name[:]), device) {
				return p, nil
			}
		}
	}
	if first != nil {
		return first, nil
	}
	return nil, errors.New("tela não encontrada")
}

// Lê o HDR: primeiro a versão nova (_2), senão a antiga
func readHdr(p *dcPath) (supported, on bool, newAPI bool, err error) {
	var ci dcColorInfo
	ci.Header = dcHeader{Type: dcGetAdvancedColorInfo2, Size: uint32(unsafe.Sizeof(ci)), Adapter: p.TgtAdapter, ID: p.TgtID}
	if r, _, _ := pDisplayConfigGetDeviceInfo.Call(uintptr(unsafe.Pointer(&ci))); r == 0 {
		// bit 4: highDynamicRangeSupported, bit 5: highDynamicRangeUserEnabled; modo 2 = HDR ativo
		return ci.Value&(1<<4) != 0, ci.Value&(1<<5) != 0 || ci.Mode == 2, true, nil
	}
	var old struct {
		Header   dcHeader
		Value    uint32
		Encoding uint32
		Bits     uint32
	}
	old.Header = dcHeader{Type: dcGetAdvancedColorInfo, Size: uint32(unsafe.Sizeof(old)), Adapter: p.TgtAdapter, ID: p.TgtID}
	if r, _, _ := pDisplayConfigGetDeviceInfo.Call(uintptr(unsafe.Pointer(&old))); r != 0 {
		return false, false, false, errors.New("não deu para ler a cor avançada da tela")
	}
	// bit 0: advancedColorSupported, bit 1: advancedColorEnabled
	return old.Value&1 != 0, old.Value&2 != 0, false, nil
}

var (
	hdrMu    sync.Mutex
	hdrCache hdrInfo
	hdrAt    time.Time
)

func getHdr(fresh bool) hdrInfo {
	hdrMu.Lock()
	defer hdrMu.Unlock()
	if !fresh && time.Since(hdrAt) < 3*time.Second {
		return hdrCache
	}
	out := hdrInfo{}
	dev := stremioMonitor()
	if p, err := displayPath(dev); err == nil {
		if sup, on, _, err := readHdr(p); err == nil {
			out = hdrInfo{Supported: sup, On: on, Monitor: dev}
		}
	}
	hdrCache, hdrAt = out, time.Now()
	return out
}

func setHdr(on bool) error {
	p, err := displayPath(stremioMonitor())
	if err != nil {
		return err
	}
	sup, _, newAPI, err := readHdr(p)
	if err != nil {
		return err
	}
	if !sup {
		return errors.New("esta tela não tem HDR")
	}
	var v uint32
	if on {
		v = 1
	}
	st := dcSetState{Value: v}
	if newAPI {
		st.Header = dcHeader{Type: dcSetHdrState, Size: uint32(unsafe.Sizeof(st)), Adapter: p.TgtAdapter, ID: p.TgtID}
		if r, _, _ := pDisplayConfigSetDeviceInfo.Call(uintptr(unsafe.Pointer(&st))); r == 0 {
			getHdr(true)
			return nil
		}
	}
	st.Header = dcHeader{Type: dcSetAdvancedColorState, Size: uint32(unsafe.Sizeof(st)), Adapter: p.TgtAdapter, ID: p.TgtID}
	if r, _, _ := pDisplayConfigSetDeviceInfo.Call(uintptr(unsafe.Pointer(&st))); r != 0 {
		return errors.New("o Windows não aceitou mudar o HDR")
	}
	getHdr(true)
	return nil
}
