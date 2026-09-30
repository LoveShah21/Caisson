//go:build linux && diagnostic

package main

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
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
	return serveDiagnosticsWithControl(nil, nil)
}

func serveDiagnosticsWithControl(listenerReady chan<- error, continueBroker chan<- struct{}) error {
	if err := os.MkdirAll("/dev/shm", 0o700); err != nil {
		return err
	}
	if err := syscall.Mount("tmpfs", "/dev/shm", "tmpfs", 0, "mode=0700,size=1m"); err != nil {
		return err
	}
	fd, err := syscall.Socket(afVsock, syscall.SOCK_STREAM, 0)
	if err != nil {
		if listenerReady != nil {
			listenerReady <- err
		}
		return err
	}
	defer syscall.Close(fd)
	address := sockaddrVM{Family: afVsock, Port: diagnosticPort, CID: vmaddrCIDAny}
	_, _, errno := syscall.Syscall(syscall.SYS_BIND, uintptr(fd), uintptr(unsafe.Pointer(&address)), unsafe.Sizeof(address))
	if errno != 0 {
		if listenerReady != nil {
			listenerReady <- errno
		}
		return errno
	}
	if err := syscall.Listen(fd, 8); err != nil {
		if listenerReady != nil {
			listenerReady <- err
		}
		return err
	}
	if listenerReady != nil {
		listenerReady <- nil
	}
	for {
		connection, _, errno := syscall.Syscall(syscall.SYS_ACCEPT, uintptr(fd), 0, 0)
		if errno != 0 {
			return errno
		}
		go handleDiagnostic(int(connection), continueBroker)
	}
}

func handleDiagnostic(fd int, continueBroker chan<- struct{}) {
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
	if request.Operation == "continue_broker" && request.Path == "" && request.Value == "" && continueBroker != nil {
		select {
		case continueBroker <- struct{}{}:
			writeDiagnostic(fd, diagnosticResponse{Ok: true})
			return
		default:
			writeDiagnostic(fd, diagnosticResponse{Error: "broker already continued"})
			return
		}
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
	if request.Operation == "scan_secret_shapes" && request.Path == "" && request.Value == "" {
		matches, err := diagnosticSecretShapeLocations()
		if err == nil {
			value, _ := json.Marshal(matches)
			writeDiagnostic(fd, diagnosticResponse{Ok: true, Value: string(value)})
			return
		}
	}
	writeDiagnostic(fd, diagnosticResponse{Error: "invalid request"})
}

var diagnosticSecretShape = regexp.MustCompile(`AKIA[A-Z0-9]{16}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|sk-[A-Za-z0-9]{20,}`)

// diagnosticSecretShapeLocations inspects only diagnostic-visible process and
// filesystem state. It returns locations, never matched values.
func diagnosticSecretShapeLocations() ([]string, error) {
	matches := make([]string, 0)
	inspect := func(location string, value []byte) {
		if diagnosticSecretShape.Match(value) {
			matches = append(matches, location)
		}
	}
	inspect("environment", []byte(strings.Join(os.Environ(), "\n")))
	processes, err := os.ReadDir("/proc")
	if err != nil {
		return nil, err
	}
	for _, process := range processes {
		if !process.IsDir() || !isDecimal(process.Name()) {
			continue
		}
		for _, name := range []string{"environ", "cmdline"} {
			path := filepath.Join("/proc", process.Name(), name)
			if value, readErr := os.ReadFile(path); readErr == nil {
				inspect(path, value)
			}
		}
	}
	for _, root := range []string{"/init", "/dev", "/dev/shm"} {
		walkErr := filepath.Walk(root, func(path string, info os.FileInfo, walkErr error) error {
			if walkErr != nil || !info.Mode().IsRegular() || info.Size() > 4*1024*1024 {
				return nil
			}
			if value, readErr := os.ReadFile(path); readErr == nil {
				inspect(path, value)
			}
			return nil
		})
		if walkErr != nil && !os.IsNotExist(walkErr) {
			return nil, fmt.Errorf("scan %s: %w", root, walkErr)
		}
	}
	return matches, nil
}

func isDecimal(value string) bool {
	if value == "" {
		return false
	}
	for _, character := range value {
		if character < '0' || character > '9' {
			return false
		}
	}
	return true
}
func writeDiagnostic(fd int, response diagnosticResponse) {
	value, _ := json.Marshal(response)
	_, _ = syscall.Write(fd, append(value, '\n'))
}
