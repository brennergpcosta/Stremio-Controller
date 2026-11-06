package main

import (
	"runtime"
	"sync"
	"syscall"
	"unsafe"

	"github.com/skip2/go-qrcode"
	"golang.org/x/sys/windows"
)

// Janela própria do Windows com o QR code de pareamento (sem abrir o navegador). Desenhada com a
// API do Windows (user32/gdi32), numa thread só dela com o próprio laço de mensagens.

var (
	user32 = windows.NewLazySystemDLL("user32.dll")
	gdi32  = windows.NewLazySystemDLL("gdi32.dll")
	kernel = windows.NewLazySystemDLL("kernel32.dll")

	pRegisterClassExW   = user32.NewProc("RegisterClassExW")
	pCreateWindowExW    = user32.NewProc("CreateWindowExW")
	pDefWindowProcW     = user32.NewProc("DefWindowProcW")
	pGetMessageW        = user32.NewProc("GetMessageW")
	pTranslateMessage   = user32.NewProc("TranslateMessage")
	pDispatchMessageW   = user32.NewProc("DispatchMessageW")
	pPostQuitMessage    = user32.NewProc("PostQuitMessage")
	pBeginPaint         = user32.NewProc("BeginPaint")
	pEndPaint           = user32.NewProc("EndPaint")
	pFillRect           = user32.NewProc("FillRect")
	pGetClientRect      = user32.NewProc("GetClientRect")
	pDrawTextW          = user32.NewProc("DrawTextW")
	pShowWindow         = user32.NewProc("ShowWindow")
	pSetForegroundWin   = user32.NewProc("SetForegroundWindow")
	pInvalidateRect     = user32.NewProc("InvalidateRect")
	pLoadCursorW        = user32.NewProc("LoadCursorW")
	pGetSystemMetrics   = user32.NewProc("GetSystemMetrics")
	pDestroyWindow      = user32.NewProc("DestroyWindow")
	pGetDpiForWindow    = user32.NewProc("GetDpiForWindow")
	pCreateSolidBrush   = gdi32.NewProc("CreateSolidBrush")
	pDeleteObject       = gdi32.NewProc("DeleteObject")
	pSetBkMode          = gdi32.NewProc("SetBkMode")
	pSetTextColor       = gdi32.NewProc("SetTextColor")
	pCreateFontW        = gdi32.NewProc("CreateFontW")
	pSelectObject       = gdi32.NewProc("SelectObject")
	pGetModuleHandleW   = kernel.NewProc("GetModuleHandleW")
	pLoadImageW         = user32.NewProc("LoadImageW")
	pIsWindow           = user32.NewProc("IsWindow")
	pSetProcessDpiAware = user32.NewProc("SetProcessDpiAwarenessContext")
)

const (
	wmDestroy    = 0x0002
	wmPaint      = 0x000F
	wmClose      = 0x0010
	wmKeyDown    = 0x0100
	wmUser       = 0x0400
	wmDpiChanged = 0x02E0
	wsOverlapped = 0x00000000
	wsCaption    = 0x00C00000
	wsSysMenu    = 0x00080000
	wsMinimize   = 0x00020000
	wsVisible    = 0x10000000
	swShow       = 5
	dtCenter     = 0x0001
	dtWordbreak  = 0x0010
	dtNoPrefix   = 0x0800
	vkEscape     = 0x1B
)

type wndClassEx struct {
	cbSize        uint32
	style         uint32
	lpfnWndProc   uintptr
	cbClsExtra    int32
	cbWndExtra    int32
	hInstance     windows.Handle
	hIcon         windows.Handle
	hCursor       windows.Handle
	hbrBackground windows.Handle
	lpszMenuName  *uint16
	lpszClassName *uint16
	hIconSm       windows.Handle
}

type rect struct{ left, top, right, bottom int32 }

type msg struct {
	hwnd    windows.Handle
	message uint32
	wParam  uintptr
	lParam  uintptr
	time    uint32
	pt      struct{ x, y int32 }
}

type paintStruct struct {
	hdc         windows.Handle
	fErase      int32
	rcPaint     rect
	fRestore    int32
	fIncUpdate  int32
	rgbReserved [32]byte
}

var (
	qrWinMu  sync.Mutex
	qrHwnd   windows.Handle
	qrBits   [][]bool
	qrAddr   string
	qrClass  = windows.StringToUTF16Ptr("StremioControllerQR")
	qrProcCB = syscall.NewCallback(qrWndProc)
)

// Monta o QR (e o texto) com o endereço e a chave atuais
func qrContent() (bits [][]bool, addr string) {
	link := pairLink()
	if link == "" {
		return nil, ""
	}
	q, err := qrcode.New(link, qrcode.Medium)
	if err != nil {
		return nil, ""
	}
	q.DisableBorder = true
	for i := 0; i < len(link); i++ {
		if link[i] == '#' {
			addr = link[:i]
			break
		}
	}
	return q.Bitmap(), addr
}

// Abre a janela (ou traz para a frente e atualiza, se já estiver aberta)
func showQRWindow() {
	bits, addr := qrContent()
	qrWinMu.Lock()
	qrBits, qrAddr = bits, addr
	h := qrHwnd
	qrWinMu.Unlock()
	if h != 0 {
		if ok, _, _ := pIsWindow.Call(uintptr(h)); ok != 0 {
			pInvalidateRect.Call(uintptr(h), 0, 1)
			pShowWindow.Call(uintptr(h), swShow)
			pSetForegroundWin.Call(uintptr(h))
			return
		}
	}
	go qrWindowThread()
}

func scaleDpi(h windows.Handle, v int32) int32 {
	if pGetDpiForWindow.Find() != nil || h == 0 {
		return v
	}
	dpi, _, _ := pGetDpiForWindow.Call(uintptr(h))
	if dpi == 0 {
		return v
	}
	return v * int32(dpi) / 96
}

func qrWindowThread() {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	// Nítida em telas com escala (125%, 150%...): por monitor (v2)
	if pSetProcessDpiAware.Find() == nil {
		pSetProcessDpiAware.Call(^uintptr(3)) // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4
	}
	hinst, _, _ := pGetModuleHandleW.Call(0)
	cursor, _, _ := pLoadCursorW.Call(0, 32512) // IDC_ARROW
	// Ícone do .exe (recurso 1, colocado pelo go-winres no build), se houver
	icon, _, _ := pLoadImageW.Call(hinst, 1, 1, 0, 0, 0x00000040) // IMAGE_ICON, LR_DEFAULTSIZE
	wc := wndClassEx{
		lpfnWndProc: qrProcCB, hInstance: windows.Handle(hinst), hCursor: windows.Handle(cursor),
		hIcon: windows.Handle(icon), hIconSm: windows.Handle(icon), lpszClassName: qrClass,
	}
	wc.cbSize = uint32(unsafe.Sizeof(wc))
	pRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc))) // já registrada: segue

	w, h := int32(440), int32(560)
	sw, _, _ := pGetSystemMetrics.Call(0)
	sh, _, _ := pGetSystemMetrics.Call(1)
	title := windows.StringToUTF16Ptr("Stremio Controller: parear o celular")
	hwnd, _, _ := pCreateWindowExW.Call(0x00000008, // WS_EX_TOPMOST
		uintptr(unsafe.Pointer(qrClass)), uintptr(unsafe.Pointer(title)),
		wsOverlapped|wsCaption|wsSysMenu|wsMinimize|wsVisible,
		uintptr((int32(sw)-w)/2), uintptr((int32(sh)-h)/2), uintptr(w), uintptr(h),
		0, 0, hinst, 0)
	if hwnd == 0 {
		logf("janela do QR não abriu; abrindo no navegador")
		showQR()
		return
	}
	// Tamanho conforme a escala da tela
	sW, sH := scaleDpi(windows.Handle(hwnd), w), scaleDpi(windows.Handle(hwnd), h)
	if sW != w {
		user32.NewProc("SetWindowPos").Call(hwnd, 0, uintptr((int32(sw)-sW)/2), uintptr((int32(sh)-sH)/2), uintptr(sW), uintptr(sH), 0x0004)
	}
	qrWinMu.Lock()
	qrHwnd = windows.Handle(hwnd)
	qrWinMu.Unlock()
	pShowWindow.Call(hwnd, swShow)
	pSetForegroundWin.Call(hwnd)
	// Fica por cima só ao abrir (para não sumir atrás de outra janela); depois volta ao normal
	user32.NewProc("SetWindowPos").Call(hwnd, ^uintptr(1), 0, 0, 0, 0, 0x0001|0x0002) // HWND_NOTOPMOST, NOSIZE|NOMOVE

	var m msg
	for {
		r, _, _ := pGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if int32(r) <= 0 {
			break
		}
		pTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
		pDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
	}
	qrWinMu.Lock()
	qrHwnd = 0
	qrWinMu.Unlock()
}

func drawText(hdc windows.Handle, s string, r *rect, size int32, bold bool, color uint32, h windows.Handle) {
	weight := int32(400)
	if bold {
		weight = 600
	}
	font, _, _ := pCreateFontW.Call(uintptr(-scaleDpi(h, size)), 0, 0, 0, uintptr(weight), 0, 0, 0, 1, 0, 0, 5, 0,
		uintptr(unsafe.Pointer(windows.StringToUTF16Ptr("Segoe UI"))))
	old, _, _ := pSelectObject.Call(uintptr(hdc), font)
	pSetTextColor.Call(uintptr(hdc), uintptr(color))
	pSetBkMode.Call(uintptr(hdc), 1) // TRANSPARENT
	u := windows.StringToUTF16Ptr(s)
	pDrawTextW.Call(uintptr(hdc), uintptr(unsafe.Pointer(u)), ^uintptr(0), uintptr(unsafe.Pointer(r)), dtCenter|dtWordbreak|dtNoPrefix)
	pSelectObject.Call(uintptr(hdc), old)
	pDeleteObject.Call(font)
}

func qrWndProc(hwnd windows.Handle, m uint32, wp, lp uintptr) uintptr {
	switch m {
	case wmPaint:
		var ps paintStruct
		hdc, _, _ := pBeginPaint.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&ps)))
		var rc rect
		pGetClientRect.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&rc)))
		white, _, _ := pCreateSolidBrush.Call(0x00FFFFFF)
		black, _, _ := pCreateSolidBrush.Call(0x00000000)
		pFillRect.Call(hdc, uintptr(unsafe.Pointer(&rc)), white)
		qrWinMu.Lock()
		bits, addr := qrBits, qrAddr
		qrWinMu.Unlock()
		pad := scaleDpi(hwnd, 24)
		top := rect{pad, pad / 2, rc.right - pad, pad/2 + scaleDpi(hwnd, 60)}
		if bits == nil {
			drawText(windows.Handle(hdc), "Não achei o endereço deste PC na rede de casa. Confira se o PC está conectado ao Wi-Fi ou ao cabo.", &rect{pad, pad * 3, rc.right - pad, rc.bottom - pad}, 16, false, 0x00333333, hwnd)
		} else {
			drawText(windows.Handle(hdc), "Com o celular no mesmo Wi-Fi deste PC, leia o código com a câmera.", &top, 15, true, 0x00222222, hwnd)
			n := int32(len(bits))
			avail := rc.right - 2*pad
			if hh := rc.bottom - top.bottom - scaleDpi(hwnd, 110); hh < avail {
				avail = hh
			}
			cell := avail / n
			if cell < 1 {
				cell = 1
			}
			size := cell * n
			x0 := (rc.right - size) / 2
			y0 := top.bottom + scaleDpi(hwnd, 8)
			for y := int32(0); y < n; y++ {
				for x := int32(0); x < n; x++ {
					if bits[y][x] {
						r := rect{x0 + x*cell, y0 + y*cell, x0 + (x+1)*cell, y0 + (y+1)*cell}
						pFillRect.Call(hdc, uintptr(unsafe.Pointer(&r)), black)
					}
				}
			}
			bottom := rect{pad, y0 + size + scaleDpi(hwnd, 12), rc.right - pad, rc.bottom - pad/2}
			drawText(windows.Handle(hdc), "Endereço deste PC: "+addr+"\nEste código é a chave do seu controle: não mostre para outras pessoas. Se o endereço do PC mudar, abra esta janela de novo.", &bottom, 12, false, 0x00555555, hwnd)
		}
		pDeleteObject.Call(white)
		pDeleteObject.Call(black)
		pEndPaint.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&ps)))
		return 0
	case wmKeyDown:
		if wp == vkEscape {
			pDestroyWindow.Call(uintptr(hwnd))
		}
		return 0
	case wmDpiChanged:
		pInvalidateRect.Call(uintptr(hwnd), 0, 1)
		return 0
	case wmDestroy:
		pPostQuitMessage.Call(0)
		return 0
	}
	r, _, _ := pDefWindowProcW.Call(uintptr(hwnd), uintptr(m), wp, lp)
	return r
}
