//go:build linux

package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"syscall"
	"unsafe"
)

const brokerPort = 1024
const entropyPort = 1025
const hostCID = 2
const afVsock = 40
const vmaddrCIDAny = 0xffffffff

type sockaddrVM struct {
	Family   uint16
	Reserved uint16
	Port     uint32
	CID      uint32
	Zero     [4]byte
}

func main() {
	if err := mountFilesystems(); err != nil {
		fail("dev setup failed")
	}
	request, err := bootRequest()
	if err != nil {
		fail("broker request missing or invalid")
	}
	entropyReady := make(chan error, 1)
	go serveEntropyControl(entropyReady)
	if err := <-entropyReady; err != nil {
		fail("entropy control failed")
	}
	if diagnosticRuntimeBuild && diagnosticPreflightEnabled() {
		listenerReady := make(chan error, 1)
		continueBroker := make(chan struct{}, 1)
		go func() {
			if err := serveDiagnosticsWithControl(listenerReady, continueBroker); err != nil {
				fail("diagnostic control failed")
			}
		}()
		if err := <-listenerReady; err != nil {
			fail("diagnostic control failed")
		}
		<-continueBroker
	}
	response, err := brokerCall(request)
	if err != nil {
		fail("broker call failed")
	}
	// The one-shot response is deliberately written only to the serial console.
	// Snapshot tests inspect host transport messages rather than relying on it.
	fmt.Fprintln(os.Stdout, string(response))
	if diagnosticRuntimeBuild && !diagnosticPreflightEnabled() {
		if err := serveDiagnostics(); err != nil {
			fail("diagnostic control failed")
		}
		return
	}
	// M-2 intentionally has no agent tool surface. Keep PID 1 alive after the
	// one-shot broker call so a clean base snapshot remains runnable.
	select {}
}

func diagnosticPreflightEnabled() bool {
	data, err := os.ReadFile("/proc/cmdline")
	if err != nil {
		return false
	}
	for _, field := range strings.Fields(string(data)) {
		if field == "caisson.diagnostic_preflight=1" {
			return true
		}
	}
	return false
}

func bootRequest() ([]byte, error) {
	data, err := os.ReadFile("/proc/cmdline")
	if err != nil {
		return nil, err
	}
	for _, field := range strings.Fields(string(data)) {
		if value, ok := strings.CutPrefix(field, "caisson.broker_request_b64="); ok {
			return base64.RawURLEncoding.DecodeString(value)
		}
	}
	return nil, os.ErrNotExist
}

func brokerCall(payload []byte) ([]byte, error) {
	var request struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(payload, &request); err != nil || request.ID == "" {
		return nil, fmt.Errorf("invalid broker request")
	}
	fd, err := syscall.Socket(afVsock, syscall.SOCK_STREAM, 0)
	if err != nil {
		return nil, err
	}
	defer syscall.Close(fd)
	address := sockaddrVM{Family: afVsock, Port: brokerPort, CID: hostCID}
	_, _, errno := syscall.Syscall(syscall.SYS_CONNECT, uintptr(fd), uintptr(unsafe.Pointer(&address)), unsafe.Sizeof(address))
	if errno != 0 {
		return nil, errno
	}
	frame := make([]byte, 4+len(payload))
	frame[0] = byte(len(payload) >> 24)
	frame[1] = byte(len(payload) >> 16)
	frame[2] = byte(len(payload) >> 8)
	frame[3] = byte(len(payload))
	copy(frame[4:], payload)
	if _, err := syscall.Write(fd, frame); err != nil {
		return nil, err
	}
	reader := bufio.NewReader(os.NewFile(uintptr(fd), "broker"))
	header := make([]byte, 4)
	if _, err := io.ReadFull(reader, header); err != nil {
		return nil, err
	}
	length := int(header[0])<<24 | int(header[1])<<16 | int(header[2])<<8 | int(header[3])
	if length > 16*1024*1024 {
		return nil, fmt.Errorf("oversize response")
	}
	response := make([]byte, length)
	if _, err = io.ReadFull(reader, response); err != nil {
		return nil, err
	}
	if err := validateBrokerResponse(response, request.ID); err != nil {
		return nil, err
	}
	return response, nil
}

// The host owns the full Zod response schema. The static runtime still
// rejects malformed or mis-correlated responses before exposing them to PID 1.
func validateBrokerResponse(payload []byte, requestID string) error {
	var response map[string]json.RawMessage
	if err := json.Unmarshal(payload, &response); err != nil {
		return err
	}
	if len(response) != 3 && len(response) != 2 {
		return fmt.Errorf("invalid broker response fields")
	}
	var id string
	var ok bool
	if err := json.Unmarshal(response["id"], &id); err != nil || id != requestID {
		return fmt.Errorf("invalid broker response id")
	}
	if err := json.Unmarshal(response["ok"], &ok); err != nil {
		return fmt.Errorf("invalid broker response status")
	}
	if ok && response["body"] == nil {
		return fmt.Errorf("broker success lacks body")
	}
	if !ok && response["error"] == nil {
		return fmt.Errorf("broker failure lacks error")
	}
	return nil
}

func serveEntropyControl(firstReady chan<- error) {
	fd, err := syscall.Socket(afVsock, syscall.SOCK_STREAM, 0)
	if err != nil {
		firstReady <- err
		return
	}
	defer syscall.Close(fd)
	address := sockaddrVM{Family: afVsock, Port: entropyPort, CID: vmaddrCIDAny}
	_, _, errno := syscall.Syscall(syscall.SYS_BIND, uintptr(fd), uintptr(unsafe.Pointer(&address)), unsafe.Sizeof(address))
	if errno != 0 {
		firstReady <- errno
		return
	}
	if err := syscall.Listen(fd, 1); err != nil {
		firstReady <- err
		return
	}
	first := true
	for {
		connection, _, errno := syscall.Syscall(syscall.SYS_ACCEPT, uintptr(fd), 0, 0)
		if errno != 0 {
			if first {
				firstReady <- errno
			}
			return
		}
		err := mixEntropy(int(connection))
		if err != nil {
			fmt.Fprintf(os.Stderr, "caisson runtime: entropy mix failed: %v\n", err)
			_, _ = syscall.Write(int(connection), []byte("ENTROPY_ERROR\n"))
		}
		syscall.Close(int(connection))
		if first {
			firstReady <- err
			first = false
		}
	}
}

func mixEntropy(connection int) error {
	seed := make([]byte, 32)
	if _, err := io.ReadFull(os.NewFile(uintptr(connection), "entropy"), seed); err != nil {
		return err
	}
	// RNDADDENTROPY needs the kernel entropy-count structure. The runtime only
	// acknowledges after the ioctl succeeds.
	device, err := os.OpenFile("/dev/random", os.O_WRONLY, 0)
	if err != nil {
		return err
	}
	defer device.Close()
	input := append([]byte{0, 1, 0, 0, 32, 0, 0, 0}, seed...)
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, device.Fd(), 0x40085203, uintptr(unsafe.Pointer(&input[0]))); errno != 0 {
		return errno
	}
	_, err = syscall.Write(connection, []byte("ENTROPY_OK\n"))
	return err
}

func mountFilesystems() error {
	if err := syscall.Mount("proc", "/proc", "proc", 0, ""); err != nil {
		return fmt.Errorf("mount proc: %w", err)
	}
	return nil
}

func fail(message string) {
	fmt.Fprintln(os.Stderr, "caisson runtime:", message)
	os.Exit(1)
}
