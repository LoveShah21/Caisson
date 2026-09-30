//go:build linux && diagnostic

package main

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"syscall"
	"unsafe"
)

const diagnosticPort = 1026

type diagnosticRequest struct {
	Operation string `json:"operation"`
	Path      string `json:"path,omitempty"`
	Value     string `json:"value,omitempty"`
}
type diagnosticResponse struct {
	Ok    bool   `json:"ok"`
	Value string `json:"value,omitempty"`
	Error string `json:"error,omitempty"`
}

// Diagnostic builds are selected only by the test-rootfs builder. Keeping this
// file behind a build tag makes the production runtime artifact incapable of
// acquiring test commands.
const diagnosticRuntimeBuild = true

// diagnosticRandom is deliberately unavailable from the production artifact.
// KVM tests use it only to compare post-restore kernel randomness.
func diagnosticRandom() (string, error) {
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return hex.EncodeToString(value), nil
}

func diagnosticWriteMarker(path, value string) error   { return os.WriteFile(path, []byte(value), 0o600) }
func diagnosticReadMarker(path string) ([]byte, error) { return os.ReadFile(path) }

func serveDiagnostics() error {
	if err := os.MkdirAll("/dev/shm", 0o700); err != nil {
		return err
	}
	if err := syscall.Mount("tmpfs", "/dev/shm", "tmpfs", 0, "mode=0700,size=1m"); err != nil {
		return err
	}
	fd, err := syscall.Socket(afVsock, syscall.SOCK_STREAM, 0)
	if err != nil {
		return err
	}
	defer syscall.Close(fd)
	address := sockaddrVM{Family: afVsock, Port: diagnosticPort, CID: vmaddrCIDAny}
	_, _, errno := syscall.Syscall(syscall.SYS_BIND, uintptr(fd), uintptr(unsafe.Pointer(&address)), unsafe.Sizeof(address))
	if errno != 0 {
		return errno
	}
	if err := syscall.Listen(fd, 8); err != nil {
		return err
	}
	for {
		connection, _, errno := syscall.Syscall(syscall.SYS_ACCEPT, uintptr(fd), 0, 0)
		if errno != 0 {
			return errno
		}
		go handleDiagnostic(int(connection))
	}
}

func handleDiagnostic(fd int) {
	defer syscall.Close(fd)
	reader := bufio.NewReader(os.NewFile(uintptr(fd), "diagnostic"))
	line, err := reader.ReadBytes('\n')
	if err != nil || len(line) > 4096 {
		return
	}
	var request diagnosticRequest
	if json.Unmarshal(line, &request) != nil {
		writeDiagnostic(fd, diagnosticResponse{Error: "invalid request"})
		return
	}
	if request.Operation == "random" && request.Path == "" && request.Value == "" {
		value, err := diagnosticRandom()
		if err == nil {
			writeDiagnostic(fd, diagnosticResponse{Ok: true, Value: value})
			return
		}
	}
	if request.Operation == "write_marker" && request.Path == "/dev/shm/caisson-marker" && len(request.Value) <= 256 {
		err := diagnosticWriteMarker(request.Path, request.Value)
		if err == nil {
			writeDiagnostic(fd, diagnosticResponse{Ok: true})
			return
		}
	}
	if request.Operation == "read_marker" && request.Path == "/dev/shm/caisson-marker" && request.Value == "" {
		value, err := diagnosticReadMarker(request.Path)
		if err == nil {
			writeDiagnostic(fd, diagnosticResponse{Ok: true, Value: string(value)})
			return
		}
		if os.IsNotExist(err) {
			writeDiagnostic(fd, diagnosticResponse{Ok: true})
			return
		}
	}
	writeDiagnostic(fd, diagnosticResponse{Error: "invalid request"})
}
func writeDiagnostic(fd int, response diagnosticResponse) {
	value, _ := json.Marshal(response)
	_, _ = syscall.Write(fd, append(value, '\n'))
}
